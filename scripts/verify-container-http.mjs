import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.env.BROKER_SMOKE_URL);
assert.equal(base.protocol, 'http:');
assert.equal(base.hostname, '127.0.0.1');
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(new URL('/ready', base), { signal: AbortSignal.timeout(1000) });
    ready = response.ok;
    if (ready) break;
  } catch {}
  await delay(1000);
}
assert(ready, 'Production container must become ready within the smoke-test deadline.');
const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
assert.equal(response.status, 200);
assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
const html = await response.text();
const scriptPath = html.match(/src="(\/assets\/[^"<>]+\.js)"/)?.[1];
assert(scriptPath, 'Built homepage must reference a JavaScript asset.');
const script = await fetch(new URL(scriptPath, base), { signal: AbortSignal.timeout(5000) });
assert.equal(script.status, 200);
assert.match(script.headers.get('content-type'), /javascript/);
assert((await script.text()).length > 100);
for (const path of ['/.env', '/package.json', '/src/server/config.ts']) {
  const result = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  // SPA fallback may serve HTML, but must never expose source/configuration.
  assert(result.status === 404 || /text\/html/.test(result.headers.get('content-type') ?? ''));
}
