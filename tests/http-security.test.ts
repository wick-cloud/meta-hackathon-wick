import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/server/context.js';
import { registerHttpSecurity } from '../src/server/http-security.js';
import { registerRequestLimits } from '../src/server/request-limits.js';

function setup() {
  const app = Fastify();
  registerHttpSecurity(app, { nodeEnv: 'production', appUrl: 'https://broker.test' });
  registerRequestLimits(app, { authTrustRailwayProxy: false });
  app.get('/api/orders', async () => ({ items: [] }));
  app.post('/api/orders', async () => ({ accepted: true }));
  app.get('/api/keys', async () => {
    throw new HttpError(401, 'Sign in required.');
  });
  return app;
}

describe('HTTP security boundaries', () => {
  it.each(['/api/orders', '/%61pi/orders', '/api/%6frders', '/%61pi/orders?view=all'])(
    'protects the routed API regardless of path encoding: %s',
    async (url) => {
      const app = setup();
      try {
        const read = await app.inject({ url });
        expect(read.statusCode).toBe(200);
        expect(read.headers['cache-control']).toBe('no-store');
        expect(read.headers['strict-transport-security']).toBe('max-age=31536000');
        const foreignOrigin = await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'https://foreign.test' },
          payload: {},
        });
        expect(foreignOrigin.statusCode).toBe(403);
        expect(foreignOrigin.headers['cache-control']).toBe('no-store');
        const crossSite = await app.inject({
          method: 'POST',
          url,
          headers: { 'sec-fetch-site': 'cross-site' },
          payload: {},
        });
        expect(crossSite.statusCode).toBe(403);
        const sameOrigin = await app.inject({
          method: 'POST',
          url,
          headers: { origin: 'https://broker.test' },
          payload: {},
        });
        expect(sameOrigin.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it('applies no-store to authentication failures and admission rejections', async () => {
    const app = setup();
    try {
      const denied = await app.inject({ url: '/%61pi/keys' });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
      for (let i = 0; i < 300; i++)
        expect((await app.inject({ method: 'POST', url: '/api/orders' })).statusCode).toBe(200);
      const limited = await app.inject({ method: 'POST', url: '/%61pi/orders' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['cache-control']).toBe('no-store');
      expect(limited.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await app.close();
    }
  });

  it('does not impose HSTS on local HTTP development', async () => {
    const app = Fastify();
    registerHttpSecurity(app, { nodeEnv: 'development', appUrl: 'http://localhost:3000' });
    app.get('/', async () => 'local');
    try {
      const response = await app.inject('/');
      expect(response.headers['strict-transport-security']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
