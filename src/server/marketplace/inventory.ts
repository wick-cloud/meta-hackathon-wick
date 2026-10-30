import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { vmStatuses, type VMInventoryPage } from '../../shared/vm-inventory.js';
import { HttpError, type AppContext } from '../context.js';
import { encodeCursor, iso, pagination, uuid } from './data.js';

const active = `(v.cleanup_confirmed_at IS NULL AND v.status IN ('provisioning','running','terminating','failed','expired'))`;
export function inventoryQuery(raw: unknown) {
  const q = (raw ?? {}) as Record<string, unknown>;
  for (const name of ['search', 'status', 'provider', 'sort', 'before'])
    if (q[name] !== undefined && typeof q[name] !== 'string')
      throw new HttpError(400, `Invalid ${name} filter.`);
  if (q.before && q.cursor) throw new HttpError(400, 'Use only one page cursor.');
  const p = pagination({ ...q, ...(q.before ? { cursor: q.before } : {}) });
  if (p.cursorId) uuid(p.cursorId);
  const search = String(q.search ?? '').trim();
  const status = String(q.status ?? 'all');
  const provider = String(q.provider ?? 'all');
  const sort = String(q.sort ?? 'newest');
  if (search.length > 100) throw new HttpError(400, 'Search must be at most 100 characters.');
  if (!['all', 'active', 'past', ...vmStatuses].includes(status))
    throw new HttpError(400, 'Invalid VM status.');
  if (provider !== 'all' && !/^[a-z0-9][a-z0-9:_-]{0,119}$/.test(provider))
    throw new HttpError(400, 'Invalid provider.');
  if (!['newest', 'oldest'].includes(sort)) throw new HttpError(400, 'Invalid VM sort order.');
  return { ...p, search, status, provider, sort, backwards: Boolean(q.before) };
}

/** One authorized, bounded page. Snapshot enrichment and provider joins happen after its limit. */
export async function listVmInventory(
  pool: Pool,
  buyerId: string,
  raw: unknown,
): Promise<VMInventoryPage> {
  const q = inventoryQuery(raw),
    values: unknown[] = [buyerId];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = ['v.buyer_id=$1'];
  const ascending = q.backwards ? q.sort !== 'oldest' : q.sort === 'oldest';
  const direction = ascending ? 'ASC' : 'DESC';
  if (q.cursor)
    where.push(
      `(v.created_at,v.id) ${ascending ? '>' : '<'} (${bind(q.cursor)}::timestamptz,${bind(q.cursorId)}::uuid)`,
    );
  if (q.status === 'active') where.push(active);
  else if (q.status === 'past') where.push(`NOT ${active}`);
  else if (q.status !== 'all') where.push(`v.status=${bind(q.status)}`);
  if (q.provider !== 'all') where.push(`v.catalog_snapshot->>'provider'=${bind(q.provider)}`);
  if (q.search) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q.search))
      where.push(`v.id=${bind(q.search)}::uuid`);
    else {
      const term = bind(`%${q.search.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(v.catalog_snapshot->>'name' ILIKE ${term} OR v.id::text ILIKE ${term})`);
    }
  }
  const sql = `WITH selected AS MATERIALIZED (
    SELECT v.id,v.request_id,v.provider_id,v.status,v.created_at,v.expires_at,v.cleanup_confirmed_at,v.catalog_snapshot,v.quote_snapshot
    FROM broker_vms v WHERE ${where.join(' AND ')} ORDER BY v.created_at ${direction},v.id ${direction} LIMIT ${bind(q.limit + 1)}
  ) SELECT s.id,s.request_id,s.status,s.created_at,s.created_at::text cursor_created_at,s.expires_at,s.cleanup_confirmed_at,
    s.catalog_snapshot->>'name' name,s.catalog_snapshot->>'provider' provider,p.name provider_name,
    s.catalog_snapshot->>'region' region,s.catalog_snapshot->>'sourceMode' source_mode,
    COALESCE(s.catalog_snapshot->'resources'->>'cpu',s.catalog_snapshot->>'cpu') cpu,
    COALESCE(s.catalog_snapshot->'resources'->>'memoryGb',s.catalog_snapshot->>'memoryGb') memory_gb,
    COALESCE(s.catalog_snapshot->'resources'->>'gpu',s.catalog_snapshot->>'gpu') gpu,
    s.quote_snapshot->>'totalPriceCents' price_cents,s.quote_snapshot->>'billingSource' billing_source,
    statement_timestamp() server_now
    FROM selected s LEFT JOIN broker_providers p ON p.id=s.provider_id ORDER BY s.created_at ${direction},s.id ${direction}`;
  const rows = (await pool.query(sql, values)).rows;
  const selected = rows.slice(0, q.limit);
  if (q.backwards) selected.reverse();
  return {
    items: selected.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      name: r.name || 'Environment',
      status: r.status,
      sourceMode: r.source_mode === 'real' ? 'real' : 'fixture',
      provider: r.provider,
      providerName: r.provider_name,
      cpu: r.cpu === null ? null : Number(r.cpu),
      memoryGb: r.memory_gb === null ? null : Number(r.memory_gb),
      gpu: r.gpu,
      region: r.region,
      createdAt: iso(r.created_at)!,
      expiresAt: iso(r.expires_at),
      priceCents: r.price_cents === null ? null : Number(r.price_cents),
      cleanupPending:
        !r.cleanup_confirmed_at && ['terminating', 'failed', 'expired'].includes(r.status),
      billingSource:
        r.billing_source === 'scheduled_capacity' ? 'scheduled_capacity' : 'instant_vm',
    })),
    ...(selected.length && (q.backwards ? true : rows.length > q.limit)
      ? { nextCursor: encodeCursor(selected[selected.length - 1]) }
      : {}),
    ...(selected.length && (q.backwards ? rows.length > q.limit : Boolean(q.cursor))
      ? { previousCursor: encodeCursor(selected[0]) }
      : {}),
    serverNow: rows.length ? iso(rows[0].server_now)! : new Date().toISOString(),
  };
}

export function registerVmInventory(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/vm-inventory', async (request) => {
    const actor = await ctx.requireActor(request, ['buyer']);
    if (actor.apiKey) throw new HttpError(403, 'Use the public VM API with a Broker key.');
    return listVmInventory(ctx.pool, actor.id, request.query);
  });
}
