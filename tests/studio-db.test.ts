import { closeGrant } from '../src/server/inference/grants.js';
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
} from '../src/server/coding/studio.js';
import { processCodingJob, codingDetail } from '../src/server/coding/service.js';
import { reserveStudioCompute } from '../src/server/coding/studio-budget.js';

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
      return {
        id: 'fixture_' + id,
        content: JSON.stringify(data),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(call),
        outputTokens: 80,
      };
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
  it('runs one funded task from model auction to verified result and cleanup without manual VM or grant selection', async () => {
    const task = await create();
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(0);
    const { task: t, vm } = await ready(task.id);
    expect(t.execution_started_at).toBeNull();
    await processCodingJob(ctx, t.coding_job_id);
    await tick(task.id);
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
    expect(ledger.find((r) => r.kind === 'token_purchase')?.n).toBe(1);
    expect(ledger.find((r) => r.kind === 'studio_compute')?.n).toBe(1);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_invoices WHERE vm_id=$1', [vm.id]))
        .rows[0].n,
    ).toBe(1);
    expect(modelCalls).toBe(5);
    expect(detail.events.some((e) => e.kind === 'verification')).toBe(true);
    await tick(task.id);
    await processCodingJob(ctx, t.coding_job_id);
    expect(modelCalls).toBe(5);
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
    await tick(task.id);
    expect(modelCalls).toBe(1);
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
    await controlStudio(ctx, owner, task.id, 'stop');
    t = await tick(task.id);
    expect(t.status).toBe('needs_attention');
    expect(t.outcome).toBe('stopped');
    const held = (
      await pool.query('SELECT held_output FROM broker_token_packs WHERE grant_id=$1', [t.grant_id])
    ).rows[0];
    expect(Number(held.held_output)).toBeGreaterThan(0);
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
    const pack = Math.min(...routes.map((r) => packPrice(r, 195072, 16384).priceCents));
    const task = await create({ budgetCents: addCents(pack, 12.51) }),
      { task: t, vm } = await ready(task.id);
    const deadline = task.deadlineAt;
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
    await cleaned(task.id, vm.id);
    const d = await studioDetail(ctx, owner, task.id);
    expect(d.task.status, d.task.blockedReason ?? '').toBe('completed');
    expect(d.task.deadlineAt).toBe(deadline);
    expect(d.modelPurchases).toHaveLength(2);
    expect((await pool.query('SELECT count(*)::int n FROM broker_vms')).rows[0].n).toBe(1);
    expect(modelCalls).toBe(5);
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
