import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isMoneyCents } from '../shared/money.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError, type AppContext } from './context.js';
import { transaction } from './marketplace/db.js';
import {
  scopesForRole,
  type BrokerKeyLimits,
  type BrokerKeySummary,
  type BrokerScope,
} from '../shared/developer.js';

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export const brokerSecretDigest = digest;
export function keySummary(row: Record<string, any>): BrokerKeySummary {
  return {
    id: row.id,
    ...(row.grant_id ? { grantId: row.grant_id } : {}),
    ...(row.pack_id ? { packId: row.pack_id } : {}),
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    limits: row.limits,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}
function validateKeyInput(input: unknown, role: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError(400, 'Supply key settings.');
  const b = input as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['name', 'scopes', 'limits', 'expiresInDays'].includes(k)))
    throw new HttpError(400, 'Unsupported key settings.');
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 64)
    throw new HttpError(400, 'Key name must contain 1–64 characters.');
  const allowed = scopesForRole(role);
  if (
    !Array.isArray(b.scopes) ||
    !b.scopes.length ||
    b.scopes.length > allowed.length ||
    b.scopes.some((s) => typeof s !== 'string' || !allowed.includes(s as BrokerScope))
  )
    throw new HttpError(400, 'Select valid permissions for your account.');
  const scopes = [...new Set(b.scopes)] as BrokerScope[];
  if (!scopes.includes('account:read'))
    throw new HttpError(400, 'Account identity permission is required for client discovery.');
  const days = b.expiresInDays ?? 30;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 90)
    throw new HttpError(400, 'Expiry must be 1–90 days.');
  const raw = b.limits ?? {};
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some(
      (k) =>
        !['maxAuctionCents', 'maxAgreementReservationCents', 'maxActivationQuantity'].includes(k),
    )
  )
    throw new HttpError(400, 'Invalid per-operation limits.');
  const limits: BrokerKeyLimits = {};
  for (const [field, max] of [
    ['maxAuctionCents', 100000000],
    ['maxAgreementReservationCents', 100000000],
    ['maxActivationQuantity', 20],
  ] as const) {
    const n = (raw as Record<string, unknown>)[field];
    if (n !== undefined) {
      const monetary = field !== 'maxActivationQuantity';
      if (
        !(monetary ? isMoneyCents(n) : Number.isSafeInteger(n)) ||
        Number(n) < (monetary ? 0.01 : 1) ||
        Number(n) > max
      )
        throw new HttpError(400, `${field} is outside its allowed precision or range.`);
      limits[field] = Number(n);
    }
  }
  for (const [scope, field] of [
    ['orders:write', 'maxAuctionCents'],
    ['agreements:write', 'maxAgreementReservationCents'],
    ['agreements:activate', 'maxActivationQuantity'],
  ] as const)
    if (scopes.includes(scope) && limits[field] === undefined)
      throw new HttpError(400, `Set ${field} before granting ${scope}.`);
  if (role !== 'buyer' && Object.keys(limits).length)
    throw new HttpError(400, 'Buyer operation limits cannot be set on provider keys.');
  return { name: b.name.trim(), scopes, limits, days: Number(days) };
}

