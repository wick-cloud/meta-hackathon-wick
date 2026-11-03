import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';

const id = z.string().min(1).max(150);
const attachment = z.object({
  environmentId: id,
  generation: id,
  accessMode: z.enum(['mount', 'files']),
});
const drive = z.object({
  id,
  organizationId: id,
  groupId: id,
  name: z.string().min(1).max(100),
  visibility: z.literal('private'),
  attachmentMode: z.literal('shared'),
  status: z.enum(['creating', 'copying', 'ready', 'failed', 'deleting', 'deleted']),
  initialized: z.boolean(),
  attachments: z.array(attachment).max(100),
  cleanupPending: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const operation = z.object({
  id,
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  cleanupPending: z.boolean().optional(),
});
const result = z.object({ drive, operation });
export type WickDrive = z.infer<typeof drive>;
export type WickDriveResult = z.infer<typeof result>;
export interface WickDrives {
  create(input: { name: string }, key: string): Promise<WickDriveResult>;
  get(id: string): Promise<WickDriveResult>;
  rename(id: string, name: string): Promise<WickDriveResult>;
  delete(id: string, key: string): Promise<WickDriveResult>;
  readFile(id: string, key: string): Promise<{ key: string; contentBase64: string; size: number }>;
  listFiles(
    id: string,
    input?: { prefix?: string; continuationToken?: string },
  ): Promise<{
    data: { key: string; size: number }[];
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  }>;
}
interface DriveConfig {
  wickApiBase: string;
  wickApiKey?: string;
  wickOrganizationId: string;
  wickGroupId: string;
}
/** Native drive endpoints are newer than the published SDK. This boundary is server-only. */
export async function driveRequest(
  config: DriveConfig,
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string,
): Promise<unknown> {
  const base = new URL(config.wickApiBase.replace(/\/$/, '') + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Wick drives require a credential-free HTTPS API base.');
  const url = new URL(path, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    !path.startsWith('v1/')
  )
    throw new Error('Wick drive request is outside the configured API.');
  if (!config.wickApiKey) throw new Error('Wick drives require a service credential.');
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Bearer ${config.wickApiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'x-wick-vocabulary': 'snapshots',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Wick drive outcome requires reconciliation.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Wick drive API rejected the request (HTTP ${response.status}).`);
  }
  const max = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error('Wick drive response exceeds the size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Wick drive response is empty.');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > max) throw new Error('Wick drive response exceeds the size limit.');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Wick drive response is invalid or exceeds the size limit.');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function realDrives(config: DriveConfig): WickDrives {
  function parsed(value: unknown, expected?: string) {
    const data = result.safeParse(value);
    if (
      !data.success ||
      data.data.drive.organizationId !== config.wickOrganizationId ||
      data.data.drive.groupId !== config.wickGroupId ||
      (expected && data.data.drive.id !== expected)
    )
      throw new Error('Wick drive identity or contract could not be verified.');
    return data.data;
  }
  const path = (value: string) => `v1/drives/${encodeURIComponent(id.parse(value))}`;
  return {
    async create(input, key) {
      return parsed(
        await driveRequest(
          config,
          `v1/organizations/${encodeURIComponent(config.wickOrganizationId)}/drives`,
          'POST',
          {
            groupId: config.wickGroupId,
            name: z.string().min(1).max(100).parse(input.name),
            visibility: 'private',
            attachmentMode: 'shared',
            seed: { kind: 'empty' },
          },
          key,
        ),
      );
    },
    async get(value) {
      return parsed(await driveRequest(config, path(value)), value);
    },
    async rename(value, name) {
      return parsed(await driveRequest(config, path(value), 'PATCH', { name }), value);
    },
    async delete(value, key) {
      return parsed(await driveRequest(config, path(value), 'DELETE', undefined, key), value);
    },
    async readFile(value, key) {
      const query = new URLSearchParams({ key: z.string().min(1).max(1024).parse(key) });
      const file = z
        .object({
          key: z.string(),
          contentBase64: z.string().max(1398104),
          size: z.number().int().min(0).max(1048576),
        })
        .parse(await driveRequest(config, `${path(value)}/file?${query}`));
      if (file.key !== key || Buffer.from(file.contentBase64, 'base64').length !== file.size)
        throw new Error('Wick drive file identity is invalid.');
      return file;
    },
    async listFiles(value, input = {}) {
      const query = new URLSearchParams();
      if (input.prefix) query.set('prefix', z.string().max(1024).parse(input.prefix));
      if (input.continuationToken)
        query.set('continuationToken', z.string().max(4096).parse(input.continuationToken));
      return z
        .object({
          data: z.array(z.object({ key: z.string(), size: z.number().min(0) })).max(1000),
          commonPrefixes: z.array(z.string()).max(1000),
          isTruncated: z.boolean(),
          nextContinuationToken: z.string().optional(),
        })
        .parse(await driveRequest(config, `${path(value)}/files?${query}`));
    },
  };
}
export function fixtureDrives(config: DriveConfig, pool: Pool): WickDrives {
  async function get(value: string): Promise<WickDriveResult> {
    const row = (await pool.query('SELECT * FROM broker_fixture_drives WHERE id=$1', [value]))
      .rows[0];
    if (!row) throw new Error('Simulated drive not found.');
    const attachments = (
      await pool.query(
        `SELECT id,input_json FROM broker_fixture_environments WHERE input_json->'workspaceDrive'->>'driveId'=$1 AND status NOT IN('terminated','failed') AND expires_at>clock_timestamp()`,
        [value],
      )
    ).rows;
    return {
      drive: {
        id: row.id,
        organizationId: config.wickOrganizationId,
        groupId: config.wickGroupId,
        name: row.name,
        visibility: 'private',
        attachmentMode: 'shared',
        status: row.status,
        initialized: true,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.created_at.toISOString(),
        attachments: attachments.map((a) => ({
          environmentId: a.id,
          generation: `fixture-${a.id}`,
          accessMode: 'mount',
        })),
      },
      operation: { id: `fixture-drive-op-${row.id}`, status: 'succeeded' },
    };
  }
  return {
    async create(input, key) {
      const row = (
        await pool.query(
          `INSERT INTO broker_fixture_drives(id,create_key,name) VALUES($1,$2,$3) ON CONFLICT(create_key) DO UPDATE SET create_key=excluded.create_key RETURNING *`,
          [`fixture-drive-${randomUUID()}`, key, input.name],
        )
      ).rows[0];
      if (row.name !== input.name) throw new Error('Simulated drive idempotency conflict.');
      return get(row.id);
    },
    get,
    async rename(value, name) {
      await pool.query('UPDATE broker_fixture_drives SET name=$2 WHERE id=$1', [value, name]);
      return get(value);
    },
    async delete(value) {
      const current = await get(value);
      if (current.drive.attachments.length) throw new Error('Simulated drive remains attached.');
      await pool.query("UPDATE broker_fixture_drives SET status='deleted' WHERE id=$1", [value]);
      return get(value);
    },
    async readFile(value, key) {
      await get(value);
      const row = (
        await pool.query('SELECT * FROM broker_fixture_drive_files WHERE drive_id=$1 AND key=$2', [
          value,
          key,
        ])
      ).rows[0];
      if (!row) throw new Error('Simulated drive file not found.');
      return {
        key,
        contentBase64: row.content_base64,
        size: Buffer.from(row.content_base64, 'base64').length,
      };
    },
    async listFiles(value, input = {}) {
      await get(value);
      const rows = (
        await pool.query(
          'SELECT key,content_base64 FROM broker_fixture_drive_files WHERE drive_id=$1 AND left(key,length($2))=$2 ORDER BY key LIMIT 1001',
          [value, input.prefix ?? ''],
        )
      ).rows;
      return {
        data: rows
          .slice(0, 1000)
          .map((r) => ({ key: r.key, size: Buffer.from(r.content_base64, 'base64').length })),
        commonPrefixes: [],
        isTruncated: rows.length > 1000,
      };
    },
  };
}
