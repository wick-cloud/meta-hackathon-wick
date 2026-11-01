import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor, CatalogItem } from '../../shared/types.js';
import type { StudioDetail, StudioTask, StudioStatus, StudioPlan } from '../../shared/studio.js';
import { INFERENCE_MODEL_ID, type InferenceProvider } from '../../shared/inference.js';
import {
  addCents,
  subtractCents,
  moneyUnits,
  centsFromUnits,
  MIN_ORDER_PRICE_CENTS,
} from '../../shared/money.js';
import {
  fixedQuote,
  managedPricing,
  requireFreshManagedRate,
  requireCurrentRate,
} from '../../shared/pricing.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { transaction } from '../db.js';
import { enqueue } from '../marketplace/db.js';
import { pagination, encodeCursor, type Row } from '../marketplace/data.js';
import { operationFingerprint } from '../operations.js';
import {
  authority,
  lockedGrant,
  assertRoute,
  moneyAmount,
  operationSchema,
} from '../inference/data.js';
import { createGrantInTransaction, fundGrant } from '../inference/grants.js';
import {
  OFFER_SELECT,
  quotes,
  packPrice,
  createTokenOrder,
  cancelTokenOrder,
  closeGrantLocked,
  offeringOpen,
} from '../inference/market.js';
import { completeStudioTask, completionSchema } from '../inference/gateway.js';
import {
  boundedJson,
  inputReservation,
  MIN_TASK_OUTPUT_RESERVATION,
} from '../inference/runtime.js';
import {
  MAX_PLAN_ATTEMPT,
  planOperation,
  planMessages,
  validatePlan,
  planFailureMessage,
  readPlanAttempt,
  planningView,
} from './planning.js';
import { usageFeatures } from './usage-estimator.js';
import { ensureUsageEstimate, recordUsageSample, studioUsage } from './usage-data.js';
import { createRequest, cancelRequest } from '../marketplace/auction.js';
import { assertManagedCustomerRoute } from '../marketplace/matching.js';
import { availableForBids } from '../marketplace/policy.js';
import { terminateVm } from '../marketplace/lifecycle.js';
import { createCodingJob, controlCoding, wakeCoding, seal, open, ownerOnly } from './service.js';
import { verifyPublicRepository, publicRepository, baseRefSchema } from './contracts.js';
import {
  studioAuthority,
  reserveStudioCompute,
  settleStudioCompute,
  type StudioSource,
} from './studio-budget.js';

