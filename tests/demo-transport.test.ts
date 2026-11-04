import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearDraft, loadDraft, saveDraft, type Draft } from '../src/client/api';
import {
  demoAwareDraftStorage,
  demoDownloadHref,
  getDemoStore,
  resetDemoStores,
} from '../src/client/demo-store';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const draft: Draft = {
  description: 'Private account draft',
  catalogId: 'live-catalog',
  region: 'us-east-1',
  durationMinutes: 30,
  maxPriceCents: 20,
  requirements: { cpu: 2, memoryGb: 4 },
};

beforeEach(() => {
  resetDemoStores();
  vi.stubGlobal('window', {
    location: { pathname: '/demo/buyer', search: '', origin: 'https://demo.invalid' },
  });
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ live: true }), { status: 200 })),
  );
});

afterEach(() => {
  resetDemoStores();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('interactive console transport boundary', () => {
  it('blocks backend calls outside a workspace in standalone demo mode', async () => {
    vi.stubEnv('MODE', 'demo');
    for (const path of ['/', '/demos', '/login', '/orders']) {
      window.location.pathname = path;
      await expect(api('/api/me')).rejects.toMatchObject({ status: 422 });
      await expect(
        api('/api/demo/start', { method: 'POST', body: JSON.stringify({}) }),
      ).rejects.toMatchObject({ status: 422 });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported mutations and external URLs without falling through to fetch', async () => {
    await expect(
      api('/api/unknown-demo-action', { method: 'POST', body: JSON.stringify({ amount: 100 }) }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(api('https://outside.invalid/api/credits')).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps pending demo requests from recreating state after reset', async () => {
    const original = getDemoStore('buyer');
    const pending = api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Discard this pending key' }),
    });
    resetDemoStores();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDemoStore('buyer')).not.toBe(original);
    expect(getDemoStore('buyer').keys).toEqual([]);
    expect(original.keys).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts a pending demo operation on exit and leaves the live transport available', async () => {
    const pending = api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Discard this pending key' }),
    });
    window.location.pathname = '/orders';
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDemoStore('buyer').keys).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(api('/api/me')).resolves.toEqual({ live: true });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/me',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('returns snapshots so editing a response cannot mutate the demo database', async () => {
    window.location.pathname = '/demo/seller/provider/capacity';
    const first = await api<{ capacity: { total: number }; policy: { reserveSlots: number } }>(
      '/api/provider/dashboard',
    );
    first.capacity.total = 99;
    first.policy.reserveSlots = 99;
    const second = await api<typeof first>('/api/provider/dashboard');
    expect(second.capacity.total).toBe(8);
    expect(second.policy.reserveSlots).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('isolates buyer and negotiation drafts from real account storage, including reset', () => {
    sessionStorage.setItem('wick-draft', JSON.stringify(draft));
    sessionStorage.setItem('negotiation-draft', 'private-account-value');
    expect(loadDraft()).toBeNull();
    const sample = { ...draft, description: 'Sample request', catalogId: 'demo-micro-modal' };
    saveDraft(sample);
    demoAwareDraftStorage.setItem('negotiation-draft', 'sample-value');
    expect(loadDraft()).toEqual(sample);
    expect(demoAwareDraftStorage.getItem('negotiation-draft')).toBe('sample-value');
    clearDraft();
    demoAwareDraftStorage.removeItem('negotiation-draft');
    expect(loadDraft()).toBeNull();
    expect(sessionStorage.getItem('wick-draft')).toBe(JSON.stringify(draft));
    expect(sessionStorage.getItem('negotiation-draft')).toBe('private-account-value');
    saveDraft(sample);
    resetDemoStores();
    expect(loadDraft()).toBeNull();
    window.location.pathname = '/new/vm';
    expect(loadDraft()).toEqual(draft);
    expect(demoAwareDraftStorage.getItem('negotiation-draft')).toBe('private-account-value');
  });

  it('renders a local patch URL in demo mode and preserves the real download URL outside it', () => {
    const endpoint = '/api/studio/tasks/sample-task/patch';
    const patch = 'diff --git a/hello.py b/hello.py\n+print("Hello")\n';
    const href = demoDownloadHref(endpoint, patch);
    expect(href).toMatch(/^data:text\/plain;charset=utf-8,/);
    expect(decodeURIComponent(href.split(',').slice(1).join(','))).toBe(patch);
    expect(href).not.toContain('/api/');
    window.location.pathname = '/studio/tasks/real-task';
    expect(demoDownloadHref(endpoint, patch)).toBe(endpoint);
    expect(fetch).not.toHaveBeenCalled();
  });
});
