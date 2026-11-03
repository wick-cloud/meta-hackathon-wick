import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as pause } from 'node:timers/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import type { DemoState } from '../src/shared/demo.js';
import { isMoneyCents, moneyUnits } from '../src/shared/money.js';

/**
 * APP_URL=https://your-app.example npx tsx scripts/verify-homepage-demo.ts --live
 * npx tsx scripts/verify-homepage-demo.ts --self-test
 *
 * One ordinary guest run, two bounded paid model calls, and a rejected third call.
 * Uses public HTTP/WebSocket APIs only. No provider credentials, database access,
 * clock changes, retries of model calls, or quota overrides. Never loads .env.
 * JSON output contains allowlisted metadata only; terminal text and keys stay in memory.
 * SIGINT/SIGTERM request cleanup; do not force-kill while cleanup is in progress.
 */
const MODEL = 'meta/muse-spark-open';
const KEY_PATTERN = /^wbk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i;
const EXPECTED_LIMITS = {
  durationMinutes: 15,
  cooldownMinutes: 20,
  maxRequests: 2,
  maxOutputTokens: 1024,
  inputTokens: 5000,
  outputTokens: 2048,
};
const usageSchema = z
  .object({
    prompt_tokens: z.number().int().positive().max(5000),
    completion_tokens: z.number().int().positive().max(1024),
    total_tokens: z.number().int().positive().max(6024),
  })
  .refine((usage) => usage.total_tokens === usage.prompt_tokens + usage.completion_tokens);
type Usage = z.infer<typeof usageSchema>;
class CheckFailure extends Error {
  constructor(readonly check: string) {
    super(check);
  }
}
function check(value: unknown, name: string): asserts value {
  if (!value) throw new CheckFailure(name);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  check(result.success, name);
  return result.data;
}
function appOrigin(raw: string | undefined): string {
  check(raw, 'app_url_required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CheckFailure('invalid_app_url');
  }
  check(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
    'app_url_must_be_an_origin_without_credentials',
  );
  check(
    url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)),
    'https_required_except_for_localhost',
  );
  return url.origin;
}
function sameOriginPath(origin: string, path: string, expected: RegExp): URL {
  const url = new URL(path, origin);
  check(
    url.origin === origin && !url.search && !url.hash && expected.test(url.pathname),
    'unexpected_endpoint',
  );
  return url;
}
function plainTerminal(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n');
}
function hiddenPromptReady(output: string): boolean {
  check(
    !/GetPassWarning|[Pp]assword input may be echoed|[Cc]an not control echo/.test(output),
    'terminal_cannot_hide_key',
  );
  return /(?:^|\n)Batch key: $/.test(plainTerminal(output));
}
function scriptReceipt(output: string, marker: string): { usage: Usage; answerCharacters: number } {
  const text = plainTerminal(output);
  check(new RegExp(`(?:^|\\n)${marker}:0(?:\\n|$)`).test(text), 'python_script_exit');
  check(
    !/Broker response:|Outcome unconfirmed|Fixture response:|allowance ended before a final text answer/.test(
      text,
    ),
    'python_model_answer_missing',
  );
  const match = text.match(
    /Calling Meta Muse\. Request: [0-9a-f-]{36}\n([\s\S]*?)\nUsage: (\{[^\n]*\})/,
  );
  check(match && match[1].trim().length > 0, 'python_model_receipt_missing');
  let rawUsage: unknown;
  try {
    rawUsage = JSON.parse(match[2]);
  } catch {
    throw new CheckFailure('python_usage_invalid');
  }
  return {
    usage: parse(usageSchema, rawUsage, 'python_usage_invalid'),
    answerCharacters: match[1].trim().length,
  };
}

