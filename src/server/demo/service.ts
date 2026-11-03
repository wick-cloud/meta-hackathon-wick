import { open } from '../coding/artifacts.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor, CatalogItem } from '../../shared/types.js';
import type { DemoState, DemoRun } from '../../shared/demo.js';
import { HttpError, type AppContext } from '../context.js';
import { transaction, enqueue } from '../marketplace/db.js';
import { iso, type Row } from '../marketplace/data.js';
import { clientOperationKey } from '../operations.js';
import { diskCatalogEligible, diskOptions } from '../disks/service.js';
import { requireFreshManagedRate, fixedQuote, managedPricing } from '../../shared/pricing.js';
import { applyCreditEntry } from '../agreements/credits.js';
import { createGrantInTransaction } from '../inference/grants.js';
import { OFFER_SELECT, offeringOpen, packPrice } from '../inference/market.js';
import { issuePackKey } from '../inference/pack-access.js';
import type { DemoIdentity } from './access.js';
import { demoComputeCatalogs, demoComputeProviders } from './compute.js';
import { demoBidView, demoVmPrice } from './receipt.js';
import { INFERENCE_PROVIDERS, type InferenceProvider } from '../../shared/inference.js';

export const DEMO_QUEUE = 'broker-homepage-demo';
export const DEMO_CATALOG_ID = 'modal:micro:auto';
export const DEMO_LIMITS = {
  durationMinutes: 15,
  cooldownMinutes: 20,
  maxRequests: 2,
  maxOutputTokens: 1024,
  inputTokens: 5000,
  outputTokens: 2048,
} as const;
export const DEMO_RESERVATION_CENTS = 50;
export const DEMO_DAILY_CENTS = 500;
export const DEMO_TOKEN_CENTS = 5;
export const DEMO_VM_CENTS = 25;
/**
 * Muse token sellers whose qualified routes can serve this demo's small pack: the 1,024
 * output cap, the session window and (live) request-sized input accounting. Every one
 * of them is invited to the token auction; the lowest qualified bid wins.
 */
