import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileDemo } from '../src/server/demo/index.js';
import { demoActor } from '../src/server/demo/service.js';
import { completeDemoStudio } from '../src/server/inference/gateway.js';
import { fixtureInputTokens, InferenceUpstreamError } from '../src/server/inference/runtime.js';
import {
  demoGuest,
  demoHeaders,
  createDemoStudioFixture,
  type DemoGuest,
} from './fixtures/demo-studio.js';
import { localStudioRunner } from './fixtures/demo-studio-runner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'guided Studio metering, execution and recovery (disposable PostgreSQL)',
  () => {
    let f: Awaited<ReturnType<typeof createDemoStudioFixture>>;
    let runner: ReturnType<typeof localStudioRunner>;
    beforeAll(async () => {
      f = await createDemoStudioFixture(databaseUrl!);
    });
    beforeEach(async () => {
      await f.reset();
      runner = localStudioRunner();
      f.commands.mockImplementation(async (_id, { command }) => ({
        stdout: command.includes('WICK_DEMO_SCRIPT_READY')
          ? 'WICK_DEMO_SCRIPT_READY'
          : JSON.stringify(runner.execute(command)),
        stderr: '',
        exitCode: 0,
        simulated: true,
      }));
    });
    afterEach(() => {
      runner?.close();
    });
    afterAll(async () => {
      await f?.close();
    });
    const calls = () => vi.mocked(f.ctx.inference!.dispatch);
    const executions = () =>
      f.commands.mock.calls.filter(
        ([, input]) => !input.command.includes('WICK_DEMO_SCRIPT_READY'),
      );
    async function advance(id: string) {
      for (let tick = 0; tick < 4; tick++) {
        await reconcileDemo(f.ctx, id);
        if (['passed', 'needs_attention'].includes((await f.studio(id)).status)) break;
      }
      return f.studio(id);
    }
    async function terminal(guest: DemoGuest, vmId: string) {
      return f.app.inject({
        method: 'GET',
        url: `/terminal-identity/${vmId}`,
        headers: demoHeaders(guest),
      });
    }
    async function prepareAttempt(runId: string) {
      const lease = randomUUID();
      await f.pool.query(
        "UPDATE broker_demo_runs SET lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",
        [runId, lease],
      );
      await f.pool.query("UPDATE broker_demo_studio SET status='generating' WHERE run_id=$1", [
        runId,
      ]);
      await f.pool.query('INSERT INTO broker_demo_studio_attempts(run_id,attempt) VALUES($1,0)', [
        runId,
      ]);
      return lease;
    }

    it('passes the exact Muse source through real Python and records only the owned pack allocation', async () => {
      const generated = 'print ("Hello, World!")\n';
      calls().mockImplementation(async (_route, input, id) => ({
        id: `fixture_${id}`,
        content: JSON.stringify({ source: generated }),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(input),
        outputTokens: 40,
      }));
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('passed');
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
      expect(readFileSync(join(runner.directory, 'hello_world.py'), 'utf8')).toBe(generated);
      const state = await f.read(guest);
      expect(state.run.studio).toMatchObject({
        status: 'passed',
        source: generated,
        stdout: 'Hello, World!\n',
        exitCode: 0,
        requestsUsed: 1,
      });
      expect(state.run.studio.verifiedAt).toBeTruthy();
      expect(state.run.canIssueKey).toBe(false);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/demo/key',
            headers: demoHeaders(guest),
            payload: { operationKey: randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
      const allocations = (
        await f.pool.query(
          `SELECT a.pack_id,r.provider,r.status,r.reserved_output,r.input_tokens,r.output_tokens
      FROM broker_inference_allocations a JOIN broker_inference_requests r ON r.id=a.request_id WHERE r.grant_id=$1`,
          [run.grant_id],
        )
      ).rows;
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).toMatchObject({
        pack_id: run.pack_id,
        provider: 'baseten',
        status: 'settled',
        reserved_output: 1024,
      });
      expect(allocations[0].input_tokens).toBeLessThanOrEqual(5000);
      expect(allocations[0].output_tokens).toBeLessThanOrEqual(1024);
      const sourceAuthority = (
        await f.pool.query(
          'SELECT source_demo_run_id,source_key_id,source_job_id,source_task_id FROM broker_inference_requests WHERE grant_id=$1',
          [run.grant_id],
        )
      ).rows[0];
      expect(sourceAuthority).toEqual({
        source_demo_run_id: run.id,
        source_key_id: null,
        source_job_id: null,
        source_task_id: null,
      });
      await expect(
        f.pool.query(
          'UPDATE broker_inference_requests SET source_demo_run_id=NULL WHERE grant_id=$1',
          [run.grant_id],
        ),
      ).rejects.toThrow();
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(200);
      expect((await terminal(demoGuest(), run.vm_id)).statusCode).toBe(403);
      await Promise.all(Array.from({ length: 5 }, () => reconcileDemo(f.ctx, run.id)));
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
      expect(await f.row(run.id)).toMatchObject({
        status: 'ready',
        stop_requested: false,
        expires_at: run.expires_at,
      });
    });

    it('allows one definite invalid-answer repair and leaves the terminal available after both calls', async () => {
      const dispatch = calls().getMockImplementation()!;
      calls()
        .mockImplementationOnce(async (_route, input, id) => ({
          id: `fixture_${id}`,
          content: '{"not_source":"invalid"}',
          finishReason: 'stop',
          inputTokens: fixtureInputTokens(input),
          outputTokens: 25,
        }))
        .mockImplementation(dispatch);
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('passed');
      expect(calls()).toHaveBeenCalledTimes(2);
      expect(executions()).toHaveLength(1);
      const state = await f.read(guest);
      expect(state.run.tokens.requestsUsed).toBe(2);
      expect(state.run.canIssueKey).toBe(false);
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(200);
      for (let tick = 0; tick < 3; tick++) await reconcileDemo(f.ctx, run.id);
      expect(calls()).toHaveBeenCalledTimes(2);
      expect(executions()).toHaveLength(1);
      expect(
        (
          await f.pool.query('SELECT count(*)::int n FROM broker_token_orders WHERE grant_id=$1', [
            run.grant_id,
          ])
        ).rows[0].n,
      ).toBe(1);
    });

    it('stops after two AST-rejected answers without executing either, while preserving terminal access', async () => {
      calls().mockImplementation(async (_route, input, id) => ({
        id: `fixture_${id}`,
        content: JSON.stringify({ source: "__import__('os').system('id')" }),
        finishReason: 'stop',
        inputTokens: fixtureInputTokens(input),
        outputTokens: 30,
      }));
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect(await advance(run.id)).toMatchObject({ status: 'needs_attention', attempt: 1 });
      expect(calls()).toHaveBeenCalledTimes(2);
      expect(executions()).toHaveLength(2); // Both are validator receipts, not generated-code execution.
      expect(existsSync(join(runner.directory, 'hello_world.py'))).toBe(false);
      expect((await f.read(guest)).run.studio.verifiedAt).toBeNull();
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(200);
      await Promise.all(Array.from({ length: 5 }, () => reconcileDemo(f.ctx, run.id)));
      expect(calls()).toHaveBeenCalledTimes(2);
      expect(executions()).toHaveLength(2);
    });

    it('serializes competing workers and recovers a committed model reply without another dispatch', async () => {
      const guest = demoGuest(),
        run = await f.ready(guest),
        lease = await prepareAttempt(run.id);
      const actor = demoActor(run);
      const results = await Promise.allSettled([
        completeDemoStudio(f.ctx, actor, run.id, lease, 0),
        completeDemoStudio(f.ctx, actor, run.id, lease, 0),
      ]);
      expect(
        results.some((result) => result.status === 'fulfilled'),
        results
          .map((result) => (result.status === 'rejected' ? String(result.reason) : 'fulfilled'))
          .join('; '),
      ).toBe(true);
      expect(calls()).toHaveBeenCalledTimes(1);
      const attempt = (
        await f.pool.query('SELECT * FROM broker_demo_studio_attempts WHERE run_id=$1', [run.id])
      ).rows[0];
      expect(attempt.request_id).toBeTruthy();
      expect(attempt.response_cipher).toBeTruthy();
      expect(executions()).toHaveLength(0);
      await f.pool.query(
        'UPDATE broker_demo_runs SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [run.id],
      );
      await Promise.all(Array.from({ length: 5 }, () => reconcileDemo(f.ctx, run.id)));
      expect((await f.studio(run.id)).status).toBe('passed');
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
    });

    it('rejects stale worker authority and a different owner before reserving tokens', async () => {
      const run = await f.ready(demoGuest()),
        lease = await prepareAttempt(run.id);
      await expect(
        completeDemoStudio(f.ctx, demoActor(run), run.id, randomUUID(), 0),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        completeDemoStudio(f.ctx, { ...demoActor(run), id: randomUUID() }, run.id, lease, 0),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(calls()).not.toHaveBeenCalled();
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM broker_inference_requests WHERE grant_id=$1',
            [run.grant_id],
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('retains uncertain inference usage and never issues a replacement call or Python execution', async () => {
      calls().mockRejectedValue(new InferenceUpstreamError('fixture_lost_reply', false));
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('needs_attention');
      await Promise.all(Array.from({ length: 5 }, () => reconcileDemo(f.ctx, run.id)));
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(0);
      const requests = (
        await f.pool.query('SELECT status FROM broker_inference_requests WHERE grant_id=$1', [
          run.grant_id,
        ])
      ).rows;
      expect(requests).toEqual([{ status: 'outcome_unknown' }]);
      const pack = (
        await f.pool.query('SELECT held_input,held_output FROM broker_token_packs WHERE id=$1', [
          run.pack_id,
        ])
      ).rows[0];
      expect(Number(pack.held_input)).toBeGreaterThan(0);
      expect(Number(pack.held_output)).toBe(1024);
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(200);
    });

    it('blocks model admission after unmount and native execution after an attachment identity changes', async () => {
      const run = await f.ready(demoGuest()),
        lease = await prepareAttempt(run.id);
      await f.pool.query("UPDATE broker_disk_attachments SET status='detached' WHERE vm_id=$1", [
        run.vm_id,
      ]);
      await expect(
        completeDemoStudio(f.ctx, demoActor(run), run.id, lease, 0),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(calls()).not.toHaveBeenCalled();
      await f.pool.query("UPDATE broker_disk_attachments SET status='mounted' WHERE vm_id=$1", [
        run.vm_id,
      ]);
      await completeDemoStudio(f.ctx, demoActor(run), run.id, lease, 0);
      expect(calls()).toHaveBeenCalledTimes(1);
      await f.pool.query(
        "UPDATE broker_disk_attachments SET environment_id='different-environment' WHERE vm_id=$1",
        [run.vm_id],
      );
      await f.pool.query(
        'UPDATE broker_demo_runs SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [run.id],
      );
      await reconcileDemo(f.ctx, run.id);
      expect(executions()).toHaveLength(0);
      expect((await f.studio(run.id)).verified_at).toBeNull();
    });

    it('never repeats execution after a lost native receipt, even when the Python run actually succeeded', async () => {
      const realCommand = f.commands.getMockImplementation()!;
      f.commands.mockImplementation(async (id, input) => {
        const result = await realCommand(id, input);
        if (!input.command.includes('WICK_DEMO_SCRIPT_READY'))
          throw new Error('Fixture response lost after actual Python execution');
        return result;
      });
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('needs_attention');
      expect(readFileSync(join(runner.directory, 'hello_world.py'), 'utf8')).toContain(
        'Hello, World!',
      );
      expect((await f.read(guest)).run.studio.verifiedAt).toBeNull();
      await Promise.all(Array.from({ length: 5 }, () => reconcileDemo(f.ctx, run.id)));
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(200);
    });

    it('cleans both resources on End and shares its twenty-minute cooldown with the terminal demo', async () => {
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('passed');
      expect((await f.end(guest)).statusCode).toBe(200);
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(403);
      const ended = await f.cleanup(run.id);
      expect(ended.status).toBe('ended');
      expect(
        new Date(ended.cooldown_until).getTime() - new Date(ended.vm_cleanup_at).getTime(),
      ).toBe(1_200_000);
      expect(
        (await f.pool.query('SELECT status FROM broker_vms WHERE id=$1', [run.vm_id])).rows[0]
          .status,
      ).toBe('terminated');
      expect(
        (await f.pool.query('SELECT status FROM broker_disks WHERE id=$1', [run.disk_id])).rows[0]
          .status,
      ).toBe('deleted');
      expect(
        (
          await f.pool.query('SELECT status FROM broker_inference_grants WHERE id=$1', [
            run.grant_id,
          ])
        ).rows[0].status,
      ).toBe('closed');
      expect(
        (await f.pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(50);
      expect((await f.start(guest, 'terminal')).statusCode).toBe(429);
      expect((await f.start(demoGuest(guest.ip), 'studio')).statusCode).toBe(429);
    });

    it('expires a completed Studio without extending either the VM or model allowance', async () => {
      const guest = demoGuest(),
        run = await f.ready(guest);
      expect((await advance(run.id)).status).toBe('passed');
      await f.pool.query(
        "UPDATE broker_demo_runs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [run.id],
      );
      await reconcileDemo(f.ctx, run.id);
      expect((await f.row(run.id)).stop_requested).toBe(true);
      expect((await terminal(guest, run.vm_id)).statusCode).toBe(403);
      expect((await f.cleanup(run.id)).status).toBe('ended');
      expect(calls()).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
    });
  },
);
