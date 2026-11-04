import { warmDemoDisks, claimDemoDisk, demoDiskDetached } from './disks.js';
import { reconcileDemoStudio } from './studio.js';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { transaction, enqueue } from '../marketplace/db.js';
import type { Row } from '../marketplace/data.js';
import type { CatalogItem } from '../../shared/types.js';
import { createTokenOrder } from '../inference/market.js';
import { closeGrant } from '../inference/grants.js';
import { createDisk, deleteDisk, diskDetail, observeVmDisk } from '../disks/service.js';
import { createRequest, cancelRequest } from '../marketplace/auction.js';
import { terminateVm } from '../marketplace/lifecycle.js';
import { demoBootstrapCommand } from './script.js';
import { demoReceiptFacts } from './receipt.js';
import { INFERENCE_PROVIDERS } from '../../shared/inference.js';
import {
  DEMO_QUEUE,
  DEMO_CATALOG_ID,
  DEMO_LIMITS,
  demoActor,
  demoEvent,
  demoModeAllowed,
} from './service.js';

async function save(ctx: AppContext, run: Row, assignment: string, values: unknown[] = []) {
  return (
    await ctx.pool.query(
      `UPDATE broker_demo_runs SET ${assignment},updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 RETURNING *`,
      [run.id, run.lease_token, ...values],
    )
  ).rows[0] as Row | undefined;
}
async function phase(ctx: AppContext, run: Row, status: string, message: string) {
  await ctx.pool.query(
    `UPDATE broker_demo_runs SET status=$3,message=$4,updated_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND NOT stop_requested`,
    [run.id, run.lease_token, status, message],
  );
}
async function fail(ctx: AppContext, run: Row, message: string) {
  await save(ctx, run, "status='ending',stop_requested=true,failed=true,message=$3", [message]);
}
/** Recover local commits made before the demo worker checkpoint, without repeating native work. */
async function discover(ctx: AppContext, run: Row): Promise<Row> {
  const [operations, token, vm] = await Promise.all([
    ctx.pool.query(
      `SELECT operation,response FROM broker_operation_receipts WHERE owner_id=$1
      AND ((operation='disks.create' AND operation_key=$2) OR (operation='orders.create' AND operation_key=$3))`,
      [run.buyer_id, `demo:${run.id}:disk`, `demo:${run.id}:vm`],
    ),
    ctx.pool.query(
      `SELECT o.id,p.id pack_id FROM broker_token_orders o LEFT JOIN broker_token_packs p ON p.order_id=o.id
      WHERE o.grant_id=$1 AND o.operation_key=$2`,
      [run.grant_id, `demo:${run.id}:tokens`],
    ),
    ctx.pool.query(
      `SELECT v.id FROM broker_vms v JOIN broker_requests r ON r.id=v.request_id
      WHERE r.buyer_id=$1 AND r.description=$2 LIMIT 1`,
      [run.buyer_id, `Homepage demo ${run.id}`],
    ),
  ]);
  const disk = operations.rows.find((r) => r.operation === 'disks.create')?.response?.id;
  const request = operations.rows.find((r) => r.operation === 'orders.create')?.response?.id;
  return (
    (await save(
      ctx,
      run,
      'disk_id=COALESCE(disk_id,$3),request_id=COALESCE(request_id,$4),token_order_id=COALESCE(token_order_id,$5),pack_id=COALESCE(pack_id,$6),vm_id=COALESCE(vm_id,$7)',
      [
        disk ?? null,
        request ?? null,
        token.rows[0]?.id ?? null,
        token.rows[0]?.pack_id ?? null,
        vm.rows[0]?.id ?? null,
      ],
    )) ?? run
  );
}

