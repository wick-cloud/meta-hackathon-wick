import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

// Exercise the static plugin's overridden glob dependency through its public API.
const directory = await mkdtemp(join(tmpdir(), 'broker-static-'));
const root = join(directory, 'public');
const app = Fastify();
try {
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html>fixture homepage</html>');
  await writeFile(join(root, 'assets', 'app-a1b2.js'), 'console.log("fixture asset");');
  await writeFile(join(root, '.private'), 'private fixture');
  await writeFile(join(directory, 'outside.txt'), 'outside fixture');
  await app.register(fastifyStatic, { root, prefix: '/', wildcard: false });
  await app.ready();
  const homepage = await app.inject('/');
  assert.equal(homepage.statusCode, 200);
  assert.match(homepage.body, /fixture homepage/);
  const asset = await app.inject('/assets/app-a1b2.js');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'], /javascript/);
  assert.equal(asset.body, 'console.log("fixture asset");');
  const head = await app.inject({ method: 'HEAD', url: '/assets/app-a1b2.js' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  for (const url of ['/missing.js', '/.private', '/%2e%2e/outside.txt']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
    assert.doesNotMatch(response.body, /private fixture|outside fixture/);
  }
  console.log('Static-serving compatibility and traversal checks passed.');
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
