import { z } from 'zod';
import type { Actor } from '../../shared/types.js';
import type { DiskFileEntry, DiskFilePage, DiskFilePreview } from '../../shared/disks.js';
import { HttpError, type AppContext } from '../context.js';
import { WickDriveHttpError } from '../integrations/drives.js';
import { uuid } from '../marketplace/data.js';
import { requireDisks } from './service.js';

const previewLimit = 64 * 1024;
const fileLimit = 1024 * 1024;
const invalidPath = () =>
  new HttpError(400, 'Use a relative path without dot segments or control characters.');
function canonicalPath(value: string, directory: boolean): string {
  if (
    Buffer.byteLength(value, 'utf8') > 1024 ||
    (!directory && !value) ||
    value.startsWith('/') ||
    /[\p{Cc}\\]/u.test(value) ||
    (directory && value !== '' && !value.endsWith('/')) ||
    value
      .split('/')
      .some(
        (part, index, parts) =>
          part === '.' || part === '..' || (!part && !(directory && index === parts.length - 1)),
      )
  )
    throw invalidPath();
  return value;
}
const cursor = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}]/u.test(value));
const listingQuery = z
  .object({ prefix: z.string().default(''), continuationToken: cursor.optional() })
  .strict();
const previewQuery = z.object({ key: z.string() }).strict();

async function readableDisk(ctx: AppContext, actor: Actor, id: string) {
  if (actor.role !== 'buyer') throw new HttpError(403, 'Buyer access is required.');
  requireDisks(ctx);
  const row = (
    await ctx.pool.query(
      'SELECT upstream_id,source_mode,status,cleanup_pending FROM broker_disks WHERE id=$1 AND buyer_id=$2',
      [uuid(id), actor.id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Disk not found.');
  if (
    row.source_mode !== ctx.wick.mode ||
    row.status !== 'ready' ||
    !row.upstream_id ||
    row.cleanup_pending
  )
    throw new HttpError(409, 'This disk is not ready to browse.');
  let observed;
  try {
    observed = await ctx.wick.drives!.get(row.upstream_id);
  } catch (error) {
    storageError(error);
  }
  if (
    observed.drive.id !== row.upstream_id ||
    observed.drive.organizationId !== ctx.config.wickOrganizationId ||
    observed.drive.groupId !== ctx.config.wickGroupId
  )
    unconfirmed();
  if (
    observed.drive.status !== 'ready' ||
    observed.drive.cleanupPending ||
    observed.operation.cleanupPending
  )
    throw new HttpError(409, 'This disk is not ready to browse.');
  if (!observed.drive.initialized)
    throw new HttpError(409, 'Files will be available after this disk is first used by a VM.');
  return row.upstream_id as string;
}
function storageError(error: unknown): never {
  if (error instanceof WickDriveHttpError) {
    if (error.statusCode === 400)
      throw new HttpError(400, 'This folder cursor is invalid. Refresh the folder and try again.');
    if (error.statusCode === 404)
      throw new HttpError(404, 'This file is unavailable. Refresh the folder and try again.');
    if (error.statusCode === 413)
      throw new HttpError(413, 'File previews support files up to 1 MiB.');
  }
  throw new HttpError(502, 'Disk files are unavailable. Please refresh and try again.');
}
function unconfirmed(): never {
  throw new HttpError(502, 'Disk files could not be verified. Please refresh and try again.');
}

/** Reads storage directly, so a running VM is never required to inspect a disk. */
export async function listDiskFiles(
  ctx: AppContext,
  actor: Actor,
  id: string,
  query: unknown,
): Promise<DiskFilePage> {
  const input = listingQuery.parse(query ?? {});
  const prefix = canonicalPath(input.prefix, true);
  const upstreamId = await readableDisk(ctx, actor, id);
  let page;
  try {
    page = await ctx.wick.drives!.listFiles(upstreamId, input);
  } catch (error) {
    storageError(error);
  }
  const entries = new Map<string, DiskFileEntry>();
  function add(value: string, directory: boolean, size?: number) {
    try {
      canonicalPath(value, directory);
    } catch {
      unconfirmed();
    }
    if (!value.startsWith(prefix)) unconfirmed();
    const relative = value.slice(prefix.length);
    if (!relative) return; // Native folder markers are not children of themselves.
    const slash = relative.indexOf('/');
    if (slash !== -1) {
      const name = relative.slice(0, slash);
      const key = prefix + name + '/';
      entries.set(key, { key, name, kind: 'directory' });
    } else {
      if (directory || !Number.isSafeInteger(size) || size! < 0) unconfirmed();
      entries.set(value, { key: value, name: relative, kind: 'file', size });
    }
  }
  if (page.data.length > 1000 || page.commonPrefixes.length > 1000) unconfirmed();
  for (const item of page.data) add(item.key, item.key.endsWith('/'), item.size);
  for (const folder of page.commonPrefixes) add(folder, true);
  if (
    page.isTruncated &&
    (!page.nextContinuationToken ||
      !cursor.safeParse(page.nextContinuationToken).success ||
      page.nextContinuationToken === input.continuationToken)
  )
    unconfirmed();
  return {
    prefix,
    entries: [...entries.values()].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
    ),
    ...(page.isTruncated ? { nextContinuationToken: page.nextContinuationToken } : {}),
  };
}

export async function previewDiskFile(
  ctx: AppContext,
  actor: Actor,
  id: string,
  query: unknown,
): Promise<DiskFilePreview> {
  const { key: rawKey } = previewQuery.parse(query);
  const key = canonicalPath(rawKey, false);
  const upstreamId = await readableDisk(ctx, actor, id);
  let file;
  try {
    file = await ctx.wick.drives!.readFile(upstreamId, key);
  } catch (error) {
    storageError(error);
  }
  if (file.key !== key || !Number.isSafeInteger(file.size) || file.size < 0) unconfirmed();
  if (file.size > fileLimit) throw new HttpError(413, 'File previews support files up to 1 MiB.');
  if (file.contentBase64.length > Math.ceil(fileLimit / 3) * 4) unconfirmed();
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (bytes.length !== file.size || bytes.toString('base64') !== file.contentBase64) unconfirmed();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { key, size: bytes.length, content: null, truncated: false, binary: true };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    return { key, size: bytes.length, content: null, truncated: false, binary: true };
  const truncated = bytes.length > previewLimit;
  const content = truncated
    ? new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, previewLimit), {
        stream: true,
      })
    : text;
  return { key, size: bytes.length, content, truncated, binary: false };
}
