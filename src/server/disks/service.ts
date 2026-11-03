import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor, CatalogItem } from '../../shared/types.js';
import type { Disk, DiskAttachment, DiskDetail, DiskWorkspace } from '../../shared/disks.js';
import type { WickEnvironment } from '../integrations/types.js';
import { HttpError, type AppContext } from '../context.js';
import { withOperation, clientOperationKey } from '../operations.js';
import { transaction, enqueue } from '../marketplace/db.js';
import { encodeCursor, pagination, uuid, getCatalog, type Row } from '../marketplace/data.js';

export const DISK_QUEUE = 'broker-disk-reconcile';
export function diskCatalogEligible(ctx: AppContext, item: CatalogItem): boolean {
  return Boolean(
    ctx.config.disksEnabled &&
    ctx.wick.drives &&
    item.approved &&
    item.capabilities?.includes('persistent-drives') &&
    (ctx.wick.mode === 'fixture' || ctx.config.diskQualifiedCatalogIds?.includes(item.id)),
  );
}
export async function diskOptions(ctx: AppContext) {
  const candidates = (await getCatalog(ctx)).filter((c) => diskCatalogEligible(ctx, c));
  const enabled = Boolean(
    ctx.config.disksEnabled &&
    ctx.wick.drives &&
    (ctx.wick.mode === 'fixture' || new Set(candidates.map((c) => c.provider)).size >= 2),
  );
  return {
    enabled,
    mode: ctx.wick.mode,
    eligibleCatalogIds: enabled ? candidates.map((c) => c.id) : [],
  };
}
export function requireDisks(ctx: AppContext) {
  if (!ctx.config.disksEnabled || !ctx.wick.drives)
    throw new HttpError(409, 'Persistent disks are not enabled.');
}
export async function requireDisk(
  ctx: AppContext,
  db: PoolClient,
  buyerId: string,
  diskId: string,
): Promise<Row> {
  requireDisks(ctx);
  const row = (
    await db.query('SELECT * FROM broker_disks WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
      uuid(diskId),
      buyerId,
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, 'Disk not found.');
  if (
    row.source_mode !== ctx.wick.mode ||
    row.status !== 'ready' ||
    !row.upstream_id ||
    row.cleanup_pending
  )
    throw new HttpError(409, 'This disk is not ready in the current integration mode.');
  return row;
}
export async function reserveVmDisk(db: PoolClient, vmId: string, diskId: string): Promise<void> {
  await db.query(
    'INSERT INTO broker_disk_attachments(disk_id,vm_id) VALUES($1,$2) ON CONFLICT(vm_id) DO NOTHING',
    [diskId, vmId],
  );
}
/** Observe the requested native mount before Broker can dispatch work or invoice it. */
export async function observeVmDisk(
  ctx: AppContext,
  vm: Row,
  environment: WickEnvironment,
): Promise<boolean> {
  if (!vm.disk_id) return true;
  const disk = (
    await ctx.pool.query('SELECT * FROM broker_disks WHERE id=$1 AND buyer_id=$2', [
      vm.disk_id,
      vm.buyer_id,
    ])
  ).rows[0];
  const a = environment.workspaceDrive;
  if (
    !disk ||
    disk.source_mode !== ctx.wick.mode ||
    !a ||
    a.driveId !== disk.upstream_id ||
    a.driveId !== vm.create_input.workspaceDrive?.driveId ||
    a.accessMode !== 'mount' ||
    a.attachmentMode !== 'shared' ||
    a.workspacePath !== '/workspace' ||
    !a.generation ||
    environment.id !== vm.environment_id
  )
    return false;
  const updated = await ctx.pool.query(
    `UPDATE broker_disk_attachments SET environment_id=$2,generation=$3,status=$4,updated_at=clock_timestamp() WHERE vm_id=$1 AND disk_id=$5 AND (generation IS NULL OR generation=$3) AND status<>'detached'`,
    [vm.id, environment.id, a.generation, a.status, disk.id],
  );
  return Boolean(updated.rowCount && a.status === 'mounted');
}
/** Termination acceptance alone cannot release an attachment. */
export async function reconcileVmDisk(
  ctx: AppContext,
  vm: Row,
  environment?: WickEnvironment,
): Promise<boolean> {
  if (!vm.disk_id) return true;
  if (
    !ctx.wick.drives ||
    !vm.environment_id ||
    !environment ||
    environment.id !== vm.environment_id ||
    environment.status !== 'terminated'
  )
    return false;
  const disk = (
    await ctx.pool.query(
      'SELECT * FROM broker_disks WHERE id=$1 AND buyer_id=$2 AND source_mode=$3',
      [vm.disk_id, vm.buyer_id, ctx.wick.mode],
    )
  ).rows[0];
  if (!disk?.upstream_id) return false;
  const observed = await ctx.wick.drives.get(disk.upstream_id);
  if (
    observed.drive.cleanupPending ||
    observed.drive.attachments.some((a) => a.environmentId === vm.environment_id)
  )
    return false;
  await ctx.pool.query(
    "UPDATE broker_disk_attachments SET status='detached',updated_at=clock_timestamp() WHERE vm_id=$1 AND disk_id=$2",
    [vm.id, disk.id],
  );
  return true;
}
export async function confirmVmDiskDetached(
  ctx: AppContext,
  db: PoolClient,
  vm: Row,
  definitiveNoAdmission = false,
): Promise<boolean> {
  if (!vm.disk_id) return true;
  if (definitiveNoAdmission && !vm.environment_id) {
    await db.query(
      "UPDATE broker_disk_attachments SET status='detached',updated_at=clock_timestamp() WHERE vm_id=$1",
      [vm.id],
    );
    return true;
  }
  return Boolean(
    (
      await db.query(
        "SELECT 1 FROM broker_disk_attachments WHERE vm_id=$1 AND disk_id=$2 AND status='detached'",
        [vm.id, vm.disk_id],
      )
    ).rowCount,
  );
}
export function workspaceView(r: Row): DiskWorkspace {
  return {
    id: r.id,
    diskId: r.disk_id,
    name: r.name,
    repositoryUrl: r.repository_url,
    commitSha: r.commit_sha,
    initialized: r.initialized,
    activeTaskId: r.active_task_id,
    status: r.active_task_id ? 'in_use' : 'available',
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
const projection = `SELECT d.*,d.created_at::text AS cursor_created_at,
 (SELECT count(*)::int FROM broker_disk_workspaces w WHERE w.disk_id=d.id) AS workspace_count,
 (SELECT count(*)::int FROM broker_disk_attachments a WHERE a.disk_id=d.id AND a.status<>'detached') AS attachment_count,
 EXISTS(SELECT 1 FROM broker_requests r WHERE r.disk_id=d.id AND r.status IN('open','provisioning')) OR
 EXISTS(SELECT 1 FROM broker_vms v WHERE v.disk_id=d.id AND v.cleanup_confirmed_at IS NULL) OR
 EXISTS(SELECT 1 FROM broker_disk_workspaces w WHERE w.disk_id=d.id AND w.active_task_id IS NOT NULL) OR
 EXISTS(SELECT 1 FROM broker_intents i WHERE i.desired->>'diskId'=d.id::text AND i.status='open') AS referenced
 FROM broker_disks d`;
function diskView(r: Row): Disk {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    sourceMode: r.source_mode,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    cleanupPending: r.cleanup_pending,
    failureReason: r.failure_reason,
    workspaceCount: r.workspace_count ?? 0,
    attachmentCount: r.attachment_count ?? 0,
    canDelete:
      ['ready', 'failed'].includes(r.status) &&
      !r.cleanup_pending &&
      !r.needs_sync &&
      !r.referenced &&
      !r.attachment_count,
  };
}
async function owned(ctx: AppContext, buyerId: string, id: string) {
  const r = (
    await ctx.pool.query(`${projection} WHERE d.id=$1 AND d.buyer_id=$2`, [uuid(id), buyerId])
  ).rows[0];
  if (!r) throw new HttpError(404, 'Disk not found.');
  return r;
}
export async function listDisks(ctx: AppContext, actor: Actor, query: unknown) {
  const { limit, cursor, cursorId } = pagination(query);
  const rows = (
    await ctx.pool.query(
      `${projection} WHERE d.buyer_id=$1 AND d.status<>'deleted' AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2,$3::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,
      [actor.id, cursor, cursorId, limit + 1],
    )
  ).rows;
  return {
    items: rows.slice(0, limit).map(diskView),
    ...(rows.length > limit ? { nextCursor: encodeCursor(rows[limit - 1]!) } : {}),
  };
}
export async function listWorkspaces(ctx: AppContext, actor: Actor, id: string, query?: unknown) {
  await owned(ctx, actor.id, id);
  const { limit, cursor, cursorId } = pagination(query);
  const rows = (
    await ctx.pool.query(
      `SELECT *,created_at::text AS cursor_created_at FROM broker_disk_workspaces WHERE disk_id=$1 AND buyer_id=$2
    AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
      [id, actor.id, cursor, cursorId, limit + 1],
    )
  ).rows;
  return {
    items: rows.slice(0, limit).map(workspaceView),
    ...(rows.length > limit ? { nextCursor: encodeCursor(rows[limit - 1]!) } : {}),
  };
}
export async function diskDetail(ctx: AppContext, actor: Actor, id: string): Promise<DiskDetail> {
  const disk = diskView(await owned(ctx, actor.id, id));
  const [workspaces, attachments] = await Promise.all([
    listWorkspaces(ctx, actor, id, { limit: 100 }),
    ctx.pool.query(
      `SELECT a.*,v.create_input->>'name' AS vm_name,v.catalog_snapshot->>'provider' AS provider FROM broker_disk_attachments a JOIN broker_vms v ON v.id=a.vm_id WHERE a.disk_id=$1 AND v.buyer_id=$2 AND a.status<>'detached' ORDER BY a.created_at,a.vm_id LIMIT 100`,
      [id, actor.id],
    ),
  ]);
  return {
    disk,
    workspaces: workspaces.items,
    attachments: attachments.rows.map((r): DiskAttachment => ({
      vmId: r.vm_id,
      environmentId: r.environment_id,
      status: r.status,
      generation: r.generation,
      provider: r.provider,
      vmName: r.vm_name,
      createdAt: r.created_at.toISOString(),
    })),
  };
}
const nameSchema = z.string().trim().min(1).max(100);
export async function createDisk(ctx: AppContext, actor: Actor, body: unknown) {
  requireDisks(ctx);
  if (!(await diskOptions(ctx)).enabled)
    throw new HttpError(
      409,
      'Qualify shared native mounts on at least two provider routes before creating real disks.',
    );
  const b = z
    .object({ name: nameSchema, operationKey: z.string().optional() })
    .strict()
    .parse(body);
  const key = clientOperationKey(b.operationKey, Boolean(actor.apiKey)) ?? `disk:${randomUUID()}`;
  const receipt = await transaction(ctx.pool, (db) =>
    withOperation(
      db,
      actor,
      'disks.create',
      key,
      { name: b.name, mode: ctx.wick.mode },
      async () => {
        const id = randomUUID();
        await db.query(
          'INSERT INTO broker_disks(id,buyer_id,name,source_mode,create_key) VALUES($1,$2,$3,$4,$5)',
          [id, actor.id, b.name, ctx.wick.mode, `broker-disk:${id}`],
        );
        await enqueue(ctx, db, DISK_QUEUE, { id });
        return { id };
      },
    ),
  );
  return diskView(await owned(ctx, actor.id, receipt.id));
}
export async function renameDisk(ctx: AppContext, actor: Actor, id: string, body: unknown) {
  const b = z
    .object({ name: nameSchema, operationKey: z.string().optional() })
    .strict()
    .parse(body);
  const key = clientOperationKey(b.operationKey, Boolean(actor.apiKey));
  await transaction(ctx.pool, (db) =>
    withOperation(db, actor, 'disks.rename', key, { id, name: b.name }, async () => {
      await requireDisk(ctx, db, actor.id, id);
      await db.query(
        'UPDATE broker_disks SET name=$2,needs_sync=true,attempts=0,updated_at=clock_timestamp() WHERE id=$1',
        [id, b.name],
      );
      await enqueue(ctx, db, DISK_QUEUE, { id });
      return { id };
    }),
  );
  return diskView(await owned(ctx, actor.id, id));
}
export async function deleteDisk(ctx: AppContext, actor: Actor, id: string, body: unknown) {
  const b = z
    .object({ operationKey: z.string().optional() })
    .strict()
    .parse(body ?? {});
  const key = clientOperationKey(b.operationKey, Boolean(actor.apiKey));
  await transaction(ctx.pool, (db) =>
    withOperation(db, actor, 'disks.delete', key, { id }, async () => {
      // Lock first, then inspect references with a fresh READ COMMITTED snapshot.
      // A request waiting on this same disk lock cannot race deletion.
      const locked = (
        await db.query('SELECT id FROM broker_disks WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
          uuid(id),
          actor.id,
        ])
      ).rows[0];
      if (!locked) throw new HttpError(404, 'Disk not found.');
      const r = (await db.query(`${projection} WHERE d.id=$1 AND d.buyer_id=$2`, [id, actor.id]))
        .rows[0];
      if (r.source_mode !== ctx.wick.mode)
        throw new HttpError(409, 'Use the disk’s original integration mode for cleanup.');
      if (!diskView(r).canDelete)
        throw new HttpError(409, 'This disk has pending work, attachments, or unresolved cleanup.');
      await db.query(
        "UPDATE broker_disks SET status='deleting',delete_key=COALESCE(delete_key,$2),attempts=0,needs_sync=false,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [id, `broker-disk-delete:${id}`],
      );
      await enqueue(ctx, db, DISK_QUEUE, { id });
      return { id };
    }),
  );
  return diskView(await owned(ctx, actor.id, id));
}
