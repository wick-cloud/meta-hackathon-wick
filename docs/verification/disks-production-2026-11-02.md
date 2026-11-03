# Persistent disks production verification — 2026-11-02

Target: the existing Railway production Broker at
`https://meta-hackathon-wick-production.up.railway.app`.
The merged feature was deployed from `78f413b`. No seed or account reset was run.
This record distinguishes actual native and hosted checks from offline fixtures.
Deployment and resource identifiers are retained in the private run journals;
the public record preserves source revisions, tested behavior, and outcomes.

## Problems found and corrected

- Native E2B and Modal mount observations omit the optional `workspacePath` field.
  Broker now accepts the native mount mode's canonical `/workspace` default,
  while still rejecting an explicit different path and retaining drive, mode,
  generation and attachment checks.
- An empty native DELETE request with `Content-Type: application/json` was
  rejected with HTTP 400. Bodyless requests now omit that header. Native drive
  deletion and a same-key replay both reached `deleted` / `succeeded`.
- Railway configuration preserves `DISKS_ENABLED` and
  `DISK_QUALIFIED_CATALOG_IDS` across future configuration updates.

The corrected source is in PR #41. Local focused disk, DB and auction tests
passed (34 tests), as did typecheck and build. The corrected build was uploaded
to the existing service as the initial corrected deployment;
migrations and readiness succeeded. GitHub source remains `main`.

## Native shared-mount observations

The native shared-mount run used one private shared drive and
three bounded, ten-minute VM admissions: E2B micro, Modal micro, then E2B micro.
Observed results:

- Overlapping E2B and Modal VMs mounted the same drive in `mount` / `shared`
  mode, with distinct nonempty attachment generations.
- Both VMs wrote separate files with fsync and atomic rename and read the
  other VM's exact bytes. The drive HTTPS file read matched mounted bytes.
- E2B termination left Modal able to read and write. After both terminated,
  the third VM read all three saved files with matching hashes.
- All three VMs were confirmed terminated. The drive was confirmed deleted;
  cleanup recovery reused the original identity and deletion key.

The raw, private journal and report remain under ignored `test-results/`.
No credentials or runtime secret values are included in this record. These
observations establish this tested workflow; they do not establish durability
under an upstream storage outage or every possible filesystem failure.

## Hosted readiness

Actual authenticated HTTP and Playwright checks passed both before and after
enablement (8 checks per run), without API response interception:

- health and readiness, anonymous authorization boundaries, owner access and
  admin role denial on buyer disk endpoints;
- installed SDK, CLI and MCP download artifacts, verified all five immutable
  release-file hashes, and checked release 0.5.0 commands and disk methods;
- real buyer Disks, Studio and API-key UI at desktop and mobile sizes, with no
  unexpected page errors or server errors.

Production enables only `e2b:micro:us` and `modal:micro:auto` for disks. Studio
retains its existing E2B micro compute approval. Other catalog configurations
remain outside the disk qualification allowlist.

## Hosted Broker lifecycle

The hosted lifecycle run passed all seven stages against
the corrected production build. It created one disk, replayed creation without
duplication, waited for readiness, and renamed it. Two actual Broker auctions
allocated E2B micro and Modal micro VMs on that disk (5 and 8 cents quoted).
Transient provisioning responses recovered through existing same-key retries.
Both mounted VMs read each other's exact files. A real browser showed both
attachments on the disk detail page without mocked responses.

Broker termination confirmed E2B cleanup while Modal continued reading both
files, then confirmed Modal cleanup and an empty attachment list. Disk deletion
and same-key replay reached `deleted`. Final cleanup confirmed both VMs and the
disk were resolved. No native create calls were used by this hosted probe.

## Authentication ingress

Hosted checks exposed a Better Auth warning that at least one public request's
client IP could not be resolved, falling back to a shared rate-limit bucket.
The opt-in `AUTH_TRUST_RAILWAY_PROXY=true` uses only Railway's public-edge
`X-Real-IP` header, documented in Railway's
[public networking specifications](https://docs.railway.com/networking/public-networking/specs-and-limits).
This setting assumes auth traffic enters through that public HTTP edge; private
Railway networking and TCP ingress do not supply the same sanitization guarantee.
It defaults off elsewhere. Six real auth tests passed, including independent
edge-IP rate-limit buckets and rejection of a spoofed XFF bucket reset.

## Studio sandbox startup

The first real task reached a mounted,
ready E2B VM but failed before repository execution. A bounded native diagnostic
confirmed Debian 12 commands run as UID 1000 with `NoNewPrivs=1`; `sudo` cannot
install the missing bubblewrap package. That task, its VM and its disk were
cleaned up, and unused funding was returned.

For that guest, Studio now downloads only the fixed bubblewrap package using
authenticated APT metadata and extracts it into the task's private `/tmp`
runtime. It runs no package installer and requests no privilege changes. Later
steps reuse the private executable. The existing namespace, capability, network
and mount restrictions and isolation preflight remain required. Other guests
retain the existing setup behavior; unsupported rootless guests fail closed.

An actual Debian 12 Docker regression passed with UID 1000 and
`NoNewPrivs=1`: package extraction, real pinned clone, reuse from a second Python
process, hidden host root/workspace/tmp, and denied external network. System
bubblewrap remained absent. Seven focused command, workspace and guest tests
and the production build also passed.

The corrected source was deployed in the follow-up release. Readiness and all eight hosted checks
passed on this build. Subsequent authentication requests produced no client-IP
resolution warning in the deployment logs.

The actual browser mutation run also passed: sign in, create disk, wait for Ready, rename, confirm deletion, observe
Deleted, and verify absence from the owner's inventory. Screenshots were
captured after leaving the credential form, with no API interception. Its
run-owned disk was confirmed deleted.

See [PR #41](https://github.com/wick-cloud/meta-hackathon-wick/pull/41) for the
final hosted Studio execution and continuation results. The private runner
reports and exact resource journals remain under ignored `test-results/`.

The first task on the corrected sandbox completed, passed its test, and retained
its file, patch, metadata and test receipt after VM termination. Its continuation
opened the same workspace but repeatedly reread an unchanged file, eventually
reaching the bounded probe timeout. Cleanup and unused-funding return succeeded.
Coding context now includes bounded successful-read counts and step numbers,
with instructions to advance after confirmed reads. Rereading remains possible
when content is omitted or there is evidence of changed files. A regression
exercised nine identical reads beyond the eight-receipt history window and
verified distinct, bounded prompts and increasing progress. All 22 focused
coding/guest tests and typecheck passed before deploying this further fix.
