import { randomUUID } from 'node:crypto';
import type { Actor, CatalogItem } from '../../shared/types.js';
import { HttpError,type AppContext } from '../context.js';
import { transaction,enqueue,activity,QUEUES } from './db.js';
import { bidView,getProvider,integer,offeringView,requestView,shortText,type Row } from './data.js';

export async function createRequest(ctx:AppContext,actor:Actor,body:Row,priorRequestId?:string){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'A request body is required.');
  const description=shortText(body.description,'Description',4000);
  const catalogId=shortText(body.catalogId,'Catalog configuration',160);
  const region=shortText(body.region,'Region',120);
  const durationMinutes=integer(body.durationMinutes??30,'Rental duration',15,60);
  if(![15,30,60].includes(durationMinutes))throw new HttpError(400,'Choose exactly 15, 30 or 60 minutes.');
  const maxPriceCents=integer(body.maxPriceCents,'Maximum total price');
  const cpu=integer(body.requirements?.cpu,'CPU requirement',1,1024);
  const memoryGb=integer(body.requirements?.memoryGb,'Memory requirement',1,16384);
  const gpu=body.requirements?.gpu ? shortText(body.requirements.gpu,'GPU requirement',120):undefined;
  for(const key of ['git','repository','repo','task','command','agent'])if(key in body)throw new HttpError(400,'Environment requests cannot contain workload execution fields.');
  return transaction(ctx.pool,async db=>{
    const result=await db.query('SELECT item,approved FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',[catalogId,ctx.wick.mode]);
    const catalog=result.rows[0]?.item as CatalogItem|undefined;
    if(!catalog||!result.rows[0].approved)throw new HttpError(400,'Choose an administrator-approved configuration.');
    if(!catalog.durationMinutes.includes(durationMinutes))throw new HttpError(400,'This configuration does not support the exact selected rental duration.');
    if(catalog.region!==region||catalog.cpu<cpu||catalog.memoryGb<memoryGb||(gpu&&catalog.gpu!==gpu))throw new HttpError(400,'The configuration does not satisfy the requested region and resources.');
    const r=await db.query(`INSERT INTO broker_requests(buyer_id,description,catalog_id,catalog_snapshot,region,duration_minutes,max_price_cents,requirements,prior_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[actor.id,description,catalogId,{...catalog,approved:true,sourceMode:ctx.wick.mode},region,durationMinutes,maxPriceCents,{cpu,memoryGb,...(gpu?{gpu}:{})},priorRequestId||null]);
    const request=r.rows[0];
    await enqueue(ctx,db,QUEUES.close,{requestId:request.id},30);
    const providers=await db.query("SELECT id FROM broker_providers WHERE policy->>'autoBid'='true'");
    for(const p of providers.rows)await enqueue(ctx,db,QUEUES.auto,{requestId:request.id,providerId:p.id});
    return requestView(request);
  });
}

export async function submitBid(ctx:AppContext,actor:Actor,requestId:string,input:{totalPriceCents:number;offeringId?:string},source:'manual'|'auto'='manual'){
  const price=integer(input.totalPriceCents,'Total price');
  return transaction(ctx.pool,async db=>{
    const request=(await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!request)throw new HttpError(404,'Request not found.');
    const deadline=(await db.query('SELECT clock_timestamp()<closes_at AS eligible FROM broker_requests WHERE id=$1',[requestId])).rows[0].eligible;
    if(request.status!=='open'||!deadline)throw new HttpError(409,'This auction has closed. Late bids are not accepted.');
    const provider=await getProvider(db,actor);
    await db.query('SELECT id FROM broker_providers WHERE id=$1 FOR UPDATE',[provider.id]);
    const p=(await db.query('SELECT * FROM broker_providers WHERE id=$1',[provider.id])).rows[0];
    const policy=p.policy;
    if(source==='auto'&&!policy.autoBid)throw new HttpError(409,'Automatic bidding was disabled before submission.');
    if(price>request.max_price_cents||price<policy.minimumPriceCents||(policy.maxPriceCents!==undefined&&price>policy.maxPriceCents))throw new HttpError(400,'Price is outside the customer budget or provider pricing policy.');
    if(policy.allowedCatalogIds&&!policy.allowedCatalogIds.includes(request.catalog_id))throw new HttpError(400,'Provider policy excludes this configuration.');
    const offering=(await db.query(`SELECT * FROM broker_offerings WHERE provider_id=$1 AND catalog_id=$2 AND active=true ${input.offeringId?'AND id=$3':''} ORDER BY price_cents,id LIMIT 1 FOR SHARE`,input.offeringId?[p.id,request.catalog_id,input.offeringId]:[p.id,request.catalog_id])).rows[0];
    if(!offering)throw new HttpError(400,'Publish an active offering for this configuration before bidding.');
    const approved=(await db.query('SELECT approved FROM broker_catalog WHERE id=$1 AND source_mode=$2 FOR SHARE',[request.catalog_id,ctx.wick.mode])).rows[0]?.approved;
    if(!approved)throw new HttpError(409,'This configuration is no longer approved for new bids.');
    const existing=(await db.query('SELECT id FROM broker_bids WHERE request_id=$1 AND provider_id=$2',[requestId,p.id])).rows[0];
    if(existing)throw new HttpError(409,'This provider already submitted a binding bid.');
    const held=Number((await db.query('SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',[p.id])).rows[0].n);
    if(held>=p.total_capacity)throw new HttpError(409,'All simulated supplier slots are already reserved.');
    const bid=(await db.query(`WITH acceptance AS MATERIALIZED (SELECT clock_timestamp() AS accepted_at) INSERT INTO broker_bids(request_id,provider_id,offering_id,offering_snapshot,total_price_cents,created_at) SELECT $1,$2,$3,$4,$5,accepted_at FROM acceptance WHERE accepted_at<(SELECT closes_at FROM broker_requests WHERE id=$1) RETURNING *`,[requestId,p.id,offering.id,offeringView(offering),price])).rows[0];
    if(!bid)throw new HttpError(409,'This auction closed while capacity was being reserved. Late bids are not accepted.');
    await db.query('INSERT INTO broker_holds(bid_id,provider_id) VALUES($1,$2)',[bid.id,p.id]);
    await activity(db,p.id,requestId,'bid','Submitted a fixed-price bid and reserved one simulated capacity slot.');
    return bidView({...bid,provider_name:p.name});
  });
}

export async function closeAuction(ctx:AppContext,requestId:string){
  return transaction(ctx.pool,async db=>{
    const request=(await db.query('SELECT * FROM broker_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!request||request.status!=='open')return;
    const time=await db.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM (closes_at-clock_timestamp()))) AS remaining FROM broker_requests WHERE id=$1',[requestId]);
    if(Number(time.rows[0].remaining)>0){await enqueue(ctx,db,QUEUES.close,{requestId},Math.ceil(Number(time.rows[0].remaining)));return;}
    const bids=(await db.query("SELECT * FROM broker_bids WHERE request_id=$1 AND status='held' ORDER BY total_price_cents,created_at,id FOR UPDATE",[requestId])).rows;
    if((request.catalog_snapshot.sourceMode??'fixture')!==ctx.wick.mode){
      await db.query("UPDATE broker_requests SET status='failed',failure_reason='The Wick integration mode changed. Create a new request with the current approved catalog.' WHERE id=$1",[requestId]);
      await db.query("UPDATE broker_bids SET status='lost' WHERE request_id=$1",[requestId]);
      await db.query("UPDATE broker_holds SET released_at=now(),release_reason='Integration mode changed before admission' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",[requestId]);return;
    }
    if(!bids.length){await db.query("UPDATE broker_requests SET status='no_offers',failure_reason='No eligible offers arrived before the auction closed.' WHERE id=$1",[requestId]);return;}
    await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-global-vm-admission'))");
    const configured=(await db.query("SELECT value FROM broker_settings WHERE key='maxConcurrentVms'")).rows[0]?.value??ctx.config.maxConcurrentVms;
    const count=Number((await db.query('SELECT count(*)::int AS n FROM broker_vms WHERE cleanup_confirmed_at IS NULL')).rows[0].n);
    if(count>=Number(configured)){
      await db.query("UPDATE broker_requests SET status='failed',failure_reason='The concurrent VM limit is reached. Start a new auction when a VM has finished cleanup.' WHERE id=$1",[requestId]);
      await db.query("UPDATE broker_bids SET status='lost' WHERE request_id=$1",[requestId]);
      await db.query("UPDATE broker_holds SET released_at=now(),release_reason='VM limit reached' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1) AND released_at IS NULL",[requestId]);return;
    }
    const winner=bids[0];
    await db.query("UPDATE broker_bids SET status=CASE WHEN id=$2 THEN 'won' ELSE 'lost' END WHERE request_id=$1",[requestId,winner.id]);
    await db.query("UPDATE broker_holds SET released_at=now(),release_reason='Auction lost' WHERE bid_id IN(SELECT id FROM broker_bids WHERE request_id=$1 AND id<>$2) AND released_at IS NULL",[requestId,winner.id]);
    const catalog=request.catalog_snapshot;
    const vmId=randomUUID();
    const config=ctx.config as unknown as Record<string,unknown>;
    const createInput={organizationId:catalog.organizationId||config.wickOrganizationId||'fixture-organization',groupId:catalog.groupId||config.wickGroupId||'fixture-group',name:`wick-broker-${vmId.slice(0,8)}`,provider:catalog.provider,profile:catalog.profile,region:catalog.region,...(catalog.providerKeyId?{providerKeyId:catalog.providerKeyId}:{}),ttlSeconds:request.duration_minutes*60,visibility:'private'};
    if(ctx.wick.mode==='real'&&(!catalog.organizationId&&!config.wickOrganizationId||!catalog.groupId&&!config.wickGroupId))throw new HttpError(503,'Real Wick organization and group must be configured before awarding.');
    await db.query(`INSERT INTO broker_vms(id,request_id,buyer_id,provider_id,bid_id,create_key,create_input,catalog_snapshot,quote_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[vmId,requestId,request.buyer_id,winner.provider_id,winner.id,`broker-v1:${vmId}`,createInput,catalog,{totalPriceCents:winner.total_price_cents,currency:'USD',feeCents:0,offering:winner.offering_snapshot,acceptedAt:isoDate(winner.created_at)}]);
    await db.query("UPDATE broker_requests SET status='provisioning',winning_bid_id=$2 WHERE id=$1",[requestId,winner.id]);
    await activity(db,winner.provider_id,requestId,'awarded','Lowest eligible fixed-price offer won. Quote and offering revision frozen.');
    await enqueue(ctx,db,QUEUES.provision,{vmId});
    return {vmId,winningBidId:winner.id};
  });
}
function isoDate(value:unknown){return new Date(value as string).toISOString();}

