import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { HttpError } from './context.js';

type ProxyConfig = Pick<Config, 'authTrustRailwayProxy'>;

/** Use the router's canonical path: encoded static segments still match API routes. */
export function requestRoutePath(request: FastifyRequest): string {
  if (request.routeOptions.url) return request.routeOptions.url;
  const path = request.url.split('?')[0]!;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Forwarded headers are authoritative only at the explicitly configured Railway edge. */
export function clientAddress(request: FastifyRequest, config: ProxyConfig): string {
  const edge = request.headers['x-real-ip'];
  const address =
    config.authTrustRailwayProxy && typeof edge === 'string' && isIP(edge.trim())
      ? edge.trim()
      : (request.raw.socket?.remoteAddress ?? 'unknown');
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export function requestLimit(retryAfter = 60): HttpError & { retryAfter: number } {
  return Object.assign(new HttpError(429, 'Request limit reached. Try again shortly.'), {
    retryAfter,
  });
}

/** Install before authentication: invalid credentials must not have unlimited DB access. */
export function registerRequestLimits(app: FastifyInstance, config: ProxyConfig) {
  const buckets = new Map<string, { until: number; count: number; writes: number }>();
  const active = new Map<string, number>();
  const releases = new WeakMap<FastifyRequest, () => void>();
  let total = 0;
  const release = (request: FastifyRequest) => releases.get(request)?.();
  app.addHook('onRequest', async (request) => {
    const path = requestRoutePath(request);
    if (!path.startsWith('/api/') && request.headers.authorization === undefined) return;
    const address = clientAddress(request, config);
    const now = Date.now();
    const auth = path.startsWith('/api/auth/');
    const key = `${auth ? 'auth' : 'api'}:${address}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 4000)
        for (const [id, entry] of buckets) if (entry.until <= now) buckets.delete(id);
      if (buckets.size >= 4000 && !buckets.has(key)) throw requestLimit();
      bucket = { until: now + 60_000, count: 0, writes: 0 };
      buckets.set(key, bucket);
    }
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (bucket.count >= (auth ? 60 : 1200) || (write && bucket.writes >= (auth ? 20 : 300)))
      throw requestLimit(Math.max(1, Math.ceil((bucket.until - now) / 1000)));
    bucket.count++;
    if (write) bucket.writes++;
    const concurrent = active.get(address) ?? 0;
    if (total >= 256 || concurrent >= 64) throw requestLimit(1);
    total++;
    active.set(address, concurrent + 1);
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      clearTimeout(expiry);
      releases.delete(request);
      total--;
      const remaining = (active.get(address) ?? 1) - 1;
      if (remaining) active.set(address, remaining);
      else active.delete(address);
    };
    // Aborting a socket must not immediately free capacity while its auth query is running.
    // This lease recovers slots if a disconnected handler never emits a response.
    const expiry = setTimeout(done, 180_000);
    expiry.unref();
    releases.set(request, done);
  });
  app.addHook('onResponse', async (request) => release(request));
  app.addHook('onError', async (request) => release(request));
  app.addHook('preHandler', async (request) => {
    // Upgrades do not emit onResponse. Authentication/preValidation is complete;
    // the terminal bridge enforces its own connection and lifetime limits.
    if (request.ws) release(request);
  });
}
