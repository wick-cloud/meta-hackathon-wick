import { describe, it, expect, vi } from 'vitest';
import {
  publicRepository,
  verifyPublicRepository,
  baseRefSchema,
  codingAction,
} from '../src/server/coding/contracts.js';
import { seal, open, ownerOnly } from '../src/server/coding/service.js';
import type { AppContext } from '../src/server/context.js';
describe('public coding contracts', () => {
  it('canonicalizes public GitHub URL shapes without accepting credentials or other origins', () => {
    expect(publicRepository('https://github.com/wick-cloud/example.git/').url).toBe(
      'https://github.com/wick-cloud/example',
    );
    for (const url of [
      'http://github.com/a/b',
      'https://user:secret@github.com/a/b',
      'https://github.com/a/b?token=x',
      'https://github.com/a/b/tree/main',
      'https://localhost/a/b',
      'https://github.com.evil.test/a/b',
      'git@github.com:a/b',
      'https://github.com/a/.git',
    ])
      expect(() => publicRepository(url)).toThrow();
    for (const ref of ['--upload-pack=evil', 'main..secret', 'main@{0}', 'x:y', 'a b'])
      expect(baseRefSchema.safeParse(ref).success).toBe(false);
  });
  it('checks anonymous visibility and pins a commit through bounded fixed-origin requests', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          private: false,
          visibility: 'public',
          size: 10,
          default_branch: 'main',
          full_name: 'wick-cloud/example',
        }),
      )
      .mockResolvedValueOnce(Response.json({ sha: 'a'.repeat(40) }));
    expect(
      (await verifyPublicRepository('https://github.com/wick-cloud/example', '', fetcher)).sha,
    ).toBe('a'.repeat(40));
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.github.com/repos/wick-cloud/example');
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBeUndefined();
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
    expect(fetcher.mock.calls[1]![0]).toBe(
      'https://api.github.com/repos/wick-cloud/example/commits/main',
    );
    await expect(
      verifyPublicRepository(
        'https://github.com/wick-cloud/example',
        '',
        vi.fn(async () =>
          Response.json({
            private: true,
            visibility: 'private',
            size: 1,
            default_branch: 'main',
            full_name: 'wick-cloud/example',
          }),
        ),
      ),
    ).rejects.toThrow('public repository');
  });
  it('has no model-selected shell/credentials/funding action and requires owner authority', () => {
    for (const action of [
      { action: 'shell', command: 'rm -rf /' },
      { action: 'test', command: 'echo substituted' },
      { action: 'buy' },
      { action: 'write', path: 'x', content: 'x', apiKey: 'secret' },
    ])
      expect(codingAction.safeParse(action).success).toBe(false);
    expect(() =>
      ownerOnly({
        id: 'x',
        role: 'buyer',
        apiKey: { id: 'k', grantId: 'g', scopes: [], limits: {} },
        email: 'a@b.c',
        name: 'x',
      }),
    ).toThrow('signed-in owner');
  });
  it('encrypts and authenticates job artifacts without storing plaintext', () => {
    const ctx = { config: { authSecret: 'a'.repeat(40) } } as AppContext;
    const encrypted = seal(ctx, { content: 'private retained test output' });
    expect(encrypted).not.toContain('private');
    expect(open(ctx, encrypted)).toEqual({ content: 'private retained test output' });
    expect(() =>
      open({ ...ctx, config: { ...ctx.config, authSecret: 'b'.repeat(40) } }, encrypted),
    ).toThrow();
  });
});
