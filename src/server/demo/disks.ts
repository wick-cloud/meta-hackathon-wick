import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { Row } from '../marketplace/data.js';
import { transaction } from '../marketplace/db.js';
import { createDisk } from '../disks/service.js';
import { demoActor, demoModeAllowed } from './service.js';

/** Only newly created, dedicated demo disks enter this bounded pool. */
export async function warmDemoDisks(ctx: AppContext) {
  if (!ctx.config.liveDemoReuseDisks || !demoModeAllowed(ctx)) return;
  for (const slot of [1, 2]) {
    const entry = await transaction(ctx.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('demo-disk-pool'))");
      let row = (
        await db.query('SELECT * FROM broker_demo_disk_pool WHERE source_mode=$1 AND slot=$2', [
          ctx.wick.mode,
          slot,
        ])
      ).rows[0];
      if (!row) {
        const owner = randomUUID();
        await db.query(
          `INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,'Demo disk reserve','buyer',false)`,
          [owner, `disk-${owner}@demo.invalid`],
        );
        row = (
          await db.query(
            'INSERT INTO broker_demo_disk_pool(source_mode,slot,owner_id) VALUES($1,$2,$3) RETURNING *',
            [ctx.wick.mode, slot, owner],
          )
        ).rows[0];
      }
      return row;
    });
    if (entry.disk_id) continue;
    const disk = await createDisk(ctx, demoActor({ buyer_id: entry.owner_id }), {
      name: `Hackathon demo disk ${slot}`,
      operationKey: `demo-pool:${ctx.wick.mode}:${slot}`,
    });
    await ctx.pool.query(
      'UPDATE broker_demo_disk_pool SET disk_id=$3 WHERE source_mode=$1 AND slot=$2 AND disk_id IS NULL',
      [ctx.wick.mode, slot, disk.id],
    );
  }
}

/** Exclusive checkout and owner handoff commit with the run checkpoint. */
export async function claimDemoDisk(ctx: AppContext, run: Row): Promise<boolean> {
  await warmDemoDisks(ctx);
  return transaction(ctx.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('demo-disk-pool'))");
    const current = (
      await db.query(
        `SELECT * FROM broker_demo_runs WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND ended_at IS NULL AND NOT stop_requested FOR UPDATE`,
        [run.id, run.lease_token],
      )
    ).rows[0];
    if (!current) return false;
    if (current.disk_id) return true;
    const entry = (
      await db.query(
        `SELECT p.*,d.upstream_id FROM broker_demo_disk_pool p JOIN broker_disks d ON d.id=p.disk_id
      WHERE p.source_mode=$1 AND p.run_id IS NULL AND d.source_mode=p.source_mode AND d.status='ready' AND NOT d.cleanup_pending AND NOT d.needs_sync AND (d.lease_until IS NULL OR d.lease_until<clock_timestamp()) AND d.upstream_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM broker_disk_attachments a WHERE a.disk_id=d.id AND a.status<>'detached')
      AND NOT EXISTS(SELECT 1 FROM broker_vms v WHERE v.disk_id=d.id AND v.cleanup_confirmed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM broker_requests r WHERE r.disk_id=d.id AND r.status IN('open','provisioning'))
      AND NOT EXISTS(SELECT 1 FROM broker_disk_workspaces w WHERE w.disk_id=d.id)
      ORDER BY p.slot LIMIT 1 FOR UPDATE OF p,d`,
        [ctx.wick.mode],
      )
    ).rows[0];
    if (!entry) return false;
    await db.query('UPDATE broker_disks SET buyer_id=$2,updated_at=clock_timestamp() WHERE id=$1', [
      entry.disk_id,
      run.buyer_id,
    ]);
    await db.query('UPDATE broker_demo_disk_pool SET run_id=$3 WHERE source_mode=$1 AND slot=$2', [
      ctx.wick.mode,
      entry.slot,
      run.id,
    ]);
    await db.query(
      'UPDATE broker_demo_runs SET disk_id=$3,reusable_disk=true,native_attempted_at=COALESCE(native_attempted_at,clock_timestamp()) WHERE id=$1 AND lease_token=$2',
      [run.id, run.lease_token, entry.disk_id],
    );
    return true;
  });
}

/** Native detachment must be observed before checkout can ever be released. */
export async function demoDiskDetached(ctx: AppContext, run: Row): Promise<boolean> {
  const disk = (
    await ctx.pool.query(
      `SELECT d.* FROM broker_disks d JOIN broker_demo_disk_pool p ON p.disk_id=d.id AND p.run_id=$1 WHERE d.id=$2 AND d.buyer_id=$3 AND d.source_mode=$4`,
      [run.id, run.disk_id, run.buyer_id, ctx.wick.mode],
    )
  ).rows[0];
  if (!disk?.upstream_id || !ctx.wick.drives) return false;
  const { drive } = await ctx.wick.drives.get(disk.upstream_id);
  return (
    drive.id === disk.upstream_id &&
    drive.status === 'ready' &&
    !drive.cleanupPending &&
    drive.attachments.length === 0 &&
    (ctx.wick.mode === 'fixture' ||
      (drive.organizationId === ctx.config.wickOrganizationId &&
        drive.groupId === ctx.config.wickGroupId))
  );
}
