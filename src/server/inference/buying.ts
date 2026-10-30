import { z } from 'zod';
import { MIN_ORDER_PRICE_CENTS } from '../../shared/money.js';
import type { Actor } from '../../shared/types.js';
import type { BuyingCandidate, BuyingDecision, BuyingWorkspace } from '../../shared/buying.js';
import { purchaseInput } from '../../shared/buying.js';
import type { InferenceProvider, TokenQuote } from '../../shared/inference.js';
import type { AppContext } from '../context.js';
import { pagination, encodeCursor, type Row } from '../marketplace/data.js';
import { transaction } from '../marketplace/db.js';
import { withOperation } from '../operations.js';
import {
  activeMode,
  assertRoute,
  authority,
  clock,
  event,
  failure,
  grantView,
  integer,
  lockedGrant,
  moneyAmount,
  operationSchema,
  runtime,
} from './data.js';
import { allowance, decisionView, policyView, FIXTURE_BUYING_INPUT_BOUND } from './buying-guard.js';
import {
  createTokenOrder,
  OFFER_SELECT,
  offeringOpen,
  packPrice,
  quotes,
  tokenOrderDetail,
} from './market.js';

function owner(actor: Actor) {
  if (actor.apiKey || actor.role !== 'buyer')
    failure(403, 'owner_required', 'Use the signed-in owner to manage purchasing.');
}
const policySchema = z
  .object({
    operationKey: operationSchema,
    expectedRevision: integer(2_000_000_000, 0),
    mode: z.enum(['suggest', 'review', 'automatic']),
    paused: z.boolean(),
    maxPurchaseCents: moneyAmount(100_000_000),
    outputPerCall: integer(8192),
    targetCalls: integer(8),
    refillAtCalls: integer(8, 0),
    allowInstant: z.boolean(),
  })
  .strict();

export async function listAgents(ctx: AppContext, actor: Actor, raw: unknown) {
  owner(actor);
  const page = pagination(raw);
  const filter = z
    .object({
      q: z.string().trim().max(80).default(''),
      status: z.enum(['all', 'active', 'closing', 'closed']).default('all'),
    })
    .parse(raw ?? {});
  const rows = (
    await ctx.pool.query(
      `SELECT g.*,g.created_at::text cursor_created_at,p.mode buying_mode,p.paused buying_paused,COALESCE(p.output_per_call,512) output_per_call
    FROM broker_inference_grants g LEFT JOIN broker_inference_buying_policies p ON p.grant_id=g.id
    WHERE g.buyer_id=$1 AND ($2='' OR strpos(lower(g.name),lower($2))>0) AND ($3='all' OR g.status=$3)
    AND ($4::timestamptz IS NULL OR(g.created_at,g.id)<($4,$5::uuid))
    ORDER BY g.created_at DESC,g.id DESC LIMIT $6`,
      [actor.id, filter.q, filter.status, page.cursor, page.cursorId, page.limit + 1],
    )
  ).rows;
  const selected = rows.slice(0, page.limit);
  const counts = selected.length
    ? (
        await ctx.pool.query(
          `SELECT t.grant_id,sum(LEAST(
    floor(t.available_input/GREATEST(1,CASE WHEN t.source_mode='fixture' THEN ${FIXTURE_BUYING_INPUT_BOUND} ELSE (t.snapshot->>'minimumInputReservation')::numeric END)),
    floor(t.available_output/COALESCE(p.output_per_call,512))))::int eligible_calls
    FROM broker_token_packs t JOIN broker_inference_routes r ON r.provider=t.provider
    LEFT JOIN broker_inference_buying_policies p ON p.grant_id=t.grant_id
    WHERE t.grant_id=ANY($1::uuid[]) AND t.status='active' AND t.expires_at>statement_timestamp()
    AND (t.snapshot->>'minimumInputReservation')::numeric>0
    AND r.qualified AND r.quarantined_at IS NULL AND t.route_fingerprint=r.fingerprint
    AND COALESCE(p.output_per_call,512)<=r.max_output_tokens GROUP BY t.grant_id`,
          [selected.map((r) => r.id)],
        )
      ).rows
    : [];
  const byId = new Map(counts.map((r) => [r.grant_id, r.eligible_calls]));
  return {
    items: selected.map((r) => ({
      ...grantView(r),
      buyingMode: r.buying_mode ?? null,
      buyingPaused: r.buying_paused ?? false,
      eligibleCalls: byId.get(r.id) ?? 0,
      outputPerCall: r.output_per_call,
    })),
    ...(rows.length > page.limit ? { nextCursor: encodeCursor(rows[page.limit - 1]) } : {}),
  };
}