async function cleanup(ctx: AppContext, run: Row): Promise<void> {
  if (run.source_mode !== ctx.wick.mode || run.source_mode !== ctx.inference?.mode) return;
  const actor = demoActor(run);
  if (run.kind === 'studio')
    await ctx.pool.query(
      "UPDATE broker_demo_studio SET status='needs_attention',failure_code='session_ended',updated_at=clock_timestamp() WHERE run_id=$1 AND status NOT IN('passed','needs_attention')",
      [run.id],
    );
  // Never hold a demo row lock while taking grant/key locks; inference uses grant → demo.
  await ctx.pool.query(
    'UPDATE broker_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND grant_id=$2',
    [run.buyer_id, run.grant_id],
  );
  await closeGrant(ctx, actor, run.grant_id, { operationKey: `demo:${run.id}:close-grant` });
  if (run.request_id) {
    const request = (
      await ctx.pool.query('SELECT status FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
        run.request_id,
        run.buyer_id,
      ])
    ).rows[0];
    if (request?.status === 'open') {
      try {
        await cancelRequest(ctx, actor, run.request_id, `demo:${run.id}:cancel-vm`);
      } catch {
        return;
      } // Award may have committed; discover the VM on the next tick.
    }
    const vm = (
      await ctx.pool.query('SELECT * FROM broker_vms WHERE request_id=$1 AND buyer_id=$2', [
        run.request_id,
        run.buyer_id,
      ])
    ).rows[0];
    if (vm) {
      await save(ctx, run, 'vm_id=$3', [vm.id]);
      if (!vm.cleanup_confirmed_at) {
        await terminateVm(ctx, run.buyer_id, vm.id, actor, `demo:${run.id}:terminate`);
        return;
      }
      await save(
        ctx,
        run,
        "vm_cleanup_at=COALESCE(vm_cleanup_at,$3),cooldown_until=COALESCE(cooldown_until,$3::timestamptz+interval '20 minutes')",
        [vm.cleanup_confirmed_at],
      );
    } else if (request?.status === 'provisioning' || request?.status === 'ready') return;
  }
  if (run.disk_id && run.reusable_disk) {
    if (!(await demoDiskDetached(ctx, run))) return;
  } else if (run.disk_id) {
    const disk = await diskDetail(ctx, actor, run.disk_id);
    if (disk.disk.status !== 'deleted') {
      if (disk.disk.canDelete)
        await deleteDisk(ctx, actor, run.disk_id, { operationKey: `demo:${run.id}:delete-disk` });
      return;
    }
  }
  const grant = (
    await ctx.pool.query('SELECT status FROM broker_inference_grants WHERE id=$1', [run.grant_id])
  ).rows[0];
  if (grant?.status !== 'closed') return;
  await transaction(ctx.pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('demo-disk-pool'))");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('homepage-demo-admission'))");
    const ended = await db.query(
      `UPDATE broker_demo_runs SET status=CASE WHEN failed THEN 'failed' ELSE 'ended' END,
      message=CASE WHEN failed THEN 'The demo could not finish. Resources were cleaned up; try again after the cooldown.' WHEN reusable_disk THEN 'Demo ended. Your VM and token access are closed; the demo disk is reserved for reuse.' ELSE 'Demo ended. Your VM, token access and private disk have been cleaned up.' END,
      ended_at=clock_timestamp(),vm_cleanup_at=COALESCE(vm_cleanup_at,clock_timestamp()),
      cooldown_until=COALESCE(cooldown_until,clock_timestamp()+interval '20 minutes'),updated_at=clock_timestamp()
      WHERE id=$1 AND lease_token=$2 AND ended_at IS NULL RETURNING id`,
      [run.id, run.lease_token],
    );
    if (ended.rowCount) {
      await db.query(
        'UPDATE broker_demo_disk_pool SET run_id=NULL WHERE run_id=$1 AND disk_id=$2',
        [run.id, run.disk_id],
      );
      await demoEvent(db, run.id, 'cleanup_confirmed');
    }
  });
}