export function demoTokenProviders(ctx: AppContext): InferenceProvider[] {
  const until = Date.now() + 18 * 60_000;
  return INFERENCE_PROVIDERS.filter((provider) => {
    const route = ctx.inference?.routes.get(provider);
    return Boolean(
      route?.qualified &&
      route.validUntil >= until &&
      route.maximumOutputTokens >= DEMO_LIMITS.maxOutputTokens &&
      (route.minimumOutputTokens ?? 1) <= DEMO_LIMITS.maxOutputTokens &&
      (ctx.wick.mode !== 'real' || route.inputAccounting === 'utf8-bytes-v1'),
    );
  });
}
export function demoActor(row: Row): Actor {
  return { id: row.buyer_id, email: '', name: 'Demo visitor', role: 'buyer' };
}
export async function demoEvent(db: PoolClient, id: string, kind: string) {
  await db.query(
    'INSERT INTO broker_demo_events(run_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [id, kind],
  );
}
export function demoModeAllowed(ctx: AppContext): boolean {
  return Boolean(
    ctx.config.liveDemoEnabled &&
    ((ctx.wick.mode === 'real' && ctx.inference?.mode === 'real') ||
      (ctx.config.nodeEnv !== 'production' &&
        ctx.config.liveDemoAllowFixtures &&
        ctx.wick.mode === 'fixture' &&
        ctx.inference?.mode === 'fixture')),
  );
}
/** Read-only checks; admission and the existing marketplaces recheck all binding constraints. */
export async function demoPrerequisites(
  ctx: AppContext,
): Promise<{ reason: string | null; catalog?: CatalogItem }> {
  if (!ctx.config.liveDemoEnabled) return { reason: 'The live demo is not enabled.' };
  if (!demoModeAllowed(ctx))
    return { reason: 'The live demo requires real qualified compute and inference.' };
  if (!ctx.wick.runCommand || !ctx.wick.drives || !ctx.config.disksEnabled)
    return { reason: 'The demo terminal and private disk are not ready.' };
  const catalogs = await demoComputeCatalogs(ctx, ctx.pool);
  const catalog = catalogs.find((item) => item.id === DEMO_CATALOG_ID);
  if (
    !catalog ||
    catalog.provider !== 'modal' ||
    catalog.profile !== 'micro' ||
    catalog.region !== 'auto' ||
    catalog.gpu ||
    !catalog.durationMinutes.includes(15) ||
    !diskCatalogEligible(ctx, catalog)
  )
    return { reason: 'The qualified Modal Micro disk configuration is unavailable.' };
  if (!(await diskOptions(ctx)).enabled)
    return { reason: 'Native disk qualification is incomplete.' };
  if (ctx.wick.mode === 'real') {
    try {
      requireFreshManagedRate(catalog);
      if (fixedQuote(managedPricing(catalog), 15).totalPriceCents > DEMO_VM_CENTS)
        return { reason: 'The Modal Micro price is above the demo limit.' };
    } catch {
      return { reason: 'The Modal Micro price needs a fresh qualification check.' };
    }
  }
  try {
    await demoComputeProviders(
      ctx,
      ctx.pool,
      catalogs.filter((item) => item.cpu >= catalog.cpu && item.memoryGb >= catalog.memoryGb),
    );
  } catch {
    return {
      reason: 'Modal and at least one rival Micro offer are required within the demo limit.',
    };
  }
  const sellers = ctx.inference?.enabled ? demoTokenProviders(ctx) : [];
  if (!sellers.length) return { reason: 'Muse token qualification is unavailable.' };
  const offers = (
    await ctx.pool.query(`${OFFER_SELECT} WHERE r.provider=ANY($1::text[])`, [sellers])
  ).rows;
  const now = new Date();
  if (
    !offers.some(
      (offer) =>
        offer.qualified &&
        !offer.quarantined_at &&
        offer.fingerprint === ctx.inference!.routes.get(offer.provider)?.fingerprint &&
        offer.auto_bid &&
        offeringOpen(offer, now) &&
        Number(offer.outstanding_input) + DEMO_LIMITS.inputTokens <=
          Number(offer.max_outstanding_input) &&
        Number(offer.outstanding_output) + DEMO_LIMITS.outputTokens <=
          Number(offer.max_outstanding_output) &&
        packPrice(offer, DEMO_LIMITS.inputTokens, DEMO_LIMITS.outputTokens).priceCents <=
          DEMO_TOKEN_CENTS,
    )
  )
    return { reason: 'No Muse token seller has a qualified offer within the demo limit.' };
  return { reason: null, catalog };
}

