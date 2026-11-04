import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createRequireActor,
  registerBrokerKeyAccess,
  type createAuth,
} from '../src/server/auth.js';
import { registerRequestLimits } from '../src/server/request-limits.js';

function credential() {
  return `Bearer wbk_${randomUUID()}.${'s'.repeat(43)}`;
}
function protectedApp(query: ReturnType<typeof vi.fn>, trusted = false) {
  const app = Fastify();
  registerRequestLimits(app, { authTrustRailwayProxy: trusted });
  registerBrokerKeyAccess(
    app,
    createRequireActor({} as ReturnType<typeof createAuth>, { query } as unknown as Pool),
  );
  app.get('/api/me', async () => ({ ok: true }));
  return app;
}

describe('preauthentication admission', () => {
  it('shares admission between canonical and encoded API paths before session lookups', async () => {
    const app = Fastify();
    const query = vi.fn(async () => ({ ok: true }));
    registerRequestLimits(app, { authTrustRailwayProxy: false });
    app.post('/api/requests', query);
    try {
      for (let i = 0; i < 300; i++) {
        const response = await app.inject({
          method: 'POST',
          url: i % 2 ? '/%61pi/requests?path=/api/auth/' : '/api/%72equests',
        });
        expect(response.statusCode).toBe(200);
      }
      expect((await app.inject({ method: 'POST', url: '/api/requests' })).statusCode).toBe(429);
      expect((await app.inject({ method: 'POST', url: '/%61pi/requests' })).statusCode).toBe(429);
      expect(query).toHaveBeenCalledTimes(300);
    } finally {
      await app.close();
    }
  });

  it('keeps encoded authentication paths in the stricter auth bucket', async () => {
    const app = Fastify();
    registerRequestLimits(app, { authTrustRailwayProxy: false });
    app.post('/api/auth/*', async () => ({ ok: true }));
    app.post('/api/requests', async () => ({ ok: true }));
    try {
      for (let i = 0; i < 20; i++)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: i % 2 ? '/%61pi/auth/sign-in/email' : '/api/%61uth/sign-in/email',
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/sign-in/email' })).statusCode,
      ).toBe(429);
      expect(
        (await app.inject({ method: 'POST', url: '/%61pi/%61uth/sign-in/email' })).statusCode,
      ).toBe(429);
      expect((await app.inject({ method: 'POST', url: '/api/requests' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('releases HTTP admission after WebSocket authentication instead of retaining reconnect slots', async () => {
    const app = Fastify();
    registerRequestLimits(app, { authTrustRailwayProxy: false });
    await app.register(websocket);
    app.get('/api/socket', { websocket: true }, () => {});
    await app.ready();
    const sockets = [];
    try {
      for (let i = 0; i < 65; i++) sockets.push(await app.injectWS('/api/socket'));
      expect(sockets).toHaveLength(65);
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
    }
  });
  it('bounds invalid well-formed keys before PostgreSQL and ignores spoofed forwarding headers', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const app = protectedApp(query);
    try {
      for (let i = 0; i < 1200; i++) {
        const response = await app.inject({
          url: '/api/me',
          headers: {
            authorization: credential(),
            'x-real-ip': `192.0.${Math.floor(i / 250)}.${(i % 250) + 1}`,
            'x-forwarded-for': `198.51.100.${(i % 250) + 1}`,
          },
        });
        expect(response.statusCode).toBe(401);
      }
      expect(
        (await app.inject({ url: '/api/me', headers: { authorization: credential() } })).statusCode,
      ).toBe(429);
      expect(query).toHaveBeenCalledTimes(1200);
    } finally {
      await app.close();
    }
  });

  it('only uses the opted-in edge IP, ignoring conflicting forwarded chains', async () => {
    const app = Fastify();
    registerRequestLimits(app, { authTrustRailwayProxy: true });
    app.post('/api/auth/sign-in/email', async () => ({ ok: true }));
    try {
      for (let i = 0; i < 20; i++)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/auth/sign-in/email',
              headers: {
                'x-real-ip': '192.0.2.1',
                'x-forwarded-for': `198.51.100.${i + 1}`,
              },
            })
          ).statusCode,
        ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/email',
            headers: {
              'x-real-ip': '192.0.2.1',
              'x-forwarded-for': '203.0.113.1',
            },
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/sign-in/email',
            headers: {
              'x-real-ip': '192.0.2.2',
              'x-forwarded-for': '203.0.113.1',
            },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    'bounds concurrent authentication queries (global=%s) and releases completed requests',
    async (global) => {
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let admitted!: () => void;
      const target = global ? 256 : 64;
      const started = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      let calls = 0;
      const query = vi.fn(async () => {
        if (++calls === target) admitted();
        await gate;
        return { rows: [] };
      });
      const app = protectedApp(query, global);
      await app.ready();
      const pending = Array.from({ length: target }, (_, index) =>
        app
          .inject({
            url: '/api/me',
            headers: {
              authorization: credential(),
              'x-real-ip': `192.0.2.${Math.floor(index / 64) + 1}`,
            },
          })
          .then((response) => response.statusCode),
      );
      try {
        await started;
        expect(
          (
            await app.inject({
              url: '/api/me',
              headers: {
                authorization: credential(),
                'x-real-ip': '192.0.2.99',
              },
            })
          ).statusCode,
        ).toBe(429);
        expect(query).toHaveBeenCalledTimes(target);
        unblock();
        expect((await Promise.all(pending)).every((status) => status === 401)).toBe(true);
        expect(
          (await app.inject({ url: '/api/me', headers: { authorization: credential() } }))
            .statusCode,
        ).toBe(401);
        expect(query).toHaveBeenCalledTimes(target + 1);
      } finally {
        unblock();
        await Promise.all(pending);
        await app.close();
      }
    },
  );
});
