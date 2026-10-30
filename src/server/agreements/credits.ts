import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { CreditEntry, CreditWallet } from '../../shared/agreements.js';
import { HttpError, type AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { pagination, encodeCursor, shortText } from '../marketplace/data.js';

type Db = Pool | PoolClient;
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function operationKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[-A-Za-z0-9_:./]{8,160}$/.test(value))
    throw new HttpError(400, 'Use a unique operationKey of 8–160 safe characters.');
  return value;
}
export function cents(value: unknown, name = 'Credit amount', min = 0, max = 100000000): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new HttpError(
      400,
      `${name} must be a whole number of USD cents within its allowed limit.`,
    );
  return Number(value);
}
function wallet(row?: Record<string, any>): CreditWallet {
  const balanceCents = Number(row?.balance_cents ?? 0),
    reservedCents = Number(row?.reserved_cents ?? 0);
  return {
    balanceCents,
    reservedCents,
    availableCents: balanceCents - reservedCents,
    currency: 'USD',
    kind: 'broker-pilot-credit',
    wickComputeCreditsSeparate: true,
  };
}
export async function creditWalletView(db: Db, buyerId: string) {
  return wallet(
    (
      await db.query(
        'SELECT balance_cents,reserved_cents FROM broker_credit_wallets WHERE buyer_id=$1',
        [buyerId],
      )
    ).rows[0],
  );
}
export async function lockedWallet(db: PoolClient, buyerId: string) {
  await db.query('INSERT INTO broker_credit_wallets(buyer_id) VALUES($1) ON CONFLICT DO NOTHING', [
    buyerId,
  ]);
  return (
    await db.query('SELECT * FROM broker_credit_wallets WHERE buyer_id=$1 FOR UPDATE', [buyerId])
  ).rows[0];
}
export async function applyCreditEntry(
  db: PoolClient,
  buyerId: string,
  input: {
    operationKey: string;
    kind: CreditEntry['kind'];
    balanceDeltaCents: number;
    reservedDeltaCents: number;
    agreementId?: string;
    grantId?: string;
    description: string;
    inputFingerprint?: string;
  },
) {
  operationKey(input.operationKey);
  for (const amount of [input.balanceDeltaCents, input.reservedDeltaCents])
    cents(amount, 'Ledger amount', -100000000, 100000000);
  const row = await lockedWallet(db, buyerId);
  const digest =
    input.inputFingerprint ??
    fingerprint([
      input.kind,
      input.balanceDeltaCents,
      input.reservedDeltaCents,
      input.agreementId ?? null,
      input.description,
      ...(input.grantId ? [input.grantId] : []),
    ]);
  const prior = (
    await db.query(
      'SELECT input_fingerprint FROM broker_credit_ledger WHERE buyer_id=$1 AND operation_key=$2',
      [buyerId, input.operationKey],
    )
  ).rows[0];
  if (prior) {
    if (prior.input_fingerprint !== digest)
      throw new HttpError(
        409,
        'This operation key was already used for a different credit operation.',
      );
    return { wallet: wallet(row), replayed: true };
  }
  const balance = Number(row.balance_cents) + input.balanceDeltaCents,
    reserved = Number(row.reserved_cents) + input.reservedDeltaCents;
  if (
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    balance > 1000000000000 ||
    reserved < 0 ||
    reserved > balance
  )
    throw new HttpError(
      409,
      'Insufficient available Broker credits. Wick compute credits are separate.',
    );
  await db.query(
    'UPDATE broker_credit_wallets SET balance_cents=$2,reserved_cents=$3,updated_at=now() WHERE buyer_id=$1',
    [buyerId, balance, reserved],
  );
  await db.query(
    'INSERT INTO broker_credit_ledger(buyer_id,agreement_id,operation_key,kind,amount_cents,reserved_delta_cents,description,input_fingerprint,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      buyerId,
      input.agreementId ?? null,
      input.operationKey,
      input.kind,
      input.balanceDeltaCents,
      input.reservedDeltaCents,
      input.description,
      digest,
      input.grantId ?? null,
    ],
  );
  return { wallet: wallet({ balance_cents: balance, reserved_cents: reserved }), replayed: false };
}
export async function registerCreditRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/credits', async (request) =>
    creditWalletView(ctx.pool, (await ctx.requireActor(request, ['buyer'])).id),
  );
  app.get('/api/credits/history', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']),
      p = pagination(request.query);
    return transaction(ctx.pool, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const state = await creditWalletView(db, actor.id);
      const rows = (
        await db.query(
          'SELECT *,created_at::text AS cursor_created_at FROM broker_credit_ledger WHERE buyer_id=$1 AND ($2::timestamptz IS NULL OR(created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
          [actor.id, p.cursor, p.cursorId, p.limit + 1],
        )
      ).rows;
      return {
        wallet: state,
        items: rows.slice(0, p.limit).map((r) => ({
          id: r.id,
          kind: r.kind,
          amountCents: Number(r.amount_cents),
          reservedDeltaCents: Number(r.reserved_delta_cents),
          ...(r.agreement_id ? { agreementId: r.agreement_id } : {}),
          ...(r.grant_id ? { grantId: r.grant_id } : {}),
          operationKey: r.operation_key,
          createdAt: new Date(r.created_at).toISOString(),
          description: r.description,
        })),
        ...(rows.length > p.limit ? { nextCursor: encodeCursor(rows[p.limit - 1]) } : {}),
      };
    });
  });
  app.post('/api/admin/credits', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const body = request.body as Record<string, unknown>;
    const buyerId = shortText(body?.buyerId, 'Buyer ID', 150),
      amount = cents(body?.amountCents, 'Grant', 1),
      key = operationKey(body?.operationKey),
      description = shortText(
        body?.description ?? 'Administrator pilot credit grant',
        'Description',
        500,
      );
    return transaction(ctx.pool, async (db) => {
      if (
        !(await db.query('SELECT 1 FROM "user" WHERE id=$1 AND role=\'buyer\'', [buyerId])).rowCount
      )
        throw new HttpError(404, 'Buyer account not found.');
      return (
        await applyCreditEntry(db, buyerId, {
          operationKey: key,
          kind: 'grant',
          balanceDeltaCents: amount,
          reservedDeltaCents: 0,
          description,
        })
      ).wallet;
    });
  });
  app.get('/api/admin/credit-buyers', async (request) => {
    await ctx.requireActor(request, ['admin']);
    const q = (request.query ?? {}) as Record<string, string>,
      limit = q.limit === undefined ? 30 : cents(Number(q.limit), 'Page size', 1, 100);
    if (q.cursor && !/^[A-Za-z0-9_-]{1,250}$/.test(q.cursor))
      throw new HttpError(400, 'Invalid buyer cursor.');
    let after = '';
    try {
      after = q.cursor ? Buffer.from(q.cursor, 'base64url').toString('utf8') : '';
    } catch {
      throw new HttpError(400, 'Invalid buyer cursor.');
    }
    const rows = (
      await ctx.pool.query(
        'SELECT id,name,email FROM "user" WHERE role=\'buyer\' AND id>$1 ORDER BY id LIMIT $2',
        [after, limit + 1],
      )
    ).rows;
    return {
      items: rows.slice(0, limit),
      ...(rows.length > limit
        ? { nextCursor: Buffer.from(rows[limit - 1].id).toString('base64url') }
        : {}),
    };
  });
}
