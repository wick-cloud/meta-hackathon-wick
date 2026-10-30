import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerClientReleases } from '../src/server/client-releases.js';

const versions = ['0.1.0', '0.1.1', '0.2.0'];
const fileNames = (version: string) => [
  `wick-cloud-broker-sdk-${version}.tgz`,
  `wick-cloud-broker-cli-${version}.tgz`,
  `wick-cloud-broker-mcp-${version}.tgz`,
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
async function fixture(version: string) {
  const root = await mkdtemp(join(tmpdir(), 'broker-public-release-'));
  roots.push(root);
  const directory = join(root, version);
  await mkdir(directory);
  const files = await Promise.all(
    fileNames(version).map(async (name, index) => {
      const bytes = Buffer.from(`Approved client fixture ${index}\n`);
      await writeFile(join(directory, name), bytes);
      return { name, sha256: hash(bytes), size: bytes.byteLength };
    }),
  );
  const manifest = { version, files };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'private.txt'), 'PRIVATE_SERVER_DATA');
  await writeFile(join(directory, 'adjacent.txt'), 'PRIVATE_SERVER_DATA');
  const app = Fastify({ logger: false });
  registerClientReleases(app, root);
  apps.push(app);
  await app.ready();
  return { app, root, directory, manifest };
}
describe.each(versions)('Explicit public client release %s downloads', (version) => {
  const names = fileNames(version),
    base = `/downloads/${version}`;
  it('serves the exact three frozen repository tarballs with their published hashes', async () => {
    const root = resolve('client-releases');
    const manifest = JSON.parse(await readFile(join(root, version, 'manifest.json'), 'utf8')) as {
      files: { name: string; sha256: string; size: number }[];
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    registerClientReleases(app, root);
    for (const name of names.slice(0, 3)) {
      const file = manifest.files.find((file) => file.name === name)!;
      const response = await app.inject(`${base}/${name}`);
      expect(response.statusCode).toBe(200);
      expect(hash(response.rawPayload)).toBe(file.sha256);
      expect(response.rawPayload).toEqual(await readFile(join(root, version, name)));
    }
  });
  it('serves only the three manifest-matched client tarballs and approved documentation with digest headers', async () => {
    const { app, manifest } = await fixture(version);
    for (const file of manifest.files) {
      const response = await app.inject(`${base}/${file.name}`);
      expect(response.statusCode).toBe(200);
      expect(hash(response.rawPayload)).toBe(file.sha256);
      expect(response.headers.etag).toBe(`"${file.sha256}"`);
      expect(response.headers['content-length']).toBe(String(file.size));
      expect(response.headers['cache-control']).toContain('immutable');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${file.name}"`);
    }
    const response = await app.inject(`${base}/manifest.json`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(manifest);
    expect(response.headers.etag).toBe(`"${hash(response.rawPayload)}"`);
  });
  it('supports anonymous HEAD and conditional GET without streaming a response body', async () => {
    const { app, manifest } = await fixture(version),
      file = manifest.files[0]!;
    const head = await app.inject({ method: 'HEAD', url: `${base}/${file.name}` });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(file.size));
    const unchanged = await app.inject({
      method: 'GET',
      url: `${base}/${file.name}`,
      headers: { 'if-none-match': `W/"${file.sha256}"` },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');
  });
  it('rejects versions, directories, adjacent files and encoded traversal without disclosing filesystem paths', async () => {
    const { app, root } = await fixture(version);
    for (const path of [
      '/downloads',
      '/downloads/',
      base,
      `${base}/`,
      '/downloads/1.0.0/INSTALL.md',
      '/downloads/latest/INSTALL.md',
      `${base}/adjacent.txt`,
      `${base}/%2e%2e%2fprivate.txt`,
      `${base}/%252e%252e%252fprivate.txt`,
      `${base}/../private.txt`,
      `${base}/a/b`,
    ]) {
      const response = await app.inject(path);
      expect(response.statusCode, path).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
      expect(response.body).not.toContain(root);
      expect(response.body).not.toContain('PRIVATE_SERVER_DATA');
    }
  });
  it('does not publish missing files, altered bytes or symlinks even when their names are approved', async () => {
    const { app, root, directory, manifest } = await fixture(version);
    await rm(join(directory, names[0]!));
    expect((await app.inject(`${base}/${names[0]}`)).statusCode).toBe(404);
    await writeFile(join(directory, names[1]!), Buffer.alloc(manifest.files[1]!.size, 7));
    expect((await app.inject(`${base}/${names[1]}`)).statusCode).toBe(404);
    await rm(join(directory, names[2]!));
    await symlink(join(root, 'private.txt'), join(directory, names[2]!));
    expect((await app.inject(`${base}/${names[2]}`)).statusCode).toBe(404);
  });
  it('rejects artifacts and manifest versions from the other supported release', async () => {
    const { app, directory, manifest } = await fixture(version),
      otherVersion = versions.find((other) => other !== version)!,
      otherNames = fileNames(otherVersion);
    for (const name of otherNames.slice(0, 3)) {
      await writeFile(join(directory, name), 'Unlisted cross-version artifact');
      expect((await app.inject(`${base}/${name}`)).statusCode).toBe(404);
    }
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ ...manifest, version: otherVersion }),
    );
    expect((await app.inject(`${base}/manifest.json`)).statusCode).toBe(404);
    expect((await app.inject(`${base}/INSTALL.md`)).statusCode).toBe(404);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        files: manifest.files.map((file, index) => ({ ...file, name: otherNames[index] })),
      }),
    );
    expect((await app.inject(`${base}/manifest.json`)).statusCode).toBe(404);
    expect((await app.inject(`${base}/INSTALL.md`)).statusCode).toBe(404);
  });
  it('bounds and validates the server-authored manifest and rejects symlinked version directories', async () => {
    const { app, directory, manifest } = await fixture(version);
    await writeFile(join(directory, 'manifest.json'), ' '.repeat(32769));
    expect((await app.inject(`${base}/INSTALL.md`)).statusCode).toBe(404);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        files: [...manifest.files, { name: 'private.txt', sha256: 'a'.repeat(64), size: 1 }],
      }),
    );
    expect((await app.inject(`${base}/manifest.json`)).statusCode).toBe(404);
    await rm(directory, { recursive: true });
    const external = await mkdtemp(join(tmpdir(), 'broker-unapproved-'));
    roots.push(external);
    await writeFile(join(external, 'manifest.json'), JSON.stringify(manifest));
    await symlink(external, directory);
    expect((await app.inject(`${base}/manifest.json`)).statusCode).toBe(404);
  });
  it('can stream a verified client file and close an interrupted HTTP transport without leaking a file handle', async () => {
    const { app, directory, manifest } = await fixture(version);
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    await writeFile(join(directory, names[0]!), bytes);
    manifest.files[0] = { name: names[0]!, sha256: hash(bytes), size: bytes.byteLength };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}${base}/${names[0]}`, (res) => {
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
