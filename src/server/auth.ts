import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';
import { packKeyRoute, publicRoute } from '../shared/developer.js';
import type { Config } from './config.js';
import type { Actor, Role } from '../shared/types.js';
import { HttpError } from './context.js';
import { clientAddress } from './request-limits.js';
export function createAuth(config: Config, pool: Pool) {
  return betterAuth({
    database: pool,
    secret: config.authSecret,
    baseURL: config.appUrl,
    basePath: '/api/auth',
    trustedOrigins: [config.appUrl],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    user: {
      additionalFields: {
        role: { type: 'string', required: true, defaultValue: 'buyer', input: false },
        providerId: { type: 'string', required: false, input: false },
      },
    },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies: config.nodeEnv === 'production',
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      // registerAuth supplies this header from our explicit ingress trust policy.
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
  });
}
declare module 'fastify' {
  interface FastifyRequest {
    brokerActor?: Actor;
  }
}

/** The only accepted machine credential is a Broker-issued key, never a Wick key. */
export function createRequireActor(auth: ReturnType<typeof createAuth>, pool: Pool) {
  const checked = new WeakMap<FastifyRequest, { actor: Actor; at: number }>();
  const rates = new Map<string, { count: number; writes: number; until: number }>();
  const chargedRequests = new WeakSet<FastifyRequest>();
  function budget(id: string, max: number, writeMax: number, write: boolean) {
    const now = Date.now();
    let entry = rates.get(id);
    if (!entry || entry.until <= now) {
      if (rates.size >= 4000)
        for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
      if (rates.size >= 4000 && !rates.has(id))
        throw Object.assign(
          new HttpError(429, 'Broker API request limit reached. Try again shortly.'),
          { retryAfter: 60 },
        );
      entry = { count: 0, writes: 0, until: now + 60000 };
      rates.set(id, entry);
    }
    if (entry.count >= max || (write && entry.writes >= writeMax))
      throw Object.assign(
        new HttpError(429, 'Broker API request limit reached. Try again shortly.'),
        { retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)) },
      );
    entry.count++;
    if (write) entry.writes++;
  }
  return async (request: FastifyRequest, roles?: Role[]): Promise<Actor> => {
    const cached = checked.get(request);
    let actor: Actor;
    // A terminal reuses its upgrade request. A short cache only coalesces the initial
    // hook/handler; the existing two-second socket check always revalidates the key.
    if (cached && Date.now() - cached.at < 500) actor = cached.actor;
    else if (request.headers.authorization !== undefined) {
      const authorization = request.headers.authorization;
      const match =
        typeof authorization === 'string' &&
        /^Bearer (wbk_([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}))\.([A-Za-z0-9_-]{43})$/i.exec(
          authorization,
        );
      if (!match)
        throw new HttpError(401, 'A valid Broker API key is required. Wick keys are not accepted.');
      const row = (
        await pool.query(
          `SELECT k.id key_id,k.grant_id,k.pack_id,k.secret_digest,k.scopes,k.limits,k.issued_role,k.issued_provider_id,k.last_used_at,
        u.id,u.email,u.name,u.role,u."providerId",p.id::text actual_provider_id,
        (k.revoked_at IS NULL AND k.expires_at>clock_timestamp()
          AND(k.parent_key_id IS NULL OR(parent.revoked_at IS NULL AND parent.expires_at>clock_timestamp()
            AND parent.user_id=k.user_id AND parent.grant_id=k.grant_id AND parent.pack_id IS NULL
            AND parent.issued_role=u.role AND parent.scopes ? 'tokens:buy'))) active
        FROM broker_api_keys k JOIN "user" u ON u.id=k.user_id
        LEFT JOIN broker_api_keys parent ON parent.id=k.parent_key_id
        LEFT JOIN broker_providers p ON p.user_id=u.id WHERE k.id=$1`,
          [match[2]],
        )
      ).rows[0];
      const actual = createHash('sha256').update(match[3]!).digest();
      const expected = row ? Buffer.from(row.secret_digest, 'hex') : Buffer.alloc(32);
      const verified =
        expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
      if (
        !row ||
        !verified ||
        !row.active ||
        row.role !== row.issued_role ||
        (row.role === 'provider' &&
          (row.issued_provider_id !== row.providerId ||
            row.actual_provider_id !== row.issued_provider_id))
      )
        throw new HttpError(
          401,
          'This Broker API key is invalid, expired, revoked or no longer matches its account.',
        );
      const route = publicRoute(request.method, request.routeOptions.url);
      if (row.pack_id && !packKeyRoute(request.method, request.routeOptions.url))
        throw new HttpError(403, 'This batch key permits only its purchased token quota.');
      const scope =
        route?.scope ??
        (request.method === 'GET' && request.routeOptions.url === '/api/openapi.json'
          ? 'account:read'
          : undefined);
      if (!scope || !Array.isArray(row.scopes) || !row.scopes.includes(scope))
        throw new HttpError(403, 'This Broker API key does not permit this action.');
      if (!chargedRequests.has(request)) {
        budget(`key:${row.key_id}`, 300, 60, route?.mutation === true);
      }
      actor = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        ...(row.providerId ? { providerId: row.providerId } : {}),
        apiKey: {
          id: row.key_id,
          scopes: row.scopes,
          limits: row.limits,
          ...(row.grant_id ? { grantId: row.grant_id } : {}),
          ...(row.pack_id ? { packId: row.pack_id } : {}),
        },
      };
      if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() >= 60000)
        await pool.query(
          "UPDATE broker_api_keys SET last_used_at=clock_timestamp() WHERE id=$1 AND(last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')",
          [row.key_id],
        );
      checked.set(request, { actor, at: Date.now() });
    } else {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) throw new HttpError(401, 'Please sign in to continue.');
      const { rows } = await pool.query(
        'SELECT id,email,name,role,"providerId" FROM "user" WHERE id=$1',
        [session.user.id],
      );
      actor = rows[0] as Actor;
      if (!actor) throw new HttpError(401, 'This account is no longer active.');
    }
    if (!chargedRequests.has(request)) {
      budget(`user:${actor.id}`, 600, 120, !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
      chargedRequests.add(request);
    }
    if (roles && !roles.includes(actor.role))
      throw new HttpError(403, 'This action is not available for your role.');
    request.brokerActor = actor;
    return actor;
  };
}

