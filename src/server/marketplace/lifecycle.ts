import { observeVmDisk, reconcileVmDisk, confirmVmDiskDetached } from '../disks/service.js';
import type { Actor } from '../../shared/types.js';
import { withOperation } from '../operations.js';
import type { AppContext } from '../context.js';
import type { WickEnvironment } from '../integrations/types.js';
import {
  discoverEnvironment,
  managedEnvironmentMatches,
  environmentOwnershipMatches,
} from '../integrations/discovery.js';
import { transaction, enqueue, activity, QUEUES } from './db.js';
import { scheduledActivationReady, scheduledActivationCleaned } from '../agreements/activation.js';
import type { Row } from './data.js';

const MAX_PROVISION_POLLS = 60;
const MAX_CLEANUP_POLLS = 60;
const safeError = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 300) : 'Upstream operation failed.';

async function claim(
  ctx: AppContext,
  vmId: string,
  kind: 'provision' | 'cleanup',
): Promise<Row | undefined> {
  const counter = kind === 'provision' ? 'poll_attempts' : 'cleanup_attempts';
  const eligible = kind === 'provision' ? "status='provisioning'" : 'cleanup_confirmed_at IS NULL';
  const max = kind === 'provision' ? MAX_PROVISION_POLLS : MAX_CLEANUP_POLLS;
  const row = (
    await ctx.pool.query(
      `UPDATE broker_vms SET lease_until=now()+interval '90 seconds',${counter}=${counter}+1 WHERE id=$1 AND ${eligible} AND COALESCE(catalog_snapshot->>'sourceMode','fixture')=$2 AND ${counter}<${max} AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
      [vmId, ctx.wick.mode],
    )
  ).rows[0];
  if (!row) {
    // A durable retry may arrive while a previous attempt's lease remains after
    // a crash or database error. Preserve future work rather than consuming it.
    const pending = (
      await ctx.pool.query(
        `SELECT ${counter} AS attempts,GREATEST(0,EXTRACT(EPOCH FROM(lease_until-clock_timestamp()))) AS delay FROM broker_vms WHERE id=$1 AND ${eligible} AND COALESCE(catalog_snapshot->>'sourceMode','fixture')=$2`,
        [vmId, ctx.wick.mode],
      )
    ).rows[0];
    if (pending && Number(pending.delay) > 0 && pending.attempts < max)
      await transaction(ctx.pool, (db) =>
        enqueue(
          ctx,
          db,
          kind === 'provision' ? QUEUES.provision : QUEUES.cleanup,
          { vmId },
          Math.ceil(Number(pending.delay)) + 1,
        ),
      );
    else if (pending && kind === 'provision' && pending.attempts >= max)
      await requestCleanup(
        ctx,
        vmId,
        'Provisioning confirmation exhausted its retry budget; cleanup requires confirmation.',
      );
  }
  return row;
}

async function persistObservation(ctx: AppContext, vmId: string, environment: WickEnvironment) {
  // Admission expiry is authoritative. Stored expiry prevents retries/reconnects
  // from extending the original lease; an earlier upstream expiry shortens it.
  const result = await ctx.pool.query(
    `UPDATE broker_vms SET environment_id=COALESCE(environment_id,$2),expires_at=CASE WHEN expires_at IS NULL THEN $3::timestamptz WHEN $3::timestamptz IS NULL THEN expires_at ELSE LEAST(expires_at,$3::timestamptz) END,admitted_at=COALESCE(admitted_at,$4::timestamptz) WHERE id=$1 AND COALESCE(catalog_snapshot->>'sourceMode','fixture')=$5 AND (environment_id IS NULL OR environment_id=$2)`,
    [vmId, environment.id, environment.expiresAt, environment.createdAt || null, ctx.wick.mode],
  );
  if (!result.rowCount)
    throw new Error(
      'Wick returned an unexpected environment identifier; lifecycle confirmation rejected.',
    );
}

export async function markReady(
  ctx: AppContext,
  vmId: string,
  observation?: WickEnvironment,
  terminalConfirmed = false,
) {
  return transaction(ctx.pool, async (db) => {
    const vm = (await db.query('SELECT * FROM broker_vms WHERE id=$1 FOR UPDATE', [vmId])).rows[0];
    if (
      !vm ||
      vm.status !== 'provisioning' ||
      vm.termination_requested_at ||
      (vm.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode
    )
      return false;
    if (
      ctx.wick.mode === 'real' &&
      (!managedEnvironmentMatches(observation, vm.create_input) ||
        observation?.id !== vm.environment_id ||
        observation?.status !== 'running' ||
        !observation.expiresAt ||
        !Number.isFinite(Date.parse(observation.expiresAt)) ||
        Date.parse(observation.expiresAt) <= Date.now() ||
        !terminalConfirmed ||
        !environmentOwnershipMatches(observation, vm.create_input, vm.created_at))
    )
      return false;
    if (vm.disk_id) {
      if (
        !observation?.workspaceDrive ||
        observation.workspaceDrive.driveId !== vm.create_input.workspaceDrive?.driveId ||
        observation.workspaceDrive.status !== 'mounted' ||
        observation.workspaceDrive.accessMode !== 'mount' ||
        observation.workspaceDrive.attachmentMode !== 'shared' ||
        observation.workspaceDrive.workspacePath !== '/workspace'
      )
        return false;
      const attachment = (
        await db.query(
          "SELECT 1 FROM broker_disk_attachments WHERE vm_id=$1 AND disk_id=$2 AND status='mounted' AND generation=$3 AND environment_id=$4",
          [vm.id, vm.disk_id, observation.workspaceDrive.generation, observation.id],
        )
      ).rows[0];
      if (!attachment) return false;
    }
    const eligible = (
      await db.query('SELECT $1::timestamptz>clock_timestamp() AS eligible', [vm.expires_at])
    ).rows[0].eligible;
    if (!eligible) return false;
    await db.query(
      "UPDATE broker_vms SET status='running',ready_at=COALESCE(ready_at,now()),failure_reason=NULL,lease_until=NULL WHERE id=$1",
      [vmId],
    );
    await db.query("UPDATE broker_requests SET status='ready',failure_reason=NULL WHERE id=$1", [
      vm.request_id,
    ]);
    if (vm.quote_snapshot.billingSource === 'scheduled_capacity') {
      await scheduledActivationReady(ctx, db, vm);
    } else {
      await db.query(
        `INSERT INTO broker_invoices(vm_id,buyer_id,provider_id,subtotal_cents,total_cents,revenue_share) VALUES($1,$2,$3,$4,$4,$5) ON CONFLICT(vm_id) DO NOTHING`,
        [
          vmId,
          vm.buyer_id,
          vm.provider_id,
          vm.quote_snapshot.totalPriceCents,
          vm.quote_snapshot.revenueShare ?? null,
        ],
      );
    }
    await activity(
      db,
      vm.provider_id,
      vm.request_id,
      'ready',
      vm.quote_snapshot.billingSource === 'scheduled_capacity'
        ? 'Scheduled capacity VM is ready. Its booked block is settled separately; no duplicate VM invoice.'
        : 'Wick confirmed running and terminal capability. One fixed demo invoice issued; no payment due.',
    );
    const delay = Math.max(0, Math.ceil((new Date(vm.expires_at).getTime() - Date.now()) / 1000));
    await enqueue(ctx, db, QUEUES.cleanup, { vmId }, delay);
    return true;
  });
}

async function requestCleanup(ctx: AppContext, vmId: string, reason: string, expired = false) {
  await transaction(ctx.pool, async (db) => {
    const vm = (await db.query('SELECT * FROM broker_vms WHERE id=$1 FOR UPDATE', [vmId])).rows[0];
    if (
      !vm ||
      vm.cleanup_confirmed_at ||
      (vm.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode
    )
      return;
    await db.query(
      `UPDATE broker_vms SET status=$2,termination_requested_at=COALESCE(termination_requested_at,now()),failure_reason=COALESCE(failure_reason,$3),lease_until=NULL WHERE id=$1`,
      [vmId, expired ? 'expired' : 'terminating', reason],
    );
    if (!vm.ready_at)
      await db.query(
        "UPDATE broker_requests SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,failure_reason=$2 WHERE id=$1",
        [vm.request_id, reason],
      );
    await enqueue(ctx, db, QUEUES.cleanup, { vmId });
  });
}

export async function provisionVm(ctx: AppContext, vmId: string) {
  const vm = await claim(ctx, vmId, 'provision');
  if (!vm) return;
  if (vm.quote_snapshot.studioTaskId) {
    const allowed = (
      await ctx.pool.query(
        `SELECT 1 FROM broker_studio_tasks WHERE id=$1 AND NOT stop_requested AND outcome IS NULL AND deadline_at>clock_timestamp()`,
        [vm.quote_snapshot.studioTaskId],
      )
    ).rowCount;
    if (!allowed) {
      if (vm.poll_attempts === 1 && !vm.environment_id)
        await confirmCleanup(ctx, vmId, 'Task stopped before VM admission.', true);
      else await requestCleanup(ctx, vmId, 'Task stopped; reconciling its original allocation.');
      return;
    }
  }
  const admissionDeadline = vm.create_input.hardEndAt ?? vm.quote_snapshot.admissionDeadlineAt;
  if (!vm.environment_id && admissionDeadline && Date.parse(admissionDeadline) <= Date.now()) {
    if (vm.poll_attempts === 1)
      await confirmCleanup(
        ctx,
        vmId,
        'The admission deadline elapsed before the first create; no VM was allocated.',
        true,
      );
    else
      await requestCleanup(
        ctx,
        vmId,
        'The original admission deadline elapsed; prior admission requires reconciliation.',
        true,
      );
    return;
  }
  try {
    let environment: WickEnvironment;
    if (vm.environment_id) {
      environment = await ctx.wick.get(vm.environment_id);
    } else {
      const result = await ctx.wick.create(vm.create_input, vm.create_key);
      environment = result.environment;
    }
    if (
      ctx.wick.mode === 'real' &&
      !environmentOwnershipMatches(environment, vm.create_input, vm.created_at)
    )
      throw new Error('Wick environment ownership is unverified; admission remains UNKNOWN.');
    await persistObservation(ctx, vmId, environment);
    const current = (await ctx.pool.query('SELECT * FROM broker_vms WHERE id=$1', [vmId])).rows[0];
    if (current.termination_requested_at || current.status !== 'provisioning') {
      await requestCleanup(ctx, vmId, 'Termination requested before the environment was ready.');
      return;
    }
    if (
      ctx.wick.mode === 'real' &&
      (environment.billingMode === 'byok' ||
        environment.providerKeyId ||
        (environment.status === 'running' &&
          !managedEnvironmentMatches(environment, vm.create_input)))
    ) {
      await requestCleanup(
        ctx,
        vmId,
        'Unexpected or unverified Wick billing scope; quarantined for cleanup without an invoice.',
      );
      return;
    }
    if (current.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
      await requestCleanup(
        ctx,
        vmId,
        'The rental expired before terminal readiness; no charge.',
        true,
      );
      return;
    }
    if (environment.status === 'terminated') {
      if (current.disk_id && !(await reconcileVmDisk(ctx, current, environment)))
        throw new Error('Persistent disk detachment is not confirmed.');
      await confirmCleanup(ctx, vmId, 'Wick terminated the environment before readiness.');
      return;
    }
    if (environment.status === 'failed') {
      await requestCleanup(ctx, vmId, 'Wick confirmed provisioning failure; no charge.');
      return;
    }
    if (environment.status === 'running' && current.expires_at) {
      if (current.disk_id && !(await observeVmDisk(ctx, current, environment))) {
        await retryProvision(
          ctx,
          vmId,
          vm.poll_attempts,
          'Waiting for the requested persistent disk mount.',
        );
        return;
      }
      const connections = await ctx.wick.connections(environment.id);
      if (connections.terminal && (await markReady(ctx, vmId, environment, true))) return;
    }
    await retryProvision(
      ctx,
      vmId,
      vm.poll_attempts,
      environment.expiresAt
        ? 'Waiting for Wick running state and terminal capability.'
        : 'Wick has not supplied an authoritative rental expiry.',
    );
  } catch (error) {
    const rejected = Boolean((error as { admissionRejected?: boolean })?.admissionRejected);
    if (rejected && !vm.environment_id && vm.poll_attempts === 1) {
      await confirmCleanup(
        ctx,
        vmId,
        'Wick rejected provisioning before admission; no charge.',
        true,
      );
    } else {
      await retryProvision(
        ctx,
        vmId,
        vm.poll_attempts,
        `Provisioning is not confirmed: ${safeError(error)}`,
      );
    }
  }
}

async function retryProvision(ctx: AppContext, vmId: string, attempt: number, message: string) {
  await transaction(ctx.pool, async (db) => {
    const vm = (await db.query('SELECT * FROM broker_vms WHERE id=$1 FOR UPDATE', [vmId])).rows[0];
    if (
      !vm ||
      vm.cleanup_confirmed_at ||
      (vm.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode
    )
      return;
    await db.query('UPDATE broker_vms SET lease_until=NULL,failure_reason=$2 WHERE id=$1', [
      vmId,
      message,
    ]);
    if (vm.termination_requested_at || vm.status !== 'provisioning') {
      await enqueue(ctx, db, QUEUES.cleanup, { vmId });
      return;
    }
    if (attempt >= MAX_PROVISION_POLLS) {
      await db.query(
        "UPDATE broker_vms SET status='failed',termination_requested_at=now(),failure_reason=$2 WHERE id=$1",
        [
          vmId,
          'Provisioning confirmation timed out. Cleanup is being reconciled; no invoice issued.',
        ],
      );
      await db.query(
        "UPDATE broker_requests SET status='failed',failure_reason='Provisioning confirmation timed out; no charge.' WHERE id=$1",
        [vm.request_id],
      );
      await enqueue(ctx, db, QUEUES.cleanup, { vmId });
    } else await enqueue(ctx, db, QUEUES.provision, { vmId }, Math.min(15, 2 + attempt));
  });
}

export async function confirmCleanup(
  ctx: AppContext,
  vmId: string,
  message = 'Wick confirmed cleanup.',
  admissionRejected = false,
) {
  await transaction(ctx.pool, async (db) => {
    const vm = (await db.query('SELECT * FROM broker_vms WHERE id=$1 FOR UPDATE', [vmId])).rows[0];
    if (
      !vm ||
      vm.cleanup_confirmed_at ||
      (vm.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode
    )
      return;
    if (vm.disk_id && !(await confirmVmDiskDetached(ctx, db, vm, admissionRejected)))
      throw new Error('Persistent disk detachment is not confirmed.');
    const expired = vm.expires_at && new Date(vm.expires_at).getTime() <= Date.now();
    const status = expired ? 'expired' : vm.ready_at ? 'terminated' : 'failed';
    await db.query(
      'UPDATE broker_vms SET status=$2,cleanup_confirmed_at=now(),lease_until=NULL,failure_reason=CASE WHEN ready_at IS NULL THEN $3 ELSE failure_reason END WHERE id=$1',
      [vmId, status, message],
    );
    await db.query(
      'UPDATE broker_holds SET released_at=now(),release_reason=$2 WHERE bid_id=$1 AND released_at IS NULL',
      [vm.bid_id, admissionRejected ? 'Rejected before admission' : 'Confirmed Wick cleanup'],
    );
    if (vm.quote_snapshot.billingSource === 'scheduled_capacity')
      await scheduledActivationCleaned(ctx, db, vm, { admissionRejected });
    if (!vm.ready_at)
      await db.query(
        "UPDATE broker_requests SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,failure_reason=$2 WHERE id=$1",
        [vm.request_id, message],
      );
    await activity(
      db,
      vm.provider_id,
      vm.request_id,
      'cleaned_up',
      `${message} Supplier reservation released.`,
    );
  });
}

export async function cleanupVm(ctx: AppContext, vmId: string) {
  const current = (await ctx.pool.query('SELECT * FROM broker_vms WHERE id=$1', [vmId])).rows[0];
  if (
    !current ||
    current.cleanup_confirmed_at ||
    (current.catalog_snapshot.sourceMode ?? 'fixture') !== ctx.wick.mode
  )
    return;
  if (
    current.status === 'running' &&
    !current.termination_requested_at &&
    current.expires_at &&
    new Date(current.expires_at).getTime() > Date.now()
  ) {
    await transaction(ctx.pool, (db) =>
      enqueue(
        ctx,
        db,
        QUEUES.cleanup,
        { vmId },
        Math.max(1, Math.ceil((new Date(current.expires_at).getTime() - Date.now()) / 1000)),
      ),
    );
    return;
  }
  const vm = await claim(ctx, vmId, 'cleanup');
  if (!vm) return;
  if (!vm.environment_id && vm.poll_attempts === 0) {
    await confirmCleanup(ctx, vmId, 'Cancelled before Wick admission; no charge.', true);
    return;
  }
  try {
    await ctx.pool.query(
      "UPDATE broker_vms SET status=CASE WHEN status='expired' THEN status ELSE 'terminating' END,termination_requested_at=COALESCE(termination_requested_at,now()) WHERE id=$1",
      [vmId],
    );
    let environment: WickEnvironment;
    if (!vm.environment_id) {
      // Cleanup is strictly read-only discovery followed by exact-ID termination.
      // Replaying even the original key could allocate when the first call never arrived.
      const discovered = await discoverEnvironment(ctx.wick, vm.create_input, vm.created_at);
      if (!discovered)
        throw new Error(
          'Wick admission remains UNKNOWN; no matching environment discovered. Native TTL is a backstop, not cleanup confirmation.',
        );
      environment = discovered;
    } else environment = await ctx.wick.get(vm.environment_id);
    if (
      ctx.wick.mode === 'real' &&
      !environmentOwnershipMatches(environment, vm.create_input, vm.created_at)
    )
      throw new Error('Wick cleanup ownership is unverified; no termination was attempted.');
    await persistObservation(ctx, vmId, environment);
    if (environment.status === 'terminated') {
      if (
        vm.disk_id &&
        !(await reconcileVmDisk(ctx, { ...vm, environment_id: environment.id }, environment))
      )
        throw new Error('Persistent disk detachment is not confirmed.');
      await confirmCleanup(ctx, vmId);
      return;
    }
    await ctx.wick.terminate(environment.id);
    // Termination acceptance is not cleanup confirmation.
    const observed = await ctx.wick.get(environment.id);
    if (
      ctx.wick.mode === 'real' &&
      !environmentOwnershipMatches(observed, vm.create_input, vm.created_at)
    )
      throw new Error('Wick cleanup observation ownership is unverified.');
    await persistObservation(ctx, vmId, observed);
    if (observed.status === 'terminated') {
      if (
        vm.disk_id &&
        !(await reconcileVmDisk(ctx, { ...vm, environment_id: observed.id }, observed))
      )
        throw new Error('Persistent disk detachment is not confirmed.');
      await confirmCleanup(ctx, vmId);
      return;
    }
    await retryCleanup(
      ctx,
      vmId,
      vm.cleanup_attempts,
      'Waiting for Wick to confirm environment cleanup.',
    );
  } catch (error) {
    await retryCleanup(
      ctx,
      vmId,
      vm.cleanup_attempts,
      `Cleanup is not confirmed: ${safeError(error)}`,
    );
  }
}
async function retryCleanup(ctx: AppContext, vmId: string, attempt: number, message: string) {
  await transaction(ctx.pool, async (db) => {
    await db.query(
      'UPDATE broker_vms SET lease_until=NULL,failure_reason=$2 WHERE id=$1 AND cleanup_confirmed_at IS NULL',
      [
        vmId,
        attempt >= MAX_CLEANUP_POLLS
          ? `${message} Automatic retries paused after ${MAX_CLEANUP_POLLS} attempts; an administrator can retry reconciliation.`
          : message,
      ],
    );
    if (attempt < MAX_CLEANUP_POLLS)
      await enqueue(ctx, db, QUEUES.cleanup, { vmId }, Math.min(30, 2 + attempt));
  });
}

export async function terminateVm(
  ctx: AppContext,
  buyerId: string,
  vmId: string,
  actor?: Actor,
  operationKey?: string,
) {
  return transaction(ctx.pool, async (db) =>
    withOperation(
      db,
      actor ?? { id: buyerId },
      'vms.terminate',
      operationKey,
      { vmId },
      async () => {
        const vm = (
          await db.query('SELECT * FROM broker_vms WHERE id=$1 AND buyer_id=$2 FOR UPDATE', [
            vmId,
            buyerId,
          ])
        ).rows[0];
        if (!vm) return false;
        if (vm.cleanup_confirmed_at) return true;
        await db.query(
          "UPDATE broker_vms SET status='terminating',termination_requested_at=COALESCE(termination_requested_at,now()),cleanup_attempts=0 WHERE id=$1",
          [vmId],
        );
        if (!vm.ready_at)
          await db.query(
            "UPDATE broker_requests SET status='cancelled',failure_reason='Cancelled before terminal readiness; no charge.' WHERE id=$1",
            [vm.request_id],
          );
        await enqueue(ctx, db, QUEUES.cleanup, { vmId });
        return true;
      },
    ),
  );
}
