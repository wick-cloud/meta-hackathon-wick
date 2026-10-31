import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../../shared/types.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { authority, lockedGrant, event } from '../inference/data.js';
import { applyCreditEntry } from '../agreements/credits.js';
import { transaction } from '../db.js';
import type { Row } from '../marketplace/data.js';
import { subtractCents } from '../../shared/money.js';

export type StudioSource = { id: string; leaseToken: string };
export async function studioAuthority(db: PoolClient, source: StudioSource, actor: Actor) {
  if (actor.apiKey || actor.role !== 'buyer')
    throw new HttpError(403, 'Studio requires durable owner authority.');
  const row = (
    await db.query(
      `SELECT t.* FROM broker_studio_tasks t JOIN "user" u ON u.id=t.buyer_id WHERE t.id=$1 AND t.buyer_id=$2
 AND t.lease_token=$3 AND t.lease_until>clock_timestamp() AND NOT t.stop_requested
 AND t.deadline_at>clock_timestamp() AND t.outcome IS NULL AND u.role='buyer' FOR SHARE OF t,u`,
      [source.id, actor.id, source.leaseToken],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(409, 'Studio task authority changed. No new action was authorized.');
  return row;
}
/** Grant is always locked before the task, matching token-market lock ordering. */
export async function reserveStudioCompute(
  ctx: AppContext,
  actor: Actor,
  source: StudioSource,
  amount: number,
) {
  const meta = (
    await ctx.pool.query('SELECT grant_id FROM broker_studio_tasks WHERE id=$1 AND buyer_id=$2', [
      source.id,
      actor.id,
    ])
  ).rows[0];
  if (!meta) throw new HttpError(404, 'Task not found.');
  await transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, meta.grant_id, true);
    await studioAuthority(db, source, actor);
    const task = (
      await db.query('SELECT * FROM broker_studio_tasks WHERE id=$1 FOR UPDATE', [source.id])
    ).rows[0];
    if (task.compute_charged_cents || task.vm_request_id) return;
    const difference = subtractCents(amount, task.compute_reserved_cents);
    if (difference === 0) return;
    if (difference > Number(grant.available_cents))
      throw new HttpError(409, 'The remaining task budget cannot cover compute.');
    await db.query(
      'UPDATE broker_inference_grants SET available_cents=available_cents-$2,held_cents=held_cents+$2 WHERE id=$1',
      [grant.id, difference],
    );
    await db.query('UPDATE broker_studio_tasks SET compute_reserved_cents=$2 WHERE id=$1', [
      task.id,
      amount,
    ]);
    await event(
      db,
      grant.id,
      `studio-compute-reserve:${task.id}:${randomUUID()}`,
      'studio_compute_reserved',
      task.id,
      actor.id,
      { amountCents: amount },
    );
  });
}
/** Never releases an uncertain allocation. A ready VM is charged once; a failed start needs cleanup proof. */
export async function settleStudioCompute(
  ctx: AppContext,
  actor: Actor,
  taskId: string,
  release = false,
) {
  const meta = (
    await ctx.pool.query('SELECT grant_id FROM broker_studio_tasks WHERE id=$1 AND buyer_id=$2', [
      taskId,
      actor.id,
    ])
  ).rows[0];
  if (!meta) throw new HttpError(404, 'Task not found.');
  return transaction(ctx.pool, async (db) => {
    const grant = await lockedGrant(db, actor, meta.grant_id);
    const task = (
      await db.query('SELECT * FROM broker_studio_tasks WHERE id=$1 FOR UPDATE', [taskId])
    ).rows[0];
    const held = Number(task.compute_reserved_cents);
    if (!held) return true;
    const request = task.vm_request_id
      ? (
          await db.query('SELECT status FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
            task.vm_request_id,
            actor.id,
          ])
        ).rows[0]
      : null;
    const vm = task.vm_request_id
      ? (
          await db.query(
            'SELECT ready_at,cleanup_confirmed_at,quote_snapshot FROM broker_vms WHERE request_id=$1 AND buyer_id=$2',
            [task.vm_request_id, actor.id],
          )
        ).rows[0]
      : null;
    const charged = vm?.ready_at ? Number(vm.quote_snapshot.totalPriceCents) : 0;
    if (
      !charged &&
      (!release || (vm && !vm.cleanup_confirmed_at) || (!vm && request?.status === 'open'))
    )
      return false;
    if (charged > held)
      throw new HttpError(409, 'The accepted compute charge exceeds its task reservation.');
    const spare = subtractCents(held, charged),
      active = grant.status === 'active' && new Date(grant.expires_at) > new Date();
    await applyCreditEntry(db, actor.id, {
      operationKey: `studio-compute-settle:${task.id}`,
      kind: 'studio_compute',
      grantId: grant.id,
      balanceDeltaCents: -charged,
      reservedDeltaCents: active ? -charged : -held,
      description: charged
        ? 'Studio task: accepted VM rental'
        : 'Studio task: release unallocated compute',
    });
    await db.query(
      `UPDATE broker_inference_grants SET held_cents=held_cents-$2,spent_cents=spent_cents+$3,
    available_cents=available_cents+$4,returned_cents=returned_cents+$5 WHERE id=$1`,
      [grant.id, held, charged, active ? spare : 0, active ? 0 : spare],
    );
    await db.query(
      'UPDATE broker_studio_tasks SET compute_reserved_cents=0,compute_charged_cents=$2 WHERE id=$1',
      [task.id, charged],
    );
    await db.query(
      `UPDATE broker_inference_grants g SET status='closed' WHERE id=$1 AND status='closing' AND held_cents=0
    AND NOT EXISTS(SELECT 1 FROM broker_inference_requests WHERE grant_id=g.id AND status NOT IN('settled','rejected'))`,
      [grant.id],
    );
    return true;
  });
}
export async function studioGrantOpen(db: PoolClient, grantId: string) {
  const task = (
    await db.query(
      'SELECT stop_requested,deadline_at,outcome FROM broker_studio_tasks WHERE grant_id=$1 FOR SHARE',
      [grantId],
    )
  ).rows[0] as Row | undefined;
  return (
    !task || (!task.stop_requested && !task.outcome && new Date(task.deadline_at) > new Date())
  );
}