async function visitorRun(
  ctx: AppContext,
  identity: DemoIdentity | null,
): Promise<Row | undefined> {
  if (!identity) return undefined;
  return (
    await ctx.pool.query(
      `SELECT d.* FROM broker_demo_runs d JOIN broker_demo_visitors v ON v.id=d.visitor_id
    WHERE v.secret_digest=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
      [identity.visitorDigest],
    )
  ).rows[0];
}
async function gate(
  db: PoolClient | AppContext['pool'],
  identity: DemoIdentity | null,
  ipDigest?: string,
) {
  const state = (
    await db.query(
      `SELECT
      (SELECT count(*)::int FROM broker_demo_runs WHERE ended_at IS NULL) active,
      EXISTS(SELECT 1 FROM broker_demo_runs d LEFT JOIN broker_demo_visitors v ON v.id=d.visitor_id
        WHERE (v.secret_digest=$1 OR d.ip_digest=$2) AND d.ended_at IS NULL) own_active,
      (SELECT max(d.cooldown_until) FROM broker_demo_runs d LEFT JOIN broker_demo_visitors v ON v.id=d.visitor_id
        WHERE v.secret_digest=$1 OR d.ip_digest=$2) cooldown_until,
      (SELECT reserved_cents FROM broker_demo_days WHERE day=(clock_timestamp() AT TIME ZONE 'America/New_York')::date) reserved_cents,
      clock_timestamp() at`,
      [identity?.visitorDigest ?? null, identity?.ipDigest ?? ipDigest ?? null],
    )
  ).rows[0];
  const reason = state.own_active
    ? 'A demo is already active for this browser or connection.'
    : state.cooldown_until && state.cooldown_until > state.at
      ? 'Your next demo is available after the cooldown.'
      : state.active >= 2
        ? 'Both demo slots are in use. Please try again after a demo ends.'
        : Number(state.reserved_cents ?? 0) + DEMO_RESERVATION_CENTS > DEMO_DAILY_CENTS
          ? 'Today’s demo budget is reserved. Please return after midnight Eastern time.'
          : null;
  return { ...state, reason };
}

export async function startDemo(
  ctx: AppContext,
  identity: DemoIdentity,
  operationKey: string,
  kind: 'terminal' | 'studio' = 'terminal',
  demoName = '',
): Promise<Row> {
  demoName = demoName.trim();
  if (
    demoName.length > 40 ||
    !/^[\p{L}\p{N} .'-]*$/u.test(demoName) ||
    (kind !== 'studio' && demoName)
  )
    throw new HttpError(
      400,
      'Enter a name of up to 40 letters, numbers, spaces, periods, apostrophes or hyphens.',
    );
  clientOperationKey(operationKey, true);
  if (!demoModeAllowed(ctx)) throw new HttpError(409, 'The live demo is unavailable.');
  // An accepted retry is read-only even if a provider subsequently becomes unavailable.
  const prior = (
    await ctx.pool.query(
      `SELECT d.* FROM broker_demo_runs d JOIN broker_demo_visitors v ON v.id=d.visitor_id
    WHERE v.secret_digest=$1 AND d.operation_key=$2`,
      [identity.visitorDigest, operationKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.kind !== kind || prior.demo_name !== demoName)
      throw new HttpError(409, 'This operation key belongs to a different demo kind.');
    return prior;
  }
  const prerequisites = await demoPrerequisites(ctx);
  if (prerequisites.reason) throw new HttpError(409, prerequisites.reason);
  return transaction(ctx.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('homepage-demo-admission'))");
    const existing = (
      await db.query(
        `SELECT d.* FROM broker_demo_runs d JOIN broker_demo_visitors v ON v.id=d.visitor_id
      WHERE v.secret_digest=$1 AND d.operation_key=$2`,
        [identity.visitorDigest, operationKey],
      )
    ).rows[0];
    if (existing) {
      if (existing.kind !== kind || existing.demo_name !== demoName)
        throw new HttpError(409, 'This operation key belongs to a different demo kind.');
      return existing;
    }
    const eligibility = await gate(db, identity);
    if (eligibility.reason)
      throw Object.assign(new HttpError(429, eligibility.reason), { retryAfter: 60 });
    let visitor = (
      await db.query('SELECT * FROM broker_demo_visitors WHERE secret_digest=$1 FOR UPDATE', [
        identity.visitorDigest,
      ])
    ).rows[0];
    if (!visitor) {
      const buyerId = randomUUID(),
        id = randomUUID();
      await db.query(
        'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,\'buyer\',false)',
        [buyerId, `guest-${buyerId}@demo.invalid`, 'Demo visitor'],
      );
      visitor = (
        await db.query(
          'INSERT INTO broker_demo_visitors(id,secret_digest,buyer_id) VALUES($1,$2,$3) RETURNING *',
          [id, identity.visitorDigest, buyerId],
        )
      ).rows[0];
    }
    const day = (
      await db.query(`INSERT INTO broker_demo_days(day,reserved_cents) VALUES((clock_timestamp() AT TIME ZONE 'America/New_York')::date,50)
      ON CONFLICT(day) DO UPDATE SET reserved_cents=broker_demo_days.reserved_cents+50
      WHERE broker_demo_days.reserved_cents+50<=500 RETURNING day`)
    ).rows[0];
    if (!day) throw new HttpError(429, 'Today’s demo budget is reserved.');
    const id = randomUUID(),
      actor = demoActor(visitor);
    await applyCreditEntry(db, actor.id, {
      operationKey: `demo:${id}:credit`,
      kind: 'grant',
      balanceDeltaCents: 5,
      reservedDeltaCents: 0,
      description: 'Bounded homepage demo token credit',
    });
    const expiresAt = new Date(eligibility.at.getTime() + 18 * 60_000);
    const grant = await createGrantInTransaction(ctx, db, actor, {
      operationKey: `demo:${id}:grant`,
      name: 'Homepage demo',
      budgetCents: 5,
      maxPurchaseCents: 5,
      allowedProviders: demoTokenProviders(ctx),
      allowInstant: false,
      expiresAt: expiresAt.toISOString(),
    });
    const run = (
      await db.query(
        `INSERT INTO broker_demo_runs(id,visitor_id,buyer_id,ip_digest,operation_key,source_mode,budget_day,grant_id,expires_at,kind,demo_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          visitor.id,
          visitor.buyer_id,
          identity.ipDigest,
          operationKey,
          ctx.wick.mode,
          day.day,
          grant.id,
          expiresAt,
          kind,
          demoName,
        ],
      )
    ).rows[0];
    if (kind === 'studio')
      await db.query('INSERT INTO broker_demo_studio(run_id) VALUES($1)', [id]);
    await demoEvent(db, id, 'admitted');
    await enqueue(ctx, db, DEMO_QUEUE, { id });
    return run;
  });
}

