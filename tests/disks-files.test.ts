import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/server/context.js';
import type { Actor } from '../src/shared/types.js';
import { publicRoute } from '../src/shared/developer.js';
import { registerDisks } from '../src/server/disks/index.js';
import { listDiskFiles, previewDiskFile } from '../src/server/disks/files.js';
import { WickDriveHttpError } from '../src/server/integrations/drives.js';

const diskId = '11111111-1111-4111-8111-111111111111';
const actor: Actor = { id: 'buyer-a', email: 'buyer@disk.invalid', name: 'Buyer', role: 'buyer' };
function fixture() {
  const row = {
    upstream_id: 'private-drive',
    source_mode: 'real',
    status: 'ready',
    cleanup_pending: false,
  };
  const drive = {
    id: row.upstream_id,
    organizationId: 'org',
    groupId: 'group',
    status: 'ready',
    initialized: true,
    cleanupPending: false,
  };
  const get = vi.fn(async () => ({ drive, operation: { cleanupPending: false } }));
  const listFiles = vi.fn(async (_id: string, _input?: unknown) => ({
    data: [] as { key: string; size: number }[],
    commonPrefixes: [] as string[],
    isTruncated: false,
    nextContinuationToken: undefined as string | undefined,
  }));
  const readFile = vi.fn(async (_id: string, key: string) => ({
    key,
    contentBase64: Buffer.from('hello\n').toString('base64'),
    size: 6,
  }));
  const ctx = {
    config: { disksEnabled: true, wickOrganizationId: 'org', wickGroupId: 'group' },
    pool: {
      query: vi.fn(async (_sql: string, values: unknown[]) => ({
        rows: values[0] === diskId && values[1] === actor.id ? [row] : [],
      })),
    },
    wick: { mode: 'real', drives: { get, listFiles, readFile } },
    requireActor: vi.fn(async () => actor),
  } as unknown as AppContext;
  return { ctx, row, drive, get, listFiles, readFile };
}
describe('disk file browsing', () => {
  it('lists immediate folders and files, omits markers, deduplicates and forwards pagination', async () => {
    const f = fixture();
    f.listFiles.mockResolvedValue({
      data: [
        { key: 'qa/', size: 0 },
        { key: 'qa/deep/a.txt', size: 1 },
        { key: 'qa/deep/b.txt', size: 2 },
        { key: 'qa/empty.txt', size: 0 },
        { key: 'qa/z.txt', size: 9 },
      ],
      commonPrefixes: ['qa/deep/', 'qa/alpha/'],
      isTruncated: true,
      nextContinuationToken: 'next+page/=',
    });
    const page = await listDiskFiles(f.ctx, actor, diskId, {
      prefix: 'qa/',
      continuationToken: 'previous',
    });
    expect(page).toEqual({
      prefix: 'qa/',
      entries: [
        { key: 'qa/alpha/', name: 'alpha', kind: 'directory' },
        { key: 'qa/deep/', name: 'deep', kind: 'directory' },
        { key: 'qa/empty.txt', name: 'empty.txt', kind: 'file', size: 0 },
        { key: 'qa/z.txt', name: 'z.txt', kind: 'file', size: 9 },
      ],
      nextContinuationToken: 'next+page/=',
    });
    expect(f.listFiles).toHaveBeenCalledWith('private-drive', {
      prefix: 'qa/',
      continuationToken: 'previous',
    });
    expect(JSON.stringify(page)).not.toContain('private-drive');
  });
  it('supports empty disks and empty UTF-8 files without a VM', async () => {
    const f = fixture();
    expect(await listDiskFiles(f.ctx, actor, diskId, {})).toEqual({ prefix: '', entries: [] });
    f.readFile.mockResolvedValue({ key: 'empty', contentBase64: '', size: 0 });
    expect(await previewDiskFile(f.ctx, actor, diskId, { key: 'empty' })).toEqual({
      key: 'empty',
      size: 0,
      content: '',
      truncated: false,
      binary: false,
    });
  });
  it('returns source text verbatim for the UI to escape', async () => {
    const f = fixture(),
      text = '<script>window.pwned=true</script>\nhello ☃';
    f.readFile.mockResolvedValue({
      key: 'a & b.html',
      contentBase64: Buffer.from(text).toString('base64'),
      size: Buffer.byteLength(text),
    });
    expect(await previewDiskFile(f.ctx, actor, diskId, { key: 'a & b.html' })).toEqual({
      key: 'a & b.html',
      size: Buffer.byteLength(text),
      content: text,
      truncated: false,
      binary: false,
    });
  });
  it('limits previews to 64 KiB without splitting a UTF-8 character', async () => {
    const f = fixture(),
      text = 'a'.repeat(65535) + '☃' + 'tail';
    f.readFile.mockResolvedValue({
      key: 'large.txt',
      contentBase64: Buffer.from(text).toString('base64'),
      size: Buffer.byteLength(text),
    });
    const preview = await previewDiskFile(f.ctx, actor, diskId, { key: 'large.txt' });
    expect(preview.content).toBe('a'.repeat(65535));
    expect(preview.truncated).toBe(true);
    expect(preview.binary).toBe(false);
    expect(preview.size).toBe(Buffer.byteLength(text));
  });
  it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe, 0xfd])])(
    'shows metadata instead of binary bytes',
    async (bytes) => {
      const f = fixture();
      f.readFile.mockResolvedValue({
        key: 'image.bin',
        contentBase64: bytes.toString('base64'),
        size: bytes.length,
      });
      expect(await previewDiskFile(f.ctx, actor, diskId, { key: 'image.bin' })).toEqual({
        key: 'image.bin',
        size: bytes.length,
        content: null,
        truncated: false,
        binary: true,
      });
    },
  );
  it.each([
    '../secret',
    '/etc/passwd',
    'a/../secret',
    'a//secret',
    'a/./secret',
    'a\\secret',
    'a\u0000secret',
    'a\u0085secret',
    'é'.repeat(513),
    'folder/',
  ])('rejects unsafe file path %j before storage access', async (key) => {
    const f = fixture();
    await expect(previewDiskFile(f.ctx, actor, diskId, { key })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it.each(['..', '../', '/folder/', 'folder', 'a//', 'a/./', 'a\\b/', 'é'.repeat(512) + '/'])(
    'rejects unsafe folder prefix %j',
    async (prefix) => {
      const f = fixture();
      await expect(listDiskFiles(f.ctx, actor, diskId, { prefix })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(f.listFiles).not.toHaveBeenCalled();
    },
  );
  it.each([
    { continuationToken: 'bad\n' },
    { continuationToken: 'a'.repeat(4097) },
    { continuationToken: '' },
    { unknown: 'value' },
  ])('rejects malformed listing queries', async (query) => {
    const f = fixture();
    await expect(listDiskFiles(f.ctx, actor, diskId, query)).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
  });
  it('does not call storage for another buyer or nonbuyer', async () => {
    const f = fixture();
    const other = { ...actor, id: 'buyer-b' };
    await expect(listDiskFiles(f.ctx, other, diskId, {})).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(previewDiskFile(f.ctx, other, diskId, { key: 'secret' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      listDiskFiles(f.ctx, { ...actor, role: 'provider' }, diskId, {}),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.listFiles).not.toHaveBeenCalled();
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it.each([
    { source_mode: 'fixture' },
    { status: 'deleted' },
    { status: 'deleting' },
    { status: 'creating' },
    { cleanup_pending: true },
    { upstream_id: null },
  ])('requires an available disk in the active integration mode', async (override) => {
    const f = fixture();
    Object.assign(f.row, override);
    await expect(listDiskFiles(f.ctx, actor, diskId, {})).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(f.get).not.toHaveBeenCalled();
  });
  it('requires the native identity to remain in the configured tenant', async () => {
    const f = fixture();
    f.drive.groupId = 'another-tenant';
    await expect(listDiskFiles(f.ctx, actor, diskId, {})).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it('explains an unused native disk without pretending that its files are empty', async () => {
    const f = fixture();
    f.drive.initialized = false;
    await expect(listDiskFiles(f.ctx, actor, diskId, {})).rejects.toMatchObject({
      statusCode: 409,
      message: 'Files will be available after this disk is first used by a VM.',
    });
    expect(f.listFiles).not.toHaveBeenCalled();
  });
  it.each([
    { data: [{ key: 'elsewhere/a', size: 1 }], commonPrefixes: [], isTruncated: false },
    { data: [], commonPrefixes: ['qa/../outside/'], isTruncated: false },
    { data: [{ key: 'qa/a', size: -1 }], commonPrefixes: [], isTruncated: false },
    { data: [], commonPrefixes: [], isTruncated: true },
    { data: [], commonPrefixes: [], isTruncated: true, nextContinuationToken: 'same' },
  ])('rejects unconfirmed native listing contracts', async (page) => {
    const f = fixture();
    f.listFiles.mockResolvedValue(page as Awaited<ReturnType<typeof f.listFiles>>);
    await expect(
      listDiskFiles(f.ctx, actor, diskId, { prefix: 'qa/', continuationToken: 'same' }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
  it.each([
    { key: 'other', size: 1, contentBase64: 'YQ==' },
    { key: 'a', size: 2, contentBase64: 'YQ==' },
    { key: 'a', size: 1, contentBase64: 'YQ' },
  ])('rejects changed file identity or encoding', async (file) => {
    const f = fixture();
    f.readFile.mockResolvedValue(file);
    await expect(previewDiskFile(f.ctx, actor, diskId, { key: 'a' })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
  it('maps bounded upstream status without exposing upstream bodies', async () => {
    const f = fixture();
    f.readFile.mockRejectedValueOnce(new WickDriveHttpError(413));
    await expect(previewDiskFile(f.ctx, actor, diskId, { key: 'large' })).rejects.toMatchObject({
      statusCode: 413,
      message: 'File previews support files up to 1 MiB.',
    });
    f.readFile.mockRejectedValueOnce(new WickDriveHttpError(404));
    await expect(previewDiskFile(f.ctx, actor, diskId, { key: 'gone' })).rejects.toMatchObject({
      statusCode: 404,
    });
    f.readFile.mockRejectedValueOnce(new Error('service-key private-drive secret'));
    await expect(previewDiskFile(f.ctx, actor, diskId, { key: 'a' })).rejects.toMatchObject({
      statusCode: 502,
      message: 'Disk files are unavailable. Please refresh and try again.',
    });
  });
  it('requires disks:read and returns noncacheable JSON from both routes', async () => {
    const f = fixture(),
      app = Fastify();
    await registerDisks(app, f.ctx);
    try {
      for (const path of ['files', 'file?key=hello']) {
        const response = await app.inject({ url: `/api/disks/${diskId}/${path}` });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
      }
      expect(f.ctx.requireActor).toHaveBeenCalledWith(expect.anything(), ['buyer']);
      expect(publicRoute('GET', '/api/disks/:id/files')?.scope).toBe('disks:read');
      expect(publicRoute('GET', '/api/disks/:id/file')?.scope).toBe('disks:read');
    } finally {
      await app.close();
    }
  });
});