export const STUDIO_QUEUE = 'broker-studio-task';
const ended = ['completed', 'failed', 'stopped'];
const taskInput = z
  .object({
    operationKey: operationSchema,
    goal: z.string().trim().min(10).max(4000),
    repositoryUrl: z.string().max(300),
    baseRef: baseRefSchema.default(''),
    budgetCents: moneyAmount(100_000_000, 1),
    durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
    allowInstant: z.boolean().default(true),
    testCommand: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
type Candidate = {
  id: string;
  name: string;
  provider: string;
  region: string;
  cpu: number;
  memoryGb: number;
  maximumCents: number;
};
/** The exact saved next request survives refill, restart and auction fallback. */
async function nextModelMessages(ctx: AppContext, t: Row) {
  if (!t.coding_job_id) return planMessages(t.goal, t.test_command, open(ctx, t.plan_input_cipher));
  const step = (
    await ctx.pool.query(
      `SELECT payload_cipher FROM broker_coding_steps WHERE job_id=$1 AND kind='model' AND status='pending' ORDER BY sequence LIMIT 1`,
      [t.coding_job_id],
    )
  ).rows[0];
  if (!step?.payload_cipher)
    throw new HttpError(
      409,
      'The saved next model request is required before buying more allowance.',
    );
  return completionSchema.shape.messages.parse(open(ctx, step.payload_cipher).messages);
}
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const LIST_COLUMNS = `t.id,left(t.goal,160) goal,t.repository_url,t.commit_sha,t.status,t.source_mode,t.compute_charged_cents,
 t.blocked_reason,t.plan_cipher,t.artifacts_expire_at,t.deadline_at,t.created_at,t.execution_started_at,t.verified_at,
 t.completed_at,t.vm_request_id,t.coding_job_id,t.result_summary,(t.patch_cipher IS NOT NULL) has_patch`;
export function studioView(ctx: AppContext, row: Row): StudioTask {
  const expired = new Date(row.artifacts_expire_at) <= new Date();
  return {
    id: row.id,
    goal: row.goal,
    repositoryUrl: row.repository_url,
    commitSha: row.commit_sha,
    status: row.status,
    mode: row.source_mode,
    budgetCents: Number(row.funded_cents),
    spentCents: Number(row.spent_cents),
    reservedCents: Number(row.held_cents),
    availableCents: Number(row.available_cents),
    returnedCents: Number(row.returned_cents),
    computeChargedCents: Number(row.compute_charged_cents),
    modelChargedCents: subtractCents(row.spent_cents, row.compute_charged_cents),
    blockedReason: row.blocked_reason,
    plan: !expired && row.plan_cipher ? (open(ctx, row.plan_cipher) as StudioPlan) : null,
    deadlineAt: iso(row.deadline_at)!,
    createdAt: iso(row.created_at)!,
    executionStartedAt: iso(row.execution_started_at),
    verifiedAt: iso(row.verified_at),
    completedAt: iso(row.completed_at),
    vmRequestId: row.vm_request_id,
    codingJobId: row.coding_job_id,
    summary: row.result_summary,
    hasPatch: !expired && (row.has_patch ?? !!row.patch_cipher),
  };
}
export async function studioEvent(
  ctx: AppContext,
  id: string,
  key: string,
  kind: string,
  title: string,
  message: string,
) {
  await ctx.pool.query(
    `INSERT INTO broker_studio_events(task_id,event_key,kind,title,message) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,event_key) DO NOTHING`,
    [id, key, kind, title, message],
  );
}
async function modelRoutes(ctx: AppContext, until: Date) {
  if (!ctx.inference?.enabled) return [];
  const rows = (await ctx.pool.query(OFFER_SELECT + ' ORDER BY r.provider')).rows;
  const eligible: Row[] = [];
  for (const row of rows) {
    const native = ctx.inference.routes.get(row.provider as InferenceProvider);
    try {
      await assertRoute(ctx, row, ctx.wick.mode);
    } catch {
      continue;
    }
    // Capability qualification stays server-side; the customer buys a task budget.
    if (
      native &&
      (native.mode === 'fixture' || native.inputAccounting === 'utf8-bytes-v1') &&
      native.maximumOutputTokens >= 2048 &&
      (native.minimumOutputTokens ?? 1) <= MIN_TASK_OUTPUT_RESERVATION &&
      native.validUntil >= until.getTime() &&
      offeringOpen(row, new Date())
    )
      eligible.push(row);
  }
  return eligible;
}
async function computeCandidates(ctx: AppContext, duration: number): Promise<Candidate[]> {
  if (ctx.wick.mode === 'real' && !ctx.config.studioApprovedComputeCatalogIds.length) return [];
  const rows = (
    await ctx.pool.query(
      `SELECT id,item FROM broker_catalog WHERE approved AND source_mode=$1 AND item->'durationMinutes' @> $2::jsonb
       AND ($1<>'real' OR id=ANY($3::text[]))
       ORDER BY (item->>'cpu')::numeric,(item->>'memoryGb')::numeric,id LIMIT 16`,
      [ctx.wick.mode, JSON.stringify([duration]), ctx.config.studioApprovedComputeCatalogIds],
    )
  ).rows;
  // Match the auction's bounded automatic-bid fanout. A catalog cost floor is
  // not a seller's quote: its minimum/base policy can be higher, including for
  // shorter rentals than the published offering's 30-minute baseline.
  const published = rows.length
    ? (
        await ctx.pool.query(
          `SELECT c.id catalog_id,supply.policy,supply.total_capacity,supply.pricing
           FROM broker_catalog c JOIN LATERAL (
             SELECT p.policy,p.total_capacity,o.pricing FROM broker_providers p
             JOIN LATERAL (
               SELECT o.pricing FROM broker_offerings o WHERE o.provider_id=p.id
               AND o.catalog_id=c.id AND o.active ORDER BY o.price_cents,o.id LIMIT 1
             ) o ON true
             WHERE p.policy->>'autoBid'='true'
             AND (p.cloud_provider IS NULL OR p.cloud_provider=c.item->>'provider')
             AND (p.policy->'allowedCatalogIds' IS NULL OR p.policy->'allowedCatalogIds'='null'::jsonb
                  OR p.policy->'allowedCatalogIds' ? c.id)
             ORDER BY (p.cloud_provider IS NOT NULL) DESC,p.id LIMIT 32
           ) supply ON true
           WHERE c.id=ANY($1::text[]) AND c.approved AND c.source_mode=$2`,
          [rows.map((r) => r.id), ctx.wick.mode],
        )
      ).rows
    : [];
  return rows.flatMap(({ id, item }: { id: string; item: CatalogItem }) => {
    try {
      if (item.gpu) return [];
      if (ctx.wick.mode === 'real') {
        assertManagedCustomerRoute(item);
        requireFreshManagedRate(item);
      }
      const floor =
        ctx.wick.mode === 'real'
          ? fixedQuote(managedPricing(item), duration).totalPriceCents
          : MIN_ORDER_PRICE_CENTS;
      const prices = published.flatMap((offer) => {
        if (offer.catalog_id !== id || availableForBids(offer.total_capacity, 0, offer.policy) < 1)
          return [];
        try {
          if (ctx.wick.mode === 'real') {
            if (!offer.pricing) return [];
            requireCurrentRate(offer.pricing, item);
          }
          const price = Math.max(
            MIN_ORDER_PRICE_CENTS,
            floor,
            offer.policy.minimumPriceCents,
            offer.policy.basePriceCents,
          );
          if (offer.policy.maxPriceCents !== undefined && price > offer.policy.maxPriceCents)
            return [];
          // Use the same money validation as the subsequent budget reservation.
          moneyUnits(price);
          return [price];
        } catch {
          return [];
        }
      });
      if (!prices.length) return [];
      const price = Math.min(...prices);
      return [
        {
          id,
          name: item.name,
          provider: item.provider,
          region: item.region,
          cpu: item.cpu,
          memoryGb: item.memoryGb,
          maximumCents: centsFromUnits((moneyUnits(price) * 125n + 99n) / 100n),
        },
      ];
    } catch {
      return [];
    }
  });
}
export async function studioOptions(ctx: AppContext) {
  const [routes, candidates] = await Promise.all([
    modelRoutes(ctx, new Date(Date.now() + 30 * 60000)),
    computeCandidates(ctx, 30),
  ]);
  return {
    mode: ctx.wick.mode,
    available: !!ctx.wick.runCommand && routes.length > 0 && candidates.length > 0,
    reason: !routes.length
      ? 'The configured model routes are not qualified for automatic coding yet. No purchases will be made.'
      : !candidates.length
        ? 'No execution-qualified published compute configuration is available for Studio. No credit will be reserved.'
        : '',
  };
}
export async function createStudioTask(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
  verify = verifyPublicRepository,
) {
  ownerOnly(actor);
  const input = taskInput.parse(raw),
    repo = publicRepository(input.repositoryUrl),
    digest = operationFingerprint({ ...input, repositoryUrl: repo.url });
  const existing = (
    await ctx.pool.query(
      `SELECT t.*,g.funded_cents,g.available_cents,g.held_cents,g.spent_cents,g.returned_cents FROM broker_studio_tasks t JOIN broker_inference_grants g ON g.id=t.grant_id WHERE t.buyer_id=$1 AND t.operation_key=$2`,
      [actor.id, input.operationKey],
    )
  ).rows[0];
  if (existing) {
    if (existing.input_fingerprint !== digest)
      throw new HttpError(409, 'This operation key belongs to another task.');
    return studioView(ctx, existing);
  }
  if (!ctx.wick.runCommand) throw new HttpError(409, 'Task execution is unavailable.');
  const until = new Date(Date.now() + input.durationMinutes * 60000),
    routes = await modelRoutes(ctx, until),
    candidates = await computeCandidates(ctx, input.durationMinutes);
  if (!routes.length)
    throw new HttpError(
      409,
      'A model route must be qualified for coding before Studio can accept this task. No resources were purchased.',
    );
  if (!candidates.length)
    throw new HttpError(
      409,
      'No execution-qualified published compute configuration supports this rental. No credit was reserved.',
    );
  const verified = await verify(repo.url, input.baseRef),
    id = randomUUID();
  const task = await transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    await db.query('SELECT pg_advisory_xact_lock(62401278)');
    const replay = (
      await db.query(
        'SELECT id,input_fingerprint FROM broker_studio_tasks WHERE buyer_id=$1 AND operation_key=$2',
        [actor.id, input.operationKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.input_fingerprint !== digest)
        throw new HttpError(409, 'This operation key belongs to another task.');
      return replay.id as string;
    }
    if (
      (
        await db.query(
          `SELECT id FROM broker_studio_tasks WHERE status NOT IN('completed','failed','stopped') LIMIT 4`,
        )
      ).rowCount === 4
    )
      throw new HttpError(
        429,
        'Studio is currently at capacity, including tasks needing reconciliation.',
      );
    const grant = await createGrantInTransaction(ctx, db, actor, {
      operationKey: `studio:${id}:fund`,
      name: 'Studio · ' + input.goal.slice(0, 85),
      budgetCents: input.budgetCents,
      maxPurchaseCents: input.budgetCents,
      allowedProviders: routes.map((r) => r.provider),
      allowInstant: input.allowInstant,
      expiresAt: until.toISOString(),
    });
    const output = Math.min(
      4096,
      ...routes.map((r) => ctx.inference!.routes.get(r.provider)!.maximumOutputTokens),
    );
    await db.query(
      `INSERT INTO broker_studio_tasks(id,buyer_id,grant_id,operation_key,input_fingerprint,repository_url,commit_sha,base_ref,goal,test_command,source_mode,allow_instant,duration_minutes,deadline_at,model_output)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id,
        actor.id,
        grant.id,
        input.operationKey,
        digest,
        verified.url,
        verified.sha,
        verified.ref,
        input.goal,
        input.testCommand ?? null,
        ctx.wick.mode,
        input.allowInstant,
        input.durationMinutes,
        until,
        output,
      ],
    );
    await db.query(
      `INSERT INTO broker_studio_events(task_id,event_key,kind,title,message) VALUES($1,'funded','budget','Task budget reserved','Compute and model purchases share one owner-funded budget.')`,
      [id],
    );
    await enqueue(ctx, db, STUDIO_QUEUE, { id });
    return id;
  });
  return (await studioDetail(ctx, actor, task)).task;
}
export async function listStudioTasks(ctx: AppContext, actor: Actor, raw: unknown) {
  ownerOnly(actor);
  const p = pagination({ limit: 25, ...(raw as object) });
  const rows = (
    await ctx.pool.query(
      `SELECT ${LIST_COLUMNS},t.created_at::text cursor_created_at,g.funded_cents,g.available_cents,g.held_cents,g.spent_cents,g.returned_cents FROM broker_studio_tasks t JOIN broker_inference_grants g ON g.id=t.grant_id WHERE t.buyer_id=$1 AND ($2::timestamptz IS NULL OR(t.created_at,t.id)<($2,$3::uuid)) ORDER BY t.created_at DESC,t.id DESC LIMIT $4`,
      [actor.id, p.cursor, p.cursorId, p.limit + 1],
    )
  ).rows;
  return {
    items: rows.slice(0, p.limit).map((r) => studioView(ctx, r)),
    nextCursor: rows.length > p.limit ? encodeCursor(rows[p.limit - 1]) : null,
  };
}
async function ownedTask(ctx: AppContext, actor: Actor, id: string) {
  ownerOnly(actor);
  const row = (
    await ctx.pool.query(
      `SELECT t.*,g.status grant_status,g.funded_cents,g.available_cents,g.held_cents,g.spent_cents,g.returned_cents FROM broker_studio_tasks t JOIN broker_inference_grants g ON g.id=t.grant_id WHERE t.id=$1 AND t.buyer_id=$2`,
      [id, actor.id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Task not found.');
  return row;
}
export async function studioDetail(
  ctx: AppContext,
  actor: Actor,
  id: string,
): Promise<StudioDetail> {
  const t = await ownedTask(ctx, actor, id);
  const results = await Promise.all([
    ctx.pool.query(
      `SELECT id,kind,title,message,created_at FROM broker_studio_events WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 40`,
      [id],
    ),
    ctx.pool.query(
      `SELECT id,status,cleanup_confirmed_at FROM broker_vms WHERE request_id=$1 AND buyer_id=$2`,
      [t.vm_request_id, actor.id],
    ),
    ctx.pool.query(`SELECT id,status,closes_at FROM broker_requests WHERE id=$1 AND buyer_id=$2`, [
      t.vm_request_id,
      actor.id,
    ]),
    ctx.pool.query(
      `SELECT b.total_price_cents,b.status,p.name FROM broker_bids b JOIN broker_providers p ON p.id=b.provider_id WHERE b.request_id=$1 ORDER BY b.total_price_cents,b.created_at,b.id LIMIT 32`,
      [t.vm_request_id],
    ),
    ctx.pool.query(
      `SELECT id,status,provider,price_cents,closes_at FROM broker_token_orders WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
      [t.grant_id],
    ),
    ctx.pool.query(
      `SELECT id,provider,status,source_task_id,created_at FROM broker_inference_requests WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25`,
      [t.grant_id],
    ),
  ]);
  // One indexed receipt; history size does not increase the task polling payload.
  let tests: StudioDetail['tests'] = null;
  if (t.coding_job_id && new Date(t.artifacts_expire_at) > new Date()) {
    const steps = (
      await ctx.pool.query(
        `SELECT payload_cipher,result_cipher,completed_at FROM broker_coding_steps WHERE job_id=$1 AND action='test' AND status='completed' ORDER BY sequence DESC LIMIT 1`,
        [t.coding_job_id],
      )
    ).rows;
    const test = steps[0];
    if (test?.result_cipher) {
      const result = open(ctx, test.result_cipher).result;
      if (result)
        tests = {
          output: result.output,
          exitCode: result.exitCode,
          completedAt: iso(test.completed_at)!,
        };
    }
  }
  const vm = results[1].rows[0],
    auction = results[2].rows[0];
  return {
    usage: await studioUsage(ctx.pool, t),
    planning: await planningView(ctx.pool, t),
    modelActivity: results[5].rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      status: r.status,
      phase: r.source_task_id ? 'planning' : 'execution',
      createdAt: iso(r.created_at)!,
    })),
    task: studioView(ctx, t),
    patch:
      t.patch_cipher && new Date(t.artifacts_expire_at) > new Date()
        ? String(open(ctx, t.patch_cipher).output)
        : null,
    events: results[0].rows.reverse().map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      message: e.message,
      createdAt: iso(e.created_at)!,
    })),
    vm: vm
      ? { id: vm.id, status: vm.status, cleanupConfirmedAt: iso(vm.cleanup_confirmed_at) }
      : null,
    computeAuction: auction
      ? {
          id: auction.id,
          status: auction.status,
          closesAt: iso(auction.closes_at)!,
          bids: results[3].rows.map((b) => ({
            provider: b.name,
            priceCents: Number(b.total_price_cents),
            status: b.status,
          })),
        }
      : null,
    modelPurchases: results[4].rows.map((o) => ({
      id: o.id,
      status: o.status,
      provider: o.provider,
      priceCents: o.price_cents == null ? null : Number(o.price_cents),
      closesAt: iso(o.closes_at)!,
    })),
    tests,
  };
}
export async function studioPatch(ctx: AppContext, actor: Actor, id: string) {
  const task = await ownedTask(ctx, actor, id);
  if (!task.patch_cipher || new Date(task.artifacts_expire_at) <= new Date())
    throw new HttpError(409, 'A verified retained patch is not available.');
  return String(open(ctx, task.patch_cipher).output);
}
export async function controlStudio(
  ctx: AppContext,
  actor: Actor,
  id: string,
  action: 'stop' | 'resume' | 'fund' | 'retry-plan',
  raw: unknown = {},
) {
  const meta = await ownedTask(ctx, actor, id);
  if (ended.includes(meta.status)) {
    if (action === 'stop') return studioDetail(ctx, actor, id);
    throw new HttpError(409, 'This task has ended. Start a new task to authorize new work.');
  }
  if (action === 'fund') {
    await fundGrant(ctx, actor, meta.grant_id, raw, id);
  }
  await transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    if (meta.vm_request_id)
      await db.query('SELECT id FROM broker_requests WHERE id=$1 FOR UPDATE', [meta.vm_request_id]);
    const grant = await lockedGrant(db, actor, meta.grant_id, action !== 'stop');
    const t = (await db.query('SELECT * FROM broker_studio_tasks WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (ended.includes(t.status) || t.outcome) return;
    if (action === 'retry-plan') {
      const recovery = await planningView(db, { ...t, grant_status: grant.status });
      if (!recovery?.canRetry || t.coding_job_id || t.plan_cipher)
        throw new HttpError(
          409,
          'Planning cannot be retried: its outcome is unresolved, the repair was used, or task authority has ended.',
        );
      const next =
        recovery.requestId && !recovery.hasSavedResponse ? t.plan_attempt + 1 : t.plan_attempt;
      await db.query(
        `UPDATE broker_studio_tasks SET plan_attempt=$2,status='planning',blocked_reason=NULL,next_tick_at=clock_timestamp() WHERE id=$1`,
        [id, next],
      );
    } else if (action === 'stop')
      await db.query(
        `UPDATE broker_studio_tasks SET stop_requested=true,next_tick_at=clock_timestamp() WHERE id=$1`,
        [id],
      );
    else if (['needs_budget', 'needs_attention'].includes(t.status)) {
      if (t.plan_dispatch_started_at && !t.plan_cipher)
        throw new HttpError(
          409,
          'The original planning request needs reconciliation. It cannot be regenerated.',
        );
      const child = t.coding_job_id
        ? (await db.query('SELECT status FROM broker_coding_jobs WHERE id=$1', [t.coding_job_id]))
            .rows[0]
        : null;
      if (child?.status === 'uncertain')
        throw new HttpError(409, 'Inspect the original command or usage receipt before resuming.');
      await db.query(
        `UPDATE broker_studio_tasks SET status=$2,blocked_reason=NULL,model_order_id=CASE WHEN status='needs_budget' THEN NULL ELSE model_order_id END,next_tick_at=clock_timestamp() WHERE id=$1`,
        [id, t.coding_job_id ? 'running' : t.plan_cipher ? 'compute_auction' : 'queued'],
      );
    }
    await enqueue(ctx, db, STUDIO_QUEUE, { id });
  });
  return studioDetail(ctx, actor, id);
}
async function stage(ctx: AppContext, t: Row, status: StudioStatus, message?: string) {
  await ctx.pool.query(
    'UPDATE broker_studio_tasks SET status=$3,blocked_reason=$4,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2',
    [t.id, t.lease_token, status, message ?? null],
  );
}
async function outcome(
  ctx: AppContext,
  t: Row,
  value: 'completed' | 'failed' | 'stopped',
  reason: string,
) {
  await ctx.pool.query(
    `UPDATE broker_studio_tasks SET status='cleaning_up',outcome=$3,blocked_reason=$4 WHERE id=$1 AND lease_token=$2`,
    [t.id, t.lease_token, value, reason],
  );
}
/** Pinned, fixed-origin, anonymous metadata only; never follows repository-provided URLs. */
async function repositoryContext(t: Row) {
  const repo = publicRepository(t.repository_url),
    base = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/`;
  async function get(path: string) {
    const r = await fetch(base + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Wick-Broker-Studio' },
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new HttpError(409, 'Public repository metadata is temporarily unavailable.');
    }
    return boundedJson(r, 65536) as Promise<any>;
  }
  const tree = await get('trees/' + t.commit_sha),
    entries = z
      .array(
        z.object({
          path: z.string().max(240),
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          type: z.string(),
        }),
      )
      .max(150)
      .parse(tree.tree);
  const selected = entries
    .filter((x) => ['pyproject.toml', 'package.json'].includes(x.path) && x.type === 'blob')
    .slice(0, 2);
  const manifests = await Promise.all(
    selected.map(async (x) => {
      const b = await get('blobs/' + x.sha);
      if (b.encoding !== 'base64' || typeof b.content !== 'string' || b.size > 12000)
        throw new HttpError(409, 'Use a small text project manifest for automatic planning.');
      return {
        path: x.path,
        content: Buffer.from(b.content, 'base64').toString('utf8').slice(0, 12000),
      };
    }),
  );
  return { files: entries.map((x) => x.path), manifests };
}
async function buyModelAllowance(ctx: AppContext, t: Row, actor: Actor, instant = false) {
  const routes = (await modelRoutes(ctx, new Date(t.deadline_at))).filter(
    (r) => Number(r.max_output_tokens) >= t.model_output,
  );
  if (!routes.length) {
    await stage(
      ctx,
      t,
      'needs_attention',
      'No qualified model offering can currently support this task.',
    );
    return;
  }
  const messages = await nextModelMessages(ctx, t);
  if (t.coding_job_id) {
    const packs = (
      await ctx.pool.query(
        `SELECT provider,route_fingerprint,available_input,available_output FROM broker_token_packs
       WHERE grant_id=$1 AND status='active' AND expires_at>clock_timestamp() ORDER BY expires_at,id LIMIT 10`,
        [t.grant_id],
      )
    ).rows;
    if (
      packs.some((p) => {
        const route = routes.find((r) => r.provider === p.provider);
        const native = ctx.inference!.routes.get(p.provider);
        return (
          route &&
          native &&
          p.route_fingerprint === native.fingerprint &&
          Number(p.available_input) >= inputReservation(native, { messages }) &&
          Number(p.available_output) >= Math.min(t.model_output, MIN_TASK_OUTPUT_RESERVATION)
        );
      })
    ) {
      await controlCoding(ctx, actor, t.coding_job_id, 'resume');
      await stage(ctx, t, 'running');
      return;
    }
  }
  const bound = Math.max(
    ...routes.map((r) => inputReservation(ctx.inference!.routes.get(r.provider)!, { messages })),
  );
  const estimate = await ensureUsageEstimate(ctx, t, bound),
    inputTokens = estimate.input_tokens,
    outputTokens = estimate.output_tokens;
  const g = (
    await ctx.pool.query(
      'SELECT available_cents,max_purchase_cents FROM broker_inference_grants WHERE id=$1',
      [t.grant_id],
    )
  ).rows[0];
  const available = Math.min(Number(g.available_cents), Number(g.max_purchase_cents)),
    asks = routes
      .filter(
        (r) =>
          inputReservation(ctx.inference!.routes.get(r.provider)!, { messages }) <= inputTokens,
      )
      .filter((r) => instant || r.auto_bid)
      .map((r) => packPrice(r, inputTokens, outputTokens, instant).priceCents);
  if (!asks.length) {
    if (!instant && t.allow_instant) await buyModelAllowance(ctx, t, actor, true);
    else
      await stage(
        ctx,
        t,
        'needs_attention',
        'No model provider is bidding. No additional allowance was purchased.',
      );
    return;
  }
  const minimum = asks.length ? Math.min(...asks) : Infinity;
  if (minimum > available) {
    await stage(
      ctx,
      t,
      'needs_budget',
      'The remaining budget cannot cover the next model purchase. Add funding or stop the task.',
    );
    return;
  }
  const source: StudioSource = { id: t.id, leaseToken: t.lease_token };
  let quoteId: string | undefined;
  if (instant) {
    const q = (
      await quotes(ctx, actor, { grantId: t.grant_id, inputTokens, outputTokens })
    ).items.find((q) => q.priceCents <= available && routes.some((r) => r.provider === q.provider));
    if (!q) {
      await stage(ctx, t, 'needs_attention', 'No instant model quote fits the remaining budget.');
      return;
    }
    quoteId = q.quoteId;
  }
  const order = await createTokenOrder(
    ctx,
    actor,
    {
      operationKey: `studio:${t.id}:model:${t.purchase_round}:${instant ? 'instant' : 'auction'}`,
      grantId: t.grant_id,
      mode: instant ? 'instant' : 'auction',
      inputTokens,
      outputTokens,
      maxTotalCents: available,
      ...(quoteId ? { quoteId } : {}),
    },
    undefined,
    source,
  );
  await stage(ctx, t, 'model_auction');
  await studioEvent(
    ctx,
    t.id,
    `model-order:${order.id}`,
    'purchase',
    instant ? 'Instant model allowance purchased' : 'Model auction opened',
    instant
      ? 'An accepted quote stayed within the same task budget.'
      : 'Providers have 30 seconds to compete for the model allowance.',
  );
}
async function cleanup(ctx: AppContext, t: Row, actor: Actor) {
  if (t.coding_job_id) {
    const child = (
      await ctx.pool.query('SELECT status FROM broker_coding_jobs WHERE id=$1', [t.coding_job_id])
    ).rows[0];
    if (child && !['ready', 'stopped', 'failed'].includes(child.status))
      await controlCoding(ctx, actor, t.coding_job_id, 'stop');
  }
  const request = t.vm_request_id
    ? (await ctx.pool.query('SELECT status FROM broker_requests WHERE id=$1', [t.vm_request_id]))
        .rows[0]
    : null;
  if (request?.status === 'open')
    await cancelRequest(ctx, actor, t.vm_request_id, `studio:${t.id}:cancel-vm`);
  const vm = t.vm_request_id
    ? (
        await ctx.pool.query('SELECT id,cleanup_confirmed_at FROM broker_vms WHERE request_id=$1', [
          t.vm_request_id,
        ])
      ).rows[0]
    : null;
  if (vm && !vm.cleanup_confirmed_at)
    await terminateVm(ctx, actor.id, vm.id, actor, `studio:${t.id}:terminate`);
  const orders = (
    await ctx.pool.query(
      `SELECT id FROM broker_token_orders WHERE grant_id=$1 AND status='open' ORDER BY id LIMIT 20`,
      [t.grant_id],
    )
  ).rows;
  for (const order of orders)
    await cancelTokenOrder(ctx, actor, order.id, {
      operationKey: `studio:${t.id}:cancel:${order.id}`,
    });
  const accounted = await settleStudioCompute(ctx, actor, t.id, true);
  if ((vm && !vm.cleanup_confirmed_at) || !accounted) return;
  await transaction(ctx.pool, async (db) => {
    const grant = await lockedGrant(db, actor, t.grant_id);
    await closeGrantLocked(db, grant, 'owner_closed');
  });
  const grant = (
    await ctx.pool.query('SELECT status FROM broker_inference_grants WHERE id=$1', [t.grant_id])
  ).rows[0];
  if (grant.status !== 'closed') {
    await stage(
      ctx,
      t,
      'needs_attention',
      'VM cleanup is confirmed; model usage still needs reconciliation. Reserved usage is retained.',
    );
    return;
  }
  await transaction(ctx.pool, async (db) => {
    // The observation's owner FK takes a key-share lock. Acquire it before the
    // task, consistent with owner -> grant -> task control operations. Cleanup
    // must still finish after role revocation, so this does not reauthorize work.
    await db.query('SELECT id FROM "user" WHERE id=$1 FOR KEY SHARE', [t.buyer_id]);
    const current = (
      await db.query(
        `SELECT id,buyer_id,grant_id,source_mode,model_output,usage_features,coding_job_id,outcome
         FROM broker_studio_tasks WHERE id=$1 AND lease_token=$2 FOR UPDATE`,
        [t.id, t.lease_token],
      )
    ).rows[0];
    if (!current) return;
    await recordUsageSample(db, current);
    await db.query(
      `UPDATE broker_studio_tasks SET status=outcome,completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
      [t.id, t.lease_token],
    );
  });
  await studioEvent(
    ctx,
    t.id,
    'cleanup-confirmed',
    'cleanup',
    'Cleanup confirmed',
    'The task VM is terminated, usage is settled, and unspent funding has been returned.',
  );
}
export async function processStudioTask(
  ctx: AppContext,
  id: string,
  repoContext = repositoryContext,
) {
  const token = randomUUID(),
    claimed = (
      await ctx.pool.query(
        `UPDATE broker_studio_tasks SET lease_token=$2,lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1 AND status NOT IN('completed','failed','stopped') AND next_tick_at<=clock_timestamp() AND(lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,
        [id, token],
      )
    ).rows[0];
  if (!claimed) return;
  try {
    for (let turn = 0; turn < 4; turn++) {
      const t = (
        await ctx.pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1 AND lease_token=$2', [
          id,
          token,
        ])
      ).rows[0];
      if (!t) return;
      const person = (
        await ctx.pool.query('SELECT id,email,name,role FROM "user" WHERE id=$1', [t.buyer_id])
      ).rows[0];
      const actor: Actor = {
        id: t.buyer_id,
        email: person?.email ?? '',
        name: person?.name ?? 'Task owner',
        role: 'buyer',
      };
      if (t.outcome) {
        await cleanup(ctx, t, actor);
        return;
      }
      const grant = (
        await ctx.pool.query('SELECT status FROM broker_inference_grants WHERE id=$1', [t.grant_id])
      ).rows[0];
      if (
        t.stop_requested ||
        new Date(t.deadline_at) <= new Date() ||
        person?.role !== 'buyer' ||
        grant.status !== 'active'
      ) {
        await outcome(
          ctx,
          t,
          t.stop_requested ? 'stopped' : 'failed',
          t.stop_requested
            ? 'Stopped by the owner.'
            : 'The task deadline or account authority ended.',
        );
        continue;
      }
      if (['needs_attention', 'needs_budget'].includes(t.status)) return;
      if (t.status === 'queued') {
        const candidates = await computeCandidates(ctx, t.duration_minutes);
        if (!candidates.length) {
          await outcome(ctx, t, 'failed', 'No approved compute is available.');
          continue;
        }
        const context = await repoContext(t);
        t.usage_features = usageFeatures(t.goal, context);
        t.plan_input_cipher = seal(ctx, { candidates, context });
        await ctx.pool.query(
          'UPDATE broker_studio_tasks SET plan_input_cipher=$3,usage_features=$4 WHERE id=$1 AND lease_token=$2',
          [id, token, t.plan_input_cipher, JSON.stringify(t.usage_features)],
        );
        await reserveStudioCompute(
          ctx,
          actor,
          { id, leaseToken: token },
          Math.min(...candidates.map((c) => c.maximumCents)),
        );
        await buyModelAllowance(ctx, t, actor);
        return;
      }
      if (t.status === 'model_auction') {
        const order = t.model_order_id
          ? (
              await ctx.pool.query('SELECT * FROM broker_token_orders WHERE id=$1', [
                t.model_order_id,
              ])
            ).rows[0]
          : null;
        if (!order) {
          await buyModelAllowance(ctx, t, actor);
          return;
        }
        if (order.status === 'open') return;
        if (order.status !== 'awarded') {
          if (order.mode === 'auction' && t.allow_instant) {
            await buyModelAllowance(ctx, t, actor, true);
            return;
          }
          await stage(
            ctx,
            t,
            'needs_attention',
            'No provider accepted the model purchase. No replacement was purchased.',
          );
          return;
        }
        await studioEvent(
          ctx,
          id,
          `model-awarded:${order.id}`,
          'purchase',
          'Model allowance secured',
          `${order.provider} accepted the prepaid purchase. Further purchases must fit the remaining task budget.`,
        );
        if (t.coding_job_id) {
          await controlCoding(ctx, actor, t.coding_job_id, 'resume');
          await stage(ctx, t, 'running');
        } else await stage(ctx, t, 'planning');
        continue;
      }
      if (t.status === 'planning') {
        if (!t.plan_input_cipher || new Date(t.artifacts_expire_at) <= new Date()) {
          await stage(
            ctx,
            t,
            'needs_attention',
            planFailureMessage('artifacts_expired', t.model_output),
          );
          return;
        }
        const operationKey = planOperation(id, t.plan_attempt);
        let attempt = await readPlanAttempt(ctx.pool, t);
        if (!attempt && t.plan_dispatch_started_at && t.plan_attempt === 0) {
          // Legacy planning calls have no retained result. Never send their operation again.
          const prior = (
            await ctx.pool.query(
              'SELECT id,status FROM broker_inference_requests WHERE grant_id=$1 AND operation_key=$2',
              [t.grant_id, operationKey],
            )
          ).rows[0];
          if (prior)
            await ctx.pool.query(
              'UPDATE broker_studio_tasks SET plan_request_id=$3 WHERE id=$1 AND lease_token=$2',
              [id, token, prior.id],
            );
          await stage(
            ctx,
            t,
            'needs_attention',
            planFailureMessage(
              prior?.status === 'settled'
                ? 'missing_response'
                : prior?.status === 'rejected'
                  ? 'rejected'
                  : 'unresolved',
              t.model_output,
            ),
          );
          return;
        }
        if (!attempt) {
          await transaction(ctx.pool, async (db) => {
            await authority(db, actor);
            await lockedGrant(db, actor, t.grant_id, true);
            await studioAuthority(db, { id, leaseToken: token }, actor);
            await db.query(
              'INSERT INTO broker_studio_plan_attempts(task_id,attempt) VALUES($1,$2) ON CONFLICT DO NOTHING',
              [id, t.plan_attempt],
            );
            await db.query(
              'UPDATE broker_studio_tasks SET plan_dispatch_started_at=COALESCE(plan_dispatch_started_at,clock_timestamp()) WHERE id=$1 AND lease_token=$2',
              [id, token],
            );
          });
          attempt = await readPlanAttempt(ctx.pool, t);
        }
        const input = open(ctx, t.plan_input_cipher);
        if (!attempt!.request_id) {
          const previous =
            t.plan_attempt > 0
              ? (
                  await ctx.pool.query(
                    'SELECT failure_code FROM broker_studio_plan_attempts WHERE task_id=$1 AND attempt=0',
                    [id],
                  )
                ).rows[0]
              : null;
          try {
            await completeStudioTask(
              ctx,
              actor,
              {
                operationKey,
                model: INFERENCE_MODEL_ID,
                max_tokens: t.model_output,
                messages: planMessages(
                  t.goal,
                  t.test_command,
                  input,
                  t.plan_attempt > 0 ? (previous?.failure_code ?? 'missing_response') : undefined,
                ),
              },
              id,
              token,
              t.plan_attempt,
            );
          } catch (error) {
            const saved = await readPlanAttempt(ctx.pool, t);
            if (saved?.request_status === 'settled' && saved.response_cipher) continue;
            const code = saved?.request_id
              ? saved.request_status === 'rejected'
                ? 'rejected'
                : 'unresolved'
              : (error as { code?: string }).code === 'token_allowance_exceeded'
                ? 'allowance'
                : 'not_admitted';
            await ctx.pool.query(
              `UPDATE broker_studio_plan_attempts a SET failure_code=$3 FROM broker_studio_tasks t WHERE a.task_id=t.id AND t.id=$1 AND t.lease_token=$2 AND a.attempt=t.plan_attempt`,
              [id, token, code],
            );
            if (saved?.request_id)
              await ctx.pool.query(
                'UPDATE broker_studio_tasks SET plan_request_id=$3 WHERE id=$1 AND lease_token=$2',
                [id, token, saved.request_id],
              );
            await stage(ctx, t, 'needs_attention', planFailureMessage(code, t.model_output));
            return;
          }
          attempt = await readPlanAttempt(ctx.pool, t);
        }
        if (attempt?.request_status !== 'settled' || !attempt.response_cipher) {
          const code =
            attempt?.request_status === 'settled'
              ? 'missing_response'
              : attempt?.request_status === 'rejected'
                ? 'rejected'
                : 'unresolved';
          await stage(ctx, t, 'needs_attention', planFailureMessage(code, t.model_output));
          return;
        }
        const response = open(ctx, attempt.response_cipher);
        const checked = validatePlan(
          response.content,
          attempt.finish_reason,
          input.candidates,
          t.test_command,
          response.oversized,
        );
        await ctx.pool.query(
          `UPDATE broker_studio_plan_attempts a SET failure_code=$3 FROM broker_studio_tasks t WHERE a.task_id=t.id AND t.id=$1 AND t.lease_token=$2 AND a.attempt=t.plan_attempt`,
          [id, token, checked.failure],
        );
        if (!checked.plan) {
          const repair =
            t.plan_attempt < MAX_PLAN_ATTEMPT &&
            ['truncated', 'invalid_json', 'invalid_schema', 'oversized_response'].includes(
              checked.failure,
            );
          await studioEvent(
            ctx,
            id,
            `plan-invalid:${t.plan_attempt}`,
            'meta',
            repair ? 'Muse is repairing its plan' : 'Planning needs review',
            planFailureMessage(checked.failure, attempt.reserved_output ?? t.model_output) +
              (repair
                ? ' The call settled; one shorter attempt will use existing prepaid quota.'
                : ''),
          );
          if (repair) {
            await transaction(ctx.pool, async (db) => {
              await authority(db, actor);
              await lockedGrant(db, actor, t.grant_id, true);
              await studioAuthority(db, { id, leaseToken: token }, actor);
              await db.query(
                `UPDATE broker_studio_tasks SET plan_attempt=plan_attempt+1,plan_request_id=$3,blocked_reason=NULL WHERE id=$1 AND lease_token=$2 AND plan_attempt=$4`,
                [id, token, attempt.request_id, t.plan_attempt],
              );
            });
            continue;
          }
          await ctx.pool.query(
            'UPDATE broker_studio_tasks SET plan_request_id=$3 WHERE id=$1 AND lease_token=$2',
            [id, token, attempt.request_id],
          );
          await stage(
            ctx,
            t,
            'needs_attention',
            planFailureMessage(checked.failure, attempt.reserved_output ?? t.model_output) +
              (t.plan_attempt === MAX_PLAN_ATTEMPT
                ? ' The single planning repair has been used.'
                : ''),
          );
          return;
        }
        await transaction(ctx.pool, async (db) => {
          await authority(db, actor);
          await lockedGrant(db, actor, t.grant_id, true);
          await studioAuthority(db, { id, leaseToken: token }, actor);
          await db.query(
            `UPDATE broker_studio_tasks SET plan_cipher=$3,plan_request_id=$4,test_command=$5,status='compute_auction',blocked_reason=NULL WHERE id=$1 AND lease_token=$2`,
            [id, token, seal(ctx, checked.plan), attempt.request_id, checked.plan.testCommand],
          );
        });
        await studioEvent(
          ctx,
          id,
          'plan-confirmed',
          'meta',
          'Meta prepared the task plan',
          checked.plan.explanation,
        );
        continue;
      }
      if (t.status === 'compute_auction') {
        if (!t.vm_request_id) {
          const plan = open(ctx, t.plan_cipher),
            saved = open(ctx, t.plan_input_cipher),
            c = saved.candidates.find((c: Candidate) => c.id === plan.catalogId) as Candidate;
          try {
            await reserveStudioCompute(ctx, actor, { id, leaseToken: token }, c.maximumCents);
          } catch (error) {
            if (error instanceof HttpError && error.message.includes('remaining task budget')) {
              await stage(
                ctx,
                t,
                'needs_budget',
                'The remaining budget cannot cover the compute selected by Meta. Add funding or stop.',
              );
              return;
            }
            throw error;
          }
          await createRequest(
            ctx,
            actor,
            {
              operationKey: `studio:${id}:compute`,
              description: t.goal,
              catalogId: c.id,
              region: c.region,
              durationMinutes: t.duration_minutes,
              maxPriceCents: c.maximumCents,
              requirements: { cpu: c.cpu, memoryGb: c.memoryGb },
            },
            undefined,
            { id, leaseToken: token },
          );
          await studioEvent(
            ctx,
            id,
            'compute-open',
            'purchase',
            'Compute auction opened',
            'Providers have 30 seconds to bid on the selected VM configuration.',
          );
          return;
        }
        const request = (
          await ctx.pool.query('SELECT status FROM broker_requests WHERE id=$1', [t.vm_request_id])
        ).rows[0];
        if (request.status === 'open') return;
        if (['no_offers', 'failed', 'cancelled'].includes(request.status)) {
          await outcome(ctx, t, 'failed', 'The compute auction did not produce a usable VM.');
          continue;
        }
        await stage(ctx, t, 'provisioning');
        continue;
      }
      if (t.status === 'provisioning') {
        const vm = (
          await ctx.pool.query('SELECT * FROM broker_vms WHERE request_id=$1 AND buyer_id=$2', [
            t.vm_request_id,
            actor.id,
          ])
        ).rows[0];
        if (!vm) return;
        await settleStudioCompute(ctx, actor, id);
        if (vm.status === 'provisioning') return;
        if (vm.status !== 'running') {
          await outcome(
            ctx,
            t,
            'failed',
            'The original VM did not become ready. Cleanup must be confirmed before its reservation is released.',
          );
          continue;
        }
        if (!t.coding_job_id)
          await createCodingJob(
            ctx,
            actor,
            {
              operationKey: `studio:${id}:execute`,
              repositoryUrl: t.repository_url,
              baseRef: t.commit_sha,
              vmId: vm.id,
              grantId: t.grant_id,
              goal: t.goal,
              testCommand: t.test_command,
              maxCalls: 64,
              maxOutputTokens: t.model_output,
            },
            async () => ({
              url: t.repository_url,
              ref: t.base_ref,
              owner: 'pinned',
              name: 'repository',
              sha: t.commit_sha,
            }),
            { id, leaseToken: token },
          );
        await studioEvent(
          ctx,
          id,
          'vm-ready',
          'compute',
          'VM ready · preparing the workspace',
          'Wick confirmed readiness. The executor will verify the sandbox before cloning or running repository code.',
        );
        if (!t.coding_job_id) return;
        const child = (
          await ctx.pool.query('SELECT status,blocked_reason FROM broker_coding_jobs WHERE id=$1', [
            t.coding_job_id,
          ])
        ).rows[0];
        if (child?.status === 'failed') {
          await outcome(ctx, t, 'failed', child.blocked_reason || 'Workspace preparation failed.');
          continue;
        }
        if (child?.status === 'uncertain') {
          await stage(
            ctx,
            t,
            'needs_attention',
            'Workspace setup has an uncertain receipt. No command will be replayed.',
          );
          return;
        }
        const cloned = (
          await ctx.pool.query(
            "SELECT completed_at,result_cipher FROM broker_coding_steps WHERE job_id=$1 AND sequence=0 AND status='completed'",
            [t.coding_job_id],
          )
        ).rows[0];
        if (!cloned?.result_cipher || open(ctx, cloned.result_cipher).state !== 'completed') return;
        await ctx.pool.query(
          'UPDATE broker_studio_tasks SET execution_started_at=COALESCE(execution_started_at,$3) WHERE id=$1 AND lease_token=$2',
          [id, token, cloned.completed_at],
        );
        await studioEvent(
          ctx,
          id,
          'execution-started',
          'execution',
          'Task execution confirmed',
          'A guest receipt confirms the pinned repository is cloned inside the verified sandbox.',
        );
        await stage(ctx, t, 'running');
        continue;
      }
      if (t.status === 'running') {
        const job = (
          await ctx.pool.query('SELECT * FROM broker_coding_jobs WHERE id=$1', [t.coding_job_id])
        ).rows[0];
        if (!job) {
          await outcome(ctx, t, 'failed', 'The execution record is missing.');
          continue;
        }
        const started = (
          await ctx.pool.query(
            `SELECT completed_at FROM broker_coding_steps WHERE job_id=$1 AND sequence=0 AND status='completed'`,
            [job.id],
          )
        ).rows[0];
        if (started && !t.execution_started_at && job.status !== 'failed') {
          await ctx.pool.query(
            'UPDATE broker_studio_tasks SET execution_started_at=$3 WHERE id=$1 AND lease_token=$2',
            [id, token, started.completed_at],
          );
          await studioEvent(
            ctx,
            id,
            'execution-started',
            'execution',
            'Task execution confirmed',
            'A guest command receipt confirms the pinned repository is cloned inside the verified sandbox.',
          );
        }
        if (job.status === 'ready') {
          await stage(ctx, t, 'verifying');
          continue;
        }
        if (['failed', 'stopped'].includes(job.status)) {
          await outcome(
            ctx,
            t,
            'failed',
            job.blocked_reason ?? 'Task execution stopped before verification.',
          );
          continue;
        }
        if (job.status === 'needs_allowance') {
          if (t.purchase_round >= 20) {
            await stage(ctx, t, 'needs_attention', 'Further purchases require owner review.');
            return;
          }
          await ctx.pool.query(
            `UPDATE broker_studio_tasks SET purchase_round=purchase_round+1,model_order_id=NULL,status='model_auction' WHERE id=$1 AND lease_token=$2`,
            [id, token],
          );
          continue;
        }
        if (job.status === 'queued' && (!job.lease_until || new Date(job.lease_until) < new Date()))
          await wakeCoding(ctx, job.id);
        if (job.status === 'uncertain') {
          await stage(
            ctx,
            t,
            'needs_attention',
            'The original execution or model request needs reconciliation. No replacement is sent.',
          );
          return;
        }
        if (job.status === 'paused') {
          if (
            job.blocked_reason?.startsWith('Meta returned an incomplete') &&
            t.action_retries < 2 &&
            job.model_calls < job.max_calls
          ) {
            await ctx.pool.query(
              'UPDATE broker_studio_tasks SET action_retries=action_retries+1 WHERE id=$1 AND lease_token=$2',
              [id, token],
            );
            await controlCoding(ctx, actor, job.id, 'resume');
            await studioEvent(
              ctx,
              id,
              `action-review:${t.action_retries}`,
              'meta',
              'Muse is revising its next action',
              'The earlier response settled. A new attempt uses the existing budget and original deadline.',
            );
            return;
          }
          await stage(
            ctx,
            t,
            'needs_attention',
            job.blocked_reason ?? 'Task execution needs owner review.',
          );
          return;
        }
        return;
      }
      if (t.status === 'verifying') {
        const job = (
          await ctx.pool.query('SELECT tests_passed,status FROM broker_coding_jobs WHERE id=$1', [
            t.coding_job_id,
          ])
        ).rows[0];
        const last = (
          await ctx.pool.query(
            `SELECT payload_cipher,result_cipher FROM broker_coding_steps WHERE job_id=$1 AND status='completed' ORDER BY sequence DESC LIMIT 1`,
            [t.coding_job_id],
          )
        ).rows[0];
        const result = last?.result_cipher ? open(ctx, last.result_cipher) : null;
        if (
          !job.tests_passed ||
          job.status !== 'ready' ||
          !last ||
          open(ctx, last.payload_cipher).action !== 'diff' ||
          result?.result?.exitCode !== 0 ||
          result?.result?.truncated ||
          !result?.result?.output
        ) {
          await stage(
            ctx,
            t,
            'needs_attention',
            'Passing post-edit tests and a complete patch are required before completion.',
          );
          return;
        }
        await ctx.pool.query(
          `UPDATE broker_studio_tasks SET patch_cipher=$3,verified_at=COALESCE(verified_at,clock_timestamp()),result_summary='Changes and passing test receipts are ready for review.' WHERE id=$1 AND lease_token=$2`,
          [id, token, seal(ctx, { output: result.result.output })],
        );
        await studioEvent(
          ctx,
          id,
          'verified',
          'verification',
          'Result verified',
          'Tests passed after the last edit, and a complete patch has been retained.',
        );
        await outcome(ctx, t, 'completed', 'Verified changes are ready for review.');
        continue;
      }
    }
  } catch (error) {
    const t = (
      await ctx.pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1 AND lease_token=$2', [
        id,
        token,
      ])
    ).rows[0];
    if (t)
      await stage(
        ctx,
        t,
        t.outcome
          ? 'cleaning_up'
          : error instanceof HttpError && error.message.includes('remaining task budget')
            ? 'needs_budget'
            : 'needs_attention',
        error instanceof HttpError
          ? error.message
          : 'A task operation requires review. Existing purchases and allocations are retained.',
      );
  } finally {
    await transaction(ctx.pool, async (db) => {
      const row = (
        await db.query(
          `UPDATE broker_studio_tasks SET lease_token=NULL,lease_until=NULL,next_tick_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 AND lease_token=$2 RETURNING status`,
          [id, token],
        )
      ).rows[0];
      if (row && !ended.includes(row.status))
        await enqueue(
          ctx,
          db,
          STUDIO_QUEUE,
          { id },
          ['needs_attention', 'needs_budget'].includes(row.status) ? 30 : 2,
        );
    });
  }
}
export async function maintainStudio(ctx: AppContext) {
  await transaction(ctx.pool, async (db) => {
    const expired = (
      await db.query(
        `UPDATE broker_studio_tasks SET plan_cipher=NULL,plan_input_cipher=NULL,patch_cipher=NULL,artifacts_purged_at=clock_timestamp() WHERE id IN(SELECT id FROM broker_studio_tasks WHERE artifacts_expire_at<=clock_timestamp() AND artifacts_purged_at IS NULL ORDER BY artifacts_expire_at,id LIMIT 16) RETURNING id`,
      )
    ).rows;
    if (expired.length)
      await db.query(
        'UPDATE broker_studio_plan_attempts SET response_cipher=NULL WHERE task_id=ANY($1::uuid[])',
        [expired.map((r) => r.id)],
      );
  });
  const rows = (
    await ctx.pool.query(
      `SELECT id FROM broker_studio_tasks WHERE status NOT IN('completed','failed','stopped') AND next_tick_at<=clock_timestamp() AND(lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_tick_at,id LIMIT 16`,
    )
  ).rows;
  for (const row of rows)
    await ctx.boss.send(STUDIO_QUEUE, { id: row.id }, { retryLimit: 0, expireInSeconds: 240 });
}