async function advance(ctx: AppContext, run: Row) {
  const actor = demoActor(run);
  if (!run.token_order_id) {
    const order = await createTokenOrder(ctx, actor, {
      grantId: run.grant_id,
      operationKey: `demo:${run.id}:tokens`,
      mode: 'auction',
      inputTokens: 5000,
      outputTokens: 2048,
      maxTotalCents: 5,
    });
    await save(ctx, run, 'token_order_id=$3', [order.id]);
    await phase(
      ctx,
      run,
      'auction',
      'Running the 30-second Muse token auction. Every qualified seller is invited.',
    );
    return;
  }
  const order = (
    await ctx.pool.query('SELECT * FROM broker_token_orders WHERE id=$1 AND buyer_id=$2', [
      run.token_order_id,
      run.buyer_id,
    ])
  ).rows[0];
  if (order?.status === 'open') return;
  if (
    !order ||
    order.status !== 'awarded' ||
    !(INFERENCE_PROVIDERS as readonly string[]).includes(order.provider) ||
    Number(order.price_cents) > 5
  ) {
    await fail(ctx, run, 'No eligible Muse token offer was awarded. Closing the demo.');
    return;
  }
  if (!run.pack_id) return; // Award checkpoint is discovered on the next tick.
  if (!run.disk_id && ctx.config.liveDemoReuseDisks) {
    await claimDemoDisk(ctx, run);
    await phase(ctx, run, 'provisioning', 'Reserving a dedicated demo disk.');
    return;
  }
  if (!run.disk_id) {
    await save(ctx, run, 'native_attempted_at=COALESCE(native_attempted_at,clock_timestamp())');
    const disk = await createDisk(ctx, actor, {
      name: `Demo ${run.id.slice(0, 8)}`,
      operationKey: `demo:${run.id}:disk`,
    });
    await save(ctx, run, 'disk_id=$3', [disk.id]);
    await phase(ctx, run, 'provisioning', 'Preparing your private persistent disk.');
    return;
  }
  const disk = await diskDetail(ctx, actor, run.disk_id);
  if (disk.disk.status === 'failed' || disk.disk.cleanupPending) {
    await fail(ctx, run, 'Private disk readiness could not be confirmed. Cleaning up.');
    return;
  }
  if (disk.disk.status !== 'ready') return;
  if (!run.request_id) {
    const catalogRow = (
      await ctx.pool.query(
        'SELECT item,approved FROM broker_catalog WHERE id=$1 AND source_mode=$2',
        [DEMO_CATALOG_ID, ctx.wick.mode],
      )
    ).rows[0];
    const catalog = catalogRow?.item as CatalogItem | undefined;
    if (
      !catalogRow?.approved ||
      !catalog ||
      catalog.provider !== 'modal' ||
      catalog.profile !== 'micro' ||
      catalog.region !== 'auto'
    ) {
      await fail(ctx, run, 'The fixed Modal Micro configuration is no longer available.');
      return;
    }
    const request = await createRequest(
      ctx,
      actor,
      {
        operationKey: `demo:${run.id}:vm`,
        description: `Homepage demo ${run.id}`,
        catalogId: DEMO_CATALOG_ID,
        region: 'any',
        matchAcrossProviders: true,
        durationMinutes: 15,
        maxPriceCents: 25,
        requirements: { cpu: catalog.cpu, memoryGb: catalog.memoryGb },
        diskId: run.disk_id,
      },
      undefined,
      undefined,
      { runId: run.id, leaseToken: run.lease_token },
    );
    await save(ctx, run, 'request_id=$3', [request.id]);
    await phase(
      ctx,
      run,
      'auction',
      'Running the 30-second Modal and E2B Micro auction. Modal receives a disclosed sponsorship credit to one cent.',
    );
    return;
  }
  const request = (
    await ctx.pool.query('SELECT status FROM broker_requests WHERE id=$1 AND buyer_id=$2', [
      run.request_id,
      run.buyer_id,
    ])
  ).rows[0];
  if (request?.status === 'open') return;
  if (!request || ['no_offers', 'failed', 'cancelled'].includes(request.status)) {
    await fail(ctx, run, 'The Modal Micro auction or VM startup did not complete. Cleaning up.');
    return;
  }
  const vm = (
    await ctx.pool.query('SELECT * FROM broker_vms WHERE request_id=$1 AND buyer_id=$2', [
      run.request_id,
      run.buyer_id,
    ])
  ).rows[0];
  if (!vm) return;
  await save(ctx, run, 'vm_id=$3', [vm.id]);
  if (
    vm.cleanup_confirmed_at ||
    ['failed', 'expired', 'terminating', 'terminated'].includes(vm.status)
  ) {
    await fail(ctx, run, 'The demo VM is no longer running. Cleaning up.');
    return;
  }
  if (vm.status !== 'running') {
    await phase(
      ctx,
      run,
      'provisioning',
      'Modal is starting your Micro VM and mounting your private disk.',
    );
    return;
  }
  if (
    !vm.environment_id ||
    !vm.expires_at ||
    new Date(vm.expires_at).getTime() <= Date.now() ||
    vm.catalog_snapshot?.provider !== 'modal' ||
    vm.catalog_snapshot?.profile !== 'micro'
  ) {
    await fail(ctx, run, 'The fixed VM identity or lifetime could not be confirmed.');
    return;
  }
  if (run.bootstrap_completed_at) {
    await phase(
      ctx,
      run,
      'ready',
      run.kind === 'studio'
        ? 'Your guided Muse Studio workspace and terminal are ready.'
        : 'Your Modal terminal and Muse tokens are ready.',
    );
    if (run.kind === 'studio') await reconcileDemoStudio(ctx, run.id, run.lease_token);
    return;
  }
  // Reserve time for initialization without shortening an already-ready VM's lease.
  if (new Date(vm.expires_at).getTime() <= Date.now() + 30_000) {
    await fail(ctx, run, 'The VM has too little time remaining to initialize the demo.');
    return;
  }
  if (run.bootstrap_started_at) {
    // An unknown native command outcome is not replayed as successful initialization.
    await fail(ctx, run, 'Script initialization was interrupted. Cleaning up this attempt.');
    return;
  }
  const native = await ctx.wick.get(vm.environment_id);
  if (
    native.status !== 'running' ||
    native.provider !== 'modal' ||
    native.profile !== 'micro' ||
    native.organizationId !== ctx.config.wickOrganizationId ||
    native.groupId !== ctx.config.wickGroupId ||
    !(await observeVmDisk(ctx, vm, native))
  ) {
    await fail(ctx, run, 'The private native disk mount could not be confirmed.');
    return;
  }
  // Terminal runs give hello_muse.py the same public bid rows the homepage receipt shows.
  const receipt =
    run.kind === 'studio'
      ? null
      : demoReceiptFacts({
          vm,
          bids: (
            await ctx.pool.query(
              'SELECT total_price_cents,offering_snapshot,created_at FROM broker_bids WHERE request_id=$1 ORDER BY created_at,id LIMIT 8',
              [run.request_id],
            )
          ).rows,
          tokenPriceCents: order.price_cents,
          tokenProvider: order.provider,
          leaseMinutes: DEMO_LIMITS.durationMinutes,
          inputTokens: DEMO_LIMITS.inputTokens,
          outputTokens: DEMO_LIMITS.outputTokens,
        });
  const authority = (
    await ctx.pool.query(
      `UPDATE broker_demo_runs SET bootstrap_started_at=clock_timestamp()
    WHERE id=$1 AND lease_token=$2 AND NOT stop_requested AND expires_at>clock_timestamp()
    RETURNING id`,
      [run.id, run.lease_token],
    )
  ).rowCount;
  if (!authority) return;
  const initialized = await ctx.wick.runCommand!(vm.environment_id, {
    command: demoBootstrapCommand(ctx.config.appUrl, run.kind, run.reusable_disk, receipt),
    cwd: '/workspace',
  });
  if (
    initialized.exitCode !== 0 ||
    initialized.stdout.trim() !== 'WICK_DEMO_SCRIPT_READY' ||
    (ctx.wick.mode === 'real' && initialized.simulated)
  ) {
    await fail(ctx, run, 'Python script initialization did not complete. Cleaning up.');
    return;
  }
  await save(
    ctx,
    run,
    'bootstrap_completed_at=clock_timestamp(),expires_at=LEAST(expires_at,$3::timestamptz)',
    [vm.expires_at],
  );
  await phase(
    ctx,
    run,
    'ready',
    run.kind === 'studio'
      ? 'Your guided Muse Studio workspace and terminal are ready.'
      : 'Your Modal terminal and Muse tokens are ready.',
  );
}

