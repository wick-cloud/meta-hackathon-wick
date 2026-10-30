import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const VERSIONS = ['0.1.0', '0.1.1', '0.2.0'] as const;
type ReleaseVersion = (typeof VERSIONS)[number];
const MAX_MANIFEST_BYTES = 32768;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
function isReleaseVersion(version: string): version is ReleaseVersion {
  return (VERSIONS as readonly string[]).includes(version);
}
function fileNames(version: ReleaseVersion) {
  return [
    `wick-cloud-broker-sdk-${version}.tgz`,
    `wick-cloud-broker-cli-${version}.tgz`,
    `wick-cloud-broker-mcp-${version}.tgz`,
    'SHA256SUMS',
    'INSTALL.md',
  ];
}
interface ReleaseFile {
  name: string;
  sha256: string;
  size: number;
}
interface ReleaseManifest {
  version: ReleaseVersion;
  files: ReleaseFile[];
}
async function close(handle: FileHandle | undefined) {
  await handle?.close().catch(() => {});
}
async function manifestAt(
  root: string,
  version: ReleaseVersion,
): Promise<{ directory: string; manifest: ReleaseManifest; bytes: Buffer }> {
  const realRoot = await realpath(root),
    directory = join(realRoot, version),
    names = fileNames(version);
  if ((await realpath(directory)) !== directory) throw Error('Unlisted release.');
  const handle = await open(
    join(directory, 'manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES)
      throw Error('Invalid manifest.');
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1),
      read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > MAX_MANIFEST_BYTES || read.bytesRead !== stat.size)
      throw Error('Invalid manifest.');
    const bytes = buffer.subarray(0, read.bytesRead),
      value = JSON.parse(bytes.toString('utf8')) as Partial<ReleaseManifest>;
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).some((k) => !['version', 'files'].includes(k)) ||
      value.version !== version ||
      !Array.isArray(value.files) ||
      value.files.length !== names.length
    )
      throw Error('Invalid manifest.');
    const seen = new Set<string>();
    for (const file of value.files) {
      if (
        !file ||
        typeof file !== 'object' ||
        Object.keys(file).some((k) => !['name', 'sha256', 'size'].includes(k)) ||
        !names.includes(file.name) ||
        seen.has(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > MAX_FILE_BYTES ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw Error('Invalid manifest.');
      seen.add(file.name);
    }
    return { directory, manifest: value as ReleaseManifest, bytes };
  } finally {
    await close(handle);
  }
}
async function verifiedFile(directory: string, file: ReleaseFile): Promise<FileHandle> {
  const handle = await open(join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) throw Error('Unlisted release file.');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let position = 0;
    while (position < file.size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - position),
        position,
      );
      if (!result.bytesRead) throw Error('Incomplete release file.');
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    if (hash.digest('hex') !== file.sha256) throw Error('Release digest mismatch.');
    return handle;
  } catch (error) {
    await close(handle);
    throw error;
  }
}
function headers(reply: FastifyReply, name: string, size: number, digest: string) {
  reply
    .header(
      'Content-Type',
      name.endsWith('.tgz')
        ? 'application/gzip'
        : name === 'manifest.json'
          ? 'application/json; charset=utf-8'
          : name === 'INSTALL.md'
            ? 'text/markdown; charset=utf-8'
            : 'text/plain; charset=utf-8',
    )
    .header('Content-Disposition', `attachment; filename="${name}"`)
    .header('Content-Length', String(size))
    .header('Cache-Control', 'public, max-age=31536000, immutable')
    .header('ETag', `"${digest}"`)
    .header('X-Content-Type-Options', 'nosniff');
}
function unchanged(request: FastifyRequest, digest: string) {
  const supplied = request.headers['if-none-match'];
  return (
    typeof supplied === 'string' &&
    supplied
      .split(',')
      .some((value) => ['*', `"${digest}"`, `W/"${digest}"`].includes(value.trim()))
  );
}
function missing(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .removeHeader('Content-Length')
    .removeHeader('Content-Disposition')
    .removeHeader('ETag')
    .type('application/json')
    .code(404)
    .header('Cache-Control', 'no-store')
    .send({ error: 'Client release not found.', code: 'not_found', requestId: request.id });
}
/** Publish only the immutable client artifacts. Repository files and directories are never exposed. */
export function registerClientReleases(app: FastifyInstance, root = resolve('client-releases')) {
  app.get<{ Params: { version: string; file: string } }>(
    '/downloads/:version/:file',
    async (request, reply) => {
      const { version, file: name } = request.params;
      if (
        !/^\d+\.\d+\.\d+$/.test(version) ||
        !isReleaseVersion(version) ||
        ![...fileNames(version), 'manifest.json'].includes(name)
      )
        return missing(request, reply);
      let handle: FileHandle | undefined;
      try {
        const release = await manifestAt(root, version);
        if (name === 'manifest.json') {
          const digest = createHash('sha256').update(release.bytes).digest('hex');
          headers(reply, name, release.bytes.byteLength, digest);
          if (unchanged(request, digest)) return reply.code(304).send();
          return reply.send(release.bytes);
        }
        const file = release.manifest.files.find((file) => file.name === name);
        if (!file) return missing(request, reply);
        handle = await verifiedFile(release.directory, file);
        headers(reply, name, file.size, file.sha256);
        if (unchanged(request, file.sha256)) {
          await close(handle);
          return reply.code(304).send();
        }
        const stream = handle.createReadStream({ start: 0, end: file.size - 1, autoClose: true });
        handle = undefined;
        const abort = () => stream.destroy();
        reply.raw.once('close', abort);
        stream.once('close', () => reply.raw.off('close', abort));
        return reply.send(stream);
      } catch {
        await close(handle);
        return missing(request, reply);
      }
    },
  );
  app.get('/downloads', missing);
  app.get('/downloads/*', missing);
}