export async function endDemo(ctx: AppContext, identity: DemoIdentity, operationKey: string) {
  clientOperationKey(operationKey, true);
  await transaction(ctx.pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `demo-actions:${identity.visitorDigest}`,
    ]);
    const previous = await db.query(
      `SELECT 1 FROM broker_demo_mutations m JOIN broker_demo_visitors v ON v.id=m.visitor_id
      WHERE v.secret_digest=$1 AND m.operation='end' AND m.operation_key=$2`,
      [identity.visitorDigest, operationKey],
    );
    if (previous.rowCount) return;
    const run = (
      await db.query(
        `SELECT d.* FROM broker_demo_runs d JOIN broker_demo_visitors v ON v.id=d.visitor_id
      WHERE v.secret_digest=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 1 FOR UPDATE OF d`,
        [identity.visitorDigest],
      )
    ).rows[0];
    if (!run) return;
    await db.query(
      "INSERT INTO broker_demo_mutations(visitor_id,operation,operation_key,run_id) VALUES($1,'end',$2,$3)",
      [run.visitor_id, operationKey, run.id],
    );
    if (run.ended_at) return;
    await db.query(
      "UPDATE broker_demo_runs SET stop_requested=true,status='ending',message='Closing tokens and cleaning up your VM and disk.',updated_at=clock_timestamp() WHERE id=$1",
      [run.id],
    );
    await demoEvent(db, run.id, 'end_requested');
    await enqueue(ctx, db, DEMO_QUEUE, { id: run.id });
  });
}

