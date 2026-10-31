import { afterEach, describe, it, expect, vi } from 'vitest';
import { createWickAdapter } from '../src/server/integrations/wick.js';
const config = {
  wickMode: 'real' as const,
  wickApiBase: 'https://wick.fixture.invalid/api',
  wickApiKey: 'synthetic-fixture-key',
  wickOrganizationId: 'fixture-org',
  wickGroupId: 'fixture-group',
};
afterEach(() => vi.unstubAllGlobals());
describe('Wick structured coding commands', () => {
  it.each(['e2b', 'daytona', 'modal', 'provider-blaxel'])(
    'uses the same bounded SDK command contract for %s without affecting PTY',
    async (provider) => {
      const fetcher = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
        Response.json({
          stdout: '{"state":"completed"}',
          stderr: '',
          exitCode: 0,
          simulated: false,
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      const adapter = createWickAdapter(config);
      const result = await adapter.runCommand!('env_' + provider, {
        command: 'python3 -c "print(1)"',
      });
      expect(result.exitCode).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]![0])).toBe(
        `https://wick.fixture.invalid/api/v1/environments/env_${provider}/commands`,
      );
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
        command: 'python3 -c "print(1)"',
      });
      expect(typeof adapter.terminal).toBe('function');
    },
  );
  it('does not retry a mutation after an ambiguous transport failure', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('raw upstream detail must stay private');
    });
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createWickAdapter(config).runCommand!('env_fixture', { command: 'safe-fixture' }),
    ).rejects.toThrow('outcome requires reconciliation');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects simulated receipts and oversized payloads on a real adapter', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ stdout: '', stderr: '', exitCode: 0, simulated: true }),
    );
    vi.stubGlobal('fetch', fetcher);
    const adapter = createWickAdapter(config);
    await expect(adapter.runCommand!('env_fixture', { command: 'x' })).rejects.toThrow(
      'invalid command receipt',
    );
    await expect(
      adapter.runCommand!('env_fixture', { command: 'x'.repeat(16001) }),
    ).rejects.toThrow('limit');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
