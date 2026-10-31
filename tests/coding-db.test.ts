import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { registerCoding } from '../src/server/coding/index.js';
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { migrate, transaction } from '../src/server/db.js';
import { loadConfig } from '../src/server/config.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor } from '../src/shared/types.js';
import { createInferenceRuntime, fixtureInputTokens } from '../src/server/inference/runtime.js';
import { initializeInference, quotes, createTokenOrder } from '../src/server/inference/market.js';
import { createGrant } from '../src/server/inference/grants.js';
import { applyCreditEntry } from '../src/server/agreements/credits.js';
import {
  createCodingJob,
  processCodingJob,
  codingDetail,
  controlCoding,
  listCodingJobs,
  maintainCoding,
} from '../src/server/coding/service.js';
import { complete } from '../src/server/inference/gateway.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable coding jobs (disposable PostgreSQL; no live providers)', () => {
  let pool: Pool, admin: Pool, ctx: AppContext, providerId: string, vmId: string, grantId: string;
  const schema = 'coding_' + randomUUID().replaceAll('-', '');
  const owner: Actor = {
    id: randomUUID(),
    role: 'buyer',
    name: 'Coding owner',
    email: 'coding@fixture.invalid',
  };
  const other: Actor = {
    id: randomUUID(),
    role: 'buyer',
    name: 'Other owner',
    email: 'other-coding@fixture.invalid',
  };
  const providers = [
    { id: randomUUID(), role: 'provider', name: 'Modal', email: 'modal@fixture.invalid' },
    { id: randomUUID(), role: 'provider', name: 'Baseten', email: 'baseten@fixture.invalid' },
  ];
  const verify = vi.fn(async (url: string, ref: string) => ({
    url,
    ref: ref || 'main',
    owner: 'example',
    name: 'average',
    sha: 'a'.repeat(40),
  }));
  const commands: Record<string, unknown>[] = [];
  const journal = new Map<string, unknown>();
  let actions: unknown[],
    loseCommand = false,
    loseModel = false,
    testExit = 0,
    workspaceOverflow = false;
  const input = () => ({
    operationKey: randomUUID(),
    repositoryUrl: 'https://github.com/example/average',
    baseRef: 'main',
    vmId,
    grantId,
    goal: 'Fix average([]) and run tests.',
    testCommand: 'python3 -m unittest discover',
  });
  async function buy() {
    const q = (await quotes(ctx, owner, { grantId, inputTokens: 1000000, outputTokens: 5000 }))
      .items[0]!;
    await createTokenOrder(ctx, owner, {
      operationKey: randomUUID(),
      grantId,
      mode: 'instant',
      inputTokens: 1000000,
      outputTokens: 5000,
      maxTotalCents: q.priceCents,
      quoteId: q.quoteId,
    });
  }
  async function newVm() {
    const request = (
      await pool.query(
        "INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES($1,'Fixture VM','coding-fixture','{}','auto',15,100,'{}','ready') RETURNING id",
        [owner.id],
      )
    ).rows[0];
    const bid = (
      await pool.query(
        "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) SELECT $1,$2,id,'{}',100,'won' FROM broker_offerings WHERE provider_id=$2 LIMIT 1 RETURNING id",
        [request.id, providerId],
      )
    ).rows[0];
    return (
      await pool.query(
        "INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot,status,environment_id,expires_at) VALUES($1,$2,$3,$4,$5,'{}',$6,'{}','running',$7,clock_timestamp()+interval '15 minutes') RETURNING id",
        [
          request.id,
          owner.id,
          providerId,
          bid.id,
          randomUUID(),
          { sourceMode: 'fixture' },
          'fixture_' + randomUUID(),
        ],
      )
    ).rows[0].id;
  }
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
      BETTER_AUTH_SECRET: 'fixture-coding-secret-at-least-32-characters',
      INFERENCE_MODAL_PROVIDER_EMAIL: providers[0]!.email,
      INFERENCE_BASETEN_PROVIDER_EMAIL: providers[1]!.email,
    });
    for (const a of [owner, other, ...providers])
      await pool.query('INSERT INTO "user"(id,email,name,role) VALUES($1,$2,$3,$4)', [
        a.id,
        a.email,
        a.name,
        a.role,
      ]);
    for (const a of providers) {
      const p = (
        await pool.query(
          "INSERT INTO broker_providers(user_id,name,total_capacity,policy) VALUES($1,$2,5,'{}') RETURNING id",
          [a.id, a.name],
        )
      ).rows[0];
      if (a === providers[0]) providerId = p.id;
      await pool.query('UPDATE "user" SET "providerId"=$2 WHERE id=$1', [a.id, p.id]);
    }
    await pool.query(
      "INSERT INTO broker_catalog(id,item,approved) VALUES('coding-fixture','{}',true)",
    );
    await pool.query(
      "INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents) VALUES($1,'coding-fixture','Fixture','Fixture',100)",
      [providerId],
    );
    const runtime = await createInferenceRuntime(config);
    runtime.dispatch = vi.fn(async (_route, call, requestId) => {
      if (loseModel) throw new Error('lost model connection');
      const action = actions.shift() ?? {
        action: 'finish',
        summary: 'Tests passed. Review the patch.',
      };
      return {
        id: 'fixture_' + requestId,
        content: JSON.stringify(action),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(call),
        outputTokens: 40,
      };
    });
    ctx = {
      pool,
      config,
      boss: { send: vi.fn(async () => randomUUID()) },
      muse: { mode: 'fixture' },
      inference: runtime,
      wick: {
        mode: 'fixture',
        runCommand: vi.fn(async (_id: string, { command }: { command: string }) => {
          const encoded = command.match(/'([A-Za-z0-9+/=]+)'$/)![1]!;
          const data = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString());
          commands.push(data);
          if (data.action.action === 'stop')
            return {
              stdout: JSON.stringify({ stopRequested: true }),
              stderr: '',
              exitCode: 0,
              simulated: true,
            };
          const key = data.jobId + ':' + data.sequence;
          if (data.action.action === 'inspect')
            return {
              stdout: JSON.stringify(journal.get(key) ?? { state: 'not_started' }),
              stderr: '',
              exitCode: 0,
              simulated: true,
            };
          const result = {
            state: 'completed',
            action: data.action.action,
            result:
              data.action.action === 'clone'
                ? { files: ['average.py'] }
                : data.action.action === 'read'
                  ? {
                      path: 'average.py',
                      content: 'def average(items): return sum(items)/len(items)',
                    }
                  : data.action.action === 'test'
                    ? {
                        exitCode: testExit,
                        output: testExit ? '1 failed' : '2 passed',
                        interrupted: workspaceOverflow,
                        ...(workspaceOverflow ? { limitExceeded: 'workspace' } : {}),
                      }
                    : data.action.action === 'diff'
                      ? {
                          exitCode: 0,
                          output: 'diff --git a/average.py b/average.py\n+guard empty input\n',
                          truncated: false,
                        }
                      : { written: true },
          };
          journal.set(key, result);
          if (loseCommand) {
            loseCommand = false;
            throw Error('lost command result');
          }
          return { stdout: JSON.stringify(result), stderr: '', exitCode: 0, simulated: true };
        }),
      },
    } as unknown as AppContext;
  });
  beforeEach(async () => {
    commands.length = 0;
    verify.mockClear();
    loseCommand = false;
    loseModel = false;
    testExit = 0;
    workspaceOverflow = false;
    actions = [
      { action: 'read', path: 'average.py' },
      {
        action: 'write',
        path: 'average.py',
        content:
          'def average(items):\n    if not items: raise ValueError()\n    return sum(items)/len(items)',
      },
      { action: 'test' },
      { action: 'finish', summary: 'Tests passed. Review the patch.' },
    ];
    await pool.query(
      "UPDATE broker_coding_jobs SET status='stopped',lease_until=NULL,lease_token=NULL",
    );
    await transaction(pool, (db) =>
      applyCreditEntry(db, owner.id, {
        operationKey: randomUUID(),
        kind: 'grant',
        balanceDeltaCents: 5000,
        reservedDeltaCents: 0,
        description: 'Disposable coding test credit',
      }),
    );
    grantId = (
      await createGrant(ctx, owner, {
        operationKey: randomUUID(),
        name: 'Coding agent',
        budgetCents: 1000,
      })
    ).id;
    await initializeInference(ctx);
    vmId = await newVm();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('edits, tests and exports a patch through paid-quota settlement, with no owner-session gateway bypass', async () => {
    await buy();
    const request = input(),
      job = await createCodingJob(ctx, owner, request, verify);
    expect(commands).toHaveLength(0);
    await processCodingJob(ctx, job.id);
    const detail = await codingDetail(ctx, owner, job.id);
    expect(detail.job.status).toBe('ready');
    expect(detail.job.testsPassed).toBe(true);
    expect(detail.job.modelCalls).toBe(4);
    expect(detail.steps.filter((s) => s.kind === 'model').every((s) => s.inferenceRequestId)).toBe(
      true,
    );
    expect(commands.map((c) => (c.action as { action: string }).action)).toEqual([
      'clone',
      'test',
      'read',
      'write',
      'test',
      'diff',
    ]);
    const receipts = (
      await pool.query(
        'SELECT source_key_id,source_job_id,status FROM broker_inference_requests WHERE source_job_id=$1',
        [job.id],
      )
    ).rows;
    expect(receipts).toHaveLength(4);
    expect(
      receipts.every(
        (r) => r.source_job_id === job.id && !r.source_key_id && r.status === 'settled',
      ),
    ).toBe(true);
    const app = Fastify();
    registerCoding(app, {
      ...ctx,
      requireActor: async (request) =>
        request.headers['x-fixture-actor'] === 'other' ? other : owner,
    });
    try {
      const patch = await app.inject({ method: 'GET', url: `/api/coding/jobs/${job.id}/patch` });
      expect(patch.statusCode).toBe(200);
      expect(patch.headers['content-type']).toContain('text/x-diff');
      expect(patch.headers['content-disposition']).toContain('.patch');
      expect(patch.body).toContain('guard empty input');
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/coding/jobs/${job.id}/patch`,
            headers: { 'x-fixture-actor': 'other' },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
    expect((await createCodingJob(ctx, owner, request, verify)).id).toBe(job.id);
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(
      complete(ctx, owner, {
        operationKey: randomUUID(),
        model: 'meta/muse-spark-open',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 512,
      }),
    ).rejects.toThrow('grant-bound');
    await expect(codingDetail(ctx, other, job.id)).rejects.toThrow('not found');
  });
  it('serializes concurrent approvals on one VM and preserves the original operation', async () => {
    const outcomes = await Promise.allSettled([
      createCodingJob(ctx, owner, input(), verify),
      createCodingJob(ctx, owner, input(), verify),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const row = (await pool.query('SELECT count(*) FROM broker_coding_jobs WHERE vm_id=$1', [vmId]))
      .rows[0];
    expect(Number(row.count)).toBe(1);
  });
  it('pauses a command that exits zero after exceeding the workspace bound without spending model quota', async () => {
    workspaceOverflow = true;
    const job = await createCodingJob(ctx, owner, input(), verify);
    await processCodingJob(ctx, job.id);
    const detail = await codingDetail(ctx, owner, job.id);
    expect(detail.job.status).toBe('paused');
    expect(detail.job.blockedReason).toContain('64 MB');
    expect(detail.job.testsPassed).toBe(false);
    expect(detail.job.modelCalls).toBe(0);
  });
  it('pauses for allowance, resumes after purchase, and never extends the deadline', async () => {
    const job = await createCodingJob(ctx, owner, input(), verify);
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('needs_allowance');
    await buy();
    await controlCoding(ctx, owner, job.id, 'resume');
    await processCodingJob(ctx, job.id);
    const done = (await codingDetail(ctx, owner, job.id)).job;
    expect(done.status).toBe('ready');
    expect(done.deadlineAt).toBe(job.deadlineAt);
  });
  it('recovers the same command receipt after a lost response without replaying the command', async () => {
    await buy();
    loseCommand = true;
    const job = await createCodingJob(ctx, owner, input(), verify);
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('uncertain');
    await controlCoding(ctx, owner, job.id, 'reconcile');
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('ready');
    expect(
      commands.filter((c) => (c.action as { action: string }).action === 'clone'),
    ).toHaveLength(1);
    expect(commands.some((c) => (c.action as { action: string }).action === 'inspect')).toBe(true);
  });
  it('holds unresolved inference and refuses replacement generation on restart', async () => {
    await buy();
    loseModel = true;
    const job = await createCodingJob(ctx, owner, input(), verify);
    await processCodingJob(ctx, job.id);
    await controlCoding(ctx, owner, job.id, 'reconcile');
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('uncertain');
    const rows = (
      await pool.query(
        'SELECT status,reserved_output FROM broker_inference_requests WHERE source_job_id=$1',
        [job.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('outcome_unknown');
    expect(rows[0].reserved_output).toBe(512);
    const visible = await codingDetail(ctx, owner, job.id);
    expect(visible.steps.find((s) => s.kind === 'model')?.receipt?.heldOutputTokens).toBe(512);
  });
  it('rejects foreign resources before contacting GitHub and prevents agent keys from starting jobs', async () => {
    await expect(createCodingJob(ctx, other, input(), verify)).rejects.toThrow('owned running VM');
    expect(verify).not.toHaveBeenCalled();
    await expect(
      createCodingJob(
        ctx,
        { ...owner, apiKey: { id: randomUUID(), grantId, scopes: ['inference:use'], limits: {} } },
        input(),
        verify,
      ),
    ).rejects.toThrow('signed-in owner');
    expect(commands).toHaveLength(0);
  });
  it('fences duplicate workers and invalidates earlier passing tests after another write', async () => {
    await buy();
    actions = [
      { action: 'read', path: 'average.py' },
      { action: 'test' },
      { action: 'write', path: 'average.py', content: 'changed after tests' },
      { action: 'finish', summary: 'Must not accept stale tests' },
    ];
    const job = await createCodingJob(ctx, owner, input(), verify);
    await Promise.all([processCodingJob(ctx, job.id), processCodingJob(ctx, job.id)]);
    const detail = await codingDetail(ctx, owner, job.id);
    expect(detail.job.status).toBe('paused');
    expect(detail.job.testsPassed).toBe(false);
    expect(detail.job.modelCalls).toBe(4);
    expect(
      commands.filter((c) => (c.action as { action: string }).action === 'clone'),
    ).toHaveLength(1);
  });
  it('enforces original expiry and recovers a dispatching step without resending it', async () => {
    const job = await createCodingJob(ctx, owner, input(), verify);
    await pool.query("UPDATE broker_coding_steps SET status='dispatching' WHERE job_id=$1", [
      job.id,
    ]);
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('uncertain');
    expect(commands).toHaveLength(0);
    await pool.query(
      "UPDATE broker_coding_jobs SET status='queued',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('uncertain');
    expect(
      commands.every((c) => ['stop', 'inspect'].includes((c.action as { action: string }).action)),
    ).toBe(true);
  });
  it('will not claim success without tests after the last write and stops at owner request', async () => {
    await buy();
    testExit = 1;
    actions = [{ action: 'finish', summary: 'Claimed done without testing' }];
    const job = await createCodingJob(ctx, owner, input(), verify);
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('paused');
    await controlCoding(ctx, owner, job.id, 'stop');
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('stopped');
  });
  it('keeps paused jobs navigable and paginates only the owning buyer history', async () => {
    const job = await createCodingJob(ctx, owner, input(), verify);
    await controlCoding(ctx, owner, job.id, 'pause');
    await processCodingJob(ctx, job.id);
    expect((await codingDetail(ctx, owner, job.id)).job.status).toBe('paused');
    const first = await listCodingJobs(ctx, owner, { limit: '1' });
    expect(first.items).toHaveLength(1);
    if (first.nextCursor) {
      const next = await listCodingJobs(ctx, owner, { limit: '1', cursor: first.nextCursor });
      expect(next.items[0]?.id).not.toBe(first.items[0]!.id);
    }
    expect((await listCodingJobs(ctx, other, {})).items).toHaveLength(0);
  });
  it('expires artifacts without deleting history or receipts', async () => {
    const job = await createCodingJob(ctx, owner, input(), verify);
    await pool.query(
      "UPDATE broker_coding_jobs SET status='stopped',artifacts_expire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [job.id],
    );
    await maintainCoding(ctx);
    const detail = await codingDetail(ctx, owner, job.id);
    expect(detail.artifactsExpired).toBe(true);
    expect(detail.steps[0]!.action).toBe('expired');
    expect(
      (await pool.query('SELECT payload_cipher FROM broker_coding_steps WHERE job_id=$1', [job.id]))
        .rows[0].payload_cipher,
    ).toBe('');
  });
  it('retains indexed, bounded listing with 10,000 historical jobs', async () => {
    await pool.query(
      `INSERT INTO broker_coding_jobs(buyer_id,vm_id,grant_id,environment_id,operation_key,input_fingerprint,repository_url,commit_sha,base_ref,goal,test_command,source_mode,status,deadline_at,created_at)
      SELECT $1,$2,$3,'historical-fixture',gen_random_uuid()::text,'fixture','https://github.com/example/average',repeat('a',40),'main','Historical test job','true','fixture','ready',now(),now()-n*interval '1 second' FROM generate_series(1,10000)n`,
      [owner.id, vmId, grantId],
    );
    await pool.query('ANALYZE broker_coding_jobs');
    const page = await listCodingJobs(ctx, owner, { limit: '25' });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toBeTruthy();
    const next = await listCodingJobs(ctx, owner, { limit: '25', cursor: page.nextCursor });
    expect(next.items).toHaveLength(25);
    expect(next.items.every((j) => !page.items.some((p) => p.id === j.id))).toBe(true);
    const plan = (
      await pool.query(
        `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM broker_coding_jobs WHERE buyer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 26`,
        [owner.id],
      )
    ).rows[0]['QUERY PLAN'][0];
    expect(JSON.stringify(plan)).toContain('broker_coding_buyer_page');
    expect(plan.Plan['Actual Rows']).toBe(26);
  });
});
import { inflateSync } from 'node:zlib';