export async function demoKey(ctx: AppContext, identity: DemoIdentity, operationKey: string) {
  clientOperationKey(operationKey, true);
  const row = await transaction(ctx.pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `demo-actions:${identity.visitorDigest}`,
    ]);
    const previous = (
      await db.query(
        `SELECT m.run_id FROM broker_demo_mutations m JOIN broker_demo_visitors v ON v.id=m.visitor_id
      WHERE v.secret_digest=$1 AND m.operation='key' AND m.operation_key=$2`,
        [identity.visitorDigest, operationKey],
      )
    ).rows[0];
    const candidate = previous
      ? (await db.query('SELECT * FROM broker_demo_runs WHERE id=$1', [previous.run_id])).rows[0]
      : (
          await db.query(
            `SELECT d.* FROM broker_demo_runs d JOIN broker_demo_visitors v ON v.id=d.visitor_id
        WHERE v.secret_digest=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
            [identity.visitorDigest],
          )
        ).rows[0];
    if (!candidate) throw new HttpError(409, 'No ready demo was found.');
    if (candidate.kind === 'studio')
      throw new HttpError(403, 'The guided Studio run owns this demo’s token allowance.');
    // Same grant → demo order as the inference gateway. Reserve a key attempt before
    // issuance so concurrent rotations cannot exceed the five-key lifetime limit.
    await db.query('SELECT id FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [
      candidate.grant_id,
    ]);
    const selected = (
      await db.query(
        `SELECT d.*,
      EXISTS(SELECT 1 FROM broker_vms v WHERE v.id=d.vm_id AND v.buyer_id=d.buyer_id
        AND v.status='running' AND v.expires_at>clock_timestamp() AND v.cleanup_confirmed_at IS NULL) vm_active
      FROM broker_demo_runs d WHERE d.id=$1 FOR UPDATE OF d`,
        [candidate.id],
      )
    ).rows[0];
    if (
      !ctx.config.liveDemoEnabled ||
      !selected ||
      selected.status !== 'ready' ||
      selected.stop_requested ||
      selected.ended_at ||
      !selected.pack_id ||
      new Date(selected.expires_at).getTime() <= Date.now()
    )
      throw new HttpError(409, 'Wait for your demo terminal and token batch to be ready.');
    if (!selected.vm_active || selected.source_mode !== ctx.wick.mode)
      throw new HttpError(409, 'Your demo VM is no longer available.');
    const issued = (
      await db.query(
        "SELECT count(*)::int n FROM broker_demo_mutations WHERE run_id=$1 AND operation='key'",
        [selected.id],
      )
    ).rows[0].n;
    if (!previous && issued >= 5)
      throw new HttpError(
        429,
        'This demo has reached its five key issuance attempts. Use the last key you copied.',
      );
    if (!previous)
      await db.query(
        "INSERT INTO broker_demo_mutations(visitor_id,operation,operation_key,run_id) VALUES($1,'key',$2,$3)",
        [selected.visitor_id, operationKey, selected.id],
      );
    return selected;
  });
  const result = await issuePackKey(ctx, demoActor(row), row.pack_id, {
    operationKey,
    name: 'Homepage demo batch',
  });
  // Gateway rechecks the run and VM under its transaction lock even if End races key issuance.
  await ctx.pool.query('UPDATE broker_demo_runs SET key_issued_at=clock_timestamp() WHERE id=$1', [
    row.id,
  ]);
  return result;
}

export async function demoState(
  ctx: AppContext,
  identity: DemoIdentity | null,
  ipDigest?: string,
): Promise<DemoState> {
  if (!ctx.config.liveDemoEnabled && !identity)
    return {
      enabled: false,
      available: false,
      reason: 'The live demo is not enabled.',
      mode: ctx.wick.mode,
      serverTime: new Date().toISOString(),
      cooldownUntil: null,
      limits: DEMO_LIMITS,
      run: null,
    };
  const [prerequisites, state, row] = await Promise.all([
    demoPrerequisites(ctx),
    gate(ctx.pool, identity, ipDigest),
    visitorRun(ctx, identity),
  ]);
  let run: DemoRun | null = null;
  if (row) {
    const [requests, vms, orders, packs, disks, vmBids, tokenBids, calls, keys, studioRows] =
      await Promise.all([
        ctx.pool.query('SELECT * FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
          row.request_id,
          row.buyer_id,
        ]),
        ctx.pool.query('SELECT * FROM broker_vms WHERE id=$1 AND buyer_id=$2', [
          row.vm_id,
          row.buyer_id,
        ]),
        ctx.pool.query('SELECT * FROM broker_token_orders WHERE id=$1 AND buyer_id=$2', [
          row.token_order_id,
          row.buyer_id,
        ]),
        ctx.pool.query('SELECT * FROM broker_token_packs WHERE id=$1 AND buyer_id=$2', [
          row.pack_id,
          row.buyer_id,
        ]),
        ctx.pool.query('SELECT id,name,status FROM broker_disks WHERE id=$1 AND buyer_id=$2', [
          row.disk_id,
          row.buyer_id,
        ]),
        ctx.pool.query(
          'SELECT total_price_cents,offering_snapshot,created_at FROM broker_bids WHERE request_id=$1 ORDER BY created_at,id LIMIT 8',
          [row.request_id],
        ),
        ctx.pool.query(
          'SELECT provider,price_cents,created_at FROM broker_token_bids WHERE order_id=$1 ORDER BY created_at,id LIMIT 2',
          [row.token_order_id],
        ),
        ctx.pool.query('SELECT count(*)::int n FROM broker_inference_requests WHERE grant_id=$1', [
          row.grant_id,
        ]),
        ctx.pool.query(
          "SELECT count(*)::int n FROM broker_demo_mutations WHERE run_id=$1 AND operation='key'",
          [row.id],
        ),
        ctx.pool.query('SELECT * FROM broker_demo_studio WHERE run_id=$1', [row.id]),
      ]);
    const request = requests.rows[0],
      vm = vms.rows[0],
      order = orders.rows[0],
      pack = packs.rows[0];
    const live =
      ctx.config.liveDemoEnabled &&
      row.source_mode === ctx.wick.mode &&
      row.status === 'ready' &&
      !row.stop_requested &&
      !row.ended_at &&
      new Date(row.expires_at) > state.at &&
      vm?.status === 'running' &&
      !vm.cleanup_confirmed_at &&
      new Date(vm.expires_at) > state.at;
    const studio = studioRows.rows[0];
    const studioSource = studio?.source_cipher ? open(ctx, studio.source_cipher) : null;
    const studioResult = studio?.result_cipher ? open(ctx, studio.result_cipher) : null;
    run = {
      id: row.id,
      kind: row.kind,
      demoName: row.demo_name,
      studio: studio
        ? {
            status: studio.status,
            filename: 'hello_world.py',
            source: studioSource?.source ?? null,
            stdout: studioResult?.stdout ?? null,
            exitCode: studioResult?.exitCode ?? null,
            requestsUsed: calls.rows[0].n,
            verifiedAt: iso(studio.verified_at),
          }
        : null,
      status: row.status,
      message: row.message,
      createdAt: iso(row.created_at)!,
      expiresAt: iso(row.expires_at),
      endedAt: iso(row.ended_at),
      vm: request
        ? {
            id: vm?.id ?? null,
            status: vm?.status ?? request.status,
            provider: 'modal',
            catalogId: DEMO_CATALOG_ID,
            terminalPath: live ? `/api/vms/${vm.id}/terminal` : null,
            ...demoVmPrice(vm),
            auctionEndsAt: iso(request.closes_at),
            bids: vmBids.rows.map(demoBidView),
            cleanupConfirmed: Boolean(vm?.cleanup_confirmed_at),
          }
        : null,
      tokens: order
        ? {
            orderId: order.id,
            status: order.status,
            provider: order.provider,
            packId: pack?.id ?? null,
            inputTokens: 5000,
            outputTokens: 2048,
            availableInput: live ? Number(pack?.available_input ?? 0) : 0,
            availableOutput: live ? Number(pack?.available_output ?? 0) : 0,
            requestsUsed: calls.rows[0].n,
            priceCents: order.price_cents === null ? null : Number(order.price_cents),
            auctionEndsAt: iso(order.closes_at),
            bids: tokenBids.rows.map((b) => ({
              provider: b.provider,
              priceCents: Number(b.price_cents),
              acceptedAt: iso(b.created_at)!,
            })),
          }
        : null,
      disk:
        row.reusable_disk && row.ended_at
          ? { id: row.disk_id, name: 'Dedicated demo disk', status: 'retained' }
          : (disks.rows[0] ?? null),
      canIssueKey: Boolean(
        row.kind !== 'studio' &&
        live &&
        pack?.status === 'active' &&
        calls.rows[0].n < 2 &&
        keys.rows[0].n < 5,
      ),
      keyIssued: Boolean(row.key_issued_at),
    };
  }
  return {
    enabled: Boolean(ctx.config.liveDemoEnabled),
    available: !prerequisites.reason && !state.reason,
    reason: prerequisites.reason ?? state.reason,
    mode: ctx.wick.mode,
    serverTime: iso(state.at)!,
    cooldownUntil: iso(state.cooldown_until),
    limits: DEMO_LIMITS,
    run,
  };
}

export { reconcileDemo, maintainDemo } from './worker.js';
