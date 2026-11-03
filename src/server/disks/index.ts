import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { HttpError, type AppContext } from '../context.js';
import { transaction, enqueue } from '../marketplace/db.js';
import { uuid } from '../marketplace/data.js';
import { listDiskFiles, previewDiskFile } from './files.js';
import {
  createDisk,
  deleteDisk,
  diskOptions,
  diskDetail,
  DISK_QUEUE,
  listDisks,
  listWorkspaces,
  renameDisk,
} from './service.js';

export async function registerDisks(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/disks/options', async (r) => {
    await ctx.requireActor(r, ['buyer']);
    return diskOptions(ctx);
  });
  app.get('/api/disks', async (r) => listDisks(ctx, await ctx.requireActor(r, ['buyer']), r.query));
  app.post('/api/disks', async (r) =>
    createDisk(ctx, await ctx.requireActor(r, ['buyer']), {
      ...(r.body as object),
      operationKey:
        (r.body as { operationKey?: string })?.operationKey ?? r.headers['idempotency-key'],
    }),
  );
  app.get<{ Params: { id: string } }>('/api/disks/:id', async (r) =>
    diskDetail(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id)),
  );
  app.get<{ Params: { id: string } }>('/api/disks/:id/workspaces', async (r) =>
    listWorkspaces(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id), r.query),
  );
  app.get<{ Params: { id: string } }>('/api/disks/:id/files', async (r, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return listDiskFiles(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id), r.query);
  });
  app.get<{ Params: { id: string } }>('/api/disks/:id/file', async (r, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return previewDiskFile(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id), r.query);
  });
  app.patch<{ Params: { id: string } }>('/api/disks/:id', async (r) =>
    renameDisk(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id), {
      ...(r.body as object),
      operationKey:
        (r.body as { operationKey?: string })?.operationKey ?? r.headers['idempotency-key'],
    }),
  );
  app.delete<{ Params: { id: string } }>('/api/disks/:id', async (r) =>
    deleteDisk(ctx, await ctx.requireActor(r, ['buyer']), uuid(r.params.id), {
      ...(r.body as object),
      operationKey:
        (r.body as { operationKey?: string })?.operationKey ?? r.headers['idempotency-key'],
    }),
  );
}

/** Each upstream mutation reuses its durable key. Worker leases fence stale writes. */
export async function reconcileDisk(ctx: AppContext, id: string) {
  if (!ctx.wick.drives) return;
  const token = randomUUID();
  const row = (
    await ctx.pool.query(
      `UPDATE broker_disks SET lease_token=$3,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1
    WHERE id=$1 AND source_mode=$2 AND (status IN('creating','deleting') OR needs_sync) AND attempts<60
    AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,
      [id, ctx.wick.mode, token],
    )
  ).rows[0];
  if (!row) return;
  try {
    let observed;
    if (row.status === 'creating')
      observed = row.upstream_id
        ? await ctx.wick.drives.get(row.upstream_id)
        : await ctx.wick.drives.create({ name: row.name }, row.create_key);
    else if (row.status === 'deleting') {
      if (!row.upstream_id) throw new Error('Disk creation must be reconciled before deletion.');
      observed = await ctx.wick.drives.delete(row.upstream_id, row.delete_key);
    } else observed = await ctx.wick.drives.rename(row.upstream_id, row.name);
    if (row.upstream_id && observed.drive.id !== row.upstream_id)
      throw new Error('Disk operation identity changed.');
    const d = observed.drive;
    if (row.status !== 'deleting' && d.name !== row.name)
      throw new Error('Disk name synchronization is unconfirmed.');
    const pending = Boolean(d.cleanupPending || observed.operation.cleanupPending);
    const status =
      row.status === 'deleting'
        ? d.status === 'deleted' && !pending
          ? 'deleted'
          : 'deleting'
        : d.status === 'ready' && !pending
          ? 'ready'
          : d.status === 'failed'
            ? 'failed'
            : 'creating';
    const exhausted =
      row.attempts >= 60 && (pending || status === 'creating' || status === 'deleting');
    await ctx.pool.query(
      `UPDATE broker_disks SET upstream_id=COALESCE(upstream_id,$3),upstream_operation_id=$4,status=$5,cleanup_pending=$6,
      failure_reason=$7,lease_token=NULL,lease_until=NULL,needs_sync=CASE WHEN name=$8 THEN false ELSE needs_sync END,updated_at=clock_timestamp()
      WHERE id=$1 AND lease_token=$2`,
      [
        id,
        token,
        d.id,
        observed.operation.id,
        status,
        pending || exhausted,
        exhausted
          ? 'Disk reconciliation exhausted its retry budget; operator attention is required.'
          : status === 'failed'
            ? 'Wick confirmed that the disk operation failed.'
            : null,
        row.name,
      ],
    );
    if (!exhausted && (status === 'creating' || status === 'deleting'))
      await transaction(ctx.pool, (db) => enqueue(ctx, db, DISK_QUEUE, { id }, 5));
  } catch {
    await ctx.pool.query(
      `UPDATE broker_disks SET failure_reason=$3,cleanup_pending=CASE WHEN attempts>=60 THEN true ELSE cleanup_pending END,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2`,
      [
        id,
        token,
        row.attempts >= 60
          ? 'Disk reconciliation exhausted its retry budget; operator attention is required.'
          : 'Disk operation is unconfirmed; reconciling its original identity.',
      ],
    );
    if (row.attempts < 60)
      await transaction(ctx.pool, (db) => enqueue(ctx, db, DISK_QUEUE, { id }, 10));
  }
}
export async function maintainDisks(ctx: AppContext) {
  const pending = (
    await ctx.pool.query(
      `SELECT id FROM broker_disks WHERE source_mode=$1 AND (status IN('creating','deleting') OR needs_sync) AND attempts<60 AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY updated_at,id LIMIT 100`,
      [ctx.wick.mode],
    )
  ).rows;
  for (const r of pending)
    await transaction(ctx.pool, (db) => enqueue(ctx, db, DISK_QUEUE, { id: r.id }));
}
export async function startDiskWorkers(ctx: AppContext) {
  const wrongMode = (
    await ctx.pool.query(
      `SELECT 1 FROM broker_disks d WHERE d.source_mode<>$1 AND (d.status IN('creating','deleting') OR d.needs_sync OR EXISTS(SELECT 1 FROM broker_disk_workspaces w WHERE w.disk_id=d.id AND w.active_task_id IS NOT NULL) OR EXISTS(SELECT 1 FROM broker_disk_attachments a WHERE a.disk_id=d.id AND a.status<>'detached')) LIMIT 1`,
      [ctx.wick.mode],
    )
  ).rowCount;
  if (wrongMode)
    throw new HttpError(
      409,
      'Reconcile pending disks in their original Wick integration mode before switching modes.',
    );
  await ctx.boss.createQueue(DISK_QUEUE);
  await ctx.boss.work<{ id: string }>(
    DISK_QUEUE,
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) await reconcileDisk(ctx, uuid(job.data.id));
    },
  );
  const maintenance = 'broker-disk-maintenance';
  await ctx.boss.createQueue(maintenance);
  await ctx.boss.work(maintenance, { localConcurrency: 1 }, async () => maintainDisks(ctx));
  await ctx.boss.schedule(maintenance, '* * * * *', {}, { tz: 'UTC' });
  await maintainDisks(ctx);
}
