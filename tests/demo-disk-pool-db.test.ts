import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoStudioFixture, demoGuest } from './fixtures/demo-studio.js';
import { claimDemoDisk, warmDemoDisks, demoDiskDetached } from '../src/server/demo/disks.js';
import { reconcileDisk } from '../src/server/disks/index.js';
import { demoBootstrapCommand } from '../src/server/demo/script.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('dedicated demo disk pool', () => {
  let f: Awaited<ReturnType<typeof createDemoStudioFixture>>;
  beforeAll(async () => {
    f = await createDemoStudioFixture(url!);
    await f.reset();
    f.ctx.config.liveDemoReuseDisks = true;
  });
  afterAll(async () => {
    await f?.close();
  });
  it('allocates no pool disks while reuse is disabled', async () => {
    f.ctx.config.liveDemoReuseDisks = false;
    try {
      await warmDemoDisks(f.ctx);
      expect(
        (await f.pool.query('SELECT count(*)::int n FROM broker_demo_disk_pool')).rows[0].n,
      ).toBe(0);
    } finally {
      f.ctx.config.liveDemoReuseDisks = true;
    }
  });
  it('warms only five dedicated disks and preserves identities across concurrent warmers', async () => {
    await Promise.all([warmDemoDisks(f.ctx), warmDemoDisks(f.ctx)]);
    const entries = (await f.pool.query('SELECT * FROM broker_demo_disk_pool ORDER BY slot')).rows;
    expect(entries.map((e) => e.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(entries.map((e) => e.disk_id)).size).toBe(5);
    for (const e of entries) await reconcileDisk(f.ctx, e.disk_id);
    await warmDemoDisks(f.ctx);
    expect((await f.pool.query('SELECT count(*)::int n FROM broker_disks')).rows[0].n).toBe(5);
    expect(
      (await f.pool.query('SELECT disk_id FROM broker_demo_disk_pool ORDER BY slot')).rows,
    ).toEqual(entries.map(({ disk_id }) => ({ disk_id })));
    await expect(
      f.pool.query(
        "INSERT INTO broker_demo_disk_pool(source_mode,slot,owner_id) VALUES('fixture',6,$1)",
        [entries[0].owner_id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'broker_demo_disk_pool_slot_check' });
  });
  it('checks out exclusively for both kinds and blocks stale workers and attached disks', async () => {
    const runs = [];
    for (const kind of ['terminal', 'studio', 'terminal', 'studio', 'terminal']) {
      const r = await f.start(demoGuest(), kind);
      expect(r.statusCode, r.body).toBe(200);
      const lease = randomUUID();
      await f.pool.query(
        "UPDATE broker_demo_runs SET lease_token=$2,lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1",
        [r.json().run.id, lease],
      );
      runs.push(await f.row(r.json().run.id));
    }
    expect(await claimDemoDisk(f.ctx, { ...runs[0], lease_token: randomUUID() })).toBe(false);
    for (const run of runs) expect(await claimDemoDisk(f.ctx, run)).toBe(true);
    expect(
      new Set(
        (await f.pool.query('SELECT disk_id FROM broker_demo_runs')).rows.map((r) => r.disk_id),
      ).size,
    ).toBe(5);
    const first = await f.row(runs[0].id),
      second = await f.row(runs[1].id);
    expect(first.disk_id).not.toBe(second.disk_id);
    expect(
      (await f.pool.query('SELECT buyer_id FROM broker_disks WHERE id=$1', [first.disk_id])).rows[0]
        .buyer_id,
    ).toBe(first.buyer_id);
    expect(await demoDiskDetached(f.ctx, first)).toBe(true);
    // A late checkpoint cannot release another run's lease or change its disk.
    expect(await demoDiskDetached(f.ctx, { ...first, id: second.id })).toBe(false);
    await f.pool.query('UPDATE broker_demo_disk_pool SET run_id=NULL WHERE run_id=$1', [first.id]);
    await f.pool.query('UPDATE broker_demo_runs SET ended_at=clock_timestamp() WHERE id=$1', [
      first.id,
    ]);
    const response = await f.start(demoGuest(), 'studio');
    expect(response.statusCode, response.body).toBe(200);
    const lease = randomUUID();
    await f.pool.query(
      "UPDATE broker_demo_runs SET lease_token=$2,lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1",
      [response.json().run.id, lease],
    );
    const next = await f.row(response.json().run.id);
    await f.pool.query('UPDATE broker_disks SET cleanup_pending=true WHERE id=$1', [first.disk_id]);
    expect(await claimDemoDisk(f.ctx, next)).toBe(false);
    await f.pool.query('UPDATE broker_disks SET cleanup_pending=false WHERE id=$1', [
      first.disk_id,
    ]);
    expect(await claimDemoDisk(f.ctx, next)).toBe(true);
    expect((await f.row(next.id)).disk_id).toBe(first.disk_id);
    expect((await f.pool.query('SELECT count(*)::int n FROM broker_disks')).rows[0].n).toBe(5);
  });
  it('retains the native disk after full VM cleanup and reuses it for the other demo kind', async () => {
    await f.reset();
    await warmDemoDisks(f.ctx);
    for (const row of (await f.pool.query('SELECT disk_id FROM broker_demo_disk_pool')).rows)
      await reconcileDisk(f.ctx, row.disk_id);
    const guest = demoGuest();
    const run = await f.ready(guest, 'terminal');
    expect(run.reusable_disk).toBe(true);
    await f.end(guest);
    const ended = await f.cleanup(run.id);
    expect(ended.ended_at).toBeTruthy();
    expect(
      (await f.pool.query('SELECT status FROM broker_disks WHERE id=$1', [run.disk_id])).rows[0]
        .status,
    ).toBe('ready');
    expect(
      (
        await f.pool.query('SELECT run_id FROM broker_demo_disk_pool WHERE disk_id=$1', [
          run.disk_id,
        ])
      ).rows[0].run_id,
    ).toBeNull();
    expect((await f.read(guest)).run.disk.status).toBe('retained');
    const next = await f.ready(demoGuest(), 'studio');
    expect(next.disk_id).toBe(run.disk_id);
    expect(next.buyer_id).not.toBe(run.buyer_id);
    expect((await f.read(guest)).run.disk.status).toBe('retained');
    expect((await f.pool.query('SELECT count(*)::int n FROM broker_disks')).rows[0].n).toBe(5);
  });
  it('clears prior hidden data and symlinks without touching outside files before both presets', () => {
    for (const kind of ['terminal', 'studio'] as const) {
      const base = mkdtempSync(join(tmpdir(), 'demo-reset-'));
      try {
        const workspace = join(base, 'workspace');
        mkdirSync(workspace);
        mkdirSync(join(workspace, '.archil'));
        writeFileSync(join(workspace, '.archil', 'mount-control'), 'native-control');
        const outside = join(base, 'outside');
        writeFileSync(outside, 'keep');
        writeFileSync(join(workspace, '.old-studio-journal'), 'private');
        mkdirSync(join(workspace, 'old'));
        writeFileSync(join(workspace, 'old', 'secret'), 'private');
        symlinkSync(outside, join(workspace, 'README.txt'));
        // Only the fixed operator bootstrap executes; the installed example is not called.
        const command = demoBootstrapCommand('http://localhost:3000', kind, true).replaceAll(
          '/workspace',
          workspace,
        );
        expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe(
          'WICK_DEMO_SCRIPT_READY',
        );
        expect(readFileSync(outside, 'utf8')).toBe('keep');
        expect(readFileSync(join(workspace, '.archil', 'mount-control'), 'utf8')).toBe(
          'native-control',
        );
        expect(existsSync(join(workspace, '.old-studio-journal'))).toBe(false);
        expect(existsSync(join(workspace, 'old'))).toBe(false);
        expect(readFileSync(join(workspace, 'README.txt'), 'utf8')).toContain('demo');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });
});