export async function registerDeveloperKeys(app: FastifyInstance, ctx: AppContext) {
  async function sessionActor(request: FastifyRequest, mutation = false) {
    if (request.headers.authorization !== undefined)
      throw new HttpError(403, 'Manage Broker API keys from a signed-in browser.');
    if (mutation && request.headers.origin !== new URL(ctx.config.appUrl).origin)
      throw new HttpError(403, 'Key management requires the application origin.');
    const actor = await ctx.requireActor(request, ['buyer', 'provider']);
    if (actor.apiKey) throw new HttpError(403, 'Manage Broker API keys from a signed-in browser.');
    return actor;
  }
  app.get('/api/keys', async (request) => {
    const actor = await sessionActor(request);
    const q = (request.query ?? {}) as Record<string, unknown>;
    const limit = q.limit === undefined ? 25 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, 'Page size must be between 1 and 100.');
    let cursor: [string, string] | undefined;
    if (q.cursor !== undefined) {
      try {
        if (typeof q.cursor !== 'string' || q.cursor.length > 400) throw Error();
        const value = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== 'string' ||
          !Number.isFinite(Date.parse(value[0])) ||
          typeof value[1] !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value[1])
        )
          throw Error();
        cursor = value as [string, string];
      } catch {
        throw new HttpError(400, 'Invalid key cursor.');
      }
    }
    const rows = (
      await ctx.pool.query(
        `SELECT k.id,k.name,k.prefix,k.scopes,k.limits,k.grant_id,k.pack_id,k.created_at,k.created_at::text cursor_created_at,
          LEAST(k.expires_at,parent.expires_at) expires_at,k.last_used_at,COALESCE(k.revoked_at,parent.revoked_at) revoked_at
          FROM broker_api_keys k LEFT JOIN broker_api_keys parent ON parent.id=k.parent_key_id
          WHERE k.user_id=$1 AND ($2::timestamptz IS NULL OR(k.created_at,k.id)<($2,$3::uuid)) ORDER BY k.created_at DESC,k.id DESC LIMIT $4`,
        [actor.id, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit).map(keySummary),
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([rows[limit - 1].cursor_created_at, rows[limit - 1].id]),
            ).toString('base64url'),
          }
        : {}),
    };
  });
  app.post('/api/keys', async (request) => {
    const actor = await sessionActor(request, true),
      input = validateKeyInput(request.body, actor.role);
    return transaction(ctx.pool, async (db) => {
      const owner = (
        await db.query('SELECT id,role,"providerId" FROM "user" WHERE id=$1 FOR UPDATE', [actor.id])
      ).rows[0];
      if (!owner || owner.role !== actor.role)
        throw new HttpError(403, 'Your account permissions changed. Sign in again.');
      let providerId: string | null = null;
      if (owner.role === 'provider') {
        providerId =
          (
            await db.query('SELECT id::text id FROM broker_providers WHERE user_id=$1 FOR SHARE', [
              actor.id,
            ])
          ).rows[0]?.id ?? null;
        if (!providerId || providerId !== owner.providerId)
          throw new HttpError(403, 'Provider access is not configured.');
      }
      const active = Number(
        (
          await db.query(
            'SELECT count(*)::int n FROM broker_api_keys WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>statement_timestamp()',
            [actor.id],
          )
        ).rows[0].n,
      );
      if (active >= 20)
        throw new HttpError(
          409,
          'You already have 20 active keys. Revoke one before creating another.',
        );
      const id = randomUUID(),
        secret = randomBytes(32).toString('base64url'),
        prefix = `wbk_${id}`,
        token = `${prefix}.${secret}`;
      const row = (
        await db.query(
          "INSERT INTO broker_api_keys(id,user_id,name,prefix,secret_digest,scopes,limits,issued_role,issued_provider_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()+($10*interval '1 day')) RETURNING id,name,prefix,scopes,limits,created_at,expires_at,last_used_at,revoked_at",
          [
            id,
            actor.id,
            input.name,
            prefix,
            digest(secret),
            JSON.stringify(input.scopes),
            JSON.stringify(input.limits),
            actor.role,
            providerId,
            input.days,
          ],
        )
      ).rows[0];
      return { key: keySummary(row), token };
    });
  });
  app.delete('/api/keys/:id', async (request) => {
    const actor = await sessionActor(request, true),
      id = (request.params as { id: string }).id;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
      throw new HttpError(404, 'Key not found.');
    return transaction(ctx.pool, async (db) => {
      const owner = (await db.query('SELECT role FROM "user" WHERE id=$1 FOR UPDATE', [actor.id]))
        .rows[0];
      if (owner?.role !== actor.role)
        throw new HttpError(403, 'Your account permissions changed. Sign in again.');
      const prior = (
        await db.query('SELECT * FROM broker_api_keys WHERE id=$1 AND user_id=$2 FOR UPDATE', [
          id,
          actor.id,
        ])
      ).rows[0];
      if (!prior) throw new HttpError(404, 'Key not found.');
      const changed = (
        await db.query(
          `UPDATE broker_api_keys SET revoked_at=clock_timestamp() WHERE user_id=$2
        AND(id=$1 OR parent_key_id=$1) AND revoked_at IS NULL RETURNING *`,
          [id, actor.id],
        )
      ).rows;
      return { key: keySummary(changed.find((r) => r.id === id) ?? prior) };
    });
  });
}
