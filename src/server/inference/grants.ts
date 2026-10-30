import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../shared/types.js';
import { INFERENCE_PROVIDERS } from '../../shared/inference.js';
import { agentScopes } from '../../shared/developer.js';
import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { encodeCursor, pagination, type Row } from '../marketplace/data.js';
import { operationFingerprint, withOperation } from '../operations.js';
import { brokerSecretDigest, keySummary } from '../developer-keys.js';
import { applyCreditEntry } from '../agreements/credits.js';
import {
  activeMode,
  authority,
  catalog,
  clock,
  event,
  failure,
  grantView,
  integer,
  lockedGrant,
  operationSchema,
  orderView,
  packView,
  receiptView,
  runtime,
} from './data.js';
import { closeGrantLocked } from './market.js';

function ownerOnly(actor: Actor) {
  if (actor.role !== 'buyer' || actor.apiKey)
    failure(403, 'owner_required', 'Only the signed-in owner can change agent funding or keys.');
}

const createSchema = z
  .object({
    operationKey: operationSchema,
    name: z.string().trim().min(1).max(100),
    budgetCents: integer(100_000_000),
    maxPurchaseCents: integer(100_000_000).optional(),
    allowedProviders: z.array(z.enum(INFERENCE_PROVIDERS)).min(1).max(2).optional(),
    expiresAt: z.string().datetime().optional(),
    allowInstant: z.boolean().optional(),
  })
  .strict();
