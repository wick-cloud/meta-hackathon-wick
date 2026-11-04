# Secret scanning and public artifacts

Run `npm run build` followed by `npm run security:secrets` from a complete Git
checkout. The scanner downloads official Gitleaks **8.30.1** into a private
temporary directory, verifies a pinned platform SHA-256 before execution, and
removes the binary, temporary files, and reports afterward. Supported runners are
Linux/macOS on x64/arm64 with Node 24, Git, Python 3, and tar. No account token is
needed. Tool changes require reviewing the official
[release assets](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
and updating the pinned version/digests together.

The release check scans:

- Every locally available branch/tag's complete reachable Git history. Shallow
  checkouts fail; CI uses `fetch-depth: 0`.
- Tracked files and non-ignored untracked files from the current working tree.
  Deleted tracked content remains covered by the history scan.
- `dist/` and all three client package `dist/` directories. Missing or empty
  build directories fail the full check.
- Current archive contents and every unique historical `.tgz`, `.tar`, `.tar.gz`,
  or `.zip` blob reachable from local refs. Archive members are expanded in a
  private temporary directory using regular-file-only writes, path validation,
  and explicit size/count/depth limits. Unsafe or oversized archives fail the
  check rather than being silently skipped.

The helper always verifies detection using synthetic canaries in a plain file,
a deleted historical commit, and an archive. Output contains only finding rule,
file, line, and commit metadata. Raw tool output and matched values are never
forwarded. Temporary reports use full redaction and are deleted on normal exit.

For a quick source review before building, run
`node scripts/scan-secrets.mjs --source-only`. This omits generated artifacts and
is not the release gate. `--self-test` runs only the isolated canary checks.
For a private operator check, add `--known-env=/absolute/path/to/.env` to compare
sensitive values from an existing environment file against public content and
all reachable historical blobs. The helper reads that file privately; never
place its contents or secret values on a command line. Known values are also
checked inside expanded archives and decoded content. This optional comparison
does not upload credentials or contact their issuing services.

## Reviewing findings

Treat a new finding as unresolved until its context is reviewed. If it is a real
credential, follow [incident response](../SECURITY.md#credentials-and-incident-response).
Do not add a broad exception merely to make CI green.

`.gitleaks.toml` extends the complete default rule set. Its exceptions are limited
to exact non-secret operation identifiers, historical TypeScript and bundled xterm expressions,
an explicit fixture auth secret, and malformed PEM sentinels used by redaction
tests. Each exception also requires the specific file path. Test directories,
commits, and rule families are not globally excluded. Inline `gitleaks:allow`
comments and `.gitleaksignore` files cannot silently bypass the wrapper.

An initial unfiltered review found 14 historical matches in those categories;
none was a confirmed live credential. This describes that review, not future
commits. Run the gate again against the exact release commit after concurrent
work is merged and inspect the final package/container contents.

The container gate also scans OS and application vulnerabilities at every severity
(`UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`) with no unfixed or ignore-file exemptions.
Production has no npm/Yarn bundle: build stages install dependencies, and a fresh
runtime stage receives only Node and the application's production dependencies.
The root `npm run audit` separately rejects every advisory in the application and
workspace lockfile, including development dependencies.

## Coverage limits

The container release gate separately runs `scripts/scan-image-secrets.mjs` with
Trivy 0.76.1 against the locally built runtime image. It scans runtime layers
(including retained evidence from removed files) and image configuration/history,
disables built-in path exemptions, and blocks findings at every severity. Raw
scanner output and reports stay in a private temporary directory and are removed;
only finding metadata is printed. This does not scan discarded build stages,
external build caches, or previously published images.

The scanner is a detection aid, not proof that no secret exists. It sees refs
available in the checkout; it does not fetch missing refs, inspect remote issue
attachments, GitHub release assets, hosted logs, registry image layers, or
provider secret stores. Deleted remote refs and other copies require separate
review. Local ignored `.env` files are intentionally outside the public-tree
scan; `--known-env` compares their values without treating their private storage
as a publication. Encoded data beyond the configured decode depth, unsupported
formats, and unfamiliar credential structures still need review.

Historical client archive bytes/checksums stay immutable. Current source and new
packages use MIT; historical archive metadata records its original license.