export async function buyingWorkspace(
  ctx: AppContext,
  actor: Actor,
  id: string,
): Promise<BuyingWorkspace> {
  owner(actor);
  return transaction(ctx.pool, async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, id);
    const policy = (
      await db.query('SELECT * FROM broker_inference_buying_policies WHERE grant_id=$1', [id])
    ).rows[0];
    const decisions = (
      await db.query(
        'SELECT * FROM broker_inference_buying_decisions WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
        [id],
      )
    ).rows;
    return {
      policy: policy ? policyView(policy) : null,
      allowance: await allowance(db, grant, policy?.output_per_call ?? 512),
      decisions: decisions.map(decisionView),
    };
  });
}

export async function saveBuyingPolicy(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  owner(actor);
  const input = policySchema.parse(raw);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, id, true);
    activeMode(ctx, grant);
    return withOperation(
      db,
      actor,
      `inference.buying.policy:${id}`,
      input.operationKey,
      input,
      async () => {
        const prior = (
          await db.query(
            'SELECT * FROM broker_inference_buying_policies WHERE grant_id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if ((prior?.revision ?? 0) !== input.expectedRevision)
          failure(409, 'revision_conflict', 'The buying policy changed. Reload before saving.');
        if (
          input.maxPurchaseCents > Number(grant.max_purchase_cents) ||
          (input.allowInstant && !grant.allow_instant)
        )
          failure(400, 'grant_limit', 'Buying controls cannot broaden the original grant limits.');
        await db.query(
          `UPDATE broker_inference_buying_decisions SET status='superseded',reason='The owner changed the buying policy.'
        WHERE grant_id=$1 AND status IN('evaluating','recommended')`,
          [id],
        );
        const row = (
          await db.query(
            `INSERT INTO broker_inference_buying_policies(grant_id,mode,paused,max_purchase_cents,output_per_call,target_calls,refill_at_calls,allow_instant)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(grant_id) DO UPDATE SET revision=broker_inference_buying_policies.revision+1,
        mode=EXCLUDED.mode,paused=EXCLUDED.paused,max_purchase_cents=EXCLUDED.max_purchase_cents,output_per_call=EXCLUDED.output_per_call,
        target_calls=EXCLUDED.target_calls,refill_at_calls=EXCLUDED.refill_at_calls,allow_instant=EXCLUDED.allow_instant,
        next_evaluation_at=GREATEST(clock_timestamp(),COALESCE(broker_inference_buying_policies.last_evaluated_at+interval '1 minute',clock_timestamp())),updated_at=clock_timestamp() RETURNING *`,
            [
              id,
              input.mode,
              input.paused,
              input.maxPurchaseCents,
              input.outputPerCall,
              input.targetCalls,
              input.refillAtCalls,
              input.allowInstant,
            ],
          )
        ).rows[0];
        await event(db, id, `buying-policy:${row.revision}`, 'buying_policy_saved', id, actor.id, {
          revision: row.revision,
          mode: row.mode,
          paused: row.paused,
          maxPurchaseCents: Number(row.max_purchase_cents),
          outputPerCall: row.output_per_call,
          targetCalls: row.target_calls,
          refillAtCalls: row.refill_at_calls,
          allowInstant: row.allow_instant,
        });
        return policyView(row);
      },
    );
  });
}

