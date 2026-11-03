import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = 'RAW-DIAGNOSTIC-AND-MATCH-CANARY';
const scenarios = [
  ['clean', 0],
  ['finding', 1],
  ['invalid', 1],
  ['empty', 1],
  ['inconsistent', 1],
  ['error', 1],
  ['signal', 143],
];

for (const [scenario, expectedCode] of scenarios) {
  test(`image secret scanner: ${scenario}`, { timeout: 10000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'broker-image-scan-test-'));
    const capture = join(directory, 'capture.json');
    let child;
    let exit;
    try {
      const fake = join(directory, 'trivy');
      await writeFile(
        fake,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), scenario = ${JSON.stringify(scenario)};
const report = args[args.indexOf('--output') + 1], cache = args[args.indexOf('--cache-dir') + 1];
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ report, cache, args,
  inheritedSecret: process.env.UNRELATED_SECRET_CANARY !== undefined,
  inheritedFilter: process.env.TRIVY_SKIP_FILES !== undefined }));
fs.writeFileSync(cache + '/private', ${JSON.stringify(marker)});
console.log(${JSON.stringify(marker)});
console.error(${JSON.stringify(marker)});
const base = { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: 'sha256:fixture' } };
if (scenario === 'invalid') fs.writeFileSync(report, '{invalid JSON');
else if (scenario === 'empty') fs.writeFileSync(report, '{}');
else if (scenario === 'finding') fs.writeFileSync(report, JSON.stringify({ ...base, Results: [{
  Target: 'app/config.txt', Class: 'secret', Secrets: [{ RuleID: 'fixture-rule', Severity: 'LOW',
  StartLine: 12, Match: ${JSON.stringify(marker)}, Code: { Lines: [{ Content: ${JSON.stringify(marker)} }] } }] }] }));
else fs.writeFileSync(report, JSON.stringify(base));
if (scenario === 'signal') setInterval(() => {}, 1000);
else process.exit(scenario === 'finding' || scenario === 'inconsistent' ? 23 : scenario === 'error' ? 2 : 0);
`,
        { mode: 0o700 },
      );
      await chmod(fake, 0o700);
      child = spawn(
        process.execPath,
        [join(root, 'scripts/scan-image-secrets.mjs'), 'fixture:test'],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
            UNRELATED_SECRET_CANARY: marker,
            TRIVY_SKIP_FILES: '**/*',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      exit = new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });
      if (scenario === 'signal') {
        let captured = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            await stat(capture);
            captured = true;
            break;
          } catch {
            await delay(20);
          }
        }
        assert(captured, 'The fake scanner must start before interruption.');
        child.kill('SIGTERM');
      }
      assert.deepEqual(await exit, { code: expectedCode, signal: null });
      assert(!output.includes(marker), 'Scanner diagnostics and matches must never reach output.');
      const details = JSON.parse(await readFile(capture, 'utf8'));
      assert.equal(details.inheritedSecret, false);
      assert.equal(details.inheritedFilter, false);
      assert.equal(details.args[details.args.indexOf('--scanners') + 1], 'secret');
      assert.equal(details.args[details.args.indexOf('--image-config-scanners') + 1], 'secret');
      assert.equal(
        details.args[details.args.indexOf('--severity') + 1],
        'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
      );
      await assert.rejects(stat(dirname(details.report)), { code: 'ENOENT' });
      if (scenario === 'finding') {
        const finding = output
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse)
          .find((item) => item.rule);
        assert.deepEqual(finding, {
          rule: 'fixture-rule',
          path: 'app/config.txt',
          severity: 'LOW',
          line: 12,
        });
      }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exit;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