/** Public guest receipts expose the immutable VM gross quote, never invoice-list authority. */
function computeReceipt(value: unknown) {
  const cents = z.number().min(0).max(25).refine(isMoneyCents);
  const receipt = parse(
    z.object({
      provider: z.literal('modal'),
      catalogId: z.literal('modal:micro:auto'),
      priceCents: z.literal(1),
      grossPriceCents: cents.min(1),
      sponsorCreditCents: cents,
      operatorSponsored: z.boolean().optional(),
      auctionEndsAt: z.string().datetime(),
      bids: z
        .array(
          z.object({
            provider: z.enum(['modal', 'e2b']),
            catalogId: z.enum(['modal:micro:auto', 'e2b:micro:us']),
            priceCents: cents.min(1),
            grossPriceCents: cents.min(1),
            sponsorCreditCents: cents,
            operatorSponsored: z.boolean().optional(),
            acceptedAt: z.string().datetime(),
          }),
        )
        .length(2),
    }),
    value,
    'compute_competition_receipt_invalid',
  );
  const modal = receipt.bids.find((bid) => bid.provider === 'modal');
  const e2b = receipt.bids.find((bid) => bid.provider === 'e2b');
  check(modal && e2b, 'compute_requires_two_actual_providers');
  check(
    modal.catalogId === 'modal:micro:auto' && e2b.catalogId === 'e2b:micro:us',
    'compute_bid_provider_catalog_mismatch',
  );
  check(
    modal.priceCents === 1 &&
      modal.priceCents <= e2b.priceCents &&
      e2b.sponsorCreditCents === 0 &&
      e2b.operatorSponsored !== true &&
      e2b.priceCents === e2b.grossPriceCents &&
      receipt.grossPriceCents === modal.grossPriceCents &&
      receipt.sponsorCreditCents === modal.sponsorCreditCents &&
      Boolean(receipt.operatorSponsored) === Boolean(modal.operatorSponsored) &&
      (!modal.operatorSponsored ||
        (modal.grossPriceCents === 1 && modal.sponsorCreditCents === 0)) &&
      moneyUnits(modal.priceCents) + moneyUnits(modal.sponsorCreditCents) ===
        moneyUnits(modal.grossPriceCents),
    'compute_sponsorship_changed_gross_or_rival',
  );
  check(
    receipt.bids.every((bid) => Date.parse(bid.acceptedAt) < Date.parse(receipt.auctionEndsAt)),
    'compute_bid_accepted_after_deadline',
  );
  return { ...receipt, bids: [e2b, modal] };
}

