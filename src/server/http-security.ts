import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { HttpError } from './context.js';
import { requestRoutePath } from './request-limits.js';

/** Register before admission/authentication so rejected requests also get security headers. */
export function registerHttpSecurity(
  app: FastifyInstance,
  config: Pick<Config, 'nodeEnv' | 'appUrl'>,
) {
  const origin = new URL(config.appUrl).origin;
  app.addHook('onRequest', async (request, reply) => {
    const path = requestRoutePath(request);
    reply
      .header('X-Request-Id', request.id)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('X-Frame-Options', 'DENY');
    if (path.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (config.nodeEnv === 'production') {
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' ${origin.replace(/^http/, 'ws')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
      );
      if (origin.startsWith('https:'))
        reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      path.startsWith('/api/') &&
      !path.startsWith('/api/auth/')
    ) {
      if (request.headers.origin && request.headers.origin !== origin)
        throw new HttpError(403, 'Request origin is not allowed.');
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new HttpError(403, 'Cross-site requests are not allowed.');
    }
  });
}
