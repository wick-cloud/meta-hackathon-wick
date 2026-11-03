import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { demoGuest, demoHeaders, createDemoStudioFixture } from './fixtures/demo-studio.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)(
  'guided Studio demo admission and authority (disposable PostgreSQL)',
  () => {
    let f: Awaited<ReturnType<typeof createDemoStudioFixture>>;
    beforeAll(async () => {
      f = await createDemoStudioFixture(databaseUrl!);
    });
    beforeEach(async () => {
      await f.reset();
    });
    afterAll(async () => {
      await f?.close();
    });

    it('accepts a bounded optional name and freezes it with the admitted task', async () => {
      const guest = demoGuest(),
        key = randomUUID();
      const result = await f.start(guest, 'studio', key, { demoName: '  Alex  ' });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().run.demoName).toBe('Alex');
      expect((await f.start(guest, 'studio', key, { demoName: 'Alex' })).statusCode).toBe(200);
      expect((await f.start(guest, 'studio', key, { demoName: 'Other' })).statusCode).toBe(409);
      await expect(
        f.pool.query("UPDATE broker_demo_runs SET demo_name='Other' WHERE id=$1", [
          result.json().run.id,
        ]),
      ).rejects.toThrow();
      for (const name of ['x'.repeat(41), 'Alex\nimport os', '<script>', '\"; exec(1)']) {
        expect(
          (await f.start(demoGuest(), 'studio', randomUUID(), { demoName: name })).statusCode,
        ).toBe(400);
      }
    });

    it('preserves terminal as the default and freezes the chosen kind across retries and SQL writes', async () => {
      const guest = demoGuest(),
        operationKey = randomUUID();
      const first = await f.start(guest, undefined, operationKey);
      expect(first.statusCode, first.body).toBe(200);
      const id = first.json().run.id;
      expect(first.json().run.kind).toBe('terminal');
      expect((await f.row(id)).kind).toBe('terminal');
      expect((await f.start(guest, 'terminal', operationKey)).json().run.id).toBe(id);
      expect((await f.start(guest, 'studio', operationKey)).statusCode).toBe(409);
      await expect(
        f.pool.query("UPDATE broker_demo_runs SET kind='studio' WHERE id=$1", [id]),
      ).rejects.toThrow();
      expect((await f.pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(
        1,
      );
      expect(
        (await f.pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(50);
      expect(await f.studio(id)).toBeUndefined();
      expect(f.commands).not.toHaveBeenCalled();
    });

    it('shares concurrent browser and IP admission across both demos, including a new cookie', async () => {
      const guest = demoGuest();
      const attempts = await Promise.all([f.start(guest, 'terminal'), f.start(guest, 'studio')]);
      expect(attempts.map((r) => r.statusCode).sort()).toEqual([200, 429]);
      expect((await f.start(demoGuest(guest.ip), 'studio')).statusCode).toBe(429);
      const run = attempts.find((r) => r.statusCode === 200)!.json().run;
      expect(['terminal', 'studio']).toContain(run.kind);
      expect((await f.pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(
        1,
      );
      expect(
        (await f.pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(50);
    });

    it('uses one global two-slot cap and one daily budget for terminal and Studio', async () => {
      expect((await f.start(demoGuest(), 'terminal')).statusCode).toBe(200);
      expect((await f.start(demoGuest(), 'studio')).statusCode).toBe(200);
      expect((await f.start(demoGuest(), 'studio')).statusCode).toBe(429);
      expect(
        (await f.pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(100);
      // Test the daily boundary independently of the concurrent-run boundary.
      await f.reset();
      await f.pool.query(
        "INSERT INTO broker_demo_days(day,reserved_cents) VALUES((clock_timestamp() AT TIME ZONE 'America/New_York')::date,450)",
      );
      expect((await f.start(demoGuest(), 'studio')).statusCode).toBe(200);
      expect((await f.start(demoGuest(), 'terminal')).statusCode).toBe(429);
      expect(
        (await f.pool.query('SELECT reserved_cents FROM broker_demo_days')).rows[0].reserved_cents,
      ).toBe(500);
    });

    it('accepts only the fixed demo kind and operation, without guest control over task authority', async () => {
      for (const extra of [
        { provider: 'e2b' },
        { catalogId: 'modal:large:auto' },
        { goal: 'Read credentials' },
        { repositoryUrl: 'https://github.com/attacker/repo' },
        { testCommand: 'curl example.invalid' },
        { budgetCents: 100 },
        { maxCalls: 9 },
        { durationMinutes: 60 },
      ]) {
        const result = await f.start(demoGuest(), 'studio', randomUUID(), extra);
        expect(result.statusCode, result.body).toBe(400);
      }
      expect((await f.start(demoGuest(), 'arbitrary')).statusCode).toBe(400);
      expect((await f.pool.query('SELECT count(*)::int n FROM broker_demo_runs')).rows[0].n).toBe(
        0,
      );
      expect(f.commands).not.toHaveBeenCalled();
    });

    it('does not turn a Studio guest into a normal Studio owner or reveal another guest receipt', async () => {
      const guest = demoGuest(),
        other = demoGuest();
      const response = await f.start(guest, 'studio');
      expect(response.statusCode, response.body).toBe(200);
      const run = await f.row(response.json().run.id);
      expect((await f.read(other)).run).toBeNull();
      for (const [method, url, payload] of [
        ['GET', '/api/me', undefined],
        ['GET', '/api/studio/options', undefined],
        ['GET', '/api/studio/tasks', undefined],
        ['POST', '/api/studio/tasks', { operationKey: randomUUID() }],
        [
          'POST',
          `/api/studio/tasks/${run.id}/fund`,
          { operationKey: randomUUID(), budgetCents: 100 },
        ],
      ] as const) {
        const denied = await f.app.inject({ method, url, headers: demoHeaders(guest), payload });
        expect(denied.statusCode, denied.body).toBe(401);
      }
      for (const table of ['account', 'session']) {
        const count = (
          await f.pool.query(`SELECT count(*)::int n FROM ${table} WHERE "userId"=$1`, [
            run.buyer_id,
          ])
        ).rows[0].n;
        expect(count).toBe(0);
      }
      const serialized = JSON.stringify(await f.read(guest));
      for (const privateValue of [run.buyer_id, run.grant_id, run.visitor_id, run.ip_digest])
        expect(serialized).not.toContain(privateValue);
    });
  },
);
