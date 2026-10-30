import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import type { Actor, Role } from '../shared/types.js';
import type { WickAdapter, MuseAdapter } from './integrations/types.js';
import type { Config } from './config.js';
import type { InferenceRuntime } from './inference/runtime.js';
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AppContext {
  pool: Pool;
  boss: PgBoss;
  config: Config;
  wick: WickAdapter;
  muse: MuseAdapter;
  inference?: InferenceRuntime;
  requireActor(request: FastifyRequest, roles?: Role[]): Promise<Actor>;
}
