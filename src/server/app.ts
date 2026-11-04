import { registerDisks, startDiskWorkers } from './disks/index.js';
import { registerDemo, startDemoWorkers } from './demo/index.js';
import Fastify, { LogController } from 'fastify';
import { registerCoding, startCodingWorkers } from './coding/index.js';
import { registerStudio, startStudioWorkers } from './coding/studio-api.js';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { PgBoss } from 'pg-boss';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { MAX_API_BODY_BYTES } from './http-limits.js';
import { registerHttpSecurity } from './http-security.js';
import { createPool, migrate, verifyMigrations } from './db.js';
import { createReadinessProbe, workersReady } from './readiness.js';
import { registerRequestLimits } from './request-limits.js';
import { createAuth, createRequireActor, registerAuth, registerBrokerKeyAccess } from './auth.js';
import { HttpError, type AppContext } from './context.js';
import { createWickAdapter } from './integrations/wick.js';
import type { WickAdapter } from './integrations/types.js';
import { createMuseAdapter } from './integrations/muse.js';
import { registerTerminal } from './integrations/terminal.js';
import { registerMarketplace, startMarketplaceWorkers, getCatalog } from './marketplace/index.js';
import { registerMuse } from './muse/index.js';
import { registerNegotiation } from './marketplace/negotiation.js';
import { registerOrders } from './orders.js';
import { publicCatalogView } from './public-views.js';
import { registerOpenApi } from './openapi.js';
import { registerAgreements, startAgreementWorkers } from './agreements/index.js';
import { registerAgreementBilling } from './agreement-billing.js';
import { registerDeveloperKeys } from './developer-keys.js';
import { registerClientReleases } from './client-releases.js';
import { createInferenceRuntime, type InferenceRuntime } from './inference/runtime.js';
import { registerInference, startInferenceWorkers } from './inference/index.js';
export async function buildApp(
  config: Config,
  options: {
    wrapWick?: (adapter: WickAdapter) => WickAdapter;
    wrapInference?: (runtime: InferenceRuntime) => InferenceRuntime;
    clientRoot?: string;
  } = {},
) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
        'password',
        'token',
      ],
    },
    bodyLimit: MAX_API_BODY_BYTES,
    // Header trust is explicit in request-limits/auth; never accept arbitrary proxy chains.
    trustProxy: false,
    requestTimeout: 30000,
    connectionTimeout: 120000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const pool = createPool(config.databaseUrl);
  pool.on('error', () => app.log.error('Database connection error'));
  if (config.nodeEnv === 'production') await verifyMigrations(pool);
  else await migrate(pool);
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: 'pgboss',
    max: 5,
    connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000',
    migrate: config.nodeEnv !== 'production',
    createSchema: config.nodeEnv !== 'production',
  });
  boss.on('error', () => app.log.error('Durable queue error'));
  await boss.start();
  const auth = createAuth(config, pool);
  const inference = await createInferenceRuntime(config);
  const ctx: AppContext = {
    pool,
    boss,
    config,
    wick: options.wrapWick
      ? options.wrapWick(createWickAdapter(config, pool))
      : createWickAdapter(config, pool),
    muse: createMuseAdapter(config),
    inference: options.wrapInference ? options.wrapInference(inference) : inference,
    requireActor: createRequireActor(auth, pool),
  };
  registerHttpSecurity(app, config);
  registerRequestLimits(app, config);
  registerBrokerKeyAccess(app, ctx.requireActor);
  let closing = false;
  let expectedWorkers = new Set<string>();
  const dependenciesReady = createReadinessProbe(
    () => pool.query('SELECT 1'),
    () => boss.getDb().executeSql('SELECT 1'),
  );
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.status(400).send({
        error: 'Please check the supplied values.',
        code: 'invalid_request',
        requestId: request.id,
        details: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    const status =
      error instanceof HttpError
        ? error.statusCode
        : typeof (error as { statusCode?: number }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 500;
    if (status >= 500)
      app.log.error(
        { name: (error as Error).name, code: (error as { code?: string }).code },
        'Request failed',
      );
    const retryAfter = (error as { retryAfter?: number }).retryAfter;
    if (retryAfter !== undefined) reply.header('Retry-After', String(retryAfter));
    const code =
      typeof (error as { code?: unknown }).code === 'string' && status < 500
        ? (error as { code: string }).code
        : ((
            {
              400: 'invalid_request',
              401: 'unauthorized',
              403: 'forbidden',
              404: 'not_found',
              409: 'conflict',
              429: 'rate_limited',
            } as Record<number, string>
          )[status] ?? 'service_unavailable');
    return reply.status(status).send({
      code,
      requestId: request.id,
      ...((error as { inferenceRequestId?: string }).inferenceRequestId
        ? { inferenceRequestId: (error as { inferenceRequestId: string }).inferenceRequestId }
        : {}),
      error:
        status >= 500
          ? 'The service could not complete this request. Please try again.'
          : (error as Error).message,
    });
  });
  app.get('/health', async () => ({
    status: 'ok',
    service: 'wick-broker',
    modes: { wick: config.wickMode, muse: config.museMode },
  }));
  app.get('/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (closing) return reply.code(503).send({ status: 'stopping' });
    if (!workersReady(boss.getWipData(), expectedWorkers) || !(await dependenciesReady()))
      return reply.code(503).send({ status: 'unavailable' });
    return { status: 'ready', queue: 'running' };
  });
  await app.register(websocket, { options: { maxPayload: 33792, perMessageDeflate: false } });
  await registerAuth(app, auth, config);
  await registerDeveloperKeys(app, ctx);
  app.get('/api/me', async (request) => {
    try {
      const user = await ctx.requireActor(request);
      return {
        user,
        modes: { wick: config.wickMode, muse: config.museMode },
        commissionBps: 1500,
        ...(config.wickMode === 'real' && config.modalComputePromotionEnabled
          ? {
              computePromotion: {
                provider: 'modal',
                totalPriceCents: 1,
                tiePriority: 'modal',
                fundedBy: 'operator-wick-account',
              },
            }
          : {}),
        catalog:
          !user.apiKey || user.apiKey.scopes.includes('catalog:read')
            ? (await getCatalog(ctx)).map(publicCatalogView)
            : [],
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401)
        return { user: null, modes: { wick: config.wickMode, muse: config.museMode }, catalog: [] };
      throw error;
    }
  });
  app.get('/api/catalog', async (request) => {
    await ctx.requireActor(request);
    return { items: (await getCatalog(ctx)).map(publicCatalogView) };
  });
  registerOpenApi(app);
  registerClientReleases(app);
  await registerMarketplace(app, ctx);
  registerOrders(app, ctx);
  await registerAgreements(app, ctx);
  await registerInference(app, ctx);
  registerCoding(app, ctx);
  registerStudio(app, ctx);
  await registerDisks(app, ctx);
  await registerDemo(app, ctx);
  registerAgreementBilling(app, ctx);
  registerNegotiation(app, ctx);
  await registerMuse(app, ctx);
  await registerTerminal(app, ctx);
  await startDiskWorkers(ctx);
  await startMarketplaceWorkers(ctx);
  await startAgreementWorkers(ctx);
  await startInferenceWorkers(ctx);
  await startCodingWorkers(ctx);
  await startStudioWorkers(ctx);
  await startDemoWorkers(ctx);
  expectedWorkers = new Set(boss.getWipData().map((worker) => worker.name));
  const clientRoot = resolve(options.clientRoot ?? 'dist/client');
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith('/api/') ||
        request.url.startsWith('/assets/') ||
        request.method !== 'GET'
      )
        return reply
          .code(404)
          .send({ error: 'Not found.', code: 'not_found', requestId: request.id });
      return reply.sendFile('index.html');
    });
  } else if (config.nodeEnv === 'development') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    const { default: middie } = await import('@fastify/middie');
    await app.register(middie);
    app.use((req, res, next) => {
      if (req.url?.startsWith('/api/')) return next();
      vite.middlewares(req, res, next);
    });
    app.addHook('onClose', async () => {
      await vite.close();
    });
  }
  app.addHook('onClose', async () => {
    closing = true;
    await boss.stop({ graceful: true, timeout: 20000 });
    await pool.end();
  });
  return { app, ctx };
}
