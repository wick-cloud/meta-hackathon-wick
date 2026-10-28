# Wick Broker v1 shared implementation contract

Single Node 24 process: Fastify + Better Auth + pg-boss + same-origin WS bridge; Vite React frontend; PostgreSQL. All prices USD integer cents. Explicit `WICK_MODE=fixture|real` and `MUSE_MODE=fixture|real`; no fallback. Roles buyer/provider/admin. Auth user IDs text.

## Ownership
- root: package/toolchain, config, DB/auth/context/server composition, seed orchestration, deployment, integration.
- marketplace: migrations/002_marketplace.sql, src/server/marketplace/**, transactional jobs/auction/provider/admin APIs. Exports registerMarketplace(app,ctx), startMarketplaceWorkers(ctx), seedMarketplace(pool,actors).
- integrations: src/server/integrations/wick.ts, terminal.ts + own tests/docs; exports createWickAdapter(config), registerTerminal(app,ctx).
- muse: src/server/integrations/muse.ts + src/server/muse/** + tests/docs; exports createMuseAdapter(config), registerMuse(app,ctx).
- frontend: src/client/**, index.html (no package edits).
- tests/docs: tests/browser/**, playwright.config.ts, docs/**, independent contract review. Coordinate schema/API with marketplace.

## Context / API conventions
`AppContext`: pool (pg Pool), boss (PgBoss), config, wick, muse; `requireActor(request, roles?)` async validates session and returns `{id,email,name,role,providerId?:string}`. `HttpError(statusCode,message)`.
All API success direct JSON; errors `{error:string}`. List endpoints `{items:[], nextCursor?:string}`. All time values ISO strings. GET /api/me returns `{user: Actor|null, modes:{wick,muse}, catalog:CatalogItem[]}`. GET /api/catalog `{items:CatalogItem[]}`. Better Auth mounted `/api/auth/*`; email/password login only; sign-up disabled; explicit seed.

Buyer API:
POST /api/requests body `{description,catalogId,region,durationMinutes,maxPriceCents,requirements:{cpu,memoryGb,gpu?}}` => request; immutable spec; starts 30s auction immediately following review.
GET /api/requests => list; GET /api/requests/:id => `{request,bids,vm?}`; POST /api/requests/:id/cancel; POST /api/requests/:id/retry starts a NEW immutable request/auction.
GET /api/vms => list; GET /api/vms/:id => VM; POST /api/vms/:id/terminate; GET /api/invoices => list.
GET /api/vms/:id/terminal (WS) authenticates server-side, ownership, rental state; browser no upstream credentials.
VM shape includes id,requestId,buyerId,status,environmentId,expiresAt,readyAt,createdAt,catalogName,region,durationMinutes,priceCents. Status provisioning/running/terminating/terminated/failed/expired. Missing expiry never invented in real mode.
Request includes id,description,catalogId,region,durationMinutes,maxPriceCents,requirements,status,closesAt,createdAt,winningBidId. Bids id,providerId,providerName,totalPriceCents,status,createdAt. Request statuses open/provisioning/ready/no_offers/failed/cancelled.

Provider API:
GET /api/provider/dashboard => `{provider,policy,capacity:{total,held,available},activity:[]}`; PUT /api/provider/capacity `{total}`; PUT /api/provider/policy `{autoBid,minimumPriceCents,basePriceCents,...}`; GET /api/provider/requests => `{items:Request[]}`; POST /api/provider/requests/:id/bids `{totalPriceCents,offeringId?}`; GET /api/provider/offerings => `{items:Offering[]}`; POST /api/provider/offerings `{catalogId,name,description,priceCents}` (approved existing config only); PATCH /api/provider/offerings/:id `{active}`; GET /api/provider/activity => list.
GET /api/admin/config => modes + catalog + providers; PUT /api/admin/catalog/:id `{approved:boolean}`; default max actual VMs 2.

Muse API POST /api/muse/translate `{description}` => `{proposal:{catalogId,region,durationMinutes,requirements},receipt:{observed,decision,constraints},mode}`; POST /api/provider/requests/:id/propose => validated proposal/decline + receipt (can be implemented by marketplace using ctx.muse.proposeBid); POST /api/provider/offerings/propose => suggestions + receipt (Muse route).

## Durability contract
Persist create key before upstream request. Domain changes and pg-boss enqueue in same PG transaction via boss.send(...,{db:{executeSql:...}}). No network inside SQL transaction. Use locks/capacity holds and unique constraints. Explicit 30s close work; loser release; winner release only confirmed cleanup; readiness creates exactly one invoice. Poll bounded; uncertain responses retain reservation and reconcile same idempotency key. Wick admission expiry authoritative; fixture also persistent so process recovery cannot reset clock. No workload execution fields or behavior.