export async function createGrant(ctx: AppContext, actor: Actor, raw: unknown) {
  ownerOnly(actor);
  const input = createSchema.parse(raw),
    rt = runtime(ctx);
  return transaction(ctx.pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-grants:${actor.id}`]);
    await authority(db, actor);
    return withOperation(
      db,
      actor,
      'inference.grant.create',
      input.operationKey,
      input,
      async () => {
        const now = await clock(db),
          expires = input.expiresAt
            ? new Date(input.expiresAt)
            : new Date(now.getTime() + 86400000);
        if (
          expires.getTime() < now.getTime() + 60000 ||
          expires.getTime() > now.getTime() + 7 * 86400000
        )
          failure(
            400,
            'invalid_expiry',
            'Grant expiry must be between one minute and seven days away.',
          );
        const count = (
          await db.query(
            `SELECT count(*)::int n FROM (SELECT 1 FROM broker_inference_grants WHERE buyer_id=$1 AND status<>'closed' LIMIT 20) g`,
            [actor.id],
          )
        ).rows[0].n;
        if (count >= 20)
          failure(409, 'grant_limit', 'Close a grant before creating more than 20 active grants.');
        const row = (
          await db.query(
            `INSERT INTO broker_inference_grants(buyer_id,name,source_mode,funded_cents,available_cents,max_purchase_cents,allowed_providers,allow_instant,expires_at)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8) RETURNING *`,
            [
              actor.id,
              input.name,
              rt.mode,
              input.budgetCents,
              input.maxPurchaseCents ?? input.budgetCents,
              JSON.stringify([...new Set(input.allowedProviders ?? INFERENCE_PROVIDERS)]),
              input.allowInstant ?? true,
              expires,
            ],
          )
        ).rows[0];
        await applyCreditEntry(db, actor.id, {
          operationKey: `agent-fund:${row.id}:initial`,
          kind: 'agent_fund',
          grantId: row.id,
          balanceDeltaCents: 0,
          reservedDeltaCents: input.budgetCents,
          description: 'Fund agent grant',
        });
        await event(db, row.id, 'created:initial', 'funded', row.id, actor.id, {
          amountCents: input.budgetCents,
        });
        return grantView(row);
      },
    );
  });
}
export async function fundGrant(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  ownerOnly(actor);
  const input = z
    .object({ amountCents: integer(100_000_000), operationKey: operationSchema })
    .strict()
    .parse(raw);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, id);
    return withOperation(
      db,
      actor,
      `inference.grant.fund:${id}`,
      input.operationKey,
      input,
      async () => {
        if (grant.status !== 'active' || new Date(grant.expires_at) <= (await clock(db)))
          failure(409, 'grant_closed', 'This grant has closed or expired.');
        activeMode(ctx, grant);
        if (Number(grant.funded_cents) + input.amountCents > 100_000_000)
          failure(409, 'grant_limit', 'The grant funding ceiling is $1,000,000.');
        await applyCreditEntry(db, actor.id, {
          operationKey: `agent-fund:${id}:${operationFingerprint(input.operationKey)}`,
          kind: 'agent_fund',
          grantId: id,
          balanceDeltaCents: 0,
          reservedDeltaCents: input.amountCents,
          description: 'Add agent grant funding',
        });
        if (new Date(grant.expires_at) <= (await clock(db)))
          failure(
            409,
            'grant_closed',
            'The grant expired while funding was waiting for wallet credit.',
          );
        const row = (
          await db.query(
            `UPDATE broker_inference_grants SET funded_cents=funded_cents+$2,available_cents=available_cents+$2 WHERE id=$1 RETURNING *`,
            [id, input.amountCents],
          )
        ).rows[0];
        await event(db, id, `fund:${input.operationKey}`, 'funded', id, actor.id, {
          amountCents: input.amountCents,
        });
        return grantView(row);
      },
    );
  });
}
export async function closeGrant(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  ownerOnly(actor);
  const input = z.object({ operationKey: operationSchema }).strict().parse(raw);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor);
    const grant = await lockedGrant(db, actor, id);
    return withOperation(
      db,
      actor,
      `inference.grant.close:${id}`,
      input.operationKey,
      input,
      async () => {
        await closeGrantLocked(db, grant, 'owner_closed');
        await event(db, id, `close:${input.operationKey}`, 'closed', id, actor.id);
        return grantView(
          (await db.query('SELECT * FROM broker_inference_grants WHERE id=$1', [id])).rows[0],
        );
      },
    );
  });
}
export async function issueGrantKey(ctx: AppContext, actor: Actor, grantId: string, raw: unknown) {
  ownerOnly(actor);
  const input = z
    .object({ name: z.string().trim().min(1).max(64).optional() })
    .strict()
    .parse(raw ?? {});
  return transaction(ctx.pool, async (db) => {
    // Owner row first: concurrent issuance and in-flight admission cannot bypass rotation.
    const owner = (await db.query('SELECT role FROM "user" WHERE id=$1 FOR UPDATE', [actor.id]))
      .rows[0];
    if (!owner || owner.role !== 'buyer' || actor.apiKey)
      failure(403, 'owner_required', 'Only the signed-in owner may replace an agent key.');
    await db.query(
      'SELECT id FROM broker_api_keys WHERE user_id=$1 AND grant_id=$2 AND revoked_at IS NULL ORDER BY id FOR UPDATE',
      [actor.id, grantId],
    );
    const grant = await lockedGrant(db, actor, grantId, true);
    activeMode(ctx, grant);
    const active = (
      await db.query(
        `SELECT count(*)::int n FROM (SELECT 1 FROM broker_api_keys WHERE user_id=$1 AND grant_id IS DISTINCT FROM $2 AND revoked_at IS NULL AND expires_at>statement_timestamp() LIMIT 20) k`,
        [actor.id, grantId],
      )
    ).rows[0].n;
    if (active >= 20)
      failure(409, 'key_limit', 'Revoke an existing API key before issuing another.');
    await db.query(
      'UPDATE broker_api_keys SET revoked_at=clock_timestamp() WHERE grant_id=$1 AND revoked_at IS NULL',
      [grantId],
    );
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url'),
      prefix = `wbk_${id}`;
    const row = (
      await db.query(
        `INSERT INTO broker_api_keys(id,user_id,grant_id,name,prefix,secret_digest,scopes,limits,issued_role,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'{}','buyer',$8) RETURNING *`,
        [
          id,
          actor.id,
          grantId,
          input.name ?? grant.name.slice(0, 64),
          prefix,
          brokerSecretDigest(secret),
          JSON.stringify(agentScopes),
          grant.expires_at,
        ],
      )
    ).rows[0];
    await event(db, grantId, `key:${id}`, 'key_replaced', id, actor.id);
    return { key: keySummary(row), token: `${prefix}.${secret}` };
  });
}
export async function listGrants(ctx: AppContext, actor: Actor, query: unknown) {
  const p = pagination(query);
  const rows = (
    await ctx.pool.query(
      `SELECT *,created_at::text cursor_created_at FROM broker_inference_grants WHERE buyer_id=$1
    AND ($2::timestamptz IS NULL OR(created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
      [actor.id, p.cursor, p.cursorId, p.limit + 1],
    )
  ).rows;
  return {
    items: rows.slice(0, p.limit).map(grantView),
    ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
  };
}
export async function grantDetail(ctx: AppContext, actor: Actor, id: string) {
  return transaction(ctx.pool, async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await authority(db, actor, 'inference:read');
    const grant = await lockedGrant(db, actor, id);
    const packs = (
      await db.query(
        'SELECT * FROM broker_token_packs WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
        [id],
      )
    ).rows;
    const requests = (
      await db.query(
        'SELECT * FROM broker_inference_requests WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
        [id],
      )
    ).rows;
    const orders = (
      await db.query(
        `SELECT o.*,p.id pack_id FROM (SELECT * FROM broker_token_orders WHERE grant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25) o
      LEFT JOIN broker_token_packs p ON p.order_id=o.id ORDER BY o.created_at DESC,o.id DESC`,
        [id],
      )
    ).rows;
    return {
      grant: grantView(grant),
      packs: packs.map(packView),
      requests: requests.map(receiptView),
      orders: orders.map(orderView),
      catalog: await catalog(ctx, db),
    };
  });
}
export async function scopedPacks(ctx: AppContext, actor: Actor, query: unknown, provider = false) {
  const p = pagination(query);
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, provider ? 'provider:read' : 'inference:read');
    let key: string;
    if (provider) {
      const row = (await db.query('SELECT id FROM broker_providers WHERE user_id=$1', [actor.id]))
        .rows[0];
      if (!row) failure(403, 'provider_unavailable', 'This provider account is not configured.');
      key = row.id;
    } else {
      if (!actor.apiKey?.grantId)
        failure(403, 'grant_key_required', 'Use a grant-bound agent key.');
      key = actor.apiKey.grantId;
      await lockedGrant(db, actor, key);
    }
    const rows: Row[] = (
      await db.query(
        `SELECT *,created_at::text cursor_created_at FROM broker_token_packs WHERE ${provider ? 'provider_id=$1::uuid' : 'grant_id=$1::uuid'}
      AND ($2::timestamptz IS NULL OR(created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
        [key, p.cursor, p.cursorId, p.limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, p.limit).map(packView),
      ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
    };
  });
}
