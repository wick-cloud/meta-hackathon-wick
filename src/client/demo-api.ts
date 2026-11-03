import { demoSession, getDemoStore, DemoError, type DemoRole } from './demo-store';
import { handleBuyerDemo } from './demo-buyer-api';
import { handleSellerDemo } from './demo-seller-api';

/** Explicit local transport. An unimplemented action fails closed, never falls through to fetch. */
export function demoRequest(role: DemoRole, url: string, options: RequestInit = {}) {
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const parsed = new URL(url, window.location.origin);
  if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/'))
    throw new DemoError('External requests are unavailable in the demo.', 400);
  const method = (options.method ?? 'GET').toUpperCase();
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
  const store = getDemoStore(role);
  let result: unknown;
  if (parsed.pathname === '/api/me') result = demoSession(role);
  else if (parsed.pathname === '/api/keys' && method === 'GET')
    result = { items: store.keys, nextCursor: null };
  else if (parsed.pathname === '/api/keys' && method === 'POST') {
    if (!body.name?.trim()) throw new DemoError('Give this key a name.');
    const id = `demo-key-${store.keys.length + 1}`;
    const key = {
      id,
      name: body.name,
      prefix: 'demo_not_a_real_key',
      scopes: body.scopes ?? [],
      limits: body.limits ?? {},
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (body.expiresInDays ?? 30) * 86400000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    store.keys.unshift(key);
    result = { key, token: `DEMO_ONLY_NOT_A_VALID_CREDENTIAL_${id}` };
  } else if (parsed.pathname.startsWith('/api/keys/') && method === 'DELETE') {
    const key = store.keys.find((key) => key.id === parsed.pathname.split('/').at(-1));
    if (key) key.revokedAt = new Date().toISOString();
    result = { ok: true };
  } else
    result = (role === 'buyer' ? handleBuyerDemo : handleSellerDemo)(
      method,
      parsed.pathname + parsed.search,
      body,
      store,
    );
  if (result === undefined)
    throw new DemoError(
      'This action is not included in the sample workspace. Explore another area or reset the demo.',
      422,
    );
  // Match HTTP snapshot semantics: callers cannot accidentally mutate the mock database.
  return structuredClone(result);
}
