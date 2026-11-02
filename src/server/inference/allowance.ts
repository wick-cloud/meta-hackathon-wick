import type { Row } from '../marketplace/data.js';
import type { PoolClient } from 'pg';

/** The grant and sorted route rows must already be locked by the caller.
 * This also repairs an old worker's retirement committed after migration 029.
 * The partial index and remaining ten-pack room bound every admission repair.
 */
export async function repairLegacyAllowance(db: PoolClient, grantId: string) {
  await db.query(
    `WITH room AS (
       SELECT GREATEST(0,10-count(*))::int n FROM
       (SELECT 1 FROM broker_token_packs WHERE grant_id=$1 AND status<>'settled' LIMIT 10) p
     ), candidates AS (
       SELECT p.id,p.retired_input restore_input,p.retired_output restore_output
       FROM broker_token_packs p
       JOIN broker_inference_grants g ON g.id=p.grant_id
       JOIN broker_inference_routes r ON r.provider=p.provider
       WHERE p.grant_id=$1 AND g.status='active' AND g.expires_at>clock_timestamp()
         AND g.allowed_providers ? p.provider
         AND p.status='settled' AND p.retirement_reason='quota_exhausted'
         AND (p.retired_input>0 OR p.retired_output>0)
         AND p.expires_at>statement_timestamp() AND p.refund_cents=0
         AND p.held_input=0 AND p.held_output=0 AND p.available_input=0 AND p.available_output=0
         AND r.qualified AND r.quarantined_at IS NULL AND r.provider_id=p.provider_id
         AND r.source_mode=p.source_mode AND g.source_mode=p.source_mode
         AND r.fingerprint=p.route_fingerprint
       ORDER BY p.expires_at,p.id LIMIT(SELECT n FROM room) FOR UPDATE OF p
     ), restored AS (
       UPDATE broker_token_packs p SET available_input=c.restore_input,available_output=c.restore_output,
         retired_input=0,retired_output=0,status='active',retirement_reason=NULL
       FROM candidates c WHERE p.id=c.id
       RETURNING p.id,p.grant_id,p.provider,c.restore_input,c.restore_output
     ), totals AS (
       SELECT provider,sum(restore_input) input_tokens,sum(restore_output) output_tokens
       FROM restored GROUP BY provider
     ), updated AS (
       UPDATE broker_inference_routes r SET outstanding_input=r.outstanding_input+t.input_tokens,
         outstanding_output=r.outstanding_output+t.output_tokens
       FROM totals t WHERE r.provider=t.provider RETURNING r.provider
     )
     INSERT INTO broker_inference_events(grant_id,operation_key,kind,resource_id,details)
     SELECT grant_id,'pool-repair:'||id||':'||gen_random_uuid(),'quota_restored',id,
       jsonb_build_object('reason','single_pack_fragmentation','inputTokens',restore_input,
         'outputTokens',restore_output,'buyerMoneyChanged',false) FROM restored`,
    [grantId],
  );
}

/** A caller-qualified route and the certified bounds for this exact request. */
export interface AllowanceRoute {
  provider: string;
  providerId: string;
  sourceMode: string;
  routeFingerprint: string;
  inputBound: number;
  minimumOutputTokens: number;
  maximumOutputTokens: number;
}
export interface AllowanceGroup {
  route: AllowanceRoute;
  packs: Row[];
  availableInput: number;
  availableOutput: number;
}
export interface TokenAllocation {
  pack: Row;
  reservedInput: number;
  reservedOutput: number;
}
export interface AllowancePlan {
  group: AllowanceGroup;
  inputBound: number;
  outputBound: number;
  allocations: TokenAllocation[];
}

/** At most ten unsettled packs exist per grant. Never inspect settled history. */
export function tokenAllowanceGroups(
  packs: readonly Row[],
  routes: readonly AllowanceRoute[],
  options: { grantId: string; now: Date; packId?: string },
): AllowanceGroup[] {
  if (packs.length > 10) throw new Error('Token allowance exceeds the bounded pack page.');
  const groups = new Map<string, AllowanceGroup>();
  const ordered = [...packs].sort(
    (a, b) =>
      new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime() ||
      String(a.id).localeCompare(String(b.id)),
  );
  for (const pack of ordered) {
    if (
      pack.grant_id !== options.grantId ||
      pack.status !== 'active' ||
      new Date(pack.expires_at).getTime() <= options.now.getTime() ||
      (options.packId && pack.id !== options.packId)
    )
      continue;
    const route = routes.find(
      (r) =>
        r.provider === pack.provider &&
        r.providerId === pack.provider_id &&
        r.sourceMode === pack.source_mode &&
        r.routeFingerprint === pack.route_fingerprint,
    );
    if (!route) continue;
    // The route identity includes seller and accounting contract. Prices are
    // already prepaid and remain attached to each independently conserved pack.
    const key = JSON.stringify([
      route.provider,
      route.providerId,
      route.sourceMode,
      route.routeFingerprint,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = { route, packs: [], availableInput: 0, availableOutput: 0 };
      groups.set(key, group);
    }
    group.packs.push(pack);
    group.availableInput += Number(pack.available_input);
    group.availableOutput += Number(pack.available_output);
  }
  return [...groups.values()];
}

/** Reserve each dimension independently, earliest expiry first, without transfers. */
export function planTokenAllowance(
  groups: readonly AllowanceGroup[],
  options: {
    maxOutputTokens: number;
    minimumOutputReservation: number;
    allowReducedOutput: boolean;
  },
): AllowancePlan | null {
  for (const group of groups) {
    const route = group.route;
    const outputBound = options.allowReducedOutput
      ? Math.min(options.maxOutputTokens, group.availableOutput)
      : options.maxOutputTokens;
    if (
      options.maxOutputTokens > route.maximumOutputTokens ||
      options.maxOutputTokens < route.minimumOutputTokens ||
      group.availableInput < route.inputBound ||
      group.availableOutput < outputBound ||
      outputBound < Math.max(route.minimumOutputTokens, options.minimumOutputReservation)
    )
      continue;
    let inputLeft = route.inputBound;
    let outputLeft = outputBound;
    const allocations: TokenAllocation[] = [];
    for (const pack of group.packs) {
      const reservedInput = Math.min(inputLeft, Number(pack.available_input));
      const reservedOutput = Math.min(outputLeft, Number(pack.available_output));
      if (reservedInput || reservedOutput)
        allocations.push({ pack, reservedInput, reservedOutput });
      inputLeft -= reservedInput;
      outputLeft -= reservedOutput;
      if (!inputLeft && !outputLeft) break;
    }
    if (inputLeft || outputLeft) throw new Error('Token allocation conservation failed.');
    return { group, inputBound: route.inputBound, outputBound, allocations };
  }
  return null;
}
