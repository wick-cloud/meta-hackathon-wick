import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../shared/types.js';
import { packScopes } from '../../shared/developer.js';
import { INFERENCE_MODEL_ID } from '../../shared/inference.js';
import type { AppContext } from '../context.js';
import { brokerSecretDigest, keySummary } from '../developer-keys.js';
import { transaction } from '../marketplace/db.js';
import { operationFingerprint } from '../operations.js';
import {
  activeMode,
  authority,
  clock,
  event,
  failure,
  lockedGrant,
  operationSchema,
  packView,
  PACK_VIEW_COLUMNS,
} from './data.js';

export async function tokenPack(ctx: AppContext, actor: Actor, id: string) {
  if (actor.apiKey && !actor.apiKey.grantId)
    failure(403, 'grant_key_required', 'Use a grant-bound agent key.');
  return transaction(ctx.pool, async (db) => {
    await authority(db, actor, 'inference:read');
    const row = (
      await db.query(
        `SELECT ${PACK_VIEW_COLUMNS} FROM broker_token_packs WHERE id=$1 AND buyer_id=$2
      AND($3::uuid IS NULL OR grant_id=$3) AND($4::uuid IS NULL OR id=$4)`,
        [id, actor.id, actor.apiKey?.grantId ?? null, actor.apiKey?.packId ?? null],
      )
    ).rows[0];
    if (!row) failure(404, 'not_found', 'Token batch not found.');
    return packView(row);
  });
}

/** Keys only delegate already-purchased quota; no wallet or token quantities change. */
export async function issuePackKey(ctx: AppContext, actor: Actor, id: string, raw: unknown) {
  if (actor.role !== 'buyer' || (actor.apiKey && (!actor.apiKey.grantId || actor.apiKey.packId)))
    failure(403, 'pack_key_issuer', 'Use the owner session or the agent’s purchasing key.');
  const input = z
    .object({ operationKey: operationSchema, name: z.string().trim().min(1).max(64).optional() })
    .strict()
    .parse(raw);
  return transaction(ctx.pool, async (db) => {
    // Same owner → keys → grant order as ordinary key management and rotation.
    const owner = (await db.query('SELECT role FROM "user" WHERE id=$1 FOR UPDATE', [actor.id]))
      .rows[0];
    if (owner?.role !== 'buyer') failure(403, 'authority_changed', 'Buyer access has changed.');
    await authority(db, actor, 'tokens:buy');
    const meta = (
      await db.query('SELECT grant_id FROM broker_token_packs WHERE id=$1 AND buyer_id=$2', [
        id,
        actor.id,
      ])
    ).rows[0];
    if (!meta) failure(404, 'not_found', 'Token batch not found.');
    const grant = await lockedGrant(db, actor, meta.grant_id, true);
    activeMode(ctx, grant);
    const pack = (await db.query('SELECT * FROM broker_token_packs WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    const now = await clock(db);
    if (pack.status !== 'active' || new Date(pack.expires_at) <= now)
      failure(409, 'pack_closed', 'This batch has expired or is no longer active.');
    const op = `pack-key:${id}:${operationFingerprint(input.operationKey)}`;
    if (
      (
        await db.query(
          'SELECT 1 FROM broker_inference_events WHERE grant_id=$1 AND operation_key=$2',
          [grant.id, op],
        )
      ).rowCount
    )
      failure(
        409,
        'secret_already_issued',
        'This key was already issued once. Create a replacement explicitly if its response was lost.',
      );
    const active = (
      await db.query(
        `SELECT count(*)::int n FROM (SELECT 1 FROM broker_api_keys WHERE user_id=$1 AND pack_id IS DISTINCT FROM $2
      AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 20) active`,
        [actor.id, id],
      )
    ).rows[0].n;
    if (active >= 20)
      failure(409, 'key_limit', 'Revoke an existing API key before issuing another.');
    const parent = actor.apiKey
      ? (await db.query('SELECT expires_at FROM broker_api_keys WHERE id=$1', [actor.apiKey.id]))
          .rows[0]
      : undefined;
    const expires = new Date(
      Math.min(
        new Date(pack.expires_at).getTime(),
        new Date(grant.expires_at).getTime(),
        parent ? new Date(parent.expires_at).getTime() : Infinity,
      ),
    );
    if (expires <= (await clock(db)))
      failure(409, 'pack_closed', 'The batch or issuing key has expired.');
    await db.query(
      'UPDATE broker_api_keys SET revoked_at=clock_timestamp() WHERE user_id=$1 AND pack_id=$2 AND revoked_at IS NULL',
      [actor.id, id],
    );
    const keyId = randomUUID(),
      secret = randomBytes(32).toString('base64url'),
      prefix = `wbk_${keyId}`;
    const row = (
      await db.query(
        `INSERT INTO broker_api_keys(id,user_id,grant_id,pack_id,parent_key_id,name,prefix,secret_digest,scopes,limits,issued_role,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','buyer',$10) RETURNING *`,
        [
          keyId,
          actor.id,
          grant.id,
          id,
          actor.apiKey?.id ?? null,
          input.name ?? `Batch ${id.slice(0, 8)}`,
          prefix,
          brokerSecretDigest(secret),
          JSON.stringify(packScopes),
          expires,
        ],
      )
    ).rows[0];
    await event(db, grant.id, op, 'pack_key_issued', keyId, actor.id, {
      packId: id,
      parentKeyId: actor.apiKey?.id ?? null,
    });
    return {
      key: keySummary(row),
      token: `${prefix}.${secret}`,
      connection: {
        packId: id,
        baseUrl: `${ctx.config.appUrl.replace(/\/$/, '')}/api/v1`,
        model: INFERENCE_MODEL_ID,
        expiresAt: expires.toISOString(),
      },
    };
  });
}
