import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/shared/types.js';
import type { AppContext } from '../src/server/context.js';
import { migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { createDisk } from '../src/server/disks/service.js';
import { reconcileDisk } from '../src/server/disks/index.js';
import { listDiskFiles, previewDiskFile } from '../src/server/disks/files.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('disk file browsing with disposable PostgreSQL', () => {
  const schema = `diskfiles_${randomUUID().replaceAll('-', '')}`;
  const buyer = {
    id: randomUUID(),
    role: 'buyer',
    name: 'Buyer',
    email: 'buyer@files.invalid',
  } as Actor;
  const other = { ...buyer, id: randomUUID(), email: 'other@files.invalid' };
  let admin: Pool, pool: Pool, ctx: AppContext;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
    for (const actor of [buyer, other])
      await pool.query(
        'INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',
        [actor.id, actor.email, actor.name, actor.role],
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
  async function disk(actor = buyer) {
    const created = await createDisk(ctx, actor, {
      name: 'File browsing',
      operationKey: `files:${randomUUID()}`,
    });
    await reconcileDisk(ctx, created.id);
    const upstreamId = (
      await pool.query('SELECT upstream_id FROM broker_disks WHERE id=$1', [created.id])
    ).rows[0].upstream_id;
    return { id: created.id, upstreamId };
  }
  it('reads a detached disk and isolates both buyer disk identities and file contents', async () => {
    const a = await disk(),
      b = await disk(other);
    for (const [d, content] of [
      [a, 'hello from buyer A'],
      [b, 'private buyer B'],
    ] as const)
      await pool.query(
        'INSERT INTO broker_fixture_drive_files(drive_id,key,content_base64) VALUES($1,$2,$3)',
        [d.upstreamId, 'nested/probe.txt', Buffer.from(content).toString('base64')],
      );
    expect(await listDiskFiles(ctx, buyer, a.id, {})).toEqual({
      prefix: '',
      entries: [{ key: 'nested/', name: 'nested', kind: 'directory' }],
    });
    expect((await previewDiskFile(ctx, buyer, a.id, { key: 'nested/probe.txt' })).content).toBe(
      'hello from buyer A',
    );
    await expect(listDiskFiles(ctx, buyer, b.id, {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      previewDiskFile(ctx, buyer, b.id, { key: 'nested/probe.txt' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      previewDiskFile(ctx, other, a.id, { key: 'nested/probe.txt' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_disk_attachments')).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int n FROM broker_fixture_environments')).rows[0].n,
    ).toBe(0);
  });
  it('paginates a large fixture folder without dropping entries and binds cursors to their prefix', async () => {
    const d = await disk();
    await pool.query(
      "INSERT INTO broker_fixture_drive_files(drive_id,key,content_base64) SELECT $1, 'files/' || lpad(n::text,4,'0') || '.txt','eA==' FROM generate_series(1,1001) n",
      [d.upstreamId],
    );
    const first = await listDiskFiles(ctx, buyer, d.id, { prefix: 'files/' });
    expect(first.entries).toHaveLength(1000);
    expect(first.nextContinuationToken).toBeTruthy();
    const second = await listDiskFiles(ctx, buyer, d.id, {
      prefix: 'files/',
      continuationToken: first.nextContinuationToken,
    });
    expect(second.entries).toHaveLength(1);
    expect(second.nextContinuationToken).toBeUndefined();
    expect(new Set([...first.entries, ...second.entries].map((e) => e.key)).size).toBe(1001);
    await expect(
      listDiskFiles(ctx, buyer, d.id, {
        prefix: 'other/',
        continuationToken: first.nextContinuationToken,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('maps missing and oversized fixture files to bounded preview errors', async () => {
    const d = await disk();
    await expect(previewDiskFile(ctx, buyer, d.id, { key: 'missing.txt' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await pool.query(
      'INSERT INTO broker_fixture_drive_files(drive_id,key,content_base64) VALUES($1,$2,$3)',
      [d.upstreamId, 'too-large.txt', Buffer.alloc(1048577, 'x').toString('base64')],
    );
    await expect(previewDiskFile(ctx, buyer, d.id, { key: 'too-large.txt' })).rejects.toMatchObject(
      { statusCode: 413 },
    );
  });
});
