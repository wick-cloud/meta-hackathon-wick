import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [runner, path] = process.argv.slice(2);
assert(['vitest', 'playwright'].includes(runner), 'Choose a supported test report format.');
const report = JSON.parse(await readFile(path, 'utf8'));
if (runner === 'vitest') {
  assert(report.numTotalTests > 0, 'Database/unit verification must discover tests.');
  assert.equal(report.numPendingTests, 0, 'Unit/database tests must not be skipped in CI.');
  assert.equal(
    report.numTodoTests,
    0,
    'Unimplemented unit tests must not count as a release gate.',
  );
  assert.equal(report.numFailedTests, 0, 'Unit/database tests must pass.');
  assert.equal(report.numPassedTests, report.numTotalTests, 'Every discovered test must pass.');
  console.log(`Verified ${report.numPassedTests} passing unit/database tests with no skips.`);
} else {
  assert(report.stats?.expected > 0, 'Browser verification must discover tests.');
  assert.equal(report.stats.skipped, 0, 'Browser tests must not be skipped in CI.');
  assert.equal(report.stats.unexpected, 0, 'Browser tests must pass.');
  assert.equal(report.stats.flaky, 0, 'Flaky browser tests require investigation before release.');
  console.log(`Verified ${report.stats.expected} passing browser tests with no skips.`);
}
