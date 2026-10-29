import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from '../shared/types.js';
import type { BrokerKeyAuthority, BrokerKeyLimits } from '../shared/developer.js';
import { HttpError } from './context.js';

/** Canonicalize object keys without changing array order or adding defaults. */
export function operationFingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, normalize(x)]),
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}

export function clientOperationKey(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !/^[-A-Za-z0-9_:./]{8,160}$/.test(value))
    throw new HttpError(400, 'Use a stable operationKey of 8–160 safe characters.');
  return value;
}

export function enforceKeyLimit(
  authority: BrokerKeyAuthority | undefined,
  limit: keyof BrokerKeyLimits,
  amount: number,
): void {
  if (!authority) return;
  const ceiling = authority.limits[limit];
  if (ceiling === undefined || amount > ceiling)
    throw new HttpError(403, `This operation exceeds the Broker API key's ${limit} limit.`);
}

export async function recordKeyAction(
  db: PoolClient,
  actor: Pick<Actor, 'id' | 'apiKey'>,
  operation: string,
  operationKey: string,
  resourceId?: string,
): Promise<void> {
  if (!actor.apiKey) return;
  await db.query(
    `INSERT INTO broker_key_actions(owner_id,api_key_id,operation,operation_key,resource_id)
     VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,operation,operation_key) DO NOTHING`,
    [actor.id, actor.apiKey.id, operation, operationKey, resourceId ?? null],
  );
}

/** Called inside the owner's existing transaction, before any resource lock or mutation. */
export async function withOperation<T>(
  db: PoolClient,
  actor: Pick<Actor, 'id' | 'apiKey'>,
  operation: string,
  key: string | undefined,
  input: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  clientOperationKey(key, Boolean(actor.apiKey));
  if (!key) return perform();
  const digest = operationFingerprint(input);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
    `broker-operation:${actor.id}`,
    `${operation}:${key}`,
  ]);
  const prior = (
    await db.query(
      'SELECT input_fingerprint,response FROM broker_operation_receipts WHERE owner_id=$1 AND operation=$2 AND operation_key=$3',
      [actor.id, operation, key],
    )
  ).rows[0];
  if (prior) {
    if (prior.input_fingerprint !== digest)
      throw new HttpError(409, 'This operation key was already used with a different request.');
    return prior.response as T;
  }
  const response = await perform();
  await db.query(
    'INSERT INTO broker_operation_receipts(owner_id,operation,operation_key,input_fingerprint,response) VALUES($1,$2,$3,$4,$5)',
    [actor.id, operation, key, digest, response ?? null],
  );
  const r = response as Record<string, unknown> | undefined;
  if (response !== false)
    await recordKeyAction(
      db,
      actor,
      operation,
      key,
      typeof r?.id === 'string' ? r.id : typeof r?.requestId === 'string' ? r.requestId : undefined,
    );
  return response;
}
