import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Check edited files, without reformatting old files unrelated to the change.
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const base = process.env.FORMAT_BASE;
let files;
if (base && !/^0+$/.test(base)) {
  if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('FORMAT_BASE must be a commit SHA.');
  files = git('diff', '--name-only', '--diff-filter=ACMR', '-z', base, 'HEAD');
} else if (process.env.CI) {
  files = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD');
} else {
  files = [
    ...git('diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard', '-z'),
  ];
}
files = [...new Set(files)].filter(
  (file) =>
    existsSync(file) &&
    /\.(?:[cm]?js|tsx?|json|css|ya?ml|md)$/.test(file) &&
    file !== 'package-lock.json' &&
    !file.startsWith('client-releases/'),
);
if (!files.length) {
  console.log('No changed formattable source files.');
} else {
  const result = spawnSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--check', ...files],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
