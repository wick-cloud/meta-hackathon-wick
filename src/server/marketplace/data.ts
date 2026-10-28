import type { Pool, PoolClient } from 'pg';
import type { Actor,CatalogItem } from '../../shared/types.js';
import { HttpError,type AppContext } from '../context.js';
export type Row=Record<string,any>;
export const iso=(value:unknown):string|null=>value ? new Date(value as string).toISOString():null;
export const requestView=(r:Row)=>({id:r.id,buyerId:r.buyer_id,description:r.description,catalogId:r.catalog_id,catalogName:r.catalog_snapshot?.name,region:r.region,durationMinutes:r.duration_minutes,maxPriceCents:r.max_price_cents,requirements:r.requirements,status:r.status,closesAt:iso(r.closes_at),createdAt:iso(r.created_at),winningBidId:r.winning_bid_id,failureReason:r.failure_reason});
export const bidView=(r:Row)=>({id:r.id,providerId:r.provider_id,providerName:r.provider_name,totalPriceCents:r.total_price_cents,status:r.status,createdAt:iso(r.created_at),simulated:true});
export const offeringView=(r:Row)=>({id:r.id,providerId:r.provider_id,catalogId:r.catalog_id,name:r.name,description:r.description,priceCents:r.price_cents,active:r.active,revision:r.revision,createdAt:iso(r.created_at),simulated:true});
export const vmView=(r:Row)=>({id:r.id,requestId:r.request_id,buyerId:r.buyer_id,status:r.status,environmentId:r.environment_id,expiresAt:iso(r.expires_at),readyAt:iso(r.ready_at),createdAt:iso(r.created_at),admittedAt:iso(r.admitted_at),catalogName:r.catalog_snapshot?.name,region:r.catalog_snapshot?.region,durationMinutes:r.create_input?.ttlSeconds/60,priceCents:r.quote_snapshot?.totalPriceCents,failureReason:r.failure_reason,cleanupPending:!r.cleanup_confirmed_at&&['terminating','failed','expired'].includes(r.status)});
export async function getCatalog(ctx:Pick<AppContext,'pool'>):Promise<CatalogItem[]>{
  const result=await ctx.pool.query('SELECT id,item,approved FROM broker_catalog ORDER BY id');
  return result.rows.map(r=>({...r.item,id:r.id,approved:r.approved}));
}
export async function syncCatalog(ctx:AppContext){
  const items=await ctx.wick.catalog();
  for(const item of items) await ctx.pool.query('INSERT INTO broker_catalog(id,item,approved) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET item=excluded.item,updated_at=now()',[item.id,item,item.approved]);
  return getCatalog(ctx);
}
export async function getProvider(db:Pool|PoolClient,actor:Actor):Promise<Row>{
  const result=await db.query('SELECT * FROM broker_providers WHERE user_id=$1',[actor.id]);
  if(!result.rows[0])throw new HttpError(403,'Provider access is not configured.');
  return result.rows[0];
}
export function integer(value:unknown,label:string,min=0,max=100000000){if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new HttpError(400,`${label} must be an integer between ${min} and ${max}.`);return value;}
export function shortText(value:unknown,label:string,max=2000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new HttpError(400,`${label} is required and must be at most ${max} characters.`);return value.trim();}
export function uuid(value:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new HttpError(400,'Invalid resource ID.');return value;}
export function pagination(query:unknown){const q=(query||{}) as {limit?:string;cursor?:string};const limit=Math.min(100,Math.max(1,Number(q.limit)||30));if(q.cursor&&!Number.isFinite(Date.parse(q.cursor)))throw new HttpError(400,'Invalid cursor.');return {limit,cursor:q.cursor||null};}
