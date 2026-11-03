import Fastify, { type HTTPMethods } from 'fastify';
import { expect, it, vi } from 'vitest';
import { HttpError, type AppContext } from '../src/server/context.js';
import { registerMarketplace } from '../src/server/marketplace/index.js';
import { registerOrders } from '../src/server/orders.js';
import { registerAgreements } from '../src/server/agreements/index.js';
import { registerAgreementBilling } from '../src/server/agreement-billing.js';
import { registerDeveloperKeys } from '../src/server/developer-keys.js';
import { registerInference } from '../src/server/inference/index.js';
import { registerCoding } from '../src/server/coding/index.js';
import { registerStudio } from '../src/server/coding/studio-api.js';
import { registerDisks } from '../src/server/disks/index.js';
import { registerMuse } from '../src/server/muse/index.js';
import { registerNegotiation } from '../src/server/marketplace/negotiation.js';

it('denies every registered private business route before database or provider access', async () => {
  const app = Fastify();
  const routes: { method: HTTPMethods; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      if (method !== 'HEAD') routes.push({ method, url: route.url });
  });
  const forbidden = vi.fn(() => {
    throw new Error('Unauthenticated data access');
  });
  const requireActor = vi.fn(async () => {
    throw new HttpError(401, 'Authentication required');
  });
  const ctx = {
    config: { appUrl: 'https://broker.test', wickMode: 'fixture', museMode: 'fixture' },
    pool: { query: forbidden, connect: forbidden },
    boss: { send: forbidden },
    wick: { mode: 'fixture', catalog: forbidden, runCommand: forbidden },
    muse: { translate: forbidden, proposeOfferings: forbidden },
    requireActor,
  } as unknown as AppContext;
  await registerMarketplace(app, ctx);
  registerOrders(app, ctx);
  await registerAgreements(app, ctx);
  registerAgreementBilling(app, ctx);
  await registerDeveloperKeys(app, ctx);
  await registerInference(app, ctx);
  registerCoding(app, ctx);
  registerStudio(app, ctx);
  await registerDisks(app, ctx);
  await registerMuse(app, ctx);
  registerNegotiation(app, ctx);
  await app.ready();
  const id = '44444444-4444-4444-8444-444444444444';
  try {
    expect(routes.length).toBeGreaterThan(100);
    for (const route of routes) {
      const payload =
        route.url === '/api/muse/translate'
          ? { description: 'A small Linux VM for development' }
          : route.url.endsWith('/buying/accept')
            ? { decisionId: id }
            : {};
      requireActor.mockClear();
      const response = await app.inject({
        method: route.method,
        url: route.url.replace(/:[A-Za-z]+/g, id),
        headers: { origin: 'https://broker.test' },
        ...(['GET', 'HEAD'].includes(route.method) ? {} : { payload }),
      });
      expect(response.statusCode, `${route.method} ${route.url}: ${response.body}`).toBe(401);
      expect(
        requireActor,
        `${route.method} ${route.url} must check authentication`,
      ).toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    }
  } finally {
    await app.close();
  }
});
