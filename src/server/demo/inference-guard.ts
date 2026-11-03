import type { PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import type { Config } from '../config.js';
import { HttpError } from '../context.js';

/** Called under the grant lock, before reserving quota and again before dispatch. */
export async function assertDemoInference(
  db: PoolClient,
  config: Config,
  actor: Actor,
  grantId: string,
  maxOutputTokens: number,
  admission: boolean,
) {
  const run = (
    await db.query(
      `SELECT r.*,r.expires_at>clock_timestamp() AS unexpired,
        EXISTS(SELECT 1 FROM broker_vms v WHERE v.id=r.vm_id AND v.buyer_id=r.buyer_id
          AND v.status='running' AND v.expires_at>clock_timestamp()
          AND COALESCE(v.catalog_snapshot->>'sourceMode','fixture')=r.source_mode) AS vm_active
       FROM broker_demo_runs r WHERE r.grant_id=$1 FOR UPDATE OF r`,
      [grantId],
    )
  ).rows[0];
  if (!run) return;
  const fail = (code: string, message: string, status = 403): never => {
    throw Object.assign(new HttpError(status, message), { code });
  };
  if (
    !config.liveDemoEnabled ||
    run.buyer_id !== actor.id ||
    !actor.apiKey?.packId ||
    actor.apiKey.packId !== run.pack_id ||
    run.status !== 'ready' ||
    run.stop_requested ||
    run.ended_at ||
    !run.unexpired ||
    !run.vm_active ||
    run.source_mode !== config.wickMode
  )
    fail('demo_session_ended', 'Model access requires your active demo VM and its token key.');
  if (maxOutputTokens > 1024)
    fail('demo_output_limit', 'Demo requests allow at most 1,024 output tokens.', 400);
  if (admission) {
    const count = (
      await db.query('SELECT count(*)::int n FROM broker_inference_requests WHERE grant_id=$1', [
        grantId,
      ])
    ).rows[0].n;
    // Attempts with unknown usage still count. Replacing a key cannot refill the allowance.
    if (count >= 2)
      fail(
        'demo_request_limit',
        'This demo has used its two model requests. No refill is available.',
        429,
      );
  }
}
