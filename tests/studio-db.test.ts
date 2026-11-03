import { closeGrant } from '../src/server/inference/grants.js';
import { managedPricing } from '../src/shared/pricing.js';
import { addCents } from '../src/shared/money.js';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { Pool } from 'pg';
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { migrate, transaction } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor, CatalogItem } from '../src/shared/types.js';
import { applyCreditEntry, creditWalletView } from '../src/server/agreements/credits.js';
import { createInferenceRuntime, fixtureInputTokens } from '../src/server/inference/runtime.js';
import {
  initializeInference,
  closeTokenAuction,
  OFFER_SELECT,
  packPrice,
  createTokenOrder,
  quotes,
} from '../src/server/inference/market.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { closeAuction, submitBid, awardHeldBid } from '../src/server/marketplace/auction.js';
import { provisionVm, cleanupVm } from '../src/server/marketplace/lifecycle.js';
import {
  createStudioTask,
  processStudioTask,
  controlStudio,
  studioDetail,
  listStudioTasks,
  studioPatch,
  maintainStudio,
  studioOptions,
} from '../src/server/coding/studio.js';
import { processCodingJob, codingDetail, open } from '../src/server/coding/service.js';
import { reserveStudioCompute } from '../src/server/coding/studio-budget.js';
import { QUEUES } from '../src/server/marketplace/db.js';
import {
  forecastUsage,
  usageFeatures,
  sizeUsagePurchase,
  USAGE_ESTIMATOR_VERSION,
} from '../src/server/coding/usage-estimator.js';
import {
  TRAINING_SELECT,
  ensureUsageEstimate,
  recordUsageSample,
  taskUsage,
} from '../src/server/coding/usage-data.js';
import type { AdapterResult } from '../src/server/inference/runtime.js';
import { planOperation, PLAN_DIAGNOSTICS_SELECT } from '../src/server/coding/planning.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Studio task budget and lifecycle (disposable Postgres)', () => {
  const schema = 'studio_' + randomUUID().replaceAll('-', '');
  const owner: Actor = {
    id: randomUUID(),
    role: 'buyer',
    email: 'studio@fixture.invalid',
    name: 'Task owner',
  };
  const other: Actor = {
    id: randomUUID(),
    role: 'buyer',
    email: 'other@fixture.invalid',
    name: 'Other owner',
  };
  const suppliers: Actor[] = ['Modal', 'Baseten'].map((name) => ({
    id: randomUUID(),
    role: 'provider',
    name,
    email: name.toLowerCase() + '@studio.invalid',
  }));
  const catalog: CatalogItem = {
    id: 'studio-linux',
    name: 'Small Linux',
    provider: 'simulated-demo',
    profile: 'small',
    region: 'auto',
    cpu: 2,
    memoryGb: 4,
    durationMinutes: [15, 30, 60],
    approved: true,
    description: 'Fixture Linux',
  };
  let admin: Pool,
    pool: Pool,
    ctx: AppContext,
    providerId: string,
    modelLost = false,
    invalidPlan = false,
    wrote = false,
    modelCalls = 0;
  let actions: unknown[] = [];
  let planningReplies: Partial<AdapterResult>[] = [];
  const verify = async () => ({
    url: 'https://github.com/example/public',
    owner: 'example',
    name: 'public',
    ref: 'main',
    sha: 'a'.repeat(40),
  });
  const input = (overrides: Record<string, unknown> = {}) => ({
    operationKey: randomUUID(),
    goal: 'Add an average utility and verify the tests.',
    repositoryUrl: 'https://github.com/example/public',
    budgetCents: 200,
    durationMinutes: 30,
    ...overrides,
  });
  const repo = async () => ({ files: ['average.py'], manifests: [] });
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    await migrate(pool);
    const config = loadConfig({
      DATABASE_URL: url!,
      WICK_MODE: 'fixture',
      MUSE_MODE: 'fixture',
      INFERENCE_MARKET_MODE: 'fixture',
      BETTER_AUTH_SECRET: 'studio-fixture-secret-at-least-32-characters',
    });
    const runtime = await createInferenceRuntime(config),
      wick = createWickAdapter(config, pool);
    runtime.dispatch = vi.fn(async (_route, call, id) => {
      modelCalls++;
      if (modelLost) throw Error('Synthetic lost model response');
      const planning = call.messages[0]!.content.includes('planning one public-repository');
      const info = JSON.parse(call.messages[1]!.content);
      const data = planning
        ? {
            catalogId: invalidPlan ? 'unapproved-catalog' : info.candidates[0].id,
            testCommand: info.ownerTestCommand || 'python3 -m unittest discover -s tests',
            explanation:
              'A small Linux VM fits the public Python task at the lowest reviewed price.',
          }
        : (actions.shift() ?? { action: 'finish', summary: 'Ready for review.' });
      const result = {
        id: 'fixture_' + id,
        content: JSON.stringify(data),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(call),
        outputTokens: 80,
        ...(planning ? planningReplies.shift() : undefined),
      };
      return result.finishReason === 'length'
        ? { ...result, outputTokens: Math.min(result.outputTokens, call.max_tokens) }
        : result;
    });
    const command = vi.fn(async (_id: string, { command }: { command: string }) => {
      const encoded = command.match(/'([A-Za-z0-9+/=]+)'$/)![1]!;
      const data = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString()),
        kind = data.action.action;
      if (kind === 'stop')
        return {
          stdout: JSON.stringify({ stopRequested: true }),
          stderr: '',
          exitCode: 0,
          simulated: true,
        };
      const result =
        kind === 'clone'
          ? { files: ['average.py'], sandbox: 'fixture' }
          : kind === 'read'
            ? { content: 'old source' }
            : kind === 'write'
              ? ((wrote = true), { written: true })
              : kind === 'test'
                ? {
                    exitCode: wrote ? 0 : 1,
                    output: wrote ? '4 assertions passed' : 'baseline failed',
                    interrupted: false,
                  }
                : kind === 'diff'
                  ? {
                      exitCode: 0,
                      output: 'diff --git a/average.py b/average.py\n+def average(items): ...\n',
                      truncated: false,
                    }
                  : { state: 'not_started' };
      return {
        stdout: JSON.stringify({ state: 'completed', result }),
        stderr: '',
        exitCode: 0,
        simulated: true,
      };
    });
    ctx = {
      pool,
      config,
      inference: runtime,
      wick: { ...wick, runCommand: command },
      boss: { send: vi.fn(async () => randomUUID()) },
      muse: { mode: 'fixture' },
    } as unknown as AppContext;
  });
  beforeEach(async () => {
    await pool.query(
      'TRUNCATE "user",broker_catalog,broker_providers,broker_inference_grants,broker_credit_wallets,broker_credit_ledger CASCADE',
    );
    for (const a of [owner, other, ...suppliers])
      await pool.query('INSERT INTO "user"(id,email,name,role) VALUES($1,$2,$3,$4)', [
        a.id,
        a.email,
        a.name,
        a.role,
      ]);
    await pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,true)', [
      catalog.id,
      catalog,
    ]);
    for (const supplier of suppliers) {
      const p = (
        await pool.query(
          `INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,5,$3) RETURNING id`,
          [
            supplier.id,
            supplier.name,
            {
              autoBid: true,
              minimumPriceCents: 1,
              basePriceCents: 10,
              maxPriceCents: 1000,
              allowedCatalogIds: [catalog.id],
            },
          ],
        )
      ).rows[0];
      if (supplier === suppliers[0]) providerId = p.id;
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [supplier.id, p.id]);
      await pool.query(
        `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,$2,'Linux','Fixture',10)`,
        [p.id, catalog.id],
      );
    }
    for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 8192;
    await initializeInference(ctx);
    await transaction(pool, (db) =>
      applyCreditEntry(db, owner.id, {
        operationKey: randomUUID(),
        kind: 'grant',
        balanceDeltaCents: 1000,
        reservedDeltaCents: 0,
        description: 'Disposable Studio credit',
      }),
    );
    wrote = false;
    modelLost = false;
    invalidPlan = false;
    modelCalls = 0;
    actions = [
      { action: 'read', path: 'average.py' },
      {
        action: 'write',
        path: 'average.py',
        content: 'def average(items): return sum(items)/len(items)',
      },
      { action: 'test' },
      { action: 'finish', summary: 'Implemented and tested the requested change.' },
    ];
    planningReplies = [];
    vi.mocked(ctx.inference!.dispatch).mockClear();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function tick(id: string) {
    await pool.query(
      "UPDATE broker_studio_tasks SET next_tick_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [id],
    );
    await processStudioTask(ctx, id, repo);
    return (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [id])).rows[0];
  }
  async function create(overrides: Record<string, unknown> = {}) {
    return createStudioTask(ctx, owner, input(overrides), verify);
  }
  // Synthetic real-mode pricing/eligibility validation; no native API or VM is used.
  async function realCompute(ids: string[] = [catalog.id]) {
    const item: CatalogItem = {
      ...catalog,
      provider: 'daytona',
      pricingMode: 'managed',
      rateMicrosPerSecond: 20,
      rateSource: 'wick-customer-catalog',
      rateRetrievedAt: new Date().toISOString(),
      managedRouteVerification: 'organization-catalog-byok-disabled',
    };
    await pool.query("UPDATE broker_catalog SET source_mode='real',item=$1 WHERE id=$2", [
      item,
      item.id,
    ]);
    await pool.query(
      "UPDATE broker_providers SET cloud_provider='daytona',policy=jsonb_set(policy,'{basePriceCents}','5'::jsonb)",
    );
    await pool.query('UPDATE broker_offerings SET pricing=$1', [managedPricing(item)]);
    await pool.query("UPDATE broker_inference_routes SET source_mode='real'");
    return {
      ...ctx,
      config: { ...ctx.config, studioApprovedComputeCatalogIds: ids },
      wick: { ...ctx.wick, mode: 'real' as const },
      inference: {
        ...ctx.inference!,
        mode: 'real' as const,
        routes: new Map(
          [...ctx.inference!.routes].map(([provider, route]) => [
            provider,
            {
              ...route,
              mode: 'real' as const,
              inputBound: 1048576,
              inputAccounting: 'utf8-bytes-v1' as const,
            },
          ]),
        ),
      },
    };
  }
  async function diskWorkspaceContext() {
    const diskCtx = { ...ctx, config: { ...ctx.config, disksEnabled: true } };
    await pool.query(
      "UPDATE broker_catalog SET item=jsonb_set(item,'{capabilities}','[\"persistent-drives\"]'::jsonb) WHERE id=$1",
      [catalog.id],
    );
    const disk = (
      await pool.query(
        `INSERT INTO broker_disks(buyer_id,name,source_mode,status,upstream_id,create_key) VALUES($1,'Saved files','fixture','ready',$2,$3) RETURNING *`,
        [owner.id, 'fixture-drive-' + randomUUID(), randomUUID()],
      )
    ).rows[0];
    return { diskCtx, disk };
  }
  it('reserves a persistent folder before funding, serializes replay, and preserves it after a stopped task', async () => {
    const { diskCtx, disk } = await diskWorkspaceContext();
    const body = input({ diskId: disk.id });
    const [task, replay] = await Promise.all([
      createStudioTask(diskCtx, owner, body, verify),
      createStudioTask(diskCtx, owner, body, verify),
    ]);
    expect(replay.id).toBe(task.id);
    expect(task.diskId).toBe(disk.id);
    expect(task.workspaceId).toBeTruthy();
    expect(task.patchLabel).toBe('Workspace changes');
    const workspace = (
      await pool.query('SELECT * FROM broker_disk_workspaces WHERE id=$1', [task.workspaceId])
    ).rows[0];
    expect(workspace.active_task_id).toBe(task.id);
    expect(workspace.commit_sha).toBe('a'.repeat(40));
    const wallet = await creditWalletView(pool, owner.id);
    await expect(
      createStudioTask(
        diskCtx,
        owner,
        input({ diskId: disk.id, workspaceId: workspace.id }),
        verify,
      ),
    ).rejects.toThrow('already in use');
    expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
    await controlStudio(diskCtx, owner, task.id, 'stop', {});
    await processStudioTask(diskCtx, task.id, repo);
    expect((await studioDetail(diskCtx, owner, task.id)).task.status).toBe('stopped');
    expect(
      (
        await pool.query('SELECT active_task_id FROM broker_disk_workspaces WHERE id=$1', [
          workspace.id,
        ])
      ).rows[0].active_task_id,
    ).toBeNull();
    expect(
      (await pool.query('SELECT status FROM broker_disks WHERE id=$1', [disk.id])).rows[0].status,
    ).toBe('ready');
  });
  it('continues an idle folder at its original commit using current disk metadata and keeps customer ownership', async () => {
    const { diskCtx, disk } = await diskWorkspaceContext();
    const workspace = (
      await pool.query(
        `INSERT INTO broker_disk_workspaces(disk_id,buyer_id,name,repository_url,commit_sha,initialized) VALUES($1,$2,'Previous work',$3,$4,true) RETURNING *`,
        [disk.id, owner.id, 'https://github.com/example/public', 'b'.repeat(40)],
      )
    ).rows[0];
    const verifyAgain = vi.fn(verify);
    const prefix = `workspaces/${workspace.id}/repository/`;
    diskCtx.wick = {
      ...ctx.wick,
      drives: {
        ...ctx.wick.drives!,
        listFiles: vi.fn(async () => ({
          data: [
            { key: prefix + 'package.json', size: 17 },
            { key: prefix + 'untracked.ts', size: 5 },
          ],
          commonPrefixes: [],
          isTruncated: false,
        })),
        readFile: vi.fn(async () => ({
          key: prefix + 'package.json',
          contentBase64: Buffer.from('{"scripts":{}}').toString('base64'),
          size: 14,
        })),
      },
    };
    const task = await createStudioTask(
      diskCtx,
      owner,
      input({ diskId: disk.id, workspaceId: workspace.id }),
      verifyAgain,
    );
    expect(verifyAgain).not.toHaveBeenCalled();
    expect(task).toMatchObject({
      workspaceId: workspace.id,
      continuingWorkspace: true,
      commitSha: 'b'.repeat(40),
    });
    await processStudioTask(diskCtx, task.id, async () => {
      throw Error('Remote repository must not replace saved context');
    });
    const row = (
      await pool.query('SELECT plan_input_cipher FROM broker_studio_tasks WHERE id=$1', [task.id])
    ).rows[0];
    expect(open(diskCtx, row.plan_input_cipher).context).toMatchObject({
      files: ['package.json', 'untracked.ts'],
      continuingWorkspace: true,
      originalCommit: 'b'.repeat(40),
    });
    expect(diskCtx.wick.drives!.readFile).toHaveBeenCalledWith(
      disk.upstream_id,
      prefix + 'package.json',
    );
    await expect(
      createStudioTask(
        diskCtx,
        other,
        input({ diskId: disk.id, workspaceId: workspace.id }),
        verifyAgain,
      ),
    ).rejects.toThrow('Workspace not found');
  });
  it('permits separate tasks on one disk while rejecting unprepared workspace continuation without funding', async () => {
    const { diskCtx, disk } = await diskWorkspaceContext();
    const [a, b] = await Promise.all([
      createStudioTask(diskCtx, owner, input({ diskId: disk.id }), verify),
      createStudioTask(diskCtx, owner, input({ diskId: disk.id }), verify),
    ]);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    await controlStudio(diskCtx, owner, a.id, 'stop', {});
    await processStudioTask(diskCtx, a.id, repo);
    const wallet = await creditWalletView(pool, owner.id);
    await expect(
      createStudioTask(
        diskCtx,
        owner,
        input({ diskId: disk.id, workspaceId: a.workspaceId }),
        verify,
      ),
    ).rejects.toThrow('no confirmed preparation receipt');
    expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
    expect(
      (
        await pool.query('SELECT active_task_id FROM broker_disk_workspaces WHERE id=$1', [
          b.workspaceId,
        ])
      ).rows[0].active_task_id,
    ).toBe(b.id);
  });
  it('reserves the published provider quote for a 15-minute real-mode rental, not just the lower cost floor', async () => {
    const real = await realCompute();
    const policies = (await pool.query('SELECT id,policy FROM broker_providers ORDER BY id')).rows;
    const task = await createStudioTask(real, owner, input({ durationMinutes: 15 }), verify);
    await processStudioTask(real, task.id, repo);
    let t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id])).rows[0];
    const candidates = open(real, t.plan_input_cipher).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].maximumCents).toBe(6.25); // Actual base 5, retained 25% reserve buffer.
    expect(Number(t.compute_reserved_cents)).toBe(6.25);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(real, t.model_order_id);
    await pool.query(
      "UPDATE broker_studio_tasks SET next_tick_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [task.id],
    );
    await processStudioTask(real, task.id, repo);
    t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id])).rows[0];
    expect(t.status, t.blocked_reason).toBe('compute_auction');
    expect(
      Number(
        (
          await pool.query('SELECT max_price_cents FROM broker_requests WHERE id=$1', [
            t.vm_request_id,
          ])
        ).rows[0].max_price_cents,
      ),
    ).toBe(6.25);
    await expect(
      submitBid(real, suppliers[0]!, t.vm_request_id, { totalPriceCents: 5 }),
    ).resolves.toMatchObject({ totalPriceCents: 5 });
    expect((await pool.query('SELECT id,policy FROM broker_providers ORDER BY id')).rows).toEqual(
      policies,
    );
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
  });
  it('budgets for the first eight automatic bidders rather than a cheaper ninth seller', async () => {
    const real = await realCompute();
    const pricing = (await pool.query('SELECT pricing FROM broker_offerings LIMIT 1')).rows[0]
      .pricing;
    await pool.query(
      "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false'::jsonb)",
    );
    const bidders = Array.from({ length: 9 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      user_id: randomUUID(),
      email: `compute-${i}@studio.invalid`,
      name: `Compute ${i}`,
      policy: {
        autoBid: true,
        minimumPriceCents: 1,
        basePriceCents: i === 8 ? 5 : 20,
        maxPriceCents: 1000,
        allowedCatalogIds: [catalog.id],
      },
    }));
    await pool.query(
      `INSERT INTO "user"(id,email,name,role)
      SELECT user_id,email,name,'provider' FROM jsonb_to_recordset($1::jsonb) AS x(user_id text,email text,name text)`,
      [JSON.stringify(bidders)],
    );
    await pool.query(
      `INSERT INTO broker_providers(id,user_id,name,cloud_provider,total_capacity,policy)
      SELECT id,user_id,name,'daytona',5,policy FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,user_id text,name text,policy jsonb)`,
      [JSON.stringify(bidders)],
    );
    await pool.query(
      `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing)
      SELECT id,$2,'Published','Synthetic fanout',5,$3 FROM broker_providers WHERE id=ANY($1::uuid[])`,
      [bidders.map((p) => p.id), catalog.id, pricing],
    );
    const task = await createStudioTask(real, owner, input({ durationMinutes: 15 }), verify);
    await processStudioTask(real, task.id, repo);
    let t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id])).rows[0];
    expect(open(real, t.plan_input_cipher).candidates[0].maximumCents).toBe(25);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(real, t.model_order_id);
    await pool.query(
      "UPDATE broker_studio_tasks SET next_tick_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [task.id],
    );
    await processStudioTask(real, task.id, repo);
    t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id])).rows[0];
    expect(t.status, t.blocked_reason).toBe('compute_auction');
    const queued = vi
      .mocked(ctx.boss.send)
      .mock.calls.map(([queue, data]) => ({
        queue,
        data: data as { requestId?: string; providerId?: string },
      }))
      .filter(({ queue, data }) => queue === QUEUES.auto && data.requestId === t.vm_request_id);
    expect(queued.map(({ data }) => data.providerId)).toEqual(bidders.slice(0, 8).map((p) => p.id));
    expect(
      Number(
        (
          await pool.query('SELECT max_price_cents FROM broker_requests WHERE id=$1', [
            t.vm_request_id,
          ])
        ).rows[0].max_price_cents,
      ),
    ).toBe(25);
  });
  it('requires execution qualification and published eligible compute before reserving real Studio credit', async () => {
    const real = await realCompute([]);
    const wallet = await creditWalletView(pool, owner.id);
    expect(await studioOptions(real)).toMatchObject({
      available: false,
      reason: expect.stringContaining('execution-qualified'),
    });
    await expect(createStudioTask(real, owner, input(), verify)).rejects.toThrow(
      'No credit was reserved',
    );
    expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_inference_grants')).rows[0].n,
    ).toBe(0);
    real.config.studioApprovedComputeCatalogIds = [catalog.id];
    await pool.query('UPDATE broker_offerings SET active=false');
    await expect(createStudioTask(real, owner, input(), verify)).rejects.toThrow(
      'No credit was reserved',
    );
    expect(await creditWalletView(pool, owner.id)).toEqual(wallet);
  });
  it.each([
    'policy exclusion',
    'provider identity',
    'disabled auto bidding',
    'stale published rate',
    'price cap',
  ])('excludes real Studio compute with %s before funding', async (problem) => {
    const real = await realCompute();
    if (problem === 'policy exclusion')
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{allowedCatalogIds}','[]'::jsonb)",
      );
    if (problem === 'provider identity')
      await pool.query("UPDATE broker_providers SET cloud_provider='modal'");
    if (problem === 'disabled auto bidding')
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false'::jsonb)",
      );
    if (problem === 'stale published rate')
      await pool.query(
        "UPDATE broker_offerings SET pricing=jsonb_set(pricing,'{rateMicrosPerSecond}','1'::jsonb)",
      );
    if (problem === 'price cap')
      await pool.query(
        "UPDATE broker_providers SET policy=jsonb_set(policy,'{maxPriceCents}','6'::jsonb)",
      );
    await expect(
      createStudioTask(
        real,
        owner,
        input({ durationMinutes: problem === 'price cap' ? 60 : 15 }),
        verify,
      ),
    ).rejects.toThrow('No credit was reserved');
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_inference_grants')).rows[0].n,
    ).toBe(0);
  });
  it('filters execution-qualified IDs before the bounded catalog page', async () => {
    const real = await realCompute();
    await pool.query(
      `INSERT INTO broker_catalog(id,item,approved,source_mode)
      SELECT 'unqualified-'||n,item||jsonb_build_object('id','unqualified-'||n,'cpu',1),true,'real'
      FROM broker_catalog CROSS JOIN generate_series(1,20) n WHERE id=$1`,
      [catalog.id],
    );
    expect(await studioOptions(real)).toMatchObject({ available: true });
    const task = await createStudioTask(real, owner, input(), verify);
    expect(task.mode).toBe('real');
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
  });
  it('bounds published compute reads by the selected catalogs and bidders rather than offering history', async () => {
    const real = await realCompute();
    await pool.query(
      `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing)
      SELECT p.id,$1,'Historical duplicate '||n,'Synthetic history',10,$2 FROM broker_providers p
      CROSS JOIN generate_series(1,1000) n`,
      [
        catalog.id,
        managedPricing({
          ...catalog,
          provider: 'daytona',
          pricingMode: 'managed',
          rateMicrosPerSecond: 20,
          rateSource: 'wick-customer-catalog',
          rateRetrievedAt: new Date().toISOString(),
          managedRouteVerification: 'organization-catalog-byok-disabled',
        }),
      ],
    );
    const reads = vi.spyOn(pool, 'query');
    try {
      await createStudioTask(real, owner, input(), verify);
      const selected = reads.mock.calls
        .map((args, index) => ({ args, index }))
        .filter(({ args }) => String(args[0]).includes('SELECT c.id catalog_id,supply.policy'));
      expect(selected).toHaveLength(1);
      expect(selected[0]!.args[1]).toEqual([[catalog.id], 'real']);
      const result = await reads.mock.results[selected[0]!.index]!.value;
      expect(result.rows).toHaveLength(2);
    } finally {
      reads.mockRestore();
    }
  });
  it('parses a bounded explicit execution-qualified catalog list without changing fixture availability', async () => {
    const env = {
      DATABASE_URL: url!,
      WICK_MODE: 'fixture',
      MUSE_MODE: 'fixture',
      BETTER_AUTH_SECRET: 'studio-config-fixture-secret-at-least-32-chars',
    };
    expect(
      loadConfig({ ...env, STUDIO_APPROVED_COMPUTE_CATALOG_IDS: ' e2b:micro:us , e2b:micro:us ' })
        .studioApprovedComputeCatalogIds,
    ).toEqual(['e2b:micro:us']);
    expect(() => loadConfig({ ...env, STUDIO_APPROVED_COMPUTE_CATALOG_IDS: 'a,,b' })).toThrow();
    expect(() =>
      loadConfig({
        ...env,
        STUDIO_APPROVED_COMPUTE_CATALOG_IDS: Array.from(
          { length: 17 },
          (_, i) => 'route-' + i,
        ).join(','),
      }),
    ).toThrow();
    expect(await studioOptions(ctx)).toMatchObject({ available: true });
  });
  async function planned(id: string) {
    let t = await tick(id);
    expect(t.status).toBe('model_auction');
    await pool.query(
      `UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    t = await tick(id);
    expect(t.status, t.blocked_reason).toBe('compute_auction');
    expect(t.vm_request_id).toBeTruthy();
    return t;
  }
  async function awarded(id: string) {
    const t = await planned(id);
    await submitBid(ctx, suppliers[0]!, t.vm_request_id, { totalPriceCents: 10 });
    await transaction(pool, async (db) =>
      awardHeldBid(
        ctx,
        db,
        (await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE', [t.vm_request_id]))
          .rows[0],
        (
          await db.query('SELECT * FROM broker_bids WHERE request_id=$1 FOR UPDATE', [
            t.vm_request_id,
          ])
        ).rows[0],
      ),
    );
    return (await pool.query('SELECT * FROM broker_vms WHERE request_id=$1', [t.vm_request_id]))
      .rows[0];
  }
  async function ready(id: string) {
    const vm = await awarded(id);
    await provisionVm(ctx, vm.id);
    await pool.query(
      `UPDATE broker_fixture_environments SET ready_at=clock_timestamp()-interval '1 second'`,
    );
    await provisionVm(ctx, vm.id);
    const t = await tick(id);
    expect(t.status).toBe('provisioning');
    return { task: t, vm };
  }
  async function cleaned(id: string, vmId: string) {
    await cleanupVm(ctx, vmId);
    await pool.query(
      `UPDATE broker_fixture_environments SET termination_requested_at=clock_timestamp()-interval '1 second' WHERE status='terminating'`,
    );
    await cleanupVm(ctx, vmId);
    return tick(id);
  }
  async function finishExecution(id: string) {
    for (let round = 0; round < 20; round++) {
      const t = await tick(id);
      if (t.verified_at) return;
      expect(['running', 'provisioning', 'model_auction', 'verifying']).toContain(t.status);
      if (t.status === 'model_auction' && t.model_order_id) {
        await pool.query(
          "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [t.model_order_id],
        );
        await closeTokenAuction(ctx, t.model_order_id);
      } else if (t.coding_job_id) await processCodingJob(ctx, t.coding_job_id);
    }
    throw Error('The fixture task did not finish within its bounded purchase rounds.');
  }
  it('corrects an invalid model path within the bounded action retry without sending it to the VM', async () => {
    actions.unshift({ action: 'read', path: '/repo' });
    const task = await create(),
      { task: t, vm } = await ready(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    await finishExecution(task.id);
    await cleaned(task.id, vm.id);
    const detail = await studioDetail(ctx, owner, task.id);
    expect(detail.task.status).toBe('completed');
    expect(detail.task.deadlineAt).toBe(task.deadlineAt);
    expect(
      (await pool.query('SELECT action_retries FROM broker_studio_tasks WHERE id=$1', [task.id]))
        .rows[0].action_retries,
    ).toBe(1);
    const commands = (
      await pool.query(
        "SELECT payload_cipher FROM broker_coding_steps WHERE job_id=$1 AND kind='command'",
        [t.coding_job_id],
      )
    ).rows;
    expect(commands.some((r) => open(ctx, r.payload_cipher).path === '/repo')).toBe(false);
  });
  it('runs one funded task from model auction to verified result and cleanup without manual VM or grant selection', async () => {
    const task = await create();
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    const { task: t, vm } = await ready(task.id);
    expect(t.execution_started_at).toBeNull();
    await processCodingJob(ctx, t.coding_job_id);
    await tick(task.id);
    await finishExecution(task.id);
    expect(
      (
        await pool.query(
          'SELECT execution_started_at,verified_at FROM broker_studio_tasks WHERE id=$1',
          [task.id],
        )
      ).rows[0].verified_at,
    ).toBeTruthy();
    await cleaned(task.id, vm.id);
    const detail = await studioDetail(ctx, owner, task.id);
    expect(detail.task.status).toBe('completed');
    const execution = await codingDetail(ctx, owner, t.coding_job_id);
    expect(execution.parentTask).toMatchObject({ id: task.id, status: 'completed' });
    expect(execution.parentTask?.completedAt).toBeTruthy();
    expect(execution.vm).toMatchObject({ status: 'terminated' });
    expect(execution.vm?.cleanupConfirmedAt).toBeTruthy();
    await expect(codingDetail(ctx, other, t.coding_job_id)).rejects.toThrow('not found');
    expect(detail.task.executionStartedAt).toBeTruthy();
    expect(detail.tests?.exitCode).toBe(0);
    expect(await studioPatch(ctx, owner, task.id)).toContain('diff --git');
    expect(detail.task.spentCents).toBeLessThanOrEqual(200);
    expect(detail.task.computeChargedCents).toBe(10);
    expect(detail.task.reservedCents).toBe(0);
    expect(detail.task.availableCents).toBe(0);
    expect(detail.task.returnedCents).toBeCloseTo(200 - detail.task.spentCents, 2);
    const ledger = (
      await pool.query(
        `SELECT kind,count(*)::int n FROM broker_credit_ledger WHERE kind IN('token_purchase','studio_compute') GROUP BY kind`,
      )
    ).rows;
    expect(ledger.find((r) => r.kind === 'token_purchase')?.n).toBe(detail.modelPurchases.length);
    expect(ledger.find((r) => r.kind === 'studio_compute')?.n).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_invoices WHERE vm_id=$1', [vm.id]))
        .rows[0].n,
    ).toBe(1);
    expect(modelCalls).toBe(5);
    const caps = (
      await pool.query('SELECT reserved_output FROM broker_inference_requests WHERE grant_id=$1', [
        t.grant_id,
      ])
    ).rows;
    expect(caps.some((r) => r.reserved_output < 4096 && r.reserved_output >= 256)).toBe(true);
    const sample = (
      await pool.query('SELECT * FROM broker_studio_usage_samples WHERE task_id=$1', [task.id])
    ).rows[0];
    expect(sample.model_calls).toBe(5);
    expect(sample.features.goalBytes).toBe(Buffer.byteLength(input().goal));
    expect(detail.usage?.settledOutput).toBe(400);
    expect(detail.usage?.forecast.basis).toBe('cold_start');
    expect(Number(sample.output_tokens)).toBe(400);
    expect(detail.usage?.purchasedInput).toBeLessThan(195072);
    expect(JSON.stringify(sample)).not.toContain('average.py');
    expect(detail.events.some((e) => e.kind === 'verification')).toBe(true);
    await tick(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    expect(modelCalls).toBe(5);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM broker_studio_usage_samples WHERE task_id=$1',
          [task.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('atomically reserves the budget and serializes duplicate creation operations', async () => {
    const body = input();
    const [a, b] = await Promise.all([
      createStudioTask(ctx, owner, body, verify),
      createStudioTask(ctx, owner, body, verify),
    ]);
    expect(a.id).toBe(b.id);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_inference_grants')).rows[0].n,
    ).toBe(1);
    expect((await creditWalletView(pool, owner.id)).reservedCents).toBe(200);
    await expect(
      createStudioTask(ctx, owner, { ...body, goal: 'A completely different task.' }, verify),
    ).rejects.toThrow('another task');
  });
  it('persists an owner-selected model provider through planning and purchase replay', async () => {
    const body = input({ allowedProviders: ['baseten'] });
    const task = await createStudioTask(ctx, owner, body, verify);
    expect((await createStudioTask(ctx, owner, body, verify)).id).toBe(task.id);
    const state = await planned(task.id);
    expect(
      (
        await pool.query('SELECT allowed_providers FROM broker_inference_grants WHERE id=$1', [
          state.grant_id,
        ])
      ).rows[0].allowed_providers,
    ).toEqual(['baseten']);
    expect(
      (
        await pool.query('SELECT provider FROM broker_token_bids WHERE order_id=$1', [
          state.model_order_id,
        ])
      ).rows,
    ).toEqual([{ provider: 'baseten' }]);
    expect(
      (
        await pool.query(
          'SELECT DISTINCT provider FROM broker_inference_requests WHERE grant_id=$1',
          [state.grant_id],
        )
      ).rows,
    ).toEqual([{ provider: 'baseten' }]);
    await expect(
      createStudioTask(ctx, owner, { ...body, allowedProviders: ['modal'] }, verify),
    ).rejects.toThrow('another task');
  });
  it.each([
    { allowedProviders: [] },
    { allowedProviders: ['modal', 'modal'] },
    { allowedProviders: ['unknown'] },
  ])('rejects invalid model provider selection %j before funding', async ({ allowedProviders }) => {
    await expect(create({ allowedProviders })).rejects.toThrow();
    expect((await creditWalletView(pool, owner.id)).reservedCents).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_inference_grants')).rows[0].n,
    ).toBe(0);
  });
  it('rejects an unqualified owner-selected model route before funding', async () => {
    await pool.query("UPDATE broker_inference_routes SET qualified=false WHERE provider='modal'");
    await expect(create({ allowedProviders: ['modal'] })).rejects.toThrow('qualified for coding');
    expect((await creditWalletView(pool, owner.id)).reservedCents).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_inference_grants')).rows[0].n,
    ).toBe(0);
  });
  it('cannot oversubscribe wallet credit through concurrent task starts', async () => {
    const results = await Promise.allSettled([
      create({ budgetCents: 700 }),
      create({ budgetCents: 700 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await creditWalletView(pool, owner.id)).reservedCents).toBe(700);
  });
  it('reserves compute and concurrent model-purchase holds from the same grant', async () => {
    const task = await create({ budgetCents: 100 });
    await pool.query(
      `UPDATE broker_studio_tasks SET lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1`,
      [task.id, task.id],
    );
    await reserveStudioCompute(ctx, owner, { id: task.id, leaseToken: task.id }, 40);
    const t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id]))
      .rows[0];
    const buy = () =>
      createTokenOrder(ctx, owner, {
        operationKey: randomUUID(),
        grantId: t.grant_id,
        mode: 'auction',
        inputTokens: 20000,
        outputTokens: 20000,
        maxTotalCents: 50,
      });
    const results = await Promise.allSettled([buy(), buy()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const g = (await pool.query('SELECT * FROM broker_inference_grants WHERE id=$1', [t.grant_id]))
      .rows[0];
    expect(Number(g.held_cents)).toBe(90);
    expect(Number(g.available_cents)).toBe(10);
  });
  it('keeps approval and paid planning separate from VM creation', async () => {
    const task = await create();
    await tick(task.id);
    expect(modelCalls).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    await planned(task.id);
    expect(modelCalls).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
  });
  it('does not create a VM or accept invented providers from an invalid Meta plan', async () => {
    invalidPlan = true;
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      `UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    expect(t.vm_request_id).toBeNull();
    expect(modelCalls).toBe(1);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      failureCode: 'unapproved_vm',
      canRetry: true,
      requestStatus: 'settled',
    });
    await tick(task.id);
    expect(modelCalls).toBe(1);
  });
  it('repairs one settled truncated planning reply from the existing pack before opening the VM auction', async () => {
    for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 2048;
    planningReplies = [{ content: '{"catalogId":', finishReason: 'length', outputTokens: 2048 }];
    const task = await create(),
      t = await planned(task.id);
    expect(modelCalls).toBe(2);
    const attempts = (
      await pool.query(
        'SELECT a.*,r.status FROM broker_studio_plan_attempts a JOIN broker_inference_requests r ON r.id=a.request_id WHERE task_id=$1 ORDER BY attempt',
        [task.id],
      )
    ).rows;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      failure_code: 'truncated',
      finish_reason: 'length',
      status: 'settled',
    });
    expect(attempts[1]).toMatchObject({
      failure_code: null,
      finish_reason: 'stop',
      status: 'settled',
    });
    expect(attempts[0].response_cipher).not.toContain('catalogId');
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    const calls = vi.mocked(ctx.inference!.dispatch).mock.calls.map((c) => c[1]);
    expect(
      vi.mocked(ctx.inference!.dispatch).mock.calls.every((c) => c[3]?.jsonObject === true),
    ).toBe(true);
    for (const call of calls) {
      expect(call).not.toHaveProperty('reasoning_effort');
      expect(call.max_tokens).toBeLessThanOrEqual(2048);
      expect(call.max_tokens).toBeGreaterThanOrEqual(256);
    }
    expect(calls[1]!.messages[0]!.content).toContain('previous settled reply');
    expect(calls[1]!.messages[0]!.content).not.toContain('{"catalogId":');
    const detail = await studioDetail(ctx, owner, task.id);
    expect(detail.events.some((e) => e.title === 'Muse is repairing its plan')).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('response_cipher');
    await tick(task.id);
    expect(modelCalls).toBe(2);
  });
  it('stops after the single repair and exposes its exact failure without another purchase or VM', async () => {
    for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 2048;
    planningReplies = Array.from({ length: 3 }, () => ({
      content: '',
      finishReason: 'length',
      outputTokens: 2048,
    }));
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    const lastCap = vi.mocked(ctx.inference!.dispatch).mock.calls.at(-1)![1].max_tokens;
    expect(t.blocked_reason).toContain(
      `${lastCap.toLocaleString('en-US')}-token planning response limit`,
    );
    expect(t.blocked_reason).toContain('single planning repair has been used');
    expect(modelCalls).toBe(2);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      attempt: 2,
      failureCode: 'truncated',
      finishReason: 'length',
      outputTokens: lastCap,
      canRetry: false,
    });
    await expect(controlStudio(ctx, owner, task.id, 'retry-plan')).rejects.toThrow(
      'cannot be retried',
    );
    await tick(task.id);
    expect(modelCalls).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
  it('completes coding and cleanup after a capped planning reply through metered task calls', async () => {
    planningReplies = [{ content: '', finishReason: 'length', outputTokens: 2048 }];
    const task = await create(),
      { task: t, vm } = await ready(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    await tick(task.id);
    await cleaned(task.id, vm.id);
    const detail = await studioDetail(ctx, owner, task.id);
    expect(detail.task.status).toBe('completed');
    expect(detail.tests?.exitCode).toBe(0);
    expect(detail.vm?.cleanupConfirmedAt).toBeTruthy();
    expect(detail.task.reservedCents).toBe(0);
    expect(detail.task.spentCents + detail.task.returnedCents).toBeCloseTo(200, 2);
    expect(detail.modelPurchases).toHaveLength(1);
    expect(modelCalls).toBe(6);
    for (const [, call] of vi.mocked(ctx.inference!.dispatch).mock.calls) {
      expect(call).not.toHaveProperty('reasoning_effort');
      expect(call).not.toHaveProperty('reasoning');
    }
  });
  it('stops a repair at exhausted prepaid quota without buying more capacity or dispatching again', async () => {
    for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 2048;
    planningReplies = [{ content: '', finishReason: 'length', outputTokens: 2048 }];
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    await pool.query(
      'UPDATE broker_token_packs SET output_tokens=2048,available_output=2048 WHERE grant_id=$1',
      [t.grant_id],
    );
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      attempt: 2,
      failureCode: 'allowance',
      requestStatus: 'not_sent',
    });
    await controlStudio(ctx, owner, task.id, 'retry-plan');
    await tick(task.id);
    expect(modelCalls).toBe(1);
    expect((await studioDetail(ctx, owner, task.id)).modelPurchases).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    const pack = (
      await pool.query(
        'SELECT consumed_output,held_output FROM broker_token_packs WHERE grant_id=$1',
        [t.grant_id],
      )
    ).rows[0];
    expect(Number(pack.consumed_output)).toBe(2048);
    expect(Number(pack.held_output)).toBe(0);
  });
  it('serializes duplicate owner repair requests and competing workers into one repair', async () => {
    invalidPlan = true;
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    await tick(task.id);
    invalidPlan = false;
    const retries = await Promise.allSettled([
      controlStudio(ctx, owner, task.id, 'retry-plan'),
      controlStudio(ctx, owner, task.id, 'retry-plan'),
    ]);
    expect(retries.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await Promise.all([tick(task.id), tick(task.id)]);
    t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id])).rows[0];
    expect(t.status).toBe('compute_auction');
    expect(t.plan_attempt).toBe(1);
    expect(modelCalls).toBe(2);
    expect((await pool.query('SELECT count(*)::int n FROM broker_requests')).rows[0].n).toBe(1);
  });
  it.each(['stop', 'deadline', 'revocation', 'lease'] as const)(
    'does not authorize a repair or VM when %s changes during planning',
    async (change) => {
      const task = await create();
      let t = await tick(task.id);
      await pool.query(
        "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [t.model_order_id],
      );
      await closeTokenAuction(ctx, t.model_order_id);
      const dispatch = vi.mocked(ctx.inference!.dispatch);
      dispatch.mockImplementationOnce(async (_route, call, id) => {
        modelCalls++;
        if (change === 'stop') await controlStudio(ctx, owner, task.id, 'stop');
        if (change === 'deadline')
          await pool.query(
            "UPDATE broker_studio_tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [task.id],
          );
        if (change === 'revocation')
          await pool.query('UPDATE "user" SET role=\'provider\' WHERE id=$1', [owner.id]);
        if (change === 'lease')
          await pool.query(
            "UPDATE broker_studio_tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [task.id],
          );
        return {
          id,
          content: '',
          finishReason: 'length',
          inputTokens: fixtureInputTokens(call),
          outputTokens: 2048,
        };
      });
      t = await tick(task.id);
      expect(modelCalls).toBe(1);
      expect(t.plan_attempt).toBe(0);
      expect(t.vm_request_id).toBeNull();
      const receipt = (
        await pool.query(
          'SELECT status,output_tokens FROM broker_inference_requests WHERE source_task_id=$1',
          [task.id],
        )
      ).rows[0];
      expect(receipt).toMatchObject({ status: 'settled', output_tokens: 2048 });
      await tick(task.id);
      expect(modelCalls).toBe(1);
      expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    },
  );
  it('recovers a settled saved reply after a worker checkpoint failure without another provider call', async () => {
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    const query = pool.query.bind(pool);
    let failed = false;
    const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
      if (
        !failed &&
        String(args[0]).includes('UPDATE broker_studio_plan_attempts a SET failure_code')
      ) {
        failed = true;
        throw Error('Synthetic lost worker checkpoint');
      }
      return (query as any)(...args);
    }) as any);
    try {
      t = await tick(task.id);
    } finally {
      spy.mockRestore();
    }
    expect(t.status).toBe('needs_attention');
    expect(modelCalls).toBe(1);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      hasSavedResponse: true,
      canRetry: true,
    });
    await controlStudio(ctx, owner, task.id, 'retry-plan');
    t = await tick(task.id);
    expect(t.status).toBe('compute_auction');
    expect(t.plan_attempt).toBe(0);
    expect(modelCalls).toBe(1);
  });
  it('keeps usage held if the planning response cannot be committed atomically with settlement', async () => {
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    await pool.query(
      `CREATE FUNCTION reject_planning_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.response_cipher IS NOT NULL THEN RAISE EXCEPTION 'Synthetic artifact persistence failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER fail_planning_result BEFORE UPDATE ON broker_studio_plan_attempts FOR EACH ROW EXECUTE FUNCTION reject_planning_result()`,
    );
    try {
      t = await tick(task.id);
    } finally {
      await pool.query('DROP TRIGGER fail_planning_result ON broker_studio_plan_attempts');
      await pool.query('DROP FUNCTION reject_planning_result()');
    }
    expect(t.status).toBe('needs_attention');
    expect(modelCalls).toBe(1);
    const request = (
      await pool.query(
        'SELECT status,input_tokens,output_tokens FROM broker_inference_requests WHERE source_task_id=$1',
        [task.id],
      )
    ).rows[0];
    expect(request).toEqual({ status: 'outcome_unknown', input_tokens: null, output_tokens: null });
    const pack = (
      await pool.query(
        'SELECT consumed_input,held_input FROM broker_token_packs WHERE grant_id=$1',
        [t.grant_id],
      )
    ).rows[0];
    expect(Number(pack.consumed_input)).toBe(0);
    expect(Number(pack.held_input)).toBeGreaterThan(0);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      canRetry: false,
      hasSavedResponse: false,
    });
    await tick(task.id);
    expect(modelCalls).toBe(1);
  });
  it('allows one owner-authorized legacy repair, blocks other tenants, and never repeats the old operation', async () => {
    invalidPlan = true;
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    t = await tick(task.id);
    await pool.query('DELETE FROM broker_studio_plan_attempts WHERE task_id=$1', [task.id]);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      failureCode: 'missing_response',
      canRetry: true,
    });
    await expect(controlStudio(ctx, other, task.id, 'retry-plan')).rejects.toThrow('not found');
    await expect(
      controlStudio(
        ctx,
        { ...owner, apiKey: { id: randomUUID(), grantId: t.grant_id, scopes: [], limits: {} } },
        task.id,
        'retry-plan',
      ),
    ).rejects.toThrow('signed-in owner');
    invalidPlan = false;
    await controlStudio(ctx, owner, task.id, 'retry-plan');
    t = await tick(task.id);
    expect(t.status).toBe('compute_auction');
    expect(modelCalls).toBe(2);
    const operations = (
      await pool.query(
        'SELECT operation_key FROM broker_inference_requests WHERE grant_id=$1 ORDER BY created_at',
        [t.grant_id],
      )
    ).rows.map((r) => r.operation_key);
    expect(operations).toEqual([planOperation(task.id, 0), planOperation(task.id, 1)]);
  });
  it('expires retained planning replies with task artifacts while preserving diagnostic metadata', async () => {
    const task = await create();
    await planned(task.id);
    await pool.query(
      "UPDATE broker_studio_tasks SET artifacts_expire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [task.id],
    );
    await maintainStudio(ctx);
    const attempt = (
      await pool.query(
        'SELECT response_cipher,finish_reason FROM broker_studio_plan_attempts WHERE task_id=$1',
        [task.id],
      )
    ).rows[0];
    expect(attempt).toEqual({ response_cipher: null, finish_reason: 'stop' });
    expect(
      (await pool.query('SELECT plan_input_cipher FROM broker_studio_tasks WHERE id=$1', [task.id]))
        .rows[0].plan_input_cipher,
    ).toBeNull();
  });
  it('stops an open compute auction, prevents a late award, and releases only unspent funding', async () => {
    const task = await create();
    const t = await planned(task.id);
    await submitBid(ctx, suppliers[0]!, t.vm_request_id, { totalPriceCents: 10 });
    await controlStudio(ctx, owner, task.id, 'stop');
    await tick(task.id);
    const detail = await studioDetail(ctx, owner, task.id);
    expect(detail.task.status).toBe('stopped');
    expect(detail.task.computeChargedCents).toBe(0);
    expect(detail.task.reservedCents).toBe(0);
    expect(detail.task.spentCents).toBeGreaterThan(0);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_studio_usage_samples')).rows[0].n,
    ).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    await expect(
      transaction(pool, async (db) =>
        awardHeldBid(
          ctx,
          db,
          (await db.query('SELECT * FROM broker_requests WHERE id=$1', [t.vm_request_id])).rows[0],
          (await db.query('SELECT * FROM broker_bids WHERE request_id=$1', [t.vm_request_id]))
            .rows[0],
        ),
      ),
    ).rejects.toThrow();
    await controlStudio(ctx, owner, task.id, 'stop');
  });
  it('does not release the runtime or compute reservation while allocation cleanup is uncertain', async () => {
    const task = await create(),
      vm = await awarded(task.id);
    await pool.query(
      `UPDATE broker_vms SET status='failed',poll_attempts=1,environment_id=NULL WHERE id=$1`,
      [vm.id],
    );
    await controlStudio(ctx, owner, task.id, 'stop');
    const t = await tick(task.id);
    expect(t.status).toBe('cleaning_up');
    expect(Number(t.compute_reserved_cents)).toBeGreaterThan(0);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.reservedCents).toBeGreaterThan(0);
    expect(d.task.status).not.toBe('stopped');
  });
  it('keeps unknown planning usage held and never automatically generates a replacement', async () => {
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      `UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    modelLost = true;
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    expect(t.plan_request_id).toBeTruthy();
    await tick(task.id);
    expect(modelCalls).toBe(1);
    await expect(controlStudio(ctx, owner, task.id, 'retry-plan')).rejects.toThrow(
      'cannot be retried',
    );
    await controlStudio(ctx, owner, task.id, 'stop');
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    expect(t.outcome).toBe('stopped');
    const held = (
      await pool.query('SELECT held_output FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    expect(Number(held.held_output)).toBeGreaterThan(0);
    expect((await studioDetail(ctx, owner, task.id)).planning).toMatchObject({
      requestStatus: 'outcome_unknown',
      canRetry: false,
    });
    await expect(controlStudio(ctx, owner, task.id, 'retry-plan')).rejects.toThrow(
      'closed or expired',
    );
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_studio_usage_samples')).rows[0].n,
    ).toBe(0);
  });
  it('refuses a route unsuitable for coding before reserving funds or making purchases', async () => {
    for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 512;
    await expect(create()).rejects.toThrow('qualified for coding');
    expect((await creditWalletView(pool, owner.id)).reservedCents).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM broker_token_orders')).rows[0].n).toBe(0);
  });
  it('stops at the original deadline without automatically extending the rental or funding', async () => {
    const task = await create();
    await pool.query(
      `UPDATE broker_studio_tasks SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [task.id],
    );
    await tick(task.id);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.status).toBe('failed');
    expect(d.task.returnedCents).toBe(200);
    expect(modelCalls).toBe(0);
  });
  it('keeps task history, artifacts and funding isolated from other owners and agent keys', async () => {
    const task = await create();
    await expect(studioDetail(ctx, other, task.id)).rejects.toThrow('not found');
    await expect(controlStudio(ctx, other, task.id, 'stop')).rejects.toThrow('not found');
    expect((await listStudioTasks(ctx, other, {})).items).toEqual([]);
    await expect(
      createStudioTask(
        ctx,
        { ...owner, apiKey: { id: randomUUID(), grantId: randomUUID(), scopes: [], limits: {} } },
        input(),
        verify,
      ),
    ).rejects.toThrow('signed-in owner');
  });
  it('never returns a patch or a completed task from VM readiness alone', async () => {
    const task = await create();
    await ready(task.id);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.status).toBe('provisioning');
    expect(d.task.verifiedAt).toBeNull();
    expect(d.task.hasPatch).toBe(false);
    await expect(studioPatch(ctx, owner, task.id)).rejects.toThrow('not available');
  });
  it('does not close the 30-second compute auction early', async () => {
    const task = await create(),
      t = await planned(task.id);
    await submitBid(ctx, suppliers[0]!, t.vm_request_id, { totalPriceCents: 10 });
    await closeAuction(ctx, t.vm_request_id);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    const interval = (
      await pool.query(
        'SELECT extract(epoch from(closes_at-created_at)) seconds FROM broker_requests WHERE id=$1',
        [t.vm_request_id],
      )
    ).rows[0];
    expect(Number(interval.seconds)).toBe(30);
  });
  it('replenishes model allowance after owner funding without buying another VM or extending the deadline', async () => {
    const routes = (await pool.query(OFFER_SELECT)).rows;
    const forecast = forecastUsage(usageFeatures(input().goal, await repo()), []);
    const sized = sizeUsagePurchase(forecast, { input: 0, output: 0, calls: 0 }, 1, 256, 0);
    const pack = Math.min(
      ...routes.map((r) => packPrice(r, sized.inputTokens, sized.outputTokens).priceCents),
    );
    const task = await create({ budgetCents: addCents(pack, 12.51) }),
      { task: t, vm } = await ready(task.id);
    const deadline = task.deadlineAt;
    // A later seller price increase can require owner funding; accepted pack terms stay frozen.
    await pool.query(
      'UPDATE broker_token_offerings SET minimum_price_cents=10,revision=revision+1',
    );
    await pool.query(
      'UPDATE broker_token_packs SET available_output=0,consumed_output=output_tokens WHERE grant_id=$1',
      [t.grant_id],
    );
    await processCodingJob(ctx, t.coding_job_id);
    let state = await tick(task.id);
    expect(state.status, state.blocked_reason).toBe('needs_budget');
    await controlStudio(ctx, owner, task.id, 'fund', {
      operationKey: randomUUID(),
      amountCents: 200,
    });
    state = await tick(task.id);
    expect(state.status, state.blocked_reason).toBe('model_auction');
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [state.model_order_id],
    );
    await closeTokenAuction(ctx, state.model_order_id);
    await tick(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    await tick(task.id);
    await finishExecution(task.id);
    await cleaned(task.id, vm.id);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.status, d.task.blockedReason ?? '').toBe('completed');
    expect(d.task.deadlineAt).toBe(deadline);
    expect(d.modelPurchases.length).toBeGreaterThanOrEqual(2);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(1);
    expect(modelCalls).toBe(5);
  });
  it('tops up only exhausted output and combines it with prepaid input on the same VM', async () => {
    const task = await create({ allowedProviders: ['baseten'], allowInstant: false });
    const { task: t } = await ready(task.id);
    const original = (
      await pool.query('SELECT * FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    // Synthetic exhaustion models other authorized calls spending this dimension.
    // Keep the already paid input available and conserve both pack/route counters.
    await transaction(pool, async (db) => {
      await db.query(
        'UPDATE broker_inference_routes SET outstanding_output=outstanding_output-$2 WHERE provider=$1',
        [original.provider, original.available_output],
      );
      await db.query(
        'UPDATE broker_token_packs SET available_output=0,consumed_output=output_tokens WHERE id=$1',
        [original.id],
      );
    });
    await processCodingJob(ctx, t.coding_job_id);
    expect(
      (await pool.query('SELECT status FROM broker_coding_jobs WHERE id=$1', [t.coding_job_id]))
        .rows[0].status,
    ).toBe('needs_allowance');
    const state = await tick(task.id);
    expect(state.status, state.blocked_reason).toBe('model_auction');
    const order = (
      await pool.query('SELECT * FROM broker_token_orders WHERE id=$1', [state.model_order_id])
    ).rows[0];
    expect(order.input_tokens).toBe(1);
    expect(order.output_tokens).toBeGreaterThanOrEqual(1024);
    expect(order.output_tokens).toBeLessThan(4096);
    expect(order.provider_constraint).toBe('baseten');
    const estimate = (
      await pool.query(
        'SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1 AND purchase_round=1',
        [task.id],
      )
    ).rows[0];
    expect(estimate.required_provider).toBe('baseten');
    expect(Number(estimate.existing_input)).toBe(Number(original.available_input));
    expect(Number(estimate.existing_output)).toBe(0);
    expect(estimate.required_routes).toHaveLength(1);
    expect(estimate.required_routes[0]).toMatchObject({
      provider: 'baseten',
      inputBound: estimate.input_floor,
    });
    const replay = await ensureUsageEstimate(ctx, state, 1048576, [
      { route: {}, inputFloor: 1048576, availableInput: 0, availableOutput: 0 },
    ]);
    expect(replay).toEqual(estimate);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [order.id],
    );
    await closeTokenAuction(ctx, order.id);
    await tick(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    const allocations = (
      await pool.query(
        `SELECT a.* FROM broker_inference_allocations a JOIN broker_inference_requests r ON r.id=a.request_id WHERE r.source_job_id=$1 ORDER BY r.created_at,a.allocation_order LIMIT 2`,
        [t.coding_job_id],
      )
    ).rows;
    expect(allocations).toHaveLength(2);
    expect(new Set(allocations.map((a) => a.pack_id)).size).toBe(2);
    expect(allocations.some((a) => a.reserved_input > 0 && a.reserved_output === 0)).toBe(true);
    expect(allocations.some((a) => a.reserved_input <= 1 && a.reserved_output > 0)).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(1);
    expect(new Date(state.deadline_at).toISOString()).toBe(task.deadlineAt);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(2);
  });
  it('resumes from fragmented compatible packs without an auction even after new supply is unpublished', async () => {
    const task = await create({ allowedProviders: ['baseten'] });
    const { task: t } = await ready(task.id);
    const original = (
      await pool.query('SELECT * FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    await pool.query(
      'UPDATE broker_token_packs SET available_input=0,consumed_input=input_tokens WHERE id=$1',
      [original.id],
    );
    await processCodingJob(ctx, t.coding_job_id);
    const pending = (
      await pool.query(
        "SELECT payload_cipher FROM broker_coding_steps WHERE job_id=$1 AND kind='model' AND status='pending' ORDER BY sequence LIMIT 1",
        [t.coding_job_id],
      )
    ).rows[0];
    const inputFloor = fixtureInputTokens({ messages: open(ctx, pending.payload_cipher).messages });
    const q = (
      await quotes(ctx, owner, {
        grantId: t.grant_id,
        inputTokens: inputFloor * 2,
        outputTokens: 256,
      })
    ).items[0]!;
    expect(q.provider).toBe('baseten');
    const extra = await createTokenOrder(ctx, owner, {
      operationKey: randomUUID(),
      grantId: t.grant_id,
      mode: 'instant',
      inputTokens: inputFloor * 2,
      outputTokens: 256,
      maxTotalCents: q.priceCents,
      quoteId: q.quoteId,
    });
    const second = (
      await pool.query('SELECT * FROM broker_token_packs WHERE order_id=$1', [extra.id])
    ).rows[0];
    await transaction(pool, async (db) => {
      for (const [id, input, output] of [
        [original.id, Math.floor(inputFloor / 2), 256],
        [second.id, Math.ceil(inputFloor / 2), 0],
      ] as const) {
        await db.query(
          'UPDATE broker_token_packs SET available_input=$2,consumed_input=input_tokens-$2,available_output=$3,consumed_output=output_tokens-$3 WHERE id=$1',
          [id, input, output],
        );
      }
      await db.query(
        `UPDATE broker_inference_routes r SET outstanding_input=(SELECT sum(available_input+held_input) FROM broker_token_packs p WHERE p.provider=r.provider),outstanding_output=(SELECT sum(available_output+held_output) FROM broker_token_packs p WHERE p.provider=r.provider) WHERE provider='baseten'`,
      );
      await db.query('UPDATE broker_token_offerings SET active=false');
    });
    const callsBefore = modelCalls;
    const state = await tick(task.id);
    expect(state.status, state.blocked_reason).toBe('running');
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM broker_studio_usage_estimates WHERE task_id=$1',
          [task.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await processCodingJob(ctx, t.coding_job_id);
    expect(modelCalls).toBe(callsBefore + 1);
    const allocations = (
      await pool.query(
        `SELECT a.pack_id FROM broker_inference_allocations a JOIN broker_inference_requests r ON r.id=a.request_id WHERE r.source_job_id=$1`,
        [t.coding_job_id],
      )
    ).rows;
    expect(new Set(allocations.map((a) => a.pack_id))).toEqual(new Set([original.id, second.id]));
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(1);
    expect(new Date(state.deadline_at).toISOString()).toBe(task.deadlineAt);
  });
  it('resumes existing quota when a pending refill auction releases its hold instead of purchasing again', async () => {
    const task = await create({ allowedProviders: ['baseten'] });
    const { task: t } = await ready(task.id);
    const original = (
      await pool.query('SELECT * FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    await transaction(pool, async (db) => {
      await db.query(
        'UPDATE broker_inference_routes SET outstanding_output=outstanding_output-$2 WHERE provider=$1',
        [original.provider, original.available_output],
      );
      await db.query(
        'UPDATE broker_token_packs SET available_output=0,consumed_output=output_tokens WHERE id=$1',
        [original.id],
      );
    });
    await processCodingJob(ctx, t.coding_job_id);
    const auction = await tick(task.id);
    expect(auction.status).toBe('model_auction');
    const orderId = auction.model_order_id;
    // An owner may independently fund and purchase quota during a queued auction.
    await controlStudio(ctx, owner, task.id, 'fund', {
      operationKey: randomUUID(),
      amountCents: 10,
    });
    const q = (
      await quotes(ctx, owner, { grantId: t.grant_id, inputTokens: 1, outputTokens: 2048 })
    ).items.find((q) => q.provider === 'baseten')!;
    expect(q).toBeDefined();
    await createTokenOrder(ctx, owner, {
      operationKey: randomUUID(),
      grantId: t.grant_id,
      mode: 'instant',
      inputTokens: 1,
      outputTokens: 2048,
      maxTotalCents: q.priceCents,
      quoteId: q.quoteId,
    });
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [orderId],
    );
    await closeTokenAuction(ctx, orderId);
    expect(
      (await pool.query('SELECT status FROM broker_token_orders WHERE id=$1', [orderId])).rows[0]
        .status,
    ).toBe('cancelled');
    const resumed = await tick(task.id);
    expect(resumed.status, resumed.blocked_reason).toBe('running');
    expect(resumed.model_order_id).toBe(orderId);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_packs WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(2);
    expect(
      (await pool.query('SELECT held_cents FROM broker_inference_grants WHERE id=$1', [t.grant_id]))
        .rows[0].held_cents,
    ).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(1);
    expect(new Date(resumed.deadline_at).toISOString()).toBe(task.deadlineAt);
  });
  it('pauses an unusable frozen refill without charging or falling back to another purchase', async () => {
    const task = await create({ allowedProviders: ['baseten'] });
    const { task: t } = await ready(task.id);
    const original = (
      await pool.query('SELECT * FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    await pool.query(
      'UPDATE broker_token_packs SET available_output=0,consumed_output=output_tokens WHERE id=$1',
      [original.id],
    );
    await processCodingJob(ctx, t.coding_job_id);
    const auction = await tick(task.id);
    const before = (
      await pool.query('SELECT spent_cents FROM broker_inference_grants WHERE id=$1', [t.grant_id])
    ).rows[0];
    // Another authorized consumer can spend the dimension on which this top-up relies.
    await pool.query(
      'UPDATE broker_token_packs SET available_input=0,consumed_input=input_tokens WHERE id=$1',
      [original.id],
    );
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [auction.model_order_id],
    );
    await closeTokenAuction(ctx, auction.model_order_id);
    expect(
      (
        await pool.query('SELECT status FROM broker_token_orders WHERE id=$1', [
          auction.model_order_id,
        ])
      ).rows[0].status,
    ).toBe('no_offers');
    const paused = await tick(task.id);
    expect(paused.status).toBe('needs_attention');
    expect(paused.blocked_reason).toContain('No additional pack was charged');
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query('SELECT spent_cents,held_cents FROM broker_inference_grants WHERE id=$1', [
          t.grant_id,
        ])
      ).rows[0],
    ).toEqual({ spent_cents: before.spent_cents, held_cents: 0 });
    expect(new Date(paused.deadline_at).toISOString()).toBe(task.deadlineAt);
  });
  it('preserves the compute hold if the owner closes funding during VM admission', async () => {
    const task = await create(),
      vm = await awarded(task.id);
    await provisionVm(ctx, vm.id);
    await pool.query(
      "UPDATE broker_fixture_environments SET ready_at=clock_timestamp()-interval '1 second'",
    );
    await provisionVm(ctx, vm.id);
    const t = (await pool.query('SELECT * FROM broker_studio_tasks WHERE id=$1', [task.id]))
      .rows[0];
    const grant = await closeGrant(ctx, owner, t.grant_id, { operationKey: randomUUID() });
    expect(grant.status).toBe('closing');
    expect(grant.heldCents).toBe(12.5);
    await tick(task.id);
    await cleaned(task.id, vm.id);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.status).toBe('failed');
    expect(d.task.computeChargedCents).toBe(10);
    expect(d.task.reservedCents).toBe(0);
    expect(d.task.spentCents).toBeLessThanOrEqual(d.task.budgetCents);
  });
  it('uses a bounded indexed keyset page without loading retained source or patch payloads from large histories', async () => {
    await pool.query(
      `WITH grants AS (INSERT INTO broker_inference_grants(buyer_id,name,status,source_mode,funded_cents,available_cents,returned_cents,max_purchase_cents,allowed_providers,expires_at)
      SELECT $1,'History','closed','fixture',1,0,1,1,'["modal"]',clock_timestamp()+interval '1 day' FROM generate_series(1,10000) RETURNING id)
      INSERT INTO broker_studio_tasks(buyer_id,grant_id,operation_key,input_fingerprint,repository_url,commit_sha,base_ref,goal,source_mode,status,duration_minutes,deadline_at,model_output,plan_input_cipher,patch_cipher)
      SELECT $1,id,id::text,'history','https://github.com/example/public',repeat('a',40),'main','Historical coding task','fixture','completed',30,clock_timestamp()+interval '30 minutes',4096,repeat('large-source',5000),repeat('large-patch',5000) FROM grants`,
      [owner.id],
    );
    await pool.query('ANALYZE broker_studio_tasks');
    await pool.query('ANALYZE broker_inference_grants');
    const first = await listStudioTasks(ctx, owner, { limit: 5 }),
      second = await listStudioTasks(ctx, owner, { limit: 5, cursor: first.nextCursor });
    expect(first.items).toHaveLength(5);
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((t) => t.id)).size).toBe(10);
    expect(JSON.stringify(first).length).toBeLessThan(10000);
    expect((await listStudioTasks(ctx, other, { limit: 5 })).items).toEqual([]);
    const explained = (
      await pool.query(
        `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT t.id,g.funded_cents FROM broker_studio_tasks t JOIN broker_inference_grants g ON g.id=t.grant_id WHERE t.buyer_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 6`,
        [owner.id],
      )
    ).rows[0]['QUERY PLAN'];
    expect(JSON.stringify(explained)).toContain('broker_studio_owner_page');
    expect(JSON.stringify(explained)).toContain('broker_inference_grants_pkey');
    expect(explained[0].Plan['Actual Rows']).toBe(6);
    // Training reads only the latest 200 numeric observations for this owner and contract.
    await pool.query(
      `INSERT INTO broker_studio_usage_samples(task_id,buyer_id,source_mode,model_output,estimator_version,features,input_tokens,output_tokens,model_calls,completed_at)
      SELECT id,buyer_id,source_mode,model_output,$2,$3::jsonb,12000,3000,7,created_at FROM broker_studio_tasks WHERE buyer_id=$1`,
      [
        owner.id,
        USAGE_ESTIMATOR_VERSION,
        JSON.stringify(usageFeatures(input().goal, await repo())),
      ],
    );
    await pool.query('ANALYZE broker_studio_usage_samples');
    const args = [owner.id, 'fixture', 4096, USAGE_ESTIMATOR_VERSION, 200];
    const training = await pool.query(TRAINING_SELECT, args);
    expect(training.rows).toHaveLength(200);
    expect(JSON.stringify(training.rows).length).toBeLessThan(50000);
    expect((await pool.query(TRAINING_SELECT, [other.id, ...args.slice(1)])).rows).toHaveLength(0);
    expect(
      (await pool.query(TRAINING_SELECT, [owner.id, 'real', ...args.slice(2)])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query(TRAINING_SELECT, [owner.id, 'fixture', 2048, USAGE_ESTIMATOR_VERSION, 200]))
        .rows,
    ).toHaveLength(0);
    const plan = (await pool.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + TRAINING_SELECT, args))
      .rows[0]['QUERY PLAN'];
    expect(JSON.stringify(plan)).toContain('broker_studio_usage_training');
    expect(plan[0].Plan['Actual Rows']).toBe(200);
    expect(JSON.stringify(plan)).not.toContain('Seq Scan');
    await pool.query(
      `INSERT INTO broker_studio_plan_attempts(task_id,attempt,response_cipher)
      SELECT id,0,repeat('opaque-body',500) FROM broker_studio_tasks WHERE buyer_id=$1`,
      [owner.id],
    );
    await pool.query('ANALYZE broker_studio_plan_attempts');
    const historyId = (await pool.query('SELECT task_id FROM broker_studio_plan_attempts LIMIT 1'))
      .rows[0].task_id;
    const diagnostic = (await pool.query(PLAN_DIAGNOSTICS_SELECT, [historyId, 0])).rows;
    expect(diagnostic).toHaveLength(1);
    expect(JSON.stringify(diagnostic)).not.toContain('opaque-body');
    expect(JSON.stringify(diagnostic).length).toBeLessThan(500);
    const diagnosticPlan = (
      await pool.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + PLAN_DIAGNOSTICS_SELECT, [
        historyId,
        0,
      ])
    ).rows[0]['QUERY PLAN'];
    expect(JSON.stringify(diagnosticPlan)).toContain('broker_studio_plan_attempts_pkey');
    expect(diagnosticPlan[0].Plan['Actual Rows']).toBe(1);
    const task = await create(),
      state = await tick(task.id);
    const summary = await studioDetail(ctx, owner, task.id);
    expect(summary.usage?.forecast.basis).toBe('learned');
    expect(summary.usage?.forecast.trainingSamples).toBe(200);
    expect(summary.usage?.forecast.validation?.samples).toBe(40);
    expect(state.status).toBe('model_auction');
  });
  it('freezes each estimate for purchase replay even when the model or route minimum changes', async () => {
    const task = await create(),
      state = await tick(task.id);
    const original = (
      await pool.query('SELECT * FROM broker_studio_usage_estimates WHERE task_id=$1', [task.id])
    ).rows[0];
    const replay = await ensureUsageEstimate(
      ctx,
      {
        ...state,
        usage_features: usageFeatures('Refactor all services and migrate every database.'),
      },
      1048576,
    );
    expect(replay).toEqual(original);
    await tick(task.id);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM broker_studio_usage_estimates WHERE task_id=$1',
          [task.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          state.grant_id,
        ])
      ).rows[0].n,
    ).toBe(1);
    await transaction(pool, (db) => recordUsageSample(db, { ...state, outcome: 'failed' }));
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_studio_usage_samples')).rows[0].n,
    ).toBe(0);
  });
  it('does not replace unsettled usage with a new forecast or paid allowance', async () => {
    const task = await create();
    let t = await tick(task.id);
    await pool.query(
      "UPDATE broker_token_orders SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [t.model_order_id],
    );
    await closeTokenAuction(ctx, t.model_order_id);
    modelLost = true;
    t = await tick(task.id);
    expect((await taskUsage(pool, t)).unresolved).toBe(1);
    await transaction(pool, (db) => recordUsageSample(db, { ...t, outcome: 'completed' }));
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_studio_usage_samples')).rows[0].n,
    ).toBe(0);
    await expect(ensureUsageEstimate(ctx, { ...t, purchase_round: 1 }, 64000)).rejects.toThrow(
      'reconciliation',
    );
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM broker_studio_usage_estimates WHERE task_id=$1',
          [task.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
          t.grant_id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });
  it('can fund a task that starts below the minimum resource price without exposing per-purchase controls', async () => {
    const task = await create({ budgetCents: 1 });
    let t = await tick(task.id);
    expect(t.status, t.blocked_reason).toBe('needs_budget');
    expect(modelCalls).toBe(0);
    await controlStudio(ctx, owner, task.id, 'fund', {
      operationKey: randomUUID(),
      amountCents: 200,
    });
    t = await tick(task.id);
    expect(t.status, t.blocked_reason).toBe('model_auction');
    const grant = (
      await pool.query(
        'SELECT funded_cents,max_purchase_cents FROM broker_inference_grants WHERE id=$1',
        [t.grant_id],
      )
    ).rows[0];
    expect(Number(grant.funded_cents)).toBe(201);
    expect(Number(grant.max_purchase_cents)).toBe(201);
    expect(new Date(t.deadline_at).toISOString()).toBe(task.deadlineAt);
  });
});