export async function proposeBid(ctx:AppContext,actor:Actor,requestId:string){
  const provider=await getProvider(ctx.pool,actor);
  const request=(await ctx.pool.query("SELECT * FROM broker_requests WHERE id=$1 AND status='open' AND closes_at>clock_timestamp()",[requestId])).rows[0];
  if(!request)throw new HttpError(409,'This request is no longer accepting offers.');
  const held=Number((await ctx.pool.query('SELECT count(*)::int AS n FROM broker_holds WHERE provider_id=$1 AND released_at IS NULL',[provider.id])).rows[0].n);
  const catalog=(await ctx.pool.query('SELECT item,approved FROM broker_catalog WHERE approved=true AND source_mode=$1',[ctx.wick.mode])).rows.map(r=>({...r.item,approved:r.approved}));
  const proposal=await ctx.muse.proposeBid({request:{description:request.description,catalogId:request.catalog_id,durationMinutes:request.duration_minutes,maxPriceCents:request.max_price_cents,requirements:request.requirements,region:request.region},policy:provider.policy,availableCapacity:Math.max(0,provider.total_capacity-held),catalog});
  if(proposal.decision==='bid'){
    integer(proposal.totalPriceCents,'Proposed price');
    if(proposal.catalogId&&proposal.catalogId!==request.catalog_id)throw new HttpError(422,'Muse proposed a different configuration.');
    if(proposal.totalPriceCents!>request.max_price_cents||proposal.totalPriceCents!<provider.policy.minimumPriceCents)throw new HttpError(422,'Muse proposal violates the fixed-price policy or request budget.');
  }
  return {...proposal,mode:ctx.muse.mode};
}
