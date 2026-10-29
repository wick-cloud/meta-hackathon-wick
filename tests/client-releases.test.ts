import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerClientReleases } from '../src/server/client-releases.js';

const names = [
  'wick-cloud-broker-sdk-0.1.0.tgz',
  'wick-cloud-broker-cli-0.1.0.tgz',
  'wick-cloud-broker-mcp-0.1.0.tgz',
  'SHA256SUMS',
  'INSTALL.md',
];
const roots: string[] = [],
  apps: FastifyInstance[] = [];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'broker-public-release-'));
  roots.push(root);
  const directory = join(root, '0.1.0');
  await mkdir(directory);
  const files = await Promise.all(
    names.map(async (name, index) => {
      const bytes = Buffer.from(`Approved client fixture ${index}\n`);
      await writeFile(join(directory, name), bytes);
      return { name, sha256: hash(bytes), size: bytes.byteLength };
    }),
  );
  const manifest = { version: '0.1.0', files };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'private.txt'), 'PRIVATE_SERVER_DATA');
  await writeFile(join(directory, 'adjacent.txt'), 'PRIVATE_SERVER_DATA');
  const app = Fastify({ logger: false });
  registerClientReleases(app, root);
  apps.push(app);
  await app.ready();
  return { app, root, directory, manifest };
}
describe('Explicit public client release downloads', () => {
  it('serves the exact three frozen repository tarballs with their published hashes', async () => {
    const root = resolve('client-releases');
    const manifest = JSON.parse(await readFile(join(root, '0.1.0', 'manifest.json'), 'utf8')) as {
      files: { name: string; sha256: string; size: number }[];
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    registerClientReleases(app, root);
    for (const name of names.slice(0, 3)) {
      const file = manifest.files.find((file) => file.name === name)!;
      const response = await app.inject(`/downloads/0.1.0/${name}`);
      expect(response.statusCode).toBe(200);
      expect(hash(response.rawPayload)).toBe(file.sha256);
      expect(response.rawPayload).toEqual(await readFile(join(root, '0.1.0', name)));
    }
  });
  it('serves only the three manifest-matched client tarballs and approved documentation with digest headers', async () => {
    const { app, manifest } = await fixture();
    for (const file of manifest.files) {
      const response = await app.inject(`/downloads/0.1.0/${file.name}`);
      expect(response.statusCode).toBe(200);
      expect(hash(response.rawPayload)).toBe(file.sha256);
      expect(response.headers.etag).toBe(`"${file.sha256}"`);
      expect(response.headers['content-length']).toBe(String(file.size));
      expect(response.headers['cache-control']).toContain('immutable');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${file.name}"`);
    }
    const response = await app.inject('/downloads/0.1.0/manifest.json');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(manifest);
    expect(response.headers.etag).toBe(`"${hash(response.rawPayload)}"`);
  });
  it('supports anonymous HEAD and conditional GET without streaming a response body', async () => {
    const { app, manifest } = await fixture(),
      file = manifest.files[0]!;
    const head = await app.inject({ method: 'HEAD', url: `/downloads/0.1.0/${file.name}` });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(file.size));
    const unchanged = await app.inject({
      method: 'GET',
      url: `/downloads/0.1.0/${file.name}`,
      headers: { 'if-none-match': `W/"${file.sha256}"` },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
  });
  it('rejects versions, directories, adjacent files and encoded traversal without disclosing filesystem paths', async () => {
    const { app, root } = await fixture();
    for (const path of [
      '/downloads',
      '/downloads/',
      '/downloads/0.1.0',
      '/downloads/0.1.0/',
      '/downloads/1.0.0/INSTALL.md',
      '/downloads/latest/INSTALL.md',
      '/downloads/0.1.0/adjacent.txt',
      '/downloads/0.1.0/%2e%2e%2fprivate.txt',
      '/downloads/0.1.0/%252e%252e%252fprivate.txt',
      '/downloads/0.1.0/../private.txt',
      '/downloads/0.1.0/a/b',
    ]) {
      const response = await app.inject(path);
      expect(response.statusCode, path).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain('PRIVATE_SERVER_DATA');
    }
  });
  it('does not publish missing files, altered bytes or symlinks even when their names are approved', async () => {
    const { app, root, directory } = await fixture();
    await rm(join(directory, names[0]!));
    expect((await app.inject(`/downloads/0.1.0/${names[0]}`)).statusCode).toBe(404);
    await writeFile(join(directory, names[1]!), 'Changed approved artifact');
    expect((await app.inject(`/downloads/0.1.0/${names[1]}`)).statusCode).toBe(404);
    await rm(join(directory, names[2]!));
    await symlink(join(root, 'private.txt'), join(directory, names[2]!));
    expect((await app.inject(`/downloads/0.1.0/${names[2]}`)).statusCode).toBe(404);
  });
  it('bounds and validates the server-authored manifest and rejects symlinked version directories', async () => {
    const { app, root, directory, manifest } = await fixture();
    await writeFile(join(directory, 'manifest.json'), ' '.repeat(32769));
    expect((await app.inject('/downloads/0.1.0/INSTALL.md')).statusCode).toBe(404);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        files: [...manifest.files, { name: 'private.txt', sha256: 'a'.repeat(64), size: 1 }],
      }),
    );
    expect((await app.inject('/downloads/0.1.0/manifest.json')).statusCode).toBe(404);
    await rm(directory, { recursive: true });
    const external = await mkdtemp(join(tmpdir(), 'broker-unapproved-'));
    roots.push(external);
    await writeFile(join(external, 'manifest.json'), JSON.stringify(manifest));
    await symlink(external, directory);
    expect((await app.inject('/downloads/0.1.0/manifest.json')).statusCode).toBe(404);
  });
  it('can stream a verified client file and close an interrupted HTTP transport without leaking a file handle', async () => {
    const { app, directory, manifest } = await fixture();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    await writeFile(join(directory, names[0]!), bytes);
    manifest.files[0] = { name: names[0]!, sha256: hash(bytes), size: bytes.byteLength };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/downloads/0.1.0/${names[0]}`, (res) => {
        res.once('data', () => {
          res.destroy();
          req.destroy();
          resolve();
        });
        res.once('error', () => {});
      });
      req.once('error', reject);
      req.end();
    });
    await app.close();
    expect(app.server.listening).toBe(false);
  });
});
