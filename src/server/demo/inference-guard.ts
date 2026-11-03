import type { PoolClient } from 'pg';
import type { Actor } from '../../shared/types.js';
import type { Config } from '../config.js';
import { HttpError } from '../context.js';

export interface DemoStudioSource {
  id: string;
  leaseToken: string;
  packId: string;
  planAttempt: number;
}

/** Called under the grant lock, before reserving quota and again before dispatch. */
export async function assertDemoInference(
  db: PoolClient,
  config: Config,
  actor: Actor,
  grantId: string,
  maxOutputTokens: number,
  admission: boolean,
  studio?: DemoStudioSource,
) {
  const run = (
    await db.query(
      `SELECT r.*,r.expires_at>clock_timestamp() AS unexpired,r.lease_until>clock_timestamp() AS leased,
        EXISTS(SELECT 1 FROM broker_vms v WHERE v.id=r.vm_id AND v.buyer_id=r.buyer_id
          AND v.status='running' AND v.expires_at>clock_timestamp() AND v.cleanup_confirmed_at IS NULL
          AND COALESCE(v.catalog_snapshot->>'sourceMode','fixture')=r.source_mode) AS vm_active,
        EXISTS(SELECT 1 FROM broker_vms v JOIN broker_disks d ON d.id=r.disk_id AND d.id=v.disk_id AND d.buyer_id=r.buyer_id
          JOIN broker_disk_attachments a ON a.vm_id=v.id AND a.disk_id=d.id AND a.environment_id=v.environment_id
          WHERE v.id=r.vm_id AND d.status='ready' AND NOT d.cleanup_pending AND d.source_mode=r.source_mode AND a.status='mounted') AS disk_active
       FROM broker_demo_runs r WHERE r.grant_id=$1 FOR UPDATE OF r`,
      [grantId],
    )
  ).rows[0];
  if (!run) {
    if (studio) throw new HttpError(403, 'The guided demo no longer exists.');
    return;
  }
  const fail = (code: string, message: string, status = 403): never => {
    throw Object.assign(new HttpError(status, message), { code });
  };
  if (
    !config.liveDemoEnabled ||
    run.buyer_id !== actor.id ||
    (studio
      ? Boolean(actor.apiKey) ||
        run.kind !== 'studio' ||
        !run.disk_active ||
        run.id !== studio.id ||
        run.pack_id !== studio.packId ||
        run.lease_token !== studio.leaseToken ||
        !run.leased
      : run.kind === 'studio' || !actor.apiKey?.packId || actor.apiKey.packId !== run.pack_id) ||
    run.status !== 'ready' ||
    run.stop_requested ||
    run.ended_at ||
    !run.unexpired ||
    !run.vm_active ||
    run.source_mode !== config.wickMode
  )
    fail('demo_session_ended', 'Model access requires your active demo VM and its token key.');
  if (studio) {
    const attempt = (
      await db.query(
        `SELECT s.run_id FROM broker_demo_studio s JOIN broker_demo_studio_attempts a ON a.run_id=s.run_id AND a.attempt=s.attempt WHERE s.run_id=$1 AND s.status='generating' AND s.attempt=$2 FOR UPDATE OF s,a`,
        [studio.id, studio.planAttempt],
      )
    ).rows[0];
    if (!attempt)
      fail('demo_studio_authority_changed', 'The guided Studio attempt is no longer authorized.');
  }
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