export function registerBrokerKeyAccess(
  app: FastifyInstance,
  requireActor: (request: FastifyRequest) => Promise<Actor>,
) {
  app.addHook('onRequest', async (request) => {
    if (request.headers.authorization !== undefined) await requireActor(request);
  });
  app.addHook('preHandler', async (request) => {
    if (
      !request.brokerActor?.apiKey ||
      !publicRoute(request.method, request.routeOptions.url)?.mutation
    )
      return;
    const header = request.headers['idempotency-key'];
    const body = request.body;
    const value =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).operationKey
        : undefined;
    if (
      header !== undefined &&
      (typeof header !== 'string' || (value !== undefined && value !== header))
    )
      throw new HttpError(400, 'Idempotency-Key must match body.operationKey.');
    const key = header ?? value;
    if (typeof key !== 'string' || !/^[-A-Za-z0-9_:./]{8,160}$/.test(key))
      throw new HttpError(
        400,
        'Machine mutations require an operation key of 8–160 safe characters.',
      );
    if (body === undefined || body === null) request.body = { operationKey: key };
    else if (typeof body === 'object' && !Array.isArray(body))
      (body as Record<string, unknown>).operationKey = key;
    else throw new HttpError(400, 'Supply a JSON object for this mutation.');
  });
}
export async function registerAuth(
  app: FastifyInstance,
  auth: ReturnType<typeof createAuth>,
  config: Config,
) {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.raw.url!, config.appUrl);
      const headers = fromNodeHeaders(request.headers);
      headers.set('x-real-ip', clientAddress(request, config));
      headers.delete('x-forwarded-for');
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(request.method !== 'GET' && request.method !== 'HEAD'
            ? { body: JSON.stringify(request.body ?? {}) }
            : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
}