/** Durable claim is committed before the bounded Muse call. No lock spans network I/O. */
export async function evaluateBuying(
  ctx: AppContext,
  actor: Actor,
  id: string,
  automatic = false,
): Promise<BuyingDecision> {
  owner(actor);
  const claim = await transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, id, true);
    activeMode(ctx, grant);
    const policy = (
      await db.query(
        'SELECT * FROM broker_inference_buying_policies WHERE grant_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!policy)
      failure(409, 'policy_required', 'Save a buying policy before requesting a recommendation.');
    if (policy.paused || (automatic && policy.mode !== 'automatic'))
      failure(409, 'buying_paused', 'Automatic buying is paused or not enabled.');
    const now = await clock(db);
    await db.query(
      `UPDATE broker_inference_buying_decisions SET status='superseded',reason='This recommendation expired. Request a fresh one.'
      WHERE grant_id=$1 AND status IN('evaluating','recommended') AND expires_at<=$2`,
      [id, now],
    );
    const current = (
      await db.query(
        `SELECT * FROM broker_inference_buying_decisions WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (current && ['evaluating', 'recommended'].includes(current.status))
      return { existing: decisionView(current) };
    if (new Date(policy.next_evaluation_at) > now)
      failure(
        429,
        'buying_cooldown',
        'Recommendations are limited to one evaluation per minute per grant.',
      );
    const budget = Math.min(
      Number(policy.max_purchase_cents),
      Number(grant.max_purchase_cents),
      Number(grant.available_cents),
    );
    const available = await allowance(db, grant, policy.output_per_call);
    let blocked = '';
    if (available.unresolvedRequests)
      blocked = 'Usage needs reconciliation. Automatic purchasing has been paused.';
    else if (available.pendingOrders)
      blocked = 'A token purchase is already pending. Wait for its outcome.';
    else if (available.eligibleCalls > policy.refill_at_calls)
      blocked =
        'Existing allowance covers more calls than your refill trigger. No purchase is needed.';
    else if (policy.model_calls >= 20)
      blocked = 'This grant reached its 20-decision Muse limit. Manual purchases remain available.';
    else if (budget < MIN_ORDER_PRICE_CENTS)
      blocked = 'At least $0.01 of owner funding is required before another purchase.';
    else if (new Date(grant.expires_at).getTime() - now.getTime() < 45000)
      blocked = 'The grant expires too soon for a new purchase. No expiry is extended.';
    const rows = (
      await db.query(`${OFFER_SELECT} WHERE r.provider=ANY($1::text[]) ORDER BY r.provider`, [
        grant.allowed_providers,
      ])
    ).rows;
    const eligible: Row[] = [];
    for (const row of rows) {
      try {
        await assertRoute(ctx, row, grant.source_mode);
      } catch {
        continue;
      }
      const rt = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
      if (
        offeringOpen(row, now) &&
        rt.validUntil >= new Date(grant.expires_at).getTime() &&
        policy.output_per_call <= rt.maximumOutputTokens
      )
        eligible.push(row);
    }
    const inputBound = Math.max(
      0,
      ...eligible.map((r) =>
        r.source_mode === 'fixture' ? FIXTURE_BUYING_INPUT_BOUND : Number(r.input_bound),
      ),
    );
    const candidates: BuyingCandidate[] = [],
      quoteSizes: BuyingCandidate[] = [];
    if (!blocked && inputBound) {
      const target = Math.min(policy.target_calls, Math.floor(10_000_000 / inputBound));
      for (const calls of [...new Set([1, Math.min(2, target), target])].filter(
        (n) => n > 0 && n <= target,
      )) {
        const inputTokens = inputBound * calls,
          outputTokens = policy.output_per_call * calls;
        const asks = eligible
          .filter(
            (r) =>
              r.auto_bid &&
              Number(r.outstanding_input) + inputTokens <= Number(r.max_outstanding_input) &&
              Number(r.outstanding_output) + outputTokens <= Number(r.max_outstanding_output),
          )
          .map((r) => packPrice(r, inputTokens, outputTokens).priceCents)
          .filter((p) => p <= budget);
        const option: BuyingCandidate = {
          id: `auction-${calls}`,
          mode: 'auction',
          inputTokens,
          outputTokens,
          calls,
          maxTotalCents: budget,
          estimatedPriceCents: asks.length ? Math.min(...asks) : 0,
        };
        quoteSizes.push(option);
        if (asks.length) candidates.push(option);
      }
    }
    if (
      !blocked &&
      !candidates.length &&
      !(
        quoteSizes.length &&
        grant.allow_instant &&
        policy.allow_instant &&
        available.eligibleCalls === 0
      )
    )
      blocked = 'No qualified supply fits this budget, expiry, and accounting limit.';
    const decision = (
      await db.query(
        `INSERT INTO broker_inference_buying_decisions(grant_id,policy_revision,status,reason,source_mode,expires_at)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          id,
          policy.revision,
          blocked ? 'blocked' : 'evaluating',
          blocked || 'Muse is evaluating approved purchase candidates.',
          ctx.muse.mode,
          new Date(Math.min(now.getTime() + 60000, new Date(grant.expires_at).getTime())),
        ],
      )
    ).rows[0];
    await db.query(
      `UPDATE broker_inference_buying_policies SET last_evaluated_at=$2,next_evaluation_at=$2::timestamptz+interval '1 minute',
      model_calls=model_calls+$3,paused=paused OR $4 WHERE grant_id=$1`,
      [id, now, blocked ? 0 : 1, available.unresolvedRequests > 0],
    );
    if (blocked) return { existing: decisionView(decision) };
    return { decision, policy, grant, candidates, quoteSizes, available, now };
  });
  if (claim.existing) return claim.existing;
  const { decision, policy, grant, candidates, quoteSizes, available, now } = claim;
  const baselineByCandidate = new Map<string, TokenQuote>();
  try {
    // Quotes use the existing signer and server-priced routes; no native inference is run here.
    if (grant.allow_instant) {
      for (const c of quoteSizes) {
        const instant = (
          await quotes(ctx, actor, {
            grantId: id,
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
          })
        ).items[0];
        if (instant) baselineByCandidate.set(c.id, instant);
        if (
          instant &&
          available.eligibleCalls === 0 &&
          policy.allow_instant &&
          instant.priceCents <= c.maxTotalCents
        ) {
          const candidate = {
            ...c,
            id: `instant-${c.calls}`,
            mode: 'instant' as const,
            quoteId: instant.quoteId,
            estimatedPriceCents: instant.priceCents,
          };
          candidates.push(candidate);
          baselineByCandidate.set(candidate.id, instant);
        }
      }
    }
    if (!candidates.length) {
      const row = (
        await ctx.pool.query(
          `UPDATE broker_inference_buying_decisions SET status='blocked',reason='No qualified quote fits the approved budget and expiry.' WHERE id=$1 AND status='evaluating' RETURNING *`,
          [decision.id],
        )
      ).rows[0];
      return decisionView(
        row ??
          (
            await ctx.pool.query('SELECT * FROM broker_inference_buying_decisions WHERE id=$1', [
              decision.id,
            ])
          ).rows[0],
      );
    }
    if (!ctx.muse.selectTokenPurchase) throw new Error('Muse purchasing is unavailable.');
    await ctx.pool.query(
      `UPDATE broker_inference_buying_decisions SET model_called=$2 WHERE id=$1 AND status='evaluating'`,
      [decision.id, ctx.muse.mode === 'real'],
    );
    const selected = await ctx.muse.selectTokenPurchase({
      kind: 'purchase',
      availableCalls: available.eligibleCalls,
      expiresInMinutes: Math.max(
        0,
        Math.floor((new Date(grant.expires_at).getTime() - now.getTime()) / 60000),
      ),
      candidates: candidates.map(
        ({ id, mode, inputTokens, outputTokens, estimatedPriceCents, calls }) => ({
          id,
          mode,
          inputTokens,
          outputTokens,
          estimatedPriceCents,
          calls,
        }),
      ),
    });
    const candidate = candidates.find((c) => c.id === selected.candidateId);
    if (selected.candidateId && !candidate) throw new Error('Muse selected an unknown candidate.');
    const reason = candidate
      ? `${selected.mode === 'fixture' ? 'Fixture recommendation' : 'Muse recommendation'}: ${candidate.calls} bounded call${candidate.calls === 1 ? '' : 's'} via ${candidate.mode === 'auction' ? 'a 30-second auction' : 'an instant quote'}. Prices and allowance were validated by the server.`
      : 'Muse recommends waiting. No purchase has been placed.';
    const baseline = candidate ? baselineByCandidate.get(candidate.id) : undefined;
    return await transaction(ctx.pool, async (db) => {
      await authority(db, actor);
      const current = await lockedGrant(db, actor, id);
      const saved = (
        await db.query(
          'SELECT * FROM broker_inference_buying_policies WHERE grant_id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      const completedAt = await clock(db);
      const valid =
        current.status === 'active' &&
        new Date(current.expires_at) > completedAt &&
        new Date(decision.expires_at) > completedAt &&
        saved.revision === policy.revision &&
        !saved.paused;
      const result = (
        await db.query(
          `UPDATE broker_inference_buying_decisions SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'superseded' ELSE $2 END,reason=CASE WHEN expires_at<=clock_timestamp() THEN 'The recommendation expired while Muse was evaluating.' ELSE $3 END,candidate=$4,baseline=$5,model_called=$6
        WHERE id=$1 AND status='evaluating' RETURNING *`,
          [
            decision.id,
            valid ? (candidate ? 'recommended' : 'skipped') : 'superseded',
            valid
              ? reason
              : 'The grant, policy, or recommendation deadline changed while Muse was evaluating.',
            candidate ?? null,
            baseline
              ? {
                  provider: baseline.provider,
                  priceCents: baseline.priceCents,
                  inputTokens: baseline.inputTokens,
                  outputTokens: baseline.outputTokens,
                  capturedAt: now.toISOString(),
                  packExpiresAt: new Date(grant.expires_at).toISOString(),
                }
              : null,
            selected.modelCalled,
          ],
        )
      ).rows[0];
      return decisionView(
        result ??
          (
            await db.query('SELECT * FROM broker_inference_buying_decisions WHERE id=$1', [
              decision.id,
            ])
          ).rows[0],
      );
    });
  } catch (error) {
    await ctx.pool.query(
      `UPDATE broker_inference_buying_decisions SET status='failed',reason='Muse could not complete a validated recommendation. No purchase was placed; manual buying remains available.' WHERE id=$1 AND status='evaluating'`,
      [decision.id],
    );
    if ([401, 403].includes((error as { statusCode?: number }).statusCode ?? 0)) throw error;
    return decisionView(
      (
        await ctx.pool.query('SELECT * FROM broker_inference_buying_decisions WHERE id=$1', [
          decision.id,
        ])
      ).rows[0],
    );
  }
}

export async function acceptBuying(
  ctx: AppContext,
  actor: Actor,
  grantId: string,
  decisionId: string,
  automatic = false,
) {
  owner(actor);
  const decision = (
    await ctx.pool.query(
      `SELECT d.* FROM broker_inference_buying_decisions d JOIN broker_inference_grants g ON g.id=d.grant_id
    WHERE d.id=$1 AND d.grant_id=$2 AND g.buyer_id=$3`,
      [decisionId, grantId, actor.id],
    )
  ).rows[0];
  if (!decision?.candidate)
    failure(404, 'recommendation_missing', 'No purchase recommendation was found.');
  return createTokenOrder(ctx, actor, purchaseInput(grantId, decisionView(decision)), {
    decisionId,
    automatic,
  });
}

export async function purchaseReceipt(ctx: AppContext, actor: Actor, id: string) {
  await tokenOrderDetail(ctx, actor, id); // Existing grant/pack-key scope and revocation checks.
  const row = (
    await ctx.pool.query('SELECT * FROM broker_inference_buying_decisions WHERE order_id=$1', [id])
  ).rows[0];
  return { decision: row ? decisionView(row) : null };
}

/** One bounded pass; claims serialize concurrent workers and owner actions on the grant. */
export async function maintainBuying(ctx: AppContext) {
  const due = (
    await ctx.pool
      .query(`SELECT p.grant_id,g.buyer_id,u.name,u.email FROM broker_inference_buying_policies p
    JOIN broker_inference_grants g ON g.id=p.grant_id JOIN "user" u ON u.id=g.buyer_id
    WHERE p.mode='automatic' AND NOT p.paused AND p.model_calls<20 AND p.next_evaluation_at<=statement_timestamp()
    AND g.status='active' AND g.expires_at>statement_timestamp() AND u.role='buyer'
    ORDER BY p.next_evaluation_at,p.grant_id LIMIT 4`)
  ).rows;
  for (const row of due) {
    const actor: Actor = { id: row.buyer_id, name: row.name, email: row.email, role: 'buyer' };
    try {
      const decision = await evaluateBuying(ctx, actor, row.grant_id, true);
      if (decision.status === 'recommended')
        await acceptBuying(ctx, actor, row.grant_id, decision.id, true);
    } catch (error) {
      // No retry under a fresh operation key. A committed purchase is recovered by the same decision ID.
      if (!(error as { statusCode?: number }).statusCode) throw error;
    }
  }
}
