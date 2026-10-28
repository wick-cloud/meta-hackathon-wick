import Fastify, { LogController } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { PgBoss } from 'pg-boss';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createPool, migrate } from './db.js';
import { createAuth, createRequireActor, registerAuth } from './auth.js';
import { HttpError, type AppContext } from './context.js';
import { createWickAdapter } from './integrations/wick.js';
import type { WickAdapter } from './integrations/types.js';
import { createMuseAdapter } from './integrations/muse.js';
import { registerTerminal } from './integrations/terminal.js';
import { registerMarketplace, startMarketplaceWorkers, getCatalog } from './marketplace/index.js';
import { registerMuse } from './muse/index.js';
import { registerNegotiation } from './marketplace/negotiation.js';
export async function buildApp(
  config: Config,
  options: { wrapWick?: (adapter: WickAdapter) => WickAdapter; clientRoot?: string } = {},
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
    bodyLimit: 64 * 1024,
    trustProxy: config.nodeEnv === 'production',
    logController: new LogController({ disableRequestLogging: true }),
  });
  const pool = createPool(config.databaseUrl);
  pool.on('error', () => app.log.error('Database connection error'));
  await migrate(pool);
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss', max: 5 });
  boss.on('error', () => app.log.error('Durable queue error'));
  await boss.start();
  const auth = createAuth(config, pool);
  const ctx: AppContext = {
    pool,
    boss,
    config,
    wick: options.wrapWick
      ? options.wrapWick(createWickAdapter(config, pool))
      : createWickAdapter(config, pool),
    muse: createMuseAdapter(config),
    requireActor: createRequireActor(auth, pool),
  };
  let closing = false;
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (config.nodeEnv === 'production')
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ${config.appUrl.replace(/^http/, 'ws')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.url.startsWith('/api/') &&
      !request.url.startsWith('/api/auth/')
    ) {
      const origin = request.headers.origin;
      if (origin && origin !== new URL(config.appUrl).origin)
        throw new HttpError(403, 'Request origin is not allowed.');
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new HttpError(403, 'Cross-site requests are not allowed.');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.status(400).send({
        error: 'Please check the supplied values.',
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
    return reply.status(status).send({
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
    if (closing) return reply.code(503).send({ status: 'stopping' });
    await pool.query('SELECT 1');
    return { status: 'ready', queue: 'running' };
  });
  await app.register(websocket, { options: { maxPayload: 33792, perMessageDeflate: false } });
  await registerAuth(app, auth, config);
  app.get('/api/me', async (request) => {
    try {
      const user = await ctx.requireActor(request);
      return {
        user,
        modes: { wick: config.wickMode, muse: config.museMode },
        commissionBps: 1500,
        catalog: await getCatalog(ctx),
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401)
        return { user: null, modes: { wick: config.wickMode, muse: config.museMode }, catalog: [] };
      throw error;
    }
  });
  app.get('/api/catalog', async (request) => {
    await ctx.requireActor(request);
    return { items: await getCatalog(ctx) };
  });
  await registerMarketplace(app, ctx);
  registerNegotiation(app, ctx);
  await registerMuse(app, ctx);
  await registerTerminal(app, ctx);
  await startMarketplaceWorkers(ctx);
  const clientRoot = resolve(options.clientRoot ?? 'dist/client');
  if (existsSync(resolve(clientRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientRoot, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.url.startsWith('/api/') ||
        request.url.startsWith('/assets/') ||
        request.method !== 'GET'
      )
        return reply.code(404).send({ error: 'Not found.' });
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