/** Leased orchestrator; purchases and native provisioning retain their existing durable owners. */
export async function reconcileDemo(ctx: AppContext, id: string): Promise<void> {
  const token = randomUUID();
  let run = (
    await ctx.pool.query(
      `UPDATE broker_demo_runs SET lease_token=$2,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE id=$1 AND ended_at IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`,
      [id, token],
    )
  ).rows[0];
  if (!run) return;
  try {
    run = await discover(ctx, run);
    if (!demoModeAllowed(ctx) || new Date(run.expires_at).getTime() <= Date.now()) {
      run =
        (await save(
          ctx,
          run,
          "stop_requested=true,status='ending',message='The demo has ended. Cleaning up your resources.'",
        )) ?? run;
    }
    if (run.stop_requested || run.status === 'ending') await cleanup(ctx, run);
    else await advance(ctx, run);
  } catch {
    // No upstream exception text, credentials or terminal/script output is persisted.
    if (!run.stop_requested)
      await fail(
        ctx,
        run,
        'The demo encountered an unconfirmed operation. Reconciling and cleaning up.',
      );
  } finally {
    await transaction(ctx.pool, async (db) => {
      const pending = await db.query(
        `UPDATE broker_demo_runs SET lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND lease_token=$2 RETURNING ended_at,status`,
        [id, token],
      );
      if (pending.rows[0] && !pending.rows[0].ended_at)
        await enqueue(ctx, db, DEMO_QUEUE, { id }, pending.rows[0].status === 'ready' ? 10 : 3);
    });
  }
}

export async function maintainDemo(ctx: AppContext): Promise<void> {
  // A pool warming outage must not prevent cleanup of admitted runs.
  await warmDemoDisks(ctx).catch(() => {});
  const runs = (
    await ctx.pool.query(`SELECT id FROM broker_demo_runs WHERE ended_at IS NULL
    AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY updated_at,id LIMIT 20`)
  ).rows;
  for (const run of runs)
    await transaction(ctx.pool, (db) => enqueue(ctx, db, DEMO_QUEUE, { id: run.id }));
}
