import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const env = {
  DATABASE_URL: 'postgresql://localhost/fixture',
  BETTER_AUTH_SECRET: 'offline-fixture-auth-secret-at-least-32-characters',
  WICK_MODE: 'fixture',
  MUSE_MODE: 'fixture',
};

describe('Baseten Muse server configuration', () => {
  it('defaults to the Baseten endpoint without enabling live calls', () => {
    expect(loadConfig(env)).toMatchObject({
      museMode: 'fixture',
      metaApiBase: 'https://inference.baseten.co/v1',
      metaApiKey: undefined,
    });
  });

  it('uses the private Baseten key in real mode and keeps the legacy alias compatible', () => {
    expect(
      loadConfig({ ...env, MUSE_MODE: 'real', BASETEN_API_KEY: 'offline-baseten-key' }).metaApiKey,
    ).toBe('offline-baseten-key');
    expect(
      loadConfig({ ...env, MUSE_MODE: 'real', META_API_KEY: 'offline-legacy-key' }).metaApiKey,
    ).toBe('offline-legacy-key');
    expect(
      loadConfig({
        ...env,
        MUSE_MODE: 'real',
        BASETEN_API_KEY: 'offline-baseten-key',
        META_API_KEY: 'offline-legacy-key',
      }).metaApiKey,
    ).toBe('offline-baseten-key');
  });

  it('fails explicitly when real mode has no key', () => {
    expect(() => loadConfig({ ...env, MUSE_MODE: 'real' })).toThrow('BASETEN_API_KEY');
  });
});
