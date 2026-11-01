/** Opt-in: real public Git/guest commands on local Linux; model decisions and money are fixtures. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { fixtureInputTokens } from '../src/server/inference/runtime.js';
import { initializeInference, quotes, createTokenOrder } from '../src/server/inference/market.js';
import { createGrant } from '../src/server/inference/grants.js';
import { transaction } from '../src/server/db.js';
import { applyCreditEntry } from '../src/server/agreements/credits.js';
import { seedMarketplace } from '../src/server/marketplace/index.js';
import { guestStep } from '../src/server/coding/guest.js';
import type { StudioDetail, StudioTask } from '../src/shared/studio.js';
import type { Actor } from '../src/shared/types.js';
import type { CodingDetail, CodingJob } from '../src/shared/coding.js';

const exec = promisify(execFile),
  runId = randomUUID(),
  container = 'broker-coding-' + runId;
const context = process.env.CODING_TEST_DOCKER_CONTEXT;
if (!context)
  throw new Error('Set CODING_TEST_DOCKER_CONTEXT to an explicitly selected local Docker context.');
const dbUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) ||
  !dbUrl.protocol.startsWith('postgres')
)
  throw new Error('TEST_DATABASE_URL must be a disposable loopback PostgreSQL server.');
const database = 'coding_local_' + runId.replaceAll('-', ''),
  admin = new Pool({ connectionString: dbUrl.href });
async function docker(args: string[], timeout = 110000) {
  return exec('docker', ['--context', context!, ...args], { timeout, maxBuffer: 200000 });
}
const endpoint = JSON.parse(
  (await docker(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']))
    .stdout,
);
assert.ok(
  String(endpoint).startsWith('unix://'),
  'Remote Docker endpoints are not allowed for this local check.',
);
const report: Record<string, unknown> = {
  modelMode: 'fixture',
  guestMode: 'real local Linux container',
  nativeWickProvidersTested: false,
  checks: [],
};
const checks = report.checks as string[];
let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined,
  createdDatabase = false,
  createdContainer = false;
const image = process.env.CODING_TEST_IMAGE ?? 'wick-broker-coding-local:bookworm';
try {
  await docker([
    'run',
    '--detach',
    '--rm',
    '--privileged',
    '--memory=768m',
    '--cpus=1',
    '--pids-limit=128',
    '--name',
    container,
    '--label',
    'wick.broker.local-test=' + runId,
    '--env',
    'SERVICE_SECRET_CANARY=local-fixture-only',
    image,
  ]);
  createdContainer = true;
  await docker([
    'exec',
    container,
    'sh',
    '-c',
    'mkdir -p /workspace/private; printf local-fixture-only > /workspace/private/customer-secret.txt',
  ]);
  report.guestVersion = (
    await docker([
      'exec',
      container,
      'sh',
      '-c',
      'uname -sr; python3 --version; git --version; bwrap --version',
    ])
  ).stdout.trim();
  await admin.query(`CREATE DATABASE ${database}`);
  createdDatabase = true;
  const target = new URL(dbUrl.href);
  target.pathname = '/' + database;
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3188',
    DATABASE_URL: target.href,
    WICK_MODE: 'fixture',
    MUSE_MODE: 'fixture',
    INFERENCE_MARKET_MODE: 'fixture',
    BETTER_AUTH_SECRET: 'disposable-local-coding-auth-secret-at-least-32-characters',
    INFERENCE_MODAL_PROVIDER_EMAIL: 'modal@coding-local.invalid',
    INFERENCE_BASETEN_PROVIDER_EMAIL: 'baseten@coding-local.invalid',
    LOG_LEVEL: 'silent',
  });
  const marker = 'broker_coding_child_' + runId.replaceAll('-', '');
  const moduleCode =
    'def average(items):\n    if not items:\n        raise ValueError("Empty input")\n    return sum(items) / len(items)\n';
  const testCode = `import os, socket, subprocess, sys, unittest\nfrom pathlib import Path\nfrom broker_average import average\n\np = Path('/repo/.git/broker-test-runs')\np.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')\n\nclass Tests(unittest.TestCase):\n    def test_average(self): self.assertEqual(average([2, 4]), 3)\n    def test_empty(self):\n        with self.assertRaises(ValueError): average([])\n    def test_private_workspace_hidden(self): self.assertFalse(Path('/workspace/private/customer-secret.txt').exists())\n    def test_environment_clean(self): self.assertNotIn('SERVICE_SECRET_CANARY', os.environ)\n    def test_network_disabled(self):\n        with self.assertRaises(OSError): socket.create_connection(('1.1.1.1', 443), timeout=0.2)\n    def test_child_cleanup(self):\n        subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)', '${marker}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n`;
  const decisions = [
    { action: 'read', path: 'README.md' },
    { action: 'write', path: 'broker_average.py', content: moduleCode },
    { action: 'write', path: 'broker_tests/test_average.py', content: testCode },
    { action: 'test' },
    {
      action: 'finish',
      summary:
        'Added empty-input validation and six checks. Review the patch and actual command receipts.',
    },
  ];
  const nextDecision = new Map<string, number>(),
    planningCalls = new Map<string, number>(),
    nativeActions: string[] = [];
  const studioEnvironments = new Set<string>();
  let environmentId = '',
    loseTestResponse = true;
  const built = await buildApp(config, {
    wrapWick: (wick) => ({
      ...wick,
      async create(input, key) {
        const result = await wick.create(input, key);
        studioEnvironments.add(result.environment.id);
        return result;
      },
      async runCommand(id, input) {
        assert.ok(
          id === environmentId || studioEnvironments.has(id),
          'Command must target an owned local test VM.',
        );
        const payload = JSON.parse(
          inflateSync(
            Buffer.from(input.command.match(/'([A-Za-z0-9+/=]+)'$/)![1]!, 'base64'),
          ).toString(),
        );
        nativeActions.push(payload.action.action);
        const result = await docker(['exec', container, 'sh', '-lc', input.command]);
        if (payload.action.action === 'test' && loseTestResponse) {
          loseTestResponse = false;
          throw new Error('Injected lost response after native journal completion');
        }
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      },
    }),
    wrapInference: (runtime) => ({
      ...runtime,
      async dispatch(_route, input, requestId) {
        assert.equal(Object.hasOwn(input, 'reasoning_effort'), false);
        assert.equal(Object.hasOwn(input, 'reasoning'), false);
        const row = (
          await built.ctx.pool.query(
            'SELECT source_job_id,source_task_id FROM broker_inference_requests WHERE id=$1',
            [requestId],
          )
        ).rows[0];
        if (row.source_task_id) {
          const count = (planningCalls.get(row.source_task_id) ?? 0) + 1;
          planningCalls.set(row.source_task_id, count);
          assert(count <= 2, 'A planning failure permits at most one new generation.');
          assert.equal(input.max_tokens, 2048);
          const task = (
            await built.ctx.pool.query(
              'SELECT vm_request_id FROM broker_studio_tasks WHERE id=$1',
              [row.source_task_id],
            )
          ).rows[0];
          assert.equal(task.vm_request_id, null, 'Neither planning attempt may buy a VM.');
          if (count === 1)
            return {
              id: 'fixture-' + requestId,
              content: '{"catalogId":',
              finishReason: 'length',
              inputTokens: fixtureInputTokens(input),
              outputTokens: input.max_tokens,
            };
          const plan = JSON.parse(input.messages[1]!.content);
          return {
            id: 'fixture-' + requestId,
            content: JSON.stringify({
              catalogId: plan.candidates[0].id,
              testCommand: plan.ownerTestCommand || 'python3 -m unittest discover -s broker_tests',
              explanation:
                'Meta fixture chose the smallest reviewed Linux configuration for the public Python task.',
            }),
            finishReason: 'stop',
            inputTokens: fixtureInputTokens(input),
            outputTokens: 100,
          };
        }
        const index = nextDecision.get(row.source_job_id) ?? 0;
        nextDecision.set(row.source_job_id, index + 1);
        return {
          id: 'fixture-' + requestId,
          content: JSON.stringify(
            decisions[index] ?? { action: 'finish', summary: 'Review the actual test receipts.' },
          ),
          finishReason: 'stop',
          inputTokens: fixtureInputTokens(input),
          outputTokens: 100,
        };
      },
    }),
  });
  app = built.app;
  const ctx = built.ctx;
  const actors: Actor[] = [
    {
      id: randomUUID(),
      role: 'buyer',
      name: 'Local Linux test buyer',
      email: 'buyer@coding-local.invalid',
    },
    {
      id: randomUUID(),
      role: 'provider',
      name: 'Modal fixture',
      email: 'modal@coding-local.invalid',
    },
    {
      id: randomUUID(),
      role: 'provider',
      name: 'Baseten fixture',
      email: 'baseten@coding-local.invalid',
    },
  ];
  for (const a of actors)
    await ctx.pool.query(
      'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
      [a.id, a.email, a.name, a.role],
    );
  const owner = actors[0]!;
  await ctx.pool.query(
    'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
    [randomUUID(), owner.id, await hashPassword('local-coding-test-only')],
  );
  await seedMarketplace(ctx.pool, actors, await ctx.wick.catalog(), 'fixture');
  await ctx.pool.query(
    'UPDATE "user" u SET "providerId"=p.id FROM broker_providers p WHERE p.user_id=u.id',
  );
  // Match the qualified planning cap while keeping providers and billing fictional.
  for (const route of ctx.inference!.routes.values()) route.maximumOutputTokens = 2048;
  await initializeInference(ctx);
  await transaction(ctx.pool, (db) =>
    applyCreditEntry(db, owner.id, {
      operationKey: randomUUID(),
      kind: 'grant',
      balanceDeltaCents: 5000,
      reservedDeltaCents: 0,
      description: 'Disposable local test credit',
    }),
  );
  const grant = await createGrant(ctx, owner, {
    operationKey: randomUUID(),
    name: 'Local coding agent',
    budgetCents: 1000,
  });
  const quote = (
    await quotes(ctx, owner, { grantId: grant.id, inputTokens: 1000000, outputTokens: 5000 })
  ).items[0]!;
  await createTokenOrder(ctx, owner, {
    operationKey: randomUUID(),
    grantId: grant.id,
    mode: 'instant',
    inputTokens: 1000000,
    outputTokens: 5000,
    maxTotalCents: quote.priceCents,
    quoteId: quote.quoteId,
  });
  const provider = (await ctx.pool.query('SELECT id FROM broker_providers LIMIT 1')).rows[0]!;
  const request = (
    await ctx.pool.query(
      "INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,status) VALUES($1,'Local Linux test','dev-small','{}','us-east',15,100,'{}','ready') RETURNING id",
      [owner.id],
    )
  ).rows[0]!;
  const bid = (
    await ctx.pool.query(
      "INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,status) SELECT $1,$2,id,'{}',100,'won' FROM broker_offerings WHERE provider_id=$2 LIMIT 1 RETURNING id",
      [request.id, provider.id],
    )
  ).rows[0]!;
  const native = await ctx.wick.create(
    {
      organizationId: config.wickOrganizationId,
      groupId: config.wickGroupId,
      name: 'local-linux-test',
      provider: 'simulated-demo',
      profile: 'small',
      ttlSeconds: 3600,
      visibility: 'private',
    },
    randomUUID(),
  );
  environmentId = native.environment.id;
  await ctx.pool.query("UPDATE broker_fixture_environments SET status='running' WHERE id=$1", [
    environmentId,
  ]);
  const vm = (
    await ctx.pool.query(
      "INSERT INTO broker_vms(request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot,status,environment_id,expires_at) VALUES($1,$2,$3,$4,$5,'{}',$6,'{}','running',$7,clock_timestamp()+interval '30 minutes') RETURNING id",
      [
        request.id,
        owner.id,
        provider.id,
        bid.id,
        randomUUID(),
        { sourceMode: 'fixture', name: 'Actual local Linux executor', provider: 'simulated-demo' },
        environmentId,
      ],
    )
  ).rows[0]!;
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { origin: config.appUrl },
    payload: { email: owner.email, password: 'local-coding-test-only' },
  });
  assert.equal(login.statusCode, 200);
  const cookies = login.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies!])
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = { cookie, origin: config.appUrl };
  const payload = {
    operationKey: randomUUID(),
    repositoryUrl: 'https://github.com/pypa/sampleproject',
    baseRef: '',
    vmId: vm.id,
    grantId: grant.id,
    goal: 'Add a safe average utility with regression tests for empty and non-empty input.',
    testCommand: 'python3 -m unittest discover -s broker_tests',
  };
  const created = await app.inject({ method: 'POST', url: '/api/coding/jobs', headers, payload });
  assert.equal(created.statusCode, 200, created.body);
  const job = created.json<CodingJob>();
  console.log('Started local Linux public-repo job', job.id);
  let detail: CodingDetail | undefined,
    reconciled = false;
  for (let i = 0; i < 180; i++) {
    detail = (
      await app.inject({ method: 'GET', url: '/api/coding/jobs/' + job.id, headers })
    ).json<CodingDetail>();
    if (detail.job.status === 'uncertain' && !reconciled) {
      console.log('Recovering injected lost command response from the actual guest journal');
      reconciled = true;
      await app.inject({
        method: 'POST',
        url: `/api/coding/jobs/${job.id}/reconcile`,
        headers,
        payload: {},
      });
    } else if (
      ['ready', 'failed', 'paused', 'stopped', 'needs_allowance'].includes(detail.job.status)
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(detail?.job.status, 'ready', JSON.stringify(detail));
  assert.equal(detail.job.testsPassed, true);
  assert.ok(reconciled);
  const testSteps = detail.steps.filter((s) => s.action === 'test');
  assert.equal(testSteps.length, 2);
  assert.notEqual((testSteps[0]!.result?.result as { exitCode: number }).exitCode, 0);
  const passed = testSteps[1]!.result!.result as { output: string; exitCode: number };
  assert.equal(passed.exitCode, 0);
  assert.match(passed.output, /Ran 6 tests/);
  const patch = await app.inject({
    method: 'GET',
    url: `/api/coding/jobs/${job.id}/patch`,
    headers,
  });
  assert.equal(patch.statusCode, 200);
  assert.match(patch.body, /broker_average.py/);
  assert.match(patch.body, /broker_tests\/test_average.py/);
  assert.equal(
    (
      await app.inject({ method: 'POST', url: '/api/coding/jobs', headers, payload })
    ).json<CodingJob>().id,
    job.id,
  );
  const row = (await ctx.pool.query('SELECT * FROM broker_coding_jobs WHERE id=$1', [job.id]))
    .rows[0]!;
  const counterPath = `/tmp/wick-broker-coding/${job.id}/repository/.git/broker-test-runs`;
  assert.equal(
    nativeActions.filter((action) => action === 'test').length,
    2,
    'Reconciliation must not dispatch the lost baseline command again.',
  );
  const before = (await docker(['exec', container, 'cat', counterPath])).stdout;
  const replay = await guestStep(ctx, row, testSteps[1]!.sequence, { action: 'test' });
  assert.equal(replay.state, 'completed');
  assert.equal((await docker(['exec', container, 'cat', counterPath])).stdout, before);
  assert.equal(before, '1');
  const processes = (
    await docker([
      'exec',
      container,
      'python3',
      '-I',
      '-c',
      "import os; print(chr(10).join(open('/proc/'+p+'/cmdline','rb').read().decode(errors='replace') for p in os.listdir('/proc') if p.isdigit() and int(p)!=os.getpid()))",
    ])
  ).stdout;
  assert.ok(!processes.includes(marker), 'No test descendant may survive the completed step.');
  checks.push(
    'anonymous public GitHub verification and pinned clone',
    'actual source edits and six passing Linux tests',
    'private workspace, environment and network isolation',
    'baseline failure and post-edit success',
    'lost response reconciled without command replay',
    'same-step journal replay leaves execution count unchanged',
    'no surviving background test process',
    'HTTP patch export and idempotent creation',
  );
  const cutoff = {
    ...row,
    id: randomUUID(),
    deadline_at: new Date(Date.now() + 1800),
    test_command: 'python3 -c "import time; time.sleep(30)"',
  };
  await docker([
    'exec',
    container,
    'mkdir',
    '-p',
    `/tmp/wick-broker-coding/${cutoff.id}/repository`,
  ]);
  const cut = await guestStep(ctx, cutoff, 0, { action: 'test' });
  assert.equal(cut.result?.interrupted, true);
  assert.notEqual(cut.result?.exitCode, 0);
  checks.push('absolute deadline interrupts an actual Linux command');
  const stopJob = {
    ...row,
    id: randomUUID(),
    deadline_at: new Date(Date.now() + 30000),
    test_command: 'python3 -c "import time; time.sleep(30)"',
  };
  await docker([
    'exec',
    container,
    'mkdir',
    '-p',
    `/tmp/wick-broker-coding/${stopJob.id}/repository`,
  ]);
  const running = guestStep(ctx, stopJob, 0, { action: 'test' });
  for (let i = 0; i < 20; i++) {
    const receipt = await guestStep(ctx, stopJob, 0, { action: 'inspect' });
    if (receipt.state === 'unknown') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await guestStep(ctx, stopJob, 0, { action: 'stop' })).stopRequested, true);
  assert.equal((await running).result?.interrupted, true);
  checks.push('stop marker interrupts the original command with a durable receipt');
  const noisy = {
    ...row,
    id: randomUUID(),
    deadline_at: new Date(Date.now() + 20000),
    test_command: 'python3 -c \'print("x" * 50000)\'',
  };
  await docker([
    'exec',
    container,
    'mkdir',
    '-p',
    `/tmp/wick-broker-coding/${noisy.id}/repository`,
  ]);
  const output = await guestStep(ctx, noisy, 0, { action: 'test' });
  assert.equal(output.result?.truncated, true);
  assert.equal((output.result?.output as string).length, 16000);
  checks.push('native command output capped at 16 KB');
  const writer = {
    ...row,
    id: randomUUID(),
    deadline_at: new Date(Date.now() + 20000),
    test_command:
      'python3 -c \'from pathlib import Path; [Path("large"+str(i)).write_bytes(b"x"*(24*1024*1024)) for i in range(3)]\'',
  };
  await docker([
    'exec',
    container,
    'mkdir',
    '-p',
    `/tmp/wick-broker-coding/${writer.id}/repository`,
  ]);
  const oversized = await guestStep(ctx, writer, 0, { action: 'test' });
  assert.equal(oversized.result?.limitExceeded, 'workspace');
  assert.equal(oversized.result?.interrupted, true);
  checks.push('fast 72 MB write rejected by final workspace policy check');
  const unsupported = { ...row, id: randomUUID(), deadline_at: new Date(Date.now() + 20000) };
  await docker(['exec', container, 'mv', '/usr/bin/bwrap', '/usr/bin/bwrap.local-test-disabled']);
  try {
    const denied = await guestStep(ctx, unsupported, 0, { action: 'clone' });
    assert.equal(denied.state, 'failed');
    assert.match(denied.error ?? '', /bubblewrap/);
    await docker([
      'exec',
      container,
      'test',
      '!',
      '-e',
      `/tmp/wick-broker-coding/${unsupported.id}/repository/.git`,
    ]);
  } finally {
    await docker(['exec', container, 'mv', '/usr/bin/bwrap.local-test-disabled', '/usr/bin/bwrap']);
  }
  checks.push('missing sandbox fails before repository clone');
  if (process.env.CODING_LOCAL_STUDIO === '1') {
    // Only this disposable test container is changed. Exercise fresh-VM setup,
    // rather than claiming bootstrap from an image with the package preinstalled.
    await docker(['exec', container, 'apt-get', 'remove', '-y', '-qq', 'bubblewrap']);
    await docker(['exec', container, 'test', '!', '-e', '/usr/bin/bwrap']);
    const started = Date.now();
    const createdTask = await app.inject({
      method: 'POST',
      url: '/api/studio/tasks',
      headers,
      payload: {
        operationKey: randomUUID(),
        repositoryUrl: payload.repositoryUrl,
        goal: payload.goal,
        testCommand: payload.testCommand,
        budgetCents: 1000,
        durationMinutes: 30,
        allowInstant: true,
      },
    });
    assert.equal(createdTask.statusCode, 200, createdTask.body);
    const task = createdTask.json<StudioTask>();
    console.log('Started automatic Studio task', task.id);
    const phases: Record<string, number> = {};
    let studio: StudioDetail | undefined;
    for (let i = 0; i < 240; i++) {
      const reply: { statusCode: number; body: string; json: () => unknown } = await app.inject({
        method: 'GET',
        url: '/api/studio/tasks/' + task.id,
        headers,
      });
      assert.equal(reply.statusCode, 200, reply.body);
      const current: StudioDetail = reply.json() as StudioDetail;
      studio = current;
      if (phases[current.task.status] === undefined) {
        phases[current.task.status] = Date.now() - started;
        console.log('Studio phase:', current.task.status);
      }
      if (
        ['completed', 'failed', 'stopped', 'needs_attention', 'needs_budget'].includes(
          current.task.status,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(studio, 'The automatic task must have a saved detail record.');
    assert.equal(studio?.task.status, 'completed', JSON.stringify(studio));
    assert(studio.task.executionStartedAt);
    assert(studio.task.verifiedAt);
    assert(studio.task.completedAt);
    assert(studio.vm?.cleanupConfirmedAt);
    assert.equal(studio.task.reservedCents, 0);
    assert.equal(studio.task.availableCents, 0);
    assert(studio.task.spentCents <= studio.task.budgetCents);
    assert(studio.task.returnedCents > 0);
    assert.equal(studio.tests?.exitCode, 0);
    assert.match(studio.tests?.output ?? '', /Ran 6 tests/);
    const exported = await app.inject({
      method: 'GET',
      url: '/api/studio/tasks/' + task.id + '/patch',
      headers,
    });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.body, /broker_average/);
    assert(studio.modelActivity.every((r) => r.status === 'settled'));
    assert.equal(planningCalls.get(task.id), 2);
    assert.equal(studio.modelPurchases.length, 1, 'Planning repair must reuse the purchased pack.');
    assert(studio.events.some((event) => event.title === 'Muse is repairing its plan'));
    await docker(['exec', container, 'bwrap', '--version']);
    checks.push('task-owned Debian guest installs its missing sandbox package before cloning');
    report.studio = {
      taskId: task.id,
      status: studio.task.status,
      phaseElapsedMs: phases,
      modelMode: 'fixture',
      guestMode: 'actual local Linux',
      computeChargedCents: studio.task.computeChargedCents,
      modelChargedCents: studio.task.modelChargedCents,
      returnedCents: studio.task.returnedCents,
      modelReceipts: studio.modelActivity.length,
      planningAttempts: planningCalls.get(task.id),
      reasoningPolicy: 'No Broker override in planning, repair, or coding requests',
      testOutput: studio.tests?.output,
      patchExport: 'passed',
      vmCleanup: 'fixture acknowledgement; actual container removed at test teardown',
    };
    checks.push(
      'automatic Studio task reserves one budget and purchases model allowance and compute through real 30-second fixture auctions',
    );
    checks.push(
      'Meta fixture plan drives actual Linux edits and six passing tests without selecting a VM or grant',
    );
    checks.push(
      'automatic verification, retained patch, task VM cleanup and unspent funding release',
    );
    checks.push(
      'one settled capped planning reply is repaired using existing quota before VM purchase',
    );
  }
  report.repositoryUrl = job.repositoryUrl;
  report.commitSha = job.commitSha;
  report.jobId = job.id;
  report.testOutput = passed.output;
  report.modelCalls = detail.job.modelCalls;
  report.nativeCommandTransport = 'local Docker exec; not the Wick API';
  console.log(JSON.stringify(report, null, 2));
  if (process.env.CODING_LOCAL_PREVIEW === '1') {
    await app.listen({ host: '127.0.0.1', port: 3188 });
    console.log(
      'Local preview: http://localhost:3188/' +
        (report.studio
          ? 'studio/tasks/' + (report.studio as { taskId: string }).taskId
          : 'studio/jobs/' + job.id),
    );
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
  }
} finally {
  if (app) await app.close();
  if (createdContainer) {
    await docker(['rm', '-f', container]);
    report.containerCleanup = 'acknowledged';
  }
  if (createdDatabase) await admin.query(`DROP DATABASE ${database} WITH(FORCE)`);
  await admin.end();
  if (process.env.CODING_LOCAL_REPORT)
    await writeFile(process.env.CODING_LOCAL_REPORT, JSON.stringify(report, null, 2) + '\n');
}
import { inflateSync } from 'node:zlib';
