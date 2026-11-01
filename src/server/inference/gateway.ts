import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import {
  INFERENCE_MODEL_ID,
  type InferenceCompletion,
  type InferenceProvider,
} from '../../shared/inference.js';
import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import type { Row } from '../marketplace/data.js';
import { operationFingerprint } from '../operations.js';
import {
  activeMode,
  assertRoute,
  authority,
  clock,
  event,
  failure,
  integer,
  lockedGrant,
  operationSchema,
  receiptView,
  runtime,
} from './data.js';
import {
  inputReservation,
  InferenceUpstreamError,
  MIN_TASK_OUTPUT_RESERVATION,
  type AdapterResult,
} from './runtime.js';
import { retirePackLocked } from './market.js';
import { studioAuthority } from '../coding/studio-budget.js';
import { seal } from '../coding/artifacts.js';

function inferenceFailure(code: string, id: string, message: string): never {
  try {
    failure(409, code, message);
  } catch (error) {
    throw Object.assign(error as Error, { inferenceRequestId: id });
  }
}

export const completionSchema = z
  .object({
    operationKey: operationSchema,
    model: z.literal(INFERENCE_MODEL_ID),
    messages: z
      .array(
        z
          .object({ role: z.enum(['system', 'user', 'assistant']), content: z.string().max(60000) })
          .strict(),
      )
      .min(1)
      .max(64),
    max_tokens: integer(8192),
    stream: z.literal(false).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();
function requireGrantKey(actor: Actor) {
  if (!actor.apiKey?.grantId)
    failure(403, 'grant_key_required', 'Inference requires a grant-bound agent API key.');
  return actor.apiKey.grantId;
}
/** Locks grant → routes (sorted) → pack → request, also used for recovery and operator settlement. */
async function lockRequest(db: PoolClient, meta: Row) {
  const grant = (
    await db.query('SELECT * FROM broker_inference_grants WHERE id=$1 FOR UPDATE', [meta.grant_id])
  ).rows[0];
  await db.query('SELECT provider FROM broker_inference_routes ORDER BY provider FOR UPDATE');
  const pack = (
    await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [meta.pack_id])
  ).rows[0];
  const request = (
    await db.query('SELECT * FROM broker_inference_requests WHERE id=$1 FOR UPDATE', [meta.id])
  ).rows[0];
  return { grant, pack, request };
}
async function settleLocked(
  db: PoolClient,
  pack: Row,
  request: Row,
  inputTokens: number,
  outputTokens: number,
  rejected: boolean,
  failureCode: string | null,
  providerId: string | null,
  evidence?: string,
  actorId?: string,
) {
  if (['settled', 'rejected'].includes(request.status)) return;
  if (inputTokens > request.reserved_input || outputTokens > request.reserved_output)
    failure(
      409,
      'usage_exceeds_reservation',
      'Usage exceeds certified bounds. Keep the reservation and resolve the accounting contract violation separately.',
    );
  const spareInput = request.reserved_input - inputTokens,
    spareOutput = request.reserved_output - outputTokens;
  const retiring = pack.status !== 'active';
  await db.query(
    `UPDATE broker_token_packs SET held_input=held_input-$2,held_output=held_output-$3,
    consumed_input=consumed_input+$4,consumed_output=consumed_output+$5,
    available_input=available_input+$6,available_output=available_output+$7,
    retired_input=retired_input+$8,retired_output=retired_output+$9 WHERE id=$1`,
    [
      pack.id,
      request.reserved_input,
      request.reserved_output,
      inputTokens,
      outputTokens,
      retiring ? 0 : spareInput,
      retiring ? 0 : spareOutput,
      retiring ? spareInput : 0,
      retiring ? spareOutput : 0,
    ],
  );
  await db.query(
    `UPDATE broker_inference_routes SET held_calls=held_calls-1,outstanding_input=outstanding_input-$2,outstanding_output=outstanding_output-$3 WHERE provider=$1`,
    [
      pack.provider,
      retiring ? request.reserved_input : inputTokens,
      retiring ? request.reserved_output : outputTokens,
    ],
  );
  await db.query(
    `UPDATE broker_inference_requests SET status=$2,input_tokens=$3,output_tokens=$4,failure_code=$5,provider_request_id=$6,
    usage_evidence=$7,resolution_actor=$8,completed_at=clock_timestamp() WHERE id=$1`,
    [
      request.id,
      rejected ? 'rejected' : 'settled',
      inputTokens,
      outputTokens,
      failureCode,
      providerId,
      evidence ?? null,
      actorId ?? null,
    ],
  );
  await event(
    db,
    request.grant_id,
    `usage:${request.id}`,
    rejected ? 'usage_released' : 'usage_settled',
    request.id,
    actorId,
    { inputTokens, outputTokens, ...(evidence ? { evidence } : {}) },
  );
  const updated = (await db.query('SELECT * FROM broker_token_packs WHERE id=$1', [pack.id]))
    .rows[0];
  if (retiring) await retirePackLocked(db, updated, pack.retirement_reason);
  else if (
    !Number(updated.held_input) &&
    !Number(updated.held_output) &&
    (Number(updated.available_input) < Number(pack.snapshot.minimumInputReservation) ||
      !Number(updated.available_output))
  )
    await retirePackLocked(db, updated, 'quota_exhausted');
  await db.query(
    `UPDATE broker_inference_grants g SET status='closed' WHERE g.id=$1 AND g.status='closing'
    AND held_cents=0 AND NOT EXISTS(SELECT 1 FROM broker_inference_requests WHERE grant_id=g.id AND status NOT IN('settled','rejected'))`,
    [request.grant_id],
  );
}
export async function settleRequest(
  ctx: AppContext,
  id: string,
  result: AdapterResult | null,
  code?: string,
) {
  const meta = (
    await ctx.pool.query('SELECT id,grant_id,pack_id FROM broker_inference_requests WHERE id=$1', [
      id,
    ])
  ).rows[0];
  if (!meta) return;
  await transaction(ctx.pool, async (db) => {
    const { pack, request } = await lockRequest(db, meta);
    if (['settled', 'rejected'].includes(request.status)) return;
    if (
      result &&
      (result.inputTokens > request.reserved_input || result.outputTokens > request.reserved_output)
    ) {
      await db.query(
        `UPDATE broker_inference_routes SET quarantined_at=COALESCE(quarantined_at,clock_timestamp()),qualified=false,blocked_reason='Certified token bounds were exceeded.' WHERE provider=$1`,
        [pack.provider],
      );
      await db.query(
        `UPDATE broker_inference_requests SET status='needs_reconciliation',failure_code='accounting_bound_exceeded',provider_request_id=$2 WHERE id=$1`,
        [id, result.id],
      );
      await event(
        db,
        request.grant_id,
        `quarantine:${id}`,
        'accounting_quarantine',
        id,
        undefined,
        { reportedInputTokens: result.inputTokens, reportedOutputTokens: result.outputTokens },
      );
      return;
    }
    await settleLocked(
      db,
      pack,
      request,
      result?.inputTokens ?? 0,
      result?.outputTokens ?? 0,
      !result,
      code ?? null,
      result?.id ?? null,
    );
    if (result && request.source_task_id)
      // Preserve the response in the same commit as usage settlement. Recovery
      // reads it; it never repeats a paid provider POST after losing its result.
      await db.query(
        `UPDATE broker_studio_plan_attempts a SET response_cipher=$2,finish_reason=$3,failure_code=NULL,completed_at=clock_timestamp()
         FROM broker_studio_tasks t WHERE a.request_id=$1 AND t.id=a.task_id
         AND t.artifacts_expire_at>clock_timestamp() AND t.artifacts_purged_at IS NULL`,
        [
          request.id,
          seal(ctx, {
            content: result.content.length <= 16000 ? result.content : '',
            oversized: result.content.length > 16000,
          }),
          result.finishReason,
        ],
      );
    if (result?.platformOutputTokens)
      await event(
        db,
        request.grant_id,
        `platform-output:${request.id}`,
        'platform_output_absorbed',
        request.id,
        undefined,
        {
          provider: pack.provider,
          outputTokens: result.platformOutputTokens,
          policy: 'modal-reasoning-one-token',
        },
      );
  });
}
export async function markUnknown(ctx: AppContext, id: string, error: InferenceUpstreamError) {
  await transaction(ctx.pool, async (db) => {
    const meta = (
      await db.query('SELECT id,grant_id,pack_id FROM broker_inference_requests WHERE id=$1', [id])
    ).rows[0];
    if (!meta) return;
    const { request } = await lockRequest(db, meta);
    if (request.status !== 'dispatching') return;
    await db.query(
      `UPDATE broker_inference_requests SET status='outcome_unknown',failure_code=$2,provider_request_id=$3 WHERE id=$1`,
      [id, error.code, error.providerRequestId ?? null],
    );
    if (
      [
        'missing_authoritative_usage',
        'inconsistent_usage',
        'invalid_response',
        'response_too_large',
      ].includes(error.code)
    )
      await db.query(
        `UPDATE broker_inference_routes SET quarantined_at=COALESCE(quarantined_at,clock_timestamp()),qualified=false,blocked_reason='Authoritative provider usage could not be verified.' WHERE provider=$1`,
        [request.provider],
      );
  });
}
export async function complete(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
): Promise<InferenceCompletion> {
  return completeInternal(ctx, actor, raw);
}
/** Internal durable-job authority. Never exposed through the public completions route. */
export async function completeCodingJob(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
  jobId: string,
  leaseToken: string,
) {
  if (actor.apiKey || actor.role !== 'buyer')
    failure(403, 'owner_required', 'Coding requires owner authority.');
  const job = (
    await ctx.pool.query('SELECT grant_id FROM broker_coding_jobs WHERE id=$1 AND buyer_id=$2', [
      jobId,
      actor.id,
    ])
  ).rows[0];
  if (!job) failure(404, 'not_found', 'Coding job not found.');
  return completeInternal(ctx, actor, raw, {
    kind: 'coding',
    id: jobId,
    grantId: job.grant_id,
    leaseToken,
  });
}
/** Studio planning uses the same prepaid gateway, before a VM exists. */
export async function completeStudioTask(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
  taskId: string,
  leaseToken: string,
  planAttempt = 0,
) {
  if (actor.apiKey || actor.role !== 'buyer')
    failure(403, 'owner_required', 'Studio requires owner authority.');
  const task = (
    await ctx.pool.query('SELECT grant_id FROM broker_studio_tasks WHERE id=$1 AND buyer_id=$2', [
      taskId,
      actor.id,
    ])
  ).rows[0];
  if (!task) failure(404, 'not_found', 'Task not found.');
  return completeInternal(ctx, actor, raw, {
    kind: 'studio',
    id: taskId,
    grantId: task.grant_id,
    leaseToken,
    planAttempt,
  });
}
async function codingAuthority(
  db: PoolClient,
  source: { id: string; leaseToken: string },
  actor: Actor,
) {
  const row = (
    await db.query(
      `SELECT j.id FROM broker_coding_jobs j JOIN broker_vms v ON v.id=j.vm_id
    WHERE j.id=$1 AND j.buyer_id=$2 AND j.lease_token=$3 AND j.lease_until>clock_timestamp()
    AND j.status='running' AND j.requested_action IS NULL AND j.deadline_at>clock_timestamp()
    AND (j.studio_task_id IS NULL OR EXISTS(SELECT 1 FROM broker_studio_tasks t WHERE t.id=j.studio_task_id AND NOT t.stop_requested AND t.outcome IS NULL AND t.deadline_at>clock_timestamp()))
    AND v.status='running' AND v.expires_at>clock_timestamp() AND v.environment_id=j.environment_id
    FOR SHARE OF j,v`,
      [source.id, actor.id, source.leaseToken],
    )
  ).rows[0];
  if (!row)
    failure(
      409,
      'coding_authority_changed',
      'The coding job was paused, stopped, expired, or lost its execution lease.',
    );
}
async function completeInternal(
  ctx: AppContext,
  actor: Actor,
  raw: unknown,
  source?: {
    kind: 'coding' | 'studio';
    id: string;
    grantId: string;
    leaseToken: string;
    planAttempt?: number;
  },
): Promise<InferenceCompletion> {
  const { operationKey, ...input } = completionSchema.parse(raw),
    grantId = source?.grantId ?? requireGrantKey(actor),
    rt = runtime(ctx);
  // Public request parameters remain unchanged; task prompts choose their own bounded reasoning policy.
  const fingerprint = operationFingerprint(input);
  const reservation = await transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'inference:use');
    const grant = await lockedGrant(db, actor, grantId);
    if (source) {
      if (source.kind === 'studio') {
        const task = await studioAuthority(db, source, actor);
        if (task.plan_attempt !== source.planAttempt)
          failure(409, 'planning_attempt_changed', 'The planning attempt changed.');
      } else await codingAuthority(db, source, actor);
    }
    const prior = (
      await db.query(
        'SELECT * FROM broker_inference_requests WHERE grant_id=$1 AND operation_key=$2',
        [grantId, operationKey],
      )
    ).rows[0];
    if (prior) {
      if (actor.apiKey?.packId && prior.pack_id !== actor.apiKey.packId)
        failure(403, 'pack_scope', 'This request belongs to another token batch.');
      if (prior.input_fingerprint !== fingerprint)
        failure(
          409,
          'operation_conflict',
          'This operation key belongs to a different inference request.',
        );
      inferenceFailure(
        prior.status === 'settled'
          ? 'completed_without_result'
          : prior.status === 'rejected'
            ? 'inference_rejected'
            : 'inference_pending',
        prior.id,
        `Request ${prior.id} is ${prior.status}. Read /api/inference/requests/${prior.id}; it will never be automatically resent.`,
      );
    }
    if (grant.status !== 'active' || new Date(grant.expires_at) <= (await clock(db)))
      failure(409, 'grant_closed', 'The grant has closed or expired.');
    activeMode(ctx, grant);
    const routes = (
      await db.query('SELECT * FROM broker_inference_routes ORDER BY provider FOR UPDATE')
    ).rows;
    if (routes.reduce((sum, r) => sum + r.held_calls, 0) >= 4)
      failure(
        429,
        'inference_busy',
        'Inference capacity is currently occupied, including unresolved requests.',
      );
    const pending = (
      await db.query(
        `SELECT 1 FROM broker_inference_requests WHERE grant_id=$1 AND status NOT IN('settled','rejected') LIMIT 2`,
        [grantId],
      )
    ).rowCount;
    if ((pending ?? 0) >= 2)
      failure(429, 'grant_busy', 'This grant has two active or unresolved inference requests.');
    const packs = (
      await db.query(
        `SELECT * FROM broker_token_packs WHERE grant_id=$1 AND status='active' AND expires_at>clock_timestamp() AND($2::uuid IS NULL OR id=$2)
      ORDER BY expires_at,id LIMIT 10 FOR UPDATE`,
        [grantId, actor.apiKey?.packId ?? null],
      )
    ).rows;
    for (const pack of packs) {
      const route = routes.find((r) => r.provider === pack.provider);
      const native = rt.routes.get(pack.provider as InferenceProvider);
      if (
        !route ||
        !native ||
        !grant.allowed_providers.includes(pack.provider) ||
        pack.source_mode !== grant.source_mode ||
        pack.route_fingerprint !== native.fingerprint ||
        route.held_calls >= route.max_concurrent
      )
        continue;
      try {
        await assertRoute(ctx, route, grant.source_mode);
      } catch {
        continue;
      }
      const inputBound = inputReservation(native, input);
      const outputBound = source
        ? Math.min(input.max_tokens, Number(pack.available_output))
        : input.max_tokens;
      if (
        input.max_tokens > native.maximumOutputTokens ||
        Number(pack.available_input) < inputBound ||
        Number(pack.available_output) < outputBound ||
        outputBound <
          Math.min(input.max_tokens, source ? MIN_TASK_OUTPUT_RESERVATION : input.max_tokens)
      )
        continue;
      const now = await clock(db);
      if (new Date(grant.expires_at) <= now || new Date(pack.expires_at) <= now) break;
      await db.query(
        'UPDATE broker_token_packs SET available_input=available_input-$2,available_output=available_output-$3,held_input=held_input+$2,held_output=held_output+$3 WHERE id=$1',
        [pack.id, inputBound, outputBound],
      );
      await db.query(
        'UPDATE broker_inference_routes SET held_calls=held_calls+1 WHERE provider=$1',
        [pack.provider],
      );
      const request = (
        await db.query(
          `INSERT INTO broker_inference_requests(grant_id,pack_id,buyer_id,source_key_id,provider,source_mode,operation_key,input_fingerprint,reserved_input,reserved_output,deadline_at,source_job_id,source_task_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '120 seconds',$11,$12) RETURNING *`,
          [
            grantId,
            pack.id,
            actor.id,
            actor.apiKey?.id ?? null,
            pack.provider,
            pack.source_mode,
            operationKey,
            fingerprint,
            inputBound,
            outputBound,
            source?.kind === 'coding' ? source.id : null,
            source?.kind === 'studio' ? source.id : null,
          ],
        )
      ).rows[0];
      if (source?.kind === 'studio') {
        const linked = await db.query(
          `UPDATE broker_studio_plan_attempts SET request_id=$3,failure_code=NULL WHERE task_id=$1 AND attempt=$2 AND request_id IS NULL`,
          [source.id, source.planAttempt, request.id],
        );
        if (!linked.rowCount)
          failure(
            409,
            'planning_attempt_changed',
            'The planning attempt is already dispatched or was not prepared.',
          );
      }
      await event(db, grantId, `reserve:${request.id}`, 'usage_reserved', request.id, actor.id, {
        inputTokens: inputBound,
        outputTokens: outputBound,
      });
      return { request, native, pack };
    }
    failure(
      409,
      'token_allowance_exceeded',
      'No qualified prepaid pack can reserve this input bound and max_tokens. Buy another pack or reduce max_tokens.',
    );
  });
  const { request, native, pack } = reservation;
  try {
    await transaction(ctx.pool, async (db) => {
      await authority(db, actor, 'inference:use');
      const grant = await lockedGrant(db, actor, grantId, true);
      if (source) {
        if (source.kind === 'studio') {
          const task = await studioAuthority(db, source, actor);
          if (task.plan_attempt !== source.planAttempt)
            failure(409, 'planning_attempt_changed', 'The planning attempt changed.');
        } else await codingAuthority(db, source, actor);
      }
      activeMode(ctx, grant);
      const route = (
        await db.query('SELECT * FROM broker_inference_routes WHERE provider=$1 FOR UPDATE', [
          pack.provider,
        ])
      ).rows[0];
      await assertRoute(ctx, route, grant.source_mode);
      const currentPack = (
        await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [pack.id])
      ).rows[0];
      if (currentPack.status !== 'active')
        failure(409, 'pack_retired', 'The pack was retired before dispatch.');
      const changed = await db.query(
        `UPDATE broker_inference_requests SET status='dispatching',dispatch_started_at=clock_timestamp()
        WHERE id=$1 AND status='reserved' AND deadline_at>clock_timestamp()`,
        [request.id],
      );
      if (!changed.rowCount)
        failure(409, 'dispatch_unavailable', 'The request is no longer eligible for dispatch.');
    });
  } catch (error) {
    // No provider call has occurred in this process. Release only this definite pre-dispatch failure.
    await settleRequest(ctx, request.id, null, 'dispatch_not_sent');
    throw error;
  }
  let result: AdapterResult;
  try {
    result = await rt.dispatch(
      native,
      { ...input, max_tokens: request.reserved_output },
      request.id,
      source ? { jsonObject: true } : undefined,
    );
  } catch (error) {
    const upstream =
      error instanceof InferenceUpstreamError
        ? error
        : new InferenceUpstreamError('transport_outcome_unknown', false);
    if (upstream.definite) await settleRequest(ctx, request.id, null, upstream.code);
    else await markUnknown(ctx, request.id, upstream);
    inferenceFailure(
      upstream.definite ? 'inference_rejected' : 'inference_outcome_unknown',
      request.id,
      `Request ${request.id}: ${upstream.definite ? 'provider rejected the call; token quota was released' : 'usage is unresolved; reserved tokens remain held'}. Read /api/inference/requests/${request.id}.`,
    );
  }
  let current: Row;
  try {
    await settleRequest(ctx, request.id, result);
    current = (
      await ctx.pool.query('SELECT status FROM broker_inference_requests WHERE id=$1', [request.id])
    ).rows[0];
  } catch {
    // Dispatch already happened. A database outage must not turn into a retried provider POST.
    await markUnknown(
      ctx,
      request.id,
      new InferenceUpstreamError('settlement_pending', false, result.id),
    ).catch(() => {});
    inferenceFailure(
      'inference_settlement_pending',
      request.id,
      `Request ${request.id} needs a settlement check. Keep the original operation key.`,
    );
  }
  if (current.status !== 'settled')
    inferenceFailure(
      'inference_outcome_unknown',
      request.id,
      `Request ${request.id} needs accounting reconciliation; tokens remain reserved.`,
    );
  return {
    id: request.id,
    object: 'chat.completion',
    created: Math.floor(new Date(request.created_at).getTime() / 1000),
    model: INFERENCE_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
    broker: {
      requestId: request.id,
      packId: pack.id,
      provider: pack.provider,
      mode: pack.source_mode,
    },
  };
}
export async function receipt(ctx: AppContext, actor: Actor, id: string) {
  const meta = (
    await ctx.pool.query('SELECT * FROM broker_inference_requests WHERE id=$1 AND buyer_id=$2', [
      id,
      actor.id,
    ])
  ).rows[0];
  if (!meta) failure(404, 'not_found', 'Inference receipt not found.');
  if (actor.apiKey?.packId && meta.pack_id !== actor.apiKey.packId)
    failure(404, 'not_found', 'Inference receipt not found.');
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'inference:read');
    await lockedGrant(db, actor, meta.grant_id);
    return receiptView(
      (await db.query('SELECT * FROM broker_inference_requests WHERE id=$1', [id])).rows[0],
    );
  });
}
export async function recoverRequest(ctx: AppContext, id: string) {
  const meta = (
    await ctx.pool.query('SELECT id,grant_id,pack_id FROM broker_inference_requests WHERE id=$1', [
      id,
    ])
  ).rows[0];
  if (!meta) return;
  await transaction(ctx.pool, async (db) => {
    const { pack, request } = await lockRequest(db, meta);
    if (
      new Date(request.deadline_at) > (await clock(db)) ||
      ['settled', 'rejected', 'needs_reconciliation'].includes(request.status)
    )
      return;
    if (request.status === 'reserved') {
      await settleLocked(db, pack, request, 0, 0, true, 'never_dispatched', null);
    } else {
      await db.query(
        "UPDATE broker_inference_requests SET status='needs_reconciliation' WHERE id=$1",
        [id],
      );
      await event(db, request.grant_id, `uncertain:${id}`, 'usage_unresolved', id);
    }
  });
}
export async function resolveRequest(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  const input = z
    .object({
      operationKey: operationSchema,
      evidence: z.string().trim().min(20).max(2000),
      providerRequestId: z.string().trim().min(1).max(300),
      inputTokens: integer(10_000_000, 0),
      outputTokens: integer(8192, 0),
      rejected: z.boolean(),
    })
    .strict()
    .parse(raw);
  if (input.rejected && (input.inputTokens || input.outputTokens))
    failure(400, 'invalid_usage', 'A verified pre-generation rejection must have zero usage.');
  const meta = (
    await ctx.pool.query('SELECT id,grant_id,pack_id FROM broker_inference_requests WHERE id=$1', [
      id,
    ])
  ).rows[0];
  if (!meta) failure(404, 'not_found', 'Inference request not found.');
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const { pack, request } = await lockRequest(db, meta);
    const prior = (
      await db.query(
        'SELECT details FROM broker_inference_events WHERE grant_id=$1 AND operation_key=$2',
        [request.grant_id, `resolve:${id}:${input.operationKey}`],
      )
    ).rows[0];
    if (prior) {
      if (prior.details.fingerprint !== operationFingerprint(input))
        failure(409, 'operation_conflict', 'The resolution operation key was already used.');
      return receiptView(request);
    }
    if (!['outcome_unknown', 'needs_reconciliation'].includes(request.status))
      failure(409, 'request_not_unresolved', 'Only unresolved provider usage can be reconciled.');
    await settleLocked(
      db,
      pack,
      request,
      input.inputTokens,
      input.outputTokens,
      input.rejected,
      'operator_reconciled',
      input.providerRequestId,
      input.evidence,
      actor.id,
    );
    await event(
      db,
      request.grant_id,
      `resolve:${id}:${input.operationKey}`,
      'operator_reconciliation',
      id,
      actor.id,
      { fingerprint: operationFingerprint(input), evidence: input.evidence },
    );
    return receiptView(
      (await db.query('SELECT * FROM broker_inference_requests WHERE id=$1', [id])).rows[0],
    );
  });
}