class LiveTerminal {
  private readonly decoder = new StringDecoder('utf8');
  private output = '';
  private key = '';
  private failure: CheckFailure | undefined;
  private ready = false;
  private readonly watchers = new Set<() => void>();
  readonly socket: WebSocket;
  closed = false;
  constructor(url: URL, origin: string, cookie: string) {
    this.socket = new WebSocket(url, {
      headers: { origin, cookie },
      handshakeTimeout: 15000,
      maxPayload: 512 * 1024,
      followRedirects: false,
    });
    this.socket.on('error', () => this.fail('terminal_connection_failed'));
    this.socket.on('close', () => {
      this.closed = true;
      this.notify();
    });
    this.socket.on('message', (raw) => {
      try {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === 'ready') {
          check(frame.mode === 'real', 'terminal_must_be_real');
          this.ready = true;
        } else if (frame.type === 'output') {
          check(typeof frame.data === 'string', 'terminal_output_invalid');
          const bytes = Buffer.from(frame.data, 'base64');
          this.output += this.decoder.write(bytes);
          check(this.output.length <= 262144, 'terminal_output_limit');
          check(!this.key || !this.output.includes(this.key), 'terminal_key_was_echoed');
          if (this.socket.readyState === WebSocket.OPEN)
            this.socket.send(JSON.stringify({ type: 'ack', bytes: bytes.byteLength }));
        } else if (frame.type === 'error') this.fail('terminal_server_error');
      } catch (error) {
        this.fail(error instanceof CheckFailure ? error.check : 'terminal_frame_invalid');
      }
      this.notify();
    });
  }
  private fail(name: string) {
    this.failure = new CheckFailure(name);
    this.notify();
  }
  private notify() {
    for (const watcher of this.watchers) watcher();
  }
  private wait(predicate: () => boolean, milliseconds: number, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new CheckFailure(name)), milliseconds);
      const finish = (error?: CheckFailure) => {
        clearTimeout(timer);
        this.watchers.delete(inspect);
        error ? reject(error) : resolve();
      };
      const inspect = () => {
        try {
          if (this.failure) throw this.failure;
          if (predicate()) finish();
          else if (this.closed) finish(new CheckFailure('terminal_closed_early'));
        } catch (error) {
          finish(error instanceof CheckFailure ? error : new CheckFailure(name));
        }
      };
      this.watchers.add(inspect);
      inspect();
    });
  }
  async runPython(key: string): Promise<{ usage: Usage; answerCharacters: number }> {
    await this.wait(() => this.ready, 20000, 'terminal_ready_timeout');
    this.key = key;
    this.output = '';
    const marker = `WICK_DEMO_DONE_${randomUUID().replaceAll('-', '')}`;
    // Only this fixed command enters shell history. The key is sent to Python getpass separately.
    this.socket.send(
      JSON.stringify({
        type: 'input',
        data: `python3 -u /workspace/hello_muse.py; printf '\\n${marker}:%s\\n' "$?"\r`,
      }),
    );
    await this.wait(() => hiddenPromptReady(this.output), 20000, 'python_hidden_prompt_timeout');
    this.socket.send(JSON.stringify({ type: 'input', data: `${key}\r` }));
    await this.wait(
      () => new RegExp(`(?:^|\\n)${marker}:\\d+(?:\\n|$)`).test(plainTerminal(this.output)),
      125000,
      'python_result_timeout_no_retry',
    );
    return scriptReceipt(this.output, marker);
  }
  async assertInteractive() {
    await this.wait(() => this.ready, 20000, 'terminal_ready_timeout');
    this.output = '';
    const marker = `WICK_DEMO_INTERACTIVE_${randomUUID().replaceAll('-', '')}`;
    this.socket.send(JSON.stringify({ type: 'input', data: `printf '\\n${marker}\\n'\r` }));
    await this.wait(
      () => plainTerminal(this.output).split('\n').includes(marker),
      10000,
      'terminal_not_interactive_after_token_cap',
    );
  }
  async assertRevoked() {
    if (!this.closed) await this.wait(() => this.closed, 10000, 'terminal_revocation_timeout');
  }
  interrupt() {
    this.fail('verification_interrupted');
  }
  dispose() {
    this.key = '';
    this.output = '';
    this.socket.terminate();
  }
}

