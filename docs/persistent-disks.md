# Persistent shared disks

Broker disks use Wick's native persistent drives. Each buyer owns private disks;
multiple VMs belonging to that buyer may mount one disk concurrently. The server
keeps ownership, lifecycle and workspace metadata in PostgreSQL; Wick stores the
workspace files. Broker service credentials never reach customers or guests.

## Enablement and provider qualification

`DISKS_ENABLED=false` is the default. Fixture installations can set it to `true`
to exercise the UI, API, auctions and durable lifecycle without allocating paid
storage or compute. Fixture terminal output is simulated; it does not certify a
mounted filesystem or native provider behavior.

Real enablement also requires `DISK_QUALIFIED_CATALOG_IDS`, a comma-separated
operator-reviewed allowlist of approved catalog routes. A route must advertise
`persistent-drives`. Qualify at least two different provider routes before
advertising cross-provider shared storage. Neither the public schema nor a
catalog capability is a substitute for this qualification. No live shared-mount
provider qualification is asserted by this change.

For each provider pair, create one private drive with `attachmentMode: shared`,
then start overlapping VMs using `workspaceDrive: { driveId, accessMode: mount }`.
Verify distinct attachment generations, native `/workspace` mount observations,
concurrent writes in different folders, cross-reader visibility (including file
reads through the shared-drive HTTPS API used for planning), atomic rename and
required Git/filesystem operations. Terminate one VM while the other continues.
After both terminate and their drive attachments disappear, attach another VM
and compare file hashes. Test acknowledged writes surviving abrupt VM loss and
document the upstream filesystem durability/consistency limits. Keep routes out
of the allowlist until these checks pass.

The HTTPS `files` attachment mode leaves `/workspace` temporary and cannot satisfy
a disk-backed rental. Disk selection is frozen at request creation, bound at VM
creation, and rechecked before award. Hot attachment is outside this release.
The existing finite rental expiry and compute price still apply. Storage has no
separate Broker charge in this pilot; no capacity or price fields are invented.

## Customer workflow

Create a named disk from **Disks**, the VM request form, or Studio. Inspect its
workspaces and attached provider VMs, rename it, or delete it after all uses have
resolved. All disk operations are scoped to the signed-in buyer, including file
reads for planning. Sharing refers to that buyer's VMs, not cross-customer access.

Choose a disk while reviewing a new VM rental. Only qualified mount-capable
configurations remain eligible. Broker requires the exact drive ID, shared
attachment, generation and `/workspace` native mount before readiness and the
single existing VM invoice. A missing, wrong, or unconfirmed mount never starts
a task or issues a pre-ready invoice.

Studio accepts optional `diskId` and `workspaceId`. Omitting `workspaceId` creates
a new folder at `/workspace/workspaces/<workspaceId>/`; selecting an existing
workspace starts a new task against saved files. A workspace is reserved before
budget funding; different folders can run concurrently. Continuing keeps tracked
and untracked changes and the original pinned repository commit. Planning reads
bounded current files from disk. Patches are cumulative **Workspace changes**
against that original commit, rather than task-only changes.

Workspace repositories, patches, task summaries and bounded test outputs persist
on disk. The 24-hour database artifact expiry does not purge them. Trusted command
journals stay outside the shared disk, and PostgreSQL remains authoritative for
permissions, funding, task state and receipts. Continuing never restores an
expired budget or replays a command whose outcome was uncertain. System packages
and running processes are outside the workspace persistence guarantee.

Only the selected repository enters the coding sandbox. Workspace reservations
coordinate Broker-managed Studio tasks; another authorized whole-disk VM can
still edit files manually. Same-directory collaborative editing is outside this
release. Passing tests describe the recorded run and patch, not an immutable
promise about a directory another VM may later modify.

## Lifecycle and recovery

Create/delete operations have stable durable upstream keys and fenced workers.
Uncertain outcomes retain the original identity. Pending operations recover after
restart and stop automatic retries after 60 attempts with visible diagnostics.
Operators must reconcile the existing upstream operation before resetting its
attempt counter; never replace its key to escape uncertainty.

Stopping or expiring a VM releases only its attachment. A successful termination
request alone is insufficient: the VM must be terminated and its attachment absent
from the drive before cleanup releases capacity. Other attached VMs continue.
Cleanup never deletes a disk. Pending auctions, alternative intents, reserved
workspaces, active VMs and unresolved attachments block disk deletion.

All schema additions are additive. Existing diskless requests, tasks, invoices
and immutable client downloads retain their accepted behavior.

## Developer access

Use client release `0.5.0`. Buyer keys need `disks:read` for inspection,
`disks:write` for creation/rename/deletion, and `disks:use` in addition to
`orders:write` to attach a disk to a VM request. Inference-grant keys retain their
existing authority and cannot acquire VM execution access.

```ts
const disk = await broker.disks.create(
  { name: 'research-workspace' },
  { operationKey: 'research-disk-001' },
);
// Poll broker.disks.get(disk.id) until disk.status is ready.
const order = await broker.orders.create(
  { ...reviewedComputeRequest, diskId: disk.id },
  { operationKey: 'research-vm-001' },
);
```

CLI commands: `disks options`, `disks list`, `disks create`, `disks get`,
`disks workspaces`, `disks rename`, and `disks delete`. Mutations require a stable
operation key. MCP advertises the corresponding `disk_*` tools only to buyer
keys with the required scopes. Studio execution remains owner-session only.
