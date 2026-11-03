import { afterEach, describe, expect, it, vi } from 'vitest';
import { realDrives } from '../src/server/integrations/drives.js';
import {
  createWickAdapter,
  parseCatalog,
  parseEnvironment,
} from '../src/server/integrations/wick.js';
import { diskCatalogEligible, observeVmDisk } from '../src/server/disks/service.js';
import type { AppContext } from '../src/server/context.js';

const config = {
  wickMode: 'real' as const,
  wickApiBase: 'https://wick.example/api',
  wickApiKey: 'service-secret',
  wickOrganizationId: 'org',
  wickGroupId: 'group',
};
const native = {
  id: 'drive_1',
  organizationId: 'org',
  groupId: 'group',
  name: 'Research',
  visibility: 'private',
  attachmentMode: 'shared',
  status: 'ready',
  initialized: true,
  attachments: [],
  createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
};
const envelope = { drive: native, operation: { id: 'op_1', status: 'succeeded' } };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('persistent disk native contract', () => {
  it('creates a private shared drive using a stable key without inventing capacity or prices', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope)));
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await realDrives(config).create({ name: 'Research' }, 'original-disk-key')).drive.id,
    ).toBe('drive_1');
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('https://wick.example/api/v1/organizations/org/drives');
    expect(JSON.parse(options.body as string)).toEqual({
      groupId: 'group',
      name: 'Research',
      visibility: 'private',
      attachmentMode: 'shared',
      seed: { kind: 'empty' },
    });
    expect((options.headers as Record<string, string>)['idempotency-key']).toBe(
      'original-disk-key',
    );
    expect(options.redirect).toBe('error');
  });
  it('rejects tenant drift and sanitizes upstream errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...envelope, drive: { ...native, groupId: 'somebody-else' } }),
          ),
      ),
    );
    await expect(realDrives(config).get('drive_1')).rejects.toThrow('identity');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('provider-secret service-secret', { status: 500 })),
    );
    await expect(realDrives(config).get('drive_1')).rejects.toThrow('HTTP 500');
    await expect(realDrives(config).get('drive_1')).rejects.not.toThrow('provider-secret');
  });
  it('keeps mount identity and capabilities from the current public schema', () => {
    const workspaceDrive = {
      driveId: 'drive_1',
      generation: 'gen_1',
      status: 'mounted',
      attachmentMode: 'shared',
      accessMode: 'mount',
      workspacePath: '/workspace',
      seedRequired: false,
    };
    expect(
      parseEnvironment({ id: 'env_1', status: 'running', workspaceDrive }).workspaceDrive,
    ).toMatchObject({ driveId: 'drive_1', generation: 'gen_1', status: 'mounted' });
    const items = parseCatalog(
      {
        profiles: [{ id: 'small', name: 'Small', cpu: 2, memoryMiB: 4096 }],
        offers: [
          {
            provider: 'e2b',
            profile: 'small',
            region: 'us',
            available: true,
            byok: { enabled: false },
            rateMicrosPerSecond: 5,
            maxTtlSeconds: 3600,
            capabilities: ['interactive-terminal', 'persistent-drives'],
          },
        ],
      },
      config,
    );
    expect(items[0]?.capabilities).toContain('persistent-drives');
  });
  it('passes the native mount through the published SDK JSON transport', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.workspaceDrive).toEqual({ driveId: 'drive_1', accessMode: 'mount' });
      return new Response(
        JSON.stringify({
          environment: { id: 'env_1', status: 'provisioning' },
          operation: { id: 'op_1', status: 'running' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    await createWickAdapter(config).create(
      {
        organizationId: 'org',
        groupId: 'group',
        name: 'Test',
        provider: 'e2b',
        profile: 'small',
        region: 'us',
        ttlSeconds: 1800,
        maximumPriceMicrosPerSecond: 5,
        visibility: 'private',
        workspaceDrive: { driveId: 'drive_1', accessMode: 'mount' },
      },
      'original-create-key',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires explicit qualification and mount support per real catalog route', () => {
    const ctx = {
      config: { disksEnabled: true, diskQualifiedCatalogIds: ['e2b:small:us'] },
      wick: { mode: 'real', drives: {} },
    } as unknown as AppContext;
    const item = { id: 'e2b:small:us', approved: true, capabilities: ['persistent-drives'] } as any;
    expect(diskCatalogEligible(ctx, item)).toBe(true);
    expect(diskCatalogEligible(ctx, { ...item, id: 'daytona:small:us' })).toBe(false);
    expect(diskCatalogEligible(ctx, { ...item, capabilities: ['shared-files'] })).toBe(false);
    ctx.config.disksEnabled = false;
    expect(diskCatalogEligible(ctx, item)).toBe(false);
  });
  it('does not confirm files-mode, stale generations, or a mount on another environment', async () => {
    const query = vi.fn(async (sql: string) =>
      sql.startsWith('SELECT')
        ? { rows: [{ id: 'disk_1', source_mode: 'real', upstream_id: 'drive_1' }] }
        : { rowCount: 0 },
    );
    const ctx = { pool: { query }, wick: { mode: 'real' } } as unknown as AppContext;
    const vm = {
      id: 'vm_1',
      disk_id: 'disk_1',
      buyer_id: 'buyer',
      environment_id: 'env_1',
      create_input: { workspaceDrive: { driveId: 'drive_1' } },
    };
    const env = {
      id: 'env_1',
      status: 'running' as const,
      expiresAt: null,
      workspaceDrive: {
        driveId: 'drive_1',
        generation: 'old',
        status: 'mounted',
        attachmentMode: 'shared' as const,
        accessMode: 'mount' as const,
        workspacePath: '/workspace',
      },
    };
    expect(await observeVmDisk(ctx, vm, env)).toBe(false);
    expect(
      await observeVmDisk(ctx, vm, {
        ...env,
        workspaceDrive: { ...env.workspaceDrive, accessMode: 'files' },
      }),
    ).toBe(false);
    expect(await observeVmDisk(ctx, vm, { ...env, id: 'env_other' })).toBe(false);
  });
});