async function verify(origin: string) {
  const began = performance.now();
  const log = (event: string, data: Record<string, unknown> = {}) =>
    console.log(
      JSON.stringify({ event, elapsedMs: Math.round(performance.now() - began), ...data }),
    );
  let cookie = '';
  let key = '';
  let startAttempted = false;
  let admitted = false;
  let interrupted = false;
  let cleanupConfirmed = false;
  let mainPassed = false;
  let compute: ReturnType<typeof computeReceipt> | undefined;
  let terminal: LiveTerminal | undefined;
  let failure: unknown;
  const onInterrupt = () => {
    interrupted = true;
    terminal?.interrupt();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  function active() {
    check(!interrupted, 'verification_interrupted');
  }
  async function request(path: string, body?: unknown, bearer = '', timeout = 15000) {
    const endpoint = sameOriginPath(origin, path, /^\/api\//);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
        headers: {
          origin,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(bearer ? { authorization: `Bearer ${bearer}`, 'Idempotency-Key': randomUUID() } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CheckFailure('http_outcome_unconfirmed_no_model_retry');
    }
    for (const header of response.headers.getSetCookie()) {
      const value = header.split(';')[0];
      if (value.startsWith('wick_demo=')) {
        check(/^wick_demo=[A-Za-z0-9_-]{43}$/.test(value), 'invalid_demo_cookie');
        cookie = value;
      }
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CheckFailure('http_json_invalid');
    }
    return { status: response.status, value };
  }
  async function state(): Promise<DemoState> {
    const response = await request('/api/demo');
    check(response.status === 200, 'demo_status_http');
    const value = response.value as DemoState;
    check(value && value.mode === 'real', 'demo_must_be_real');
    check(
      Object.entries(EXPECTED_LIMITS).every(
        ([name, limit]) => value.limits?.[name as keyof typeof EXPECTED_LIMITS] === limit,
      ),
      'demo_limits_changed',
    );
    return value;
  }
  async function poll(
    predicate: (value: DemoState) => boolean,
    cleanup = false,
  ): Promise<DemoState> {
    const deadline = performance.now() + 180000;
    let previous = '';
    while (performance.now() < deadline) {
      if (!cleanup) active();
      const value = await state();
      const phase = `${value.run?.status}/${value.run?.tokens?.status}/${value.run?.vm?.status}/${value.run?.disk?.status}`;
      if (phase !== previous) {
        // Status fields are checked before logging so arbitrary server text cannot enter the output.
        const known = (status: unknown) =>
          typeof status === 'string' &&
          [
            'starting',
            'auction',
            'open',
            'awarded',
            'provisioning',
            'ready',
            'running',
            'ending',
            'ended',
            'failed',
            'terminating',
            'terminated',
            'deleting',
            'deleted',
          ].includes(status)
            ? status
            : null;
        log(cleanup ? 'cleanup' : 'progress', {
          run: known(value.run?.status),
          tokens: known(value.run?.tokens?.status),
          vm: known(value.run?.vm?.status),
          disk: known(value.run?.disk?.status),
        });
        previous = phase;
      }
      if (predicate(value)) return value;
      if (!cleanup) check(!value.run?.endedAt, 'demo_ended_before_verification');
      await pause(2500);
    }
    throw new CheckFailure(cleanup ? 'cleanup_unconfirmed_timeout' : 'demo_ready_timeout');
  }
  async function cleanup(): Promise<DemoState> {
    // End is retried only with the same idempotency key. Paid inference is never retried.
    const operationKey = randomUUID();
    let accepted = false;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      try {
        const ended = await request('/api/demo/end', { operationKey });
        accepted = ended.status === 200;
      } catch {}
      if (!accepted) await pause(5000);
    }
    check(accepted, 'cleanup_end_not_accepted');
    const ended = await poll(
      (value) => Boolean(value.run?.endedAt) || (!admitted && !value.run),
      true,
    );
    check(
      (!ended.run?.vm?.id || ended.run.vm.cleanupConfirmed) &&
        (!ended.run?.disk || ended.run.disk.status === 'deleted') &&
        !ended.run?.canIssueKey &&
        !ended.run?.vm?.terminalPath,
      'cleanup_resources_not_confirmed',
    );
    return ended;
  }
  const modelCall = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'Say hello in one friendly sentence and mention Meta Muse.' },
    ],
    max_tokens: 1024,
    stream: false,
  };
  try {
    const before = await state();
    check(before.enabled && before.available && !before.run && !cookie, 'demo_not_available');
    active();
    startAttempted = true;
    const operationKey = randomUUID();
    const start = await request('/api/demo/start', { operationKey });
    if (start.status >= 400 && start.status < 500 && !cookie) startAttempted = false;
    check(start.status === 200 && cookie, `demo_start_http_${start.status}`);
    admitted = true;
    const admittedRun = parse(
      z.object({ run: z.object({ id: z.string().uuid() }) }),
      start.value,
      'demo_start_run_id_invalid',
    );
    log('admitted', { runId: admittedRun.run.id });
    const replay = await request('/api/demo/start', { operationKey });
    check(
      replay.status === 200 && (replay.value as DemoState).run?.id === admittedRun.run.id,
      'start_replay_not_idempotent',
    );
    const me = await request('/api/me');
    check(
      me.status === 200 && (me.value as { user?: unknown }).user === null,
      'guest_became_signed_in',
    );
    const ready = await poll((value) => value.run?.status === 'ready');
    const run = ready.run!;
    check(run.id === admittedRun.run.id, 'demo_run_changed');
    check(
      run.tokens?.provider === 'baseten' && run.tokens.status === 'awarded',
      'baseten_not_awarded',
    );
    check(
      run.vm?.provider === 'modal' &&
        run.vm.catalogId === 'modal:micro:auto' &&
        run.vm.status === 'running' &&
        run.disk?.status === 'ready',
      'modal_micro_disk_not_ready',
    );
    check(
      run.tokens.inputTokens === 5000 &&
        run.tokens.outputTokens === 2048 &&
        run.tokens.requestsUsed === 0 &&
        run.tokens.priceCents !== null &&
        run.tokens.priceCents <= 5 &&
        run.vm.priceCents !== null &&
        run.vm.priceCents <= 25,
      'demo_pack_or_price_limit',
    );
    const ownedIds = parse(
      z.object({ vmId: z.string().uuid(), diskId: z.string().uuid(), packId: z.string().uuid() }),
      { vmId: run.vm.id, diskId: run.disk.id, packId: run.tokens.packId },
      'demo_resource_ids_invalid',
    );
    compute = computeReceipt(run.vm);
    log('ready', {
      ...ownedIds,
      tokenPriceCents: run.tokens.priceCents,
      vmPriceCents: run.vm.priceCents,
      vmGrossPriceCents: compute.grossPriceCents,
      vmSponsorCreditCents: compute.sponsorCreditCents,
      operatorSponsored: compute.operatorSponsored === true,
    });
    log('compute_auction_verified', {
      bids: compute.bids,
      grossReceiptSource: 'immutable_vm_quote',
      invoiceLedgerVerified: false,
    });
    active();
    const issued = await request('/api/demo/key', { operationKey: randomUUID() });
    check(issued.status === 200, 'demo_key_http');
    const connection = parse(
      z.object({
        token: z.string().regex(KEY_PATTERN),
        connection: z.object({
          packId: z.string().uuid(),
          baseUrl: z.string(),
          model: z.literal(MODEL),
        }),
      }),
      issued.value,
      'demo_key_response_invalid',
    );
    key = connection.token;
    check(connection.connection.packId === run.tokens.packId, 'demo_key_wrong_pack');
    sameOriginPath(origin, connection.connection.baseUrl, /^\/api\/v1\/?$/);
    check(run.vm.terminalPath, 'terminal_path_missing');
    const wsUrl = sameOriginPath(
      origin,
      run.vm.terminalPath,
      /^\/api\/vms\/[0-9a-f-]{36}\/terminal$/,
    );
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    terminal = new LiveTerminal(wsUrl, origin, cookie);
    const python = await terminal.runPython(key);
    log('python_model_call', python);
    active();
    check((await state()).run?.tokens?.requestsUsed === 1, 'python_request_not_counted_once');
    const response = await request('/api/v1/chat/completions', modelCall, key, 120000);
    check(response.status === 200, 'second_model_http_no_retry');
    const answer = parse(
      z.object({
        model: z.literal(MODEL),
        choices: z
          .array(z.object({ message: z.object({ content: z.string().trim().min(1) }) }))
          .min(1),
        usage: usageSchema,
        broker: z.object({
          mode: z.literal('real'),
          provider: z.literal('baseten'),
          packId: z.string(),
        }),
      }),
      response.value,
      'second_model_real_receipt_invalid',
    );
    check(answer.broker.packId === run.tokens.packId, 'second_model_wrong_pack');
    check(
      !answer.choices[0].message.content.includes('Fixture response:'),
      'fixture_answer_rejected',
    );
    log('second_model_call', {
      usage: answer.usage,
      answerCharacters: answer.choices[0].message.content.length,
    });
    active();
    const third = await request('/api/v1/chat/completions', modelCall, key, 120000);
    check(
      third.status === 429 && (third.value as { code?: unknown }).code === 'demo_request_limit',
      'third_model_call_not_rejected_by_demo_cap',
    );
    const used = (await state()).run?.tokens;
    check(
      used?.requestsUsed === 2 &&
        used.availableInput === 5000 - python.usage.prompt_tokens - answer.usage.prompt_tokens &&
        used.availableOutput ===
          2048 - python.usage.completion_tokens - answer.usage.completion_tokens,
      'token_usage_did_not_match_pack',
    );
    log('token_cap_verified', { requestsUsed: 2, rejectedStatus: 429 });
    const afterQuota = (await state()).run;
    check(
      afterQuota?.status === 'ready' &&
        afterQuota.vm?.id === run.vm.id &&
        afterQuota.vm.terminalPath === run.vm.terminalPath &&
        afterQuota.expiresAt === run.expiresAt,
      'token_exhaustion_changed_terminal_lease',
    );
    await terminal.assertInteractive();
    terminal.dispose();
    await terminal.assertRevoked();
    terminal = new LiveTerminal(wsUrl, origin, cookie);
    await terminal.assertInteractive();
    log('terminal_after_token_cap', { interactive: true, reconnected: true, leaseUnchanged: true });
    mainPassed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (startAttempted && cookie) {
      try {
        const ended = await cleanup();
        cleanupConfirmed = true;
        log('cleanup_confirmed');
        if (mainPassed && !interrupted) {
          check(
            JSON.stringify(computeReceipt(ended.run?.vm)) === JSON.stringify(compute),
            'compute_quote_changed_during_cleanup',
          );
          log('compute_quote_preserved_after_cleanup');
          await terminal!.assertRevoked();
          const cooldownSeconds = Math.round(
            (Date.parse(ended.cooldownUntil!) - Date.parse(ended.serverTime)) / 1000,
          );
          check(cooldownSeconds > 0 && cooldownSeconds <= 1200, 'cooldown_missing_or_wrong');
          let restartRejected = false;
          try {
            const blocked = await request('/api/demo/start', { operationKey: randomUUID() });
            restartRejected = blocked.status === 429;
            check(restartRejected, 'cooldown_restart_not_blocked');
          } finally {
            if (!restartRejected) {
              // A regression or uncertain response to this negative test must also be cleaned up.
              cleanupConfirmed = false;
              await cleanup();
              cleanupConfirmed = true;
            }
          }
          const revoked = await request('/api/v1/chat/completions', modelCall, key);
          check(revoked.status === 401, 'ended_key_not_revoked');
          log('revocation_and_cooldown_verified', {
            cooldownSeconds,
            keyStatus: 401,
            startStatus: 429,
          });
        }
      } catch (error) {
        failure ??= error;
        log('cleanup_or_revocation_failed', {
          check: error instanceof CheckFailure ? error.check : 'unexpected_cleanup_error',
        });
      }
    } else if (startAttempted) {
      // If a start response was lost before Set-Cookie, only server lease expiry can safely
      // reconcile it. Do not rotate cookies or start another run to work around that outcome.
      failure ??= new CheckFailure('start_outcome_unknown_without_cookie');
      log('cleanup_unconfirmed_no_cookie');
    }
    terminal?.dispose();
    key = '';
    cookie = '';
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
  const passed = mainPassed && cleanupConfirmed && !failure && !interrupted;
  log('result', {
    passed,
    cleanupConfirmed,
    ...(failure
      ? { check: failure instanceof CheckFailure ? failure.check : 'unexpected_error' }
      : {}),
  });
  process.exitCode = passed ? 0 : 1;
}

