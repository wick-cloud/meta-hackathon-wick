import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../../shared/types.js';
import { HttpError, type AppContext } from '../context.js';

export const DEMO_COOKIE = 'wick_demo';
export interface DemoIdentity {
  visitorDigest: string;
  ipDigest: string;
}
export function demoIpDigest(ctx: AppContext, request: FastifyRequest): string {
  const edge = request.headers['x-real-ip'];
  const raw =
    ctx.config.authTrustRailwayProxy && typeof edge === 'string' && isIP(edge.trim())
      ? edge.trim()
      : (request.raw.socket.remoteAddress ?? 'unknown');
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return createHmac('sha256', ctx.config.authSecret)
    .update(`homepage-demo-ip:${address}`)
    .digest('hex');
}
export function demoIdentity(ctx: AppContext, request: FastifyRequest): DemoIdentity | null {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${DEMO_COOKIE}=`));
  if (matches.length !== 1) return null;
  const secret = matches[0].slice(DEMO_COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return {
    visitorDigest: createHash('sha256').update(secret).digest('hex'),
    ipDigest: demoIpDigest(ctx, request),
  };
}
export function createDemoIdentity(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): DemoIdentity {
  const prior = demoIdentity(ctx, request);
  // Refresh the existing cookie before admission, without changing its identity.
  // An old cookie must not expire while its newly started VM is still running.
  const secret = prior
    ? (request.headers.cookie ?? '')
        .split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${DEMO_COOKIE}=`))!
        .slice(DEMO_COOKIE.length + 1)
    : randomBytes(32).toString('base64url');
  reply.header(
    'Set-Cookie',
    `${DEMO_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${ctx.config.nodeEnv === 'production' ? '; Secure' : ''}`,
  );
  return (
    prior ?? {
      visitorDigest: createHash('sha256').update(secret).digest('hex'),
      ipDigest: demoIpDigest(ctx, request),
    }
  );
}
/** Deliberately scoped to terminal authorization; never used by normal application APIs. */
export async function demoTerminalActor(
  ctx: AppContext,
  request: FastifyRequest,
  vmId?: string,
): Promise<Actor> {
  const identity = demoIdentity(ctx, request);
  const selectedVm = vmId ?? (request.params as { id?: string } | undefined)?.id;
  if (!ctx.config.liveDemoEnabled || !identity || !selectedVm)
    throw new HttpError(401, 'Start a demo to open its terminal.');
  const row = (
    await ctx.pool.query(
      `SELECT u.id,u.email,u.name,u.role FROM broker_demo_runs d
     JOIN broker_demo_visitors v ON v.id=d.visitor_id JOIN "user" u ON u.id=d.buyer_id
     JOIN broker_vms vm ON vm.id=d.vm_id AND vm.buyer_id=d.buyer_id
     WHERE v.secret_digest=$1 AND d.vm_id=$2 AND d.status='ready' AND NOT d.stop_requested
     AND d.ended_at IS NULL AND d.expires_at>clock_timestamp() AND vm.expires_at>clock_timestamp()
     AND vm.status='running' AND vm.cleanup_confirmed_at IS NULL AND u.role='buyer'
     AND d.source_mode=$3`,
      [identity.visitorDigest, selectedVm, ctx.wick.mode],
    )
  ).rows[0];
  if (!row) throw new HttpError(403, 'This demo terminal is unavailable or has expired.');
  return row as Actor;
}
