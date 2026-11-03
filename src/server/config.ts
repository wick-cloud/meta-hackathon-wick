import 'dotenv/config';
import { z } from 'zod';
import { MUSE_API_BASE } from '../shared/muse.js';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  AUTH_TRUST_RAILWAY_PROXY: z.enum(['true', 'false']).default('false'),
  LIVE_DEMO_ENABLED: z.enum(['true', 'false']).default('false'),
  LIVE_DEMO_ALLOW_FIXTURES: z.enum(['true', 'false']).default('false'),
  WICK_MODE: z.enum(['fixture', 'real']),
  MUSE_MODE: z.enum(['fixture', 'real']),
  WICK_API_BASE: z.string().url().default('https://app.wick-cloud.com/api'),
  WICK_API_KEY: z.string().optional(),
  WICK_ORGANIZATION_ID: z.string().default('demo-organization'),
  WICK_GROUP_ID: z.string().default('demo-group'),
  META_API_BASE: z.string().url().default(MUSE_API_BASE),
  BASETEN_API_KEY: z.string().optional(),
  META_API_KEY: z.string().optional(),
  INFERENCE_MARKET_MODE: z.enum(['off', 'fixture', 'real']).default('off'),
  INFERENCE_QUALIFICATION_FILE: z.string().optional(),
  INFERENCE_QUALIFICATION_JSON: z.string().optional(),
  INFERENCE_BASETEN_API_KEY: z.string().optional(),
  INFERENCE_BASETEN_PROVIDER_EMAIL: z.string().email().default('baseten@providers.wick.local'),
  INFERENCE_MODAL_PROVIDER_EMAIL: z.string().email().default('modal@providers.wick.local'),
  INFERENCE_MODAL_MODEL: z.string().optional(),
  INFERENCE_MODAL_PROXY_TOKEN: z.string().optional(),
  DISKS_ENABLED: z.enum(['true', 'false']).default('false'),
  DISK_QUALIFIED_CATALOG_IDS: z
    .string()
    .max(2575)
    .default('')
    .transform((v) => [
      ...new Set(
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().min(1).max(160)).max(16)),
  MAX_CONCURRENT_VMS: z.coerce.number().int().min(1).max(20).default(20),
  STUDIO_APPROVED_COMPUTE_CATALOG_IDS: z
    .string()
    .max(2575)
    .default('')
    .transform((value) => (value.trim() ? value.split(',').map((id) => id.trim()) : []))
    .pipe(z.array(z.string().min(1).max(160)).max(16))
    .transform((ids) => [...new Set(ids)]),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env);
  const appOrigin = new URL(e.APP_URL);
  if (
    !['http:', 'https:'].includes(appOrigin.protocol) ||
    appOrigin.username ||
    appOrigin.password ||
    appOrigin.pathname !== '/' ||
    appOrigin.search ||
    appOrigin.hash
  )
    throw new Error(
      'APP_URL must be a credential-free HTTP(S) origin with no path, query or fragment.',
    );
  if (e.BETTER_AUTH_SECRET === 'replace-with-at-least-32-random-characters')
    throw new Error('Replace the example BETTER_AUTH_SECRET with a random secret before starting.');
  if (
    e.WICK_MODE === 'real' &&
    (!e.WICK_API_KEY ||
      e.WICK_ORGANIZATION_ID === 'demo-organization' ||
      e.WICK_GROUP_ID === 'demo-group')
  )
    throw new Error('Real Wick mode requires API key, organization and group IDs.');
  const museApiKey = e.BASETEN_API_KEY || e.META_API_KEY;
  if (e.MUSE_MODE === 'real' && !museApiKey)
    throw new Error('Real Muse mode requires BASETEN_API_KEY (or the legacy META_API_KEY).');
  if (e.NODE_ENV === 'production' && !e.APP_URL.startsWith('https://'))
    throw new Error('Production APP_URL must use HTTPS.');
  if (e.NODE_ENV === 'production' && e.LIVE_DEMO_ALLOW_FIXTURES === 'true')
    throw new Error('Demo fixtures are permitted only in development or test.');
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    appUrl: appOrigin.origin,
    databaseUrl: e.DATABASE_URL,
    authSecret: e.BETTER_AUTH_SECRET,
    authTrustRailwayProxy: e.AUTH_TRUST_RAILWAY_PROXY === 'true',
    liveDemoEnabled: e.LIVE_DEMO_ENABLED === 'true',
    liveDemoAllowFixtures: e.LIVE_DEMO_ALLOW_FIXTURES === 'true',
    wickMode: e.WICK_MODE,
    museMode: e.MUSE_MODE,
    wickApiBase: e.WICK_API_BASE,
    wickApiKey: e.WICK_API_KEY,
    wickOrganizationId: e.WICK_ORGANIZATION_ID,
    wickGroupId: e.WICK_GROUP_ID,
    metaApiBase: e.META_API_BASE,
    metaApiKey: museApiKey,
    inferenceMarketMode: e.INFERENCE_MARKET_MODE,
    inferenceQualificationFile: e.INFERENCE_QUALIFICATION_FILE,
    inferenceQualificationJson: e.INFERENCE_QUALIFICATION_JSON,
    inferenceBasetenApiKey: e.INFERENCE_BASETEN_API_KEY || museApiKey,
    inferenceBasetenProviderEmail: e.INFERENCE_BASETEN_PROVIDER_EMAIL,
    inferenceModalProviderEmail: e.INFERENCE_MODAL_PROVIDER_EMAIL,
    inferenceModalModel: e.INFERENCE_MODAL_MODEL,
    inferenceModalProxyToken: e.INFERENCE_MODAL_PROXY_TOKEN,
    maxConcurrentVms: e.MAX_CONCURRENT_VMS,
    disksEnabled: e.DISKS_ENABLED === 'true',
    diskQualifiedCatalogIds: e.DISK_QUALIFIED_CATALOG_IDS,
    studioApprovedComputeCatalogIds: e.STUDIO_APPROVED_COMPUTE_CATALOG_IDS,
    logLevel: e.LOG_LEVEL,
  };
}
export type Config = ReturnType<typeof loadConfig> & {
  /** Internal isolated-run hook; not read from user environment or HTTP input. */
  environmentNamePrefix?: string;
};