function selfTest() {
  assert.equal(KEY_PATTERN.test(`wbk_${randomUUID()}.${'x'.repeat(43)}`), true);
  assert.equal(KEY_PATTERN.test('wbk_invalid'), false);
  assert.equal(appOrigin('https://example.invalid/'), 'https://example.invalid');
  assert.equal(appOrigin('http://127.0.0.1:3978'), 'http://127.0.0.1:3978');
  for (const url of [
    'http://example.invalid',
    'https://name:secret@example.invalid',
    'https://example.invalid/path',
    'https://example.invalid/?key=secret',
  ])
    assert.throws(() => appOrigin(url), CheckFailure);
  assert.throws(
    () => sameOriginPath('https://example.invalid', '//other.invalid/api/v1', /^\/api\//),
    CheckFailure,
  );
  assert.equal(hiddenPromptReady('\u001b[32mHello\u001b[0m\r\nBatch key: '), true);
  assert.equal(hiddenPromptReady('Batch ke'), false);
  assert.throws(
    () => hiddenPromptReady('Warning: Password input may be echoed.\r\nBatch key: '),
    CheckFailure,
  );
  const marker = 'WICK_DEMO_DONE_test';
  const transcript = `python3 -u /workspace/hello_muse.py; printf '\\n${marker}:%s\\n' "$?"\r\nHello Muse\r\nBatch key: \r\nCalling Meta Muse. Request: ${randomUUID()}\r\nHello from Meta Muse.\r\nUsage: {"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}\r\n${marker}:0\r\n$ `;
  assert.deepEqual(scriptReceipt(transcript, marker), {
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    answerCharacters: 21,
  });
  assert.throws(
    () => scriptReceipt(transcript.replace(`${marker}:0`, `${marker}:1`), marker),
    CheckFailure,
  );
  assert.throws(
    () =>
      scriptReceipt(transcript.replace('Hello from Meta Muse.', 'Fixture response: hello'), marker),
    CheckFailure,
  );
  assert.throws(
    () => scriptReceipt(transcript.replace('"total_tokens":30', '"total_tokens":31'), marker),
    CheckFailure,
  );
  assert.throws(
    () =>
      scriptReceipt(
        transcript.replace('"completion_tokens":10', '"completion_tokens":1025'),
        marker,
      ),
    CheckFailure,
  );
  const compute = {
    provider: 'modal',
    catalogId: 'modal:micro:auto',
    priceCents: 1,
    grossPriceCents: 7.2,
    sponsorCreditCents: 6.2,
    auctionEndsAt: '2026-11-03T06:00:30.000Z',
    bids: [
      {
        provider: 'modal',
        catalogId: 'modal:micro:auto',
        priceCents: 1,
        grossPriceCents: 7.2,
        sponsorCreditCents: 6.2,
        acceptedAt: '2026-11-03T06:00:03.000Z',
      },
      {
        provider: 'e2b',
        catalogId: 'e2b:micro:us',
        priceCents: 4.5,
        grossPriceCents: 4.5,
        sponsorCreditCents: 0,
        acceptedAt: '2026-11-03T06:00:02.000Z',
      },
    ],
  };
  assert.equal(computeReceipt(compute).bids[0].provider, 'e2b');
  const promotion = {
    ...compute,
    grossPriceCents: 1,
    sponsorCreditCents: 0,
    operatorSponsored: true,
    bids: compute.bids.map((bid) =>
      bid.provider === 'modal'
        ? { ...bid, grossPriceCents: 1, sponsorCreditCents: 0, operatorSponsored: true }
        : bid,
    ),
  };
  assert.equal(computeReceipt(promotion).operatorSponsored, true);
  for (const invalid of [
    { ...compute, bids: compute.bids.slice(0, 1) },
    { ...compute, grossPriceCents: 1 },
    { ...compute, sponsorCreditCents: 7 },
    { ...compute, operatorSponsored: true },
    { ...promotion, grossPriceCents: 8, sponsorCreditCents: 7 },
    { ...promotion, operatorSponsored: false },
    { ...compute, auctionEndsAt: '2026-11-03T06:00:02.000Z' },
    { ...compute, bids: compute.bids.map((bid) => ({ ...bid, provider: 'modal' })) },
    {
      ...compute,
      bids: compute.bids.map((bid) =>
        bid.provider === 'e2b' ? { ...bid, priceCents: 1, sponsorCreditCents: 3.5 } : bid,
      ),
    },
  ])
    assert.throws(() => computeReceipt(invalid), CheckFailure);
  console.log(
    JSON.stringify({ event: 'self_test', passed: true, networkRequests: 0, paidCalls: 0 }),
  );
}

try {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
  else {
    check(process.argv.length === 3 && process.argv[2] === '--live', 'pass_live_or_self_test');
    await verify(appOrigin(process.env.APP_URL));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'failed',
      check: error instanceof CheckFailure ? error.check : 'unexpected_error',
    }),
  );
  process.exitCode = 1;
}
