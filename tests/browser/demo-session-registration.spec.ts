import { expect, test, type BrowserContext } from '@playwright/test';
import type { DemoRun, DemoState } from '../../src/shared/demo';

// Cookie-scoped HTTP fixtures exercise browser recovery without any real resources.
async function demoSessions(context: BrowserContext) {
  const runs = new Map<string, DemoRun>();
  const writes: { path: string; identity?: string }[] = [];
  let minted = 0;
  let loseStartResponse = false;
  let registrationFailure = false;
  let registrationHold: Promise<void> | undefined;
  let startHold: Promise<void> | undefined;
  let releaseRegistration: (() => void) | undefined;
  let releaseStart: (() => void) | undefined;
  const state = (identity?: string): DemoState => ({
    enabled: true,
    available: !identity || !runs.has(identity),
    reason: null,
    mode: 'fixture',
    serverTime: new Date().toISOString(),
    cooldownUntil: null,
    limits: {
      durationMinutes: 15,
      cooldownMinutes: 20,
      maxRequests: 2,
      maxOutputTokens: 1024,
      inputTokens: 5000,
      outputTokens: 2048,
    },
    run: (identity && runs.get(identity)) || null,
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = await request.allHeaders();
    const identity = /(?:^|;\s*)wick_demo=([^;]+)/.exec(headers.cookie ?? '')?.[1];
    if (request.method() !== 'GET') writes.push({ path, identity });
    if (path === '/api/me')
      return route.fulfill({
        json: { user: null, modes: { wick: 'fixture', muse: 'fixture' }, catalog: [] },
      });
    if (path === '/api/demo') return route.fulfill({ json: state(identity) });
    if (path === '/api/demo/session') {
      if (registrationFailure)
        return route.fulfill({ status: 503, json: { error: 'Session registration unavailable.' } });
      const registered = identity ?? `fixture-session-${++minted}`.padEnd(43, '_');
      await registrationHold;
      return route.fulfill({
        status: 204,
        headers: {
          'set-cookie': `wick_demo=${registered}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        },
      });
    }
    if (path === '/api/demo/start') {
      if (!identity)
        return route.fulfill({ status: 409, json: { error: 'A saved demo session is required.' } });
      if (!runs.has(identity))
        runs.set(identity, {
          id: `demo-fixture-${runs.size + 1}`,
          kind: request.postDataJSON().kind,
          status: 'auction',
          message: 'Your saved demo is preparing its resources.',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          endedAt: null,
          vm: null,
          tokens: null,
          disk: null,
          canIssueKey: false,
          keyIssued: false,
        });
      await startHold;
      if (loseStartResponse) {
        loseStartResponse = false;
        return route.abort('failed');
      }
      return route.fulfill({ json: state(identity) });
    }
    return route.fulfill({ status: 404, json: { error: 'Unexpected fixture request.' } });
  });
  return {
    writes,
    runs,
    minted: () => minted,
    loseStartResponse: () => {
      loseStartResponse = true;
    },
    failRegistration: () => {
      registrationFailure = true;
    },
    hold: () => {
      registrationHold = new Promise<void>((resolve) => {
        releaseRegistration = resolve;
      });
      startHold = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
    },
    releaseRegistration: () => releaseRegistration?.(),
    releaseStart: () => releaseStart?.(),
  };
}

test('a lost first start response remains recoverable after reload through its saved cookie', async ({
  page,
  context,
}) => {
  const fixture = await demoSessions(context);
  fixture.loseStartResponse();
  await page.goto('/demos');
  expect(fixture.writes).toEqual([]);
  await page.getByRole('button', { name: 'Try live demo', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(fixture.writes.map((write) => write.path)).toEqual([
    '/api/demo/session',
    '/api/demo/start',
  ]);
  const identity = fixture.writes[1]!.identity;
  expect(identity).toBeTruthy();
  expect((await context.cookies()).find((cookie) => cookie.name === 'wick_demo')).toMatchObject({
    value: identity,
    httpOnly: true,
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.runs.size).toBe(1);
  expect(fixture.minted()).toBe(1);
});

test('failed session registration prevents a resource start', async ({ page, context }) => {
  const fixture = await demoSessions(context);
  fixture.failRegistration();
  await page.goto('/demos');
  await page.getByRole('button', { name: 'Try live demo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Session registration unavailable.');
  expect(fixture.writes.map((write) => write.path)).toEqual(['/api/demo/session']);
  expect(fixture.runs.size).toBe(0);
});

test('a browser without Web Locks still saves its session before starting', async ({
  page,
  context,
}) => {
  const fixture = await demoSessions(context);
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await page.goto('/demos');
  await page.getByRole('button', { name: 'Try live demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
  expect(fixture.writes.map((write) => write.path)).toEqual([
    '/api/demo/session',
    '/api/demo/start',
  ]);
  expect(fixture.writes[1]!.identity).toBeTruthy();
  expect(fixture.runs.size).toBe(1);
});

test('two first-start tabs share one identity while registration and resource start are locked', async ({
  page,
  context,
}) => {
  const fixture = await demoSessions(context);
  fixture.hold();
  const other = await context.newPage();
  try {
    await Promise.all([page.goto('/demos'), other.goto('/demos')]);
    await page.getByRole('button', { name: 'Try live demo', exact: true }).click();
    await expect.poll(() => fixture.minted()).toBe(1);
    await other.getByRole('button', { name: 'Try live demo', exact: true }).click();
    const pendingStarts = () =>
      page.evaluate(async () => {
        const locks = await navigator.locks.query();
        return locks.pending?.filter((lock) => lock.name === 'wick-demo-start').length;
      });
    await expect.poll(pendingStarts).toBe(1);
    expect(fixture.writes.map((write) => write.path)).toEqual(['/api/demo/session']);
    fixture.releaseRegistration();
    await expect.poll(() => fixture.runs.size).toBe(1);
    await expect.poll(pendingStarts).toBe(1);
    expect(fixture.writes.map((write) => write.path)).toEqual([
      '/api/demo/session',
      '/api/demo/start',
    ]);
    fixture.releaseStart();
    for (const tab of [page, other])
      await expect(tab.getByRole('heading', { name: 'Your resources, going once…' })).toBeVisible();
    expect(fixture.writes.map((write) => write.path)).toEqual([
      '/api/demo/session',
      '/api/demo/start',
      '/api/demo/session',
      '/api/demo/start',
    ]);
    expect(fixture.minted()).toBe(1);
    expect(fixture.runs.size).toBe(1);
    expect(fixture.writes[1]!.identity).toBe(fixture.writes[3]!.identity);
    expect(fixture.writes[2]!.identity).toBe(fixture.writes[1]!.identity);
  } finally {
    fixture.releaseRegistration();
    fixture.releaseStart();
    await other.close();
  }
});
