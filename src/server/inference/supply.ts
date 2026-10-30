import type { Actor } from '../../shared/types.js';
import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { authority, assertRoute, clock, failure, runtime } from './data.js';
import { OFFER_SELECT, packPrice } from './market.js';
import type { InferenceProvider } from '../../shared/inference.js';
import { FIXTURE_BUYING_INPUT_BOUND } from './buying-guard.js';

/** Only this supplier's own published rates/allocation reach Muse. No customer prompts or rival policies. */
export async function proposeTokenSupply(ctx: AppContext, actor: Actor) {
  if (actor.apiKey || actor.role !== 'provider')
    failure(403, 'owner_required', 'Use the signed-in provider workspace.');
  const prepared = await transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const row = (
      await db.query(
        `${OFFER_SELECT} JOIN broker_providers p ON p.id=r.provider_id WHERE p.user_id=$1 FOR UPDATE OF r,o`,
        [actor.id],
      )
    ).rows[0];
    if (!row)
      failure(403, 'provider_unavailable', 'This provider has no configured inference route.');
    await assertRoute(ctx, row, row.source_mode);
    const last = (
      await db.query('SELECT muse_proposed_at FROM broker_token_offerings WHERE provider=$1', [
        row.provider,
      ])
    ).rows[0].muse_proposed_at;
    const now = await clock(db);
    if (last && new Date(last).getTime() > now.getTime() - 60000)
      failure(429, 'muse_cooldown', 'Supply recommendations are limited to one per minute.');
    const route = runtime(ctx).routes.get(row.provider as InferenceProvider)!;
    const inputTokens = route.mode === 'fixture' ? FIXTURE_BUYING_INPUT_BOUND : route.inputBound,
      outputTokens = Math.min(512, route.maximumOutputTokens);
    const packs = Math.min(
      8,
      Math.floor((Number(row.max_outstanding_input) - Number(row.outstanding_input)) / inputTokens),
      Math.floor(
        (Number(row.max_outstanding_output) - Number(row.outstanding_output)) / outputTokens,
      ),
    );
    if (packs < 1)
      failure(
        409,
        'capacity_unavailable',
        'The uncommitted allocation cannot cover another qualified pack.',
      );
    const rate = (current: number, cost: number, discount: number) =>
      Number(
        [
          ((BigInt(current) * BigInt(10000 - discount) + 999999n) / 1000000n) * 100n,
          ((BigInt(cost) * 10000n + 849999n) / 850000n) * 100n,
        ].reduce((a, b) => (a > b ? a : b)),
      );
    const candidates = [0, 500, 1000].map((discount) => {
      const inputRate = rate(Number(row.input_rate), Number(row.cost_input_rate), discount),
        outputRate = rate(Number(row.output_rate), Number(row.cost_output_rate), discount);
      return {
        id: `supply-${discount}`,
        mode: 'auction' as const,
        inputTokens,
        outputTokens,
        calls: packs,
        estimatedPriceCents: packPrice(
          { ...row, input_rate: inputRate, output_rate: outputRate },
          inputTokens,
          outputTokens,
        ).priceCents,
        inputRateMicrosPerMillion: inputRate,
        outputRateMicrosPerMillion: outputRate,
      };
    });
    await db.query('UPDATE broker_token_offerings SET muse_proposed_at=$2 WHERE provider=$1', [
      row.provider,
      now,
    ]);
    return {
      candidates,
      revision: row.revision,
      provider: row.provider,
      packs,
      expiresInMinutes: Math.min(
        10080,
        Math.max(0, Math.floor((route.validUntil - now.getTime()) / 60000)),
      ),
    };
  });
  if (!ctx.muse.selectTokenPurchase)
    failure(503, 'muse_unavailable', 'Muse supply recommendations are unavailable.');
  const selection = await ctx.muse.selectTokenPurchase({
    kind: 'supply',
    availableCalls: prepared.packs,
    expiresInMinutes: prepared.expiresInMinutes,
    candidates: prepared.candidates.map(
      ({ id, mode, inputTokens, outputTokens, calls, estimatedPriceCents }) => ({
        id,
        mode,
        inputTokens,
        outputTokens,
        calls,
        estimatedPriceCents,
      }),
    ),
  });
  const proposal = prepared.candidates.find((c) => c.id === selection.candidateId);
  return {
    mode: selection.mode,
    modelCalled: selection.modelCalled,
    expectedRevision: prepared.revision,
    proposal: proposal ?? null,
    explanation: proposal
      ? 'Review these server-priced rates against your own uncommitted allocation. Applying this draft does not publish it.'
      : 'Muse recommends keeping the current offering. Nothing was changed.',
  };
}
