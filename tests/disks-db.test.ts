import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { reconcileDisk } from '../src/server/disks/index.js';
import {
  createDisk,
  deleteDisk,
  diskDetail,
  diskOptions,
  listDisks,
  listWorkspaces,
  requireDisk,
  renameDisk,
} from '../src/server/disks/service.js';
import { transaction } from '../src/server/marketplace/db.js';
import type { AppContext } from '../src/server/context.js';
import type { Actor } from '../src/shared/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('customer-owned disks (disposable PostgreSQL)', () => {
  const schema = `disks_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool, pool: Pool, ctx: AppContext;
  const actor = {
    id: randomUUID(),
    role: 'buyer',
    email: 'buyer@test.invalid',
    name: 'Buyer',
  } as Actor;
  const other = { ...actor, id: randomUUID(), email: 'other@test.invalid' };
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 8,
    });
    await migrate(pool);
    for (const a of [actor, other])
      await pool.query(
        'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
        [a.id, a.email, a.name, a.role],
      );
    const config = {
      wickMode: 'fixture',
      wickApiBase: 'https://wick.example/api',
      wickOrganizationId: 'org',
      wickGroupId: 'group',
      disksEnabled: true,
      diskQualifiedCatalogIds: [],
    } as unknown as AppContext['config'];
    ctx = {
      pool,
      config,
      wick: createWickAdapter(config, pool),
      boss: { send: vi.fn(async () => randomUUID()) },
    } as unknown as AppContext;
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function readyDisk(name = 'Research') {
    const d = await createDisk(ctx, actor, { name, operationKey: `create:${randomUUID()}` });
    await reconcileDisk(ctx, d.id);
    return (await diskDetail(ctx, actor, d.id)).disk;
  }
  it('replays concurrent creation and recovers one upstream drive after worker restart', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createDisk(ctx, actor, { name: 'Shared project', operationKey: 'create-shared-project' }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await Promise.all(results.map((r) => reconcileDisk(ctx, r.id)));
    const detail = await diskDetail(ctx, actor, results[0]!.id);
    expect(detail.disk.status).toBe('ready');
    expect(detail.disk.canDelete).toBe(true);
    expect((await pool.query('SELECT count(*)::int n FROM broker_fixture_drives')).rows[0].n).toBe(
      1,
    );
    await expect(
      createDisk(ctx, actor, { name: 'Different', operationKey: 'create-shared-project' }),
    ).rejects.toThrow('different request');
  });
  it('hides other customer disks and never exposes upstream identity', async () => {
    const d = await readyDisk();
    await expect(diskDetail(ctx, other, d.id)).rejects.toThrow('not found');
    await expect(deleteDisk(ctx, other, d.id, {})).rejects.toThrow('not found');
    await expect(transaction(pool, (db) => requireDisk(ctx, db, other.id, d.id))).rejects.toThrow(
      'not found',
    );
    expect((await listDisks(ctx, other, {})).items).toEqual([]);
    expect(JSON.stringify(await diskDetail(ctx, actor, d.id))).not.toContain('fixture-drive-');
  });
  it('preserves disks while a task reserves a workspace, even before a VM exists', async () => {
    const d = await readyDisk();
    // The FK points to an existing task; reserve through a fixture grant/task.
    const grant = randomUUID(),
      task = randomUUID();
    await pool.query(
      `INSERT INTO broker_inference_grants(id,buyer_id,name,source_mode,funded_cents,available_cents,max_purchase_cents,allowed_providers,expires_at,status) VALUES($1,$2,'Task','fixture',100,100,100,'["baseten"]',now()+interval '1 hour','active')`,
      [grant, actor.id],
    );
    await pool.query(
      `INSERT INTO broker_studio_tasks(id,buyer_id,grant_id,operation_key,input_fingerprint,repository_url,commit_sha,base_ref,goal,source_mode,duration_minutes,deadline_at,model_output) VALUES($1::uuid,$2,$3,'task:' || $1::text,'digest','https://github.com/acme/repo',$4,'main','Task','fixture',30,now()+interval '1 hour',2048)`,
      [task, actor.id, grant, 'a'.repeat(40)],
    );
    await pool.query(
      `INSERT INTO broker_disk_workspaces(disk_id,buyer_id,name,repository_url,commit_sha,active_task_id) VALUES($1,$2,'workspace','https://github.com/acme/repo',$3,$4)`,
      [d.id, actor.id, 'a'.repeat(40), task],
    );
    await expect(deleteDisk(ctx, actor, d.id, {})).rejects.toThrow('pending work');
    expect((await diskDetail(ctx, actor, d.id)).disk.canDelete).toBe(false);
    await pool.query('UPDATE broker_disk_workspaces SET active_task_id=NULL WHERE disk_id=$1', [
      d.id,
    ]);
    expect((await diskDetail(ctx, actor, d.id)).disk.canDelete).toBe(true);
  });
  it('paginates workspace history without silently hiding later folders', async () => {
    const d = await readyDisk();
    for (let n = 0; n < 3; n++)
      await pool.query(
        `INSERT INTO broker_disk_workspaces(disk_id,buyer_id,name,repository_url,commit_sha) VALUES($1,$2,$3,'https://github.com/acme/repo',$4)`,
        [d.id, actor.id, `folder-${n}`, 'a'.repeat(40)],
      );
    const a = await listWorkspaces(ctx, actor, d.id, { limit: 2 });
    const b = await listWorkspaces(ctx, actor, d.id, { limit: 2, cursor: a.nextCursor });
    expect(a.items).toHaveLength(2);
    expect(b.items).toHaveLength(1);
    expect(new Set([...a.items, ...b.items].map((w) => w.id)).size).toBe(3);
  });
  it('renames durably and deletes only after native confirmation', async () => {
    const d = await readyDisk();
    await renameDisk(ctx, actor, d.id, { name: 'Renamed' });
    await reconcileDisk(ctx, d.id);
    const row = (await pool.query('SELECT * FROM broker_disks WHERE id=$1', [d.id])).rows[0];
    expect((await ctx.wick.drives!.get(row.upstream_id)).drive.name).toBe('Renamed');
    const pending = await deleteDisk(ctx, actor, d.id, { operationKey: 'delete-one-disk' });
    expect(pending.status).toBe('deleting');
    await reconcileDisk(ctx, d.id);
    expect((await diskDetail(ctx, actor, d.id)).disk.status).toBe('deleted');
    expect((await listDisks(ctx, actor, {})).items.some((x) => x.id === d.id)).toBe(false);
  });
  it('retries an uncertain upstream create with its original durable key', async () => {
    const d = await createDisk(ctx, actor, {
      name: 'Uncertain',
      operationKey: 'uncertain-native-create',
    });
    const original = ctx.wick.drives!.create;
    const spy = vi
      .spyOn(ctx.wick.drives!, 'create')
      .mockRejectedValueOnce(new Error('Network response lost'));
    await reconcileDisk(ctx, d.id);
    expect((await diskDetail(ctx, actor, d.id)).disk.status).toBe('creating');
    spy.mockImplementation(original);
    await reconcileDisk(ctx, d.id);
    expect(spy.mock.calls[0]![1]).toBe(spy.mock.calls[1]![1]);
    expect((await diskDetail(ctx, actor, d.id)).disk.status).toBe('ready');
    spy.mockRestore();
  });
  it('preserves a newer rename when an older provider response completes late', async () => {
    const d = await readyDisk();
    await renameDisk(ctx, actor, d.id, { name: 'Earlier name' });
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ctx.wick.drives!.rename;
    const spy = vi.spyOn(ctx.wick.drives!, 'rename').mockImplementation(async (...args) => {
      began();
      await gate;
      return original(...args);
    });
    const inflight = reconcileDisk(ctx, d.id);
    await started;
    await renameDisk(ctx, actor, d.id, { name: 'Latest name' });
    await expect(deleteDisk(ctx, actor, d.id, {})).rejects.toThrow('pending work');
    release();
    await inflight;
    spy.mockRestore();
    const row = (await pool.query('SELECT * FROM broker_disks WHERE id=$1', [d.id])).rows[0];
    expect(row.name).toBe('Latest name');
    expect(row.needs_sync).toBe(true);
    await reconcileDisk(ctx, d.id);
    expect((await ctx.wick.drives!.get(row.upstream_id)).drive.name).toBe('Latest name');
  });
  it('observes references committed while deletion waits on the disk lock', async () => {
    const d = await readyDisk();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await requireDisk(ctx, blocker, actor.id, d.id);
    const deletion = deleteDisk(ctx, actor, d.id, {}).then(
      () => 'deleted',
      () => 'blocked',
    );
    await vi.waitFor(async () => {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM broker_disks%' AND state='active'",
      );
      expect(waiting.rowCount).toBeGreaterThan(0);
    });
    await blocker.query(
      `INSERT INTO broker_intents(buyer_id,operation_key,description,desired,flexibility,source_mode) VALUES($1,$2,'Pending alternative',$3,'{}','fixture')`,
      [actor.id, `intent:${randomUUID()}`, { diskId: d.id }],
    );
    await blocker.query('COMMIT');
    blocker.release();
    expect(await deletion).toBe('blocked');
    expect((await diskDetail(ctx, actor, d.id)).disk.status).toBe('ready');
  });
  it('shows operator attention after a valid but pending final native observation', async () => {
    const d = await createDisk(ctx, actor, {
      name: 'Still pending',
      operationKey: 'pending-final-native-observation',
    });
    await pool.query('UPDATE broker_disks SET attempts=59 WHERE id=$1', [d.id]);
    const original = ctx.wick.drives!.create;
    const spy = vi.spyOn(ctx.wick.drives!, 'create').mockImplementation(async (...args) => {
      const response = await original(...args);
      return {
        ...response,
        drive: { ...response.drive, status: 'creating' },
        operation: { ...response.operation, status: 'running' },
      };
    });
    await reconcileDisk(ctx, d.id);
    const disk = (await diskDetail(ctx, actor, d.id)).disk;
    expect(disk.status).toBe('creating');
    expect(disk.cleanupPending).toBe(true);
    expect(disk.failureReason).toContain('retry budget');
    expect(disk.canDelete).toBe(false);
    const calls = spy.mock.calls.length;
    await reconcileDisk(ctx, d.id);
    expect(spy.mock.calls).toHaveLength(calls);
    spy.mockRestore();
  });
  it('discovers every approved native-mount shape under the wildcard and tracks catalog changes', async () => {
    const originalMode = ctx.wick.mode;
    const originalIds = ctx.config.diskQualifiedCatalogIds;
    ctx.wick.mode = 'real';
    ctx.config.diskQualifiedCatalogIds = ['*'];
    const nativeIds = [
      'e2b:micro:us',
      'e2b:small:us',
      'e2b:medium:us',
      'modal:micro:auto',
      'modal:small:auto',
      'modal:medium:auto',
      'modal:large:auto',
    ];
    const ids = [...nativeIds, 'daytona:small:us', 'e2b:large:us', 'e2b:medium:byok'];
    try {
      for (const id of ids) {
        const [provider, profile, region] = id.split(':');
        await pool.query(
          "INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,'real')",
          [
            id,
            {
              id,
              provider,
              profile,
              region,
              pricingMode: 'managed',
              ...(id.endsWith(':byok') ? { providerKeyId: 'fixture-provider-key' } : {}),
              capabilities: id.startsWith('daytona:')
                ? ['shared-files']
                : ['persistent-drives', 'shared-files'],
            },
            id !== 'e2b:large:us',
          ],
        );
      }
      expect(await diskOptions(ctx)).toEqual({
        enabled: true,
        mode: 'real',
        eligibleCatalogIds: [...nativeIds].sort(),
      });
      await pool.query('UPDATE broker_catalog SET approved=false WHERE id=$1', [
        'modal:large:auto',
      ]);
      expect((await diskOptions(ctx)).eligibleCatalogIds).not.toContain('modal:large:auto');
      await pool.query(
        "UPDATE broker_catalog SET item=jsonb_set(item,'{capabilities}','[\"shared-files\"]') WHERE id=$1",
        ['e2b:medium:us'],
      );
      expect((await diskOptions(ctx)).eligibleCatalogIds).not.toContain('e2b:medium:us');
      ctx.config.diskQualifiedCatalogIds = [];
      expect((await diskOptions(ctx)).enabled).toBe(false);
    } finally {
      await pool.query('DELETE FROM broker_catalog WHERE id=ANY($1::text[])', [ids]);
      ctx.wick.mode = originalMode;
      ctx.config.diskQualifiedCatalogIds = originalIds;
    }
  });
  it('requires two qualified providers before enabling real creation', async () => {
    const original = ctx.wick.mode;
    ctx.wick.mode = 'real';
    ctx.config.diskQualifiedCatalogIds = ['e2b:small:us'];
    const item = {
      id: 'e2b:small:us',
      provider: 'e2b',
      pricingMode: 'managed',
      approved: true,
      capabilities: ['persistent-drives'],
    };
    await pool.query(
      `INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')`,
      [item.id, item],
    );
    expect((await diskOptions(ctx)).enabled).toBe(false);
    await expect(
      createDisk(ctx, actor, { name: 'Real', operationKey: 'real-disk-attempt' }),
    ).rejects.toThrow('at least two');
    ctx.wick.mode = original;
  });
});
