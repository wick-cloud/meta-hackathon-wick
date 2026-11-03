import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  HardDrive,
  LockKeyhole,
  Plus,
  Server,
  X,
} from 'lucide-react';
import type { Disk, DiskDetail as DiskRecord, DiskWorkspace } from '../shared/disks';
import { api, cloudRouteName, dateTime, post } from './api';
import {
  ErrorBox,
  Link,
  MarketDialog,
  PageHeader,
  Spinner,
  useNavigate,
  usePagedResource,
  useResource,
} from './components';
import {
  TableFooter,
  TableIdentity,
  TablePanel,
  TableState,
  TableStatus,
  TableTabs,
  TableViewport,
} from './table';
import './disks.css';
import { DiskFiles } from './disk-files';

export interface DiskOptions {
  enabled: boolean;
  eligibleCatalogIds: string[];
  mode: 'fixture' | 'real';
}
export const useDiskOptions = () => useResource<DiskOptions>('/api/disks/options');

function DiskStatus({ disk }: { disk: Disk }) {
  const attention = disk.cleanupPending || disk.status === 'failed';
  return (
    <TableStatus tone={attention ? 'warning' : disk.status === 'ready' ? 'success' : 'neutral'}>
      {attention
        ? 'Needs attention'
        : disk.status === 'ready'
          ? disk.attachmentCount
            ? 'In use'
            : 'Ready'
          : disk.status.charAt(0).toUpperCase() + disk.status.slice(1)}
    </TableStatus>
  );
}

export function CreateDisk({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (disk: Disk) => void;
}) {
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef(crypto.randomUUID());
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const disk = await post<Disk>('/api/disks', {
        name: name.trim(),
        operationKey: operation.current,
      });
      onCreated(disk);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the disk.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <MarketDialog titleId="create-disk-title" busy={busy} onClose={onClose} variant="drawer">
      <form className="disk-create-form" onSubmit={create}>
        <div className="disk-dialog-head">
          <h2 id="create-disk-title">Create disk</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close create disk"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <label className="field">
          <span>Disk name</span>
          <input
            autoFocus
            required
            minLength={1}
            maxLength={100}
            placeholder="research-workspace"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              operation.current = crypto.randomUUID();
            }}
          />
        </label>
        <p className="disk-private">
          <LockKeyhole size={14} /> Private to your account
        </p>
        <div className="disk-info">
          <HardDrive size={20} />
          <p>
            Use this disk across multiple VMs. Give each agent its own workspace. Files stay on the
            disk after a VM stops.
          </p>
        </div>
        <ErrorBox error={error} />
        <div className="disk-dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner label="Creating disk" /> : 'Create disk'}
          </button>
        </div>
      </form>
    </MarketDialog>
  );
}

/** The feature check stays separate so disabled installations never fetch the disk inventory. */
export function DiskPicker({
  value,
  onChange,
  options,
  label = 'Workspace disk · optional',
}: {
  value: string;
  onChange: (id: string) => void;
  options: DiskOptions | null;
  label?: string;
}) {
  if (!options?.enabled)
    return value ? (
      <div>
        <ErrorBox error="Disk selection is unavailable. Enable disk support or remove this disk from the request." />
        <button type="button" className="text-button" onClick={() => onChange('')}>
          Remove disk from request
        </button>
      </div>
    ) : null;
  return <DiskChoices value={value} onChange={onChange} label={label} />;
}
function DiskChoices({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const disks = usePagedResource<Disk>('/api/disks?limit=100', 10000),
    [creating, setCreating] = useState(false);
  const selected = disks.data?.items.find((disk) => disk.id === value);
  return (
    <div className="disk-picker">
      <div className="disk-picker-head">
        <label htmlFor="workspace-disk">{label}</label>
        <button type="button" className="text-button" onClick={() => setCreating(true)}>
          <Plus size={13} /> Create disk
        </button>
      </div>
      <select
        id="workspace-disk"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disks.loading}
      >
        <option value="">Temporary workspace · no disk</option>
        {value && !selected && (
          <option value={value} disabled>
            {disks.loading ? 'Loading selected disk…' : 'Selected disk unavailable'}
          </option>
        )}
        {disks.data?.items.map((disk) => (
          <option
            key={disk.id}
            value={disk.id}
            disabled={disk.status !== 'ready' || disk.cleanupPending}
          >
            {disk.name}
            {disk.status !== 'ready'
              ? ` · ${disk.status}`
              : disk.cleanupPending
                ? ' · needs attention'
                : ''}
          </option>
        ))}
      </select>
      {disks.nextCursor && (
        <button
          type="button"
          className="text-button disk-more"
          disabled={disks.loadingMore}
          onClick={() => void disks.loadMore()}
        >
          {disks.loadingMore ? 'Loading…' : 'Load more disks'}
        </button>
      )}
      <ErrorBox
        error={disks.error || disks.moreError}
        retry={disks.error ? disks.reload : undefined}
      />
      {value && (
        <p className="field-hint">
          <LockKeyhole size={13} /> Private to your account. Mounted at /workspace when the VM
          starts.
        </p>
      )}
      {creating && (
        <CreateDisk
          onClose={() => setCreating(false)}
          onCreated={(disk) => {
            setCreating(false);
            disks.reload();
            onChange(disk.id);
          }}
        />
      )}
    </div>
  );
}

export function WorkspacePicker({
  diskId,
  value,
  onChange,
}: {
  diskId: string;
  value: string;
  onChange: (id: string, workspace?: DiskWorkspace) => void;
}) {
  const workspaces = useResource<{ items: DiskWorkspace[] }>(
    `/api/disks/${encodeURIComponent(diskId)}/workspaces`,
    5000,
  );
  const selected = workspaces.data?.items.find((workspace) => workspace.id === value);
  useEffect(() => {
    if (selected) onChange(selected.id, selected);
  }, [selected?.id, selected?.activeTaskId, selected?.repositoryUrl]);
  return (
    <div className="disk-workspace-picker">
      <label className="field">
        <span>Agent workspace</span>
        <select
          value={value}
          onChange={(e) =>
            onChange(
              e.target.value,
              workspaces.data?.items.find((workspace) => workspace.id === e.target.value),
            )
          }
          disabled={workspaces.loading}
        >
          <option value="">New workspace · separate folder</option>
          {value && !selected && (
            <option value={value} disabled>
              {workspaces.loading ? 'Loading workspace…' : 'Workspace unavailable'}
            </option>
          )}
          {workspaces.data?.items.map((workspace) => (
            <option
              value={workspace.id}
              key={workspace.id}
              disabled={workspace.status !== 'available' || !workspace.initialized}
            >
              {workspace.name} ·{' '}
              {workspace.status !== 'available'
                ? 'In use by another task'
                : !workspace.initialized
                  ? 'Not initialized'
                  : 'Continue existing'}
            </option>
          ))}
        </select>
      </label>
      {selected?.status === 'in_use' && (
        <ErrorBox error="This workspace is in use by another task. Choose a new or available workspace." />
      )}
      <p className="field-hint">
        {value
          ? 'Existing files and uncommitted changes are kept. Continuing starts a new task.'
          : 'Each agent gets a separate persistent folder. You can continue it in a later task.'}
      </p>
      <ErrorBox error={workspaces.error} retry={workspaces.reload} />
    </div>
  );
}

export function Disks() {
  const options = useDiskOptions(),
    navigate = useNavigate(),
    [creating, setCreating] = useState(false);
  return (
    <div className="inventory-page disk-inventory">
      <PageHeader
        eyebrow="WORKSPACE"
        title="Disks"
        description="Persistent workspaces for your agents."
      >
        {options.data?.enabled && (
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Create disk
          </button>
        )}
      </PageHeader>
      {options.loading ? (
        <Spinner label="Loading disk availability" />
      ) : options.error ? (
        <ErrorBox error={options.error} retry={options.reload} />
      ) : !options.data?.enabled ? (
        <TablePanel>
          <TableState
            title="Disk support is not enabled"
            description="Your operator can enable persistent disks after qualifying compatible providers."
          />
        </TablePanel>
      ) : (
        <DiskInventory mode={options.data.mode} onCreate={() => setCreating(true)} />
      )}
      {creating && (
        <CreateDisk
          onClose={() => setCreating(false)}
          onCreated={(disk) => navigate('/disks/' + disk.id)}
        />
      )}
    </div>
  );
}
function DiskInventory({ mode, onCreate }: { mode: 'fixture' | 'real'; onCreate: () => void }) {
  const disks = usePagedResource<Disk>('/api/disks?limit=25', 5000);
  return (
    <>
      <div className="disk-inventory-head">
        <p className="disk-private">
          <LockKeyhole size={14} /> Only you can access these disks
          {mode === 'fixture' ? ' · Fixture demo' : ''}
        </p>
      </div>
      <TablePanel label="Your disks">
        <TableTabs>
          <h2>Your disks</h2>
        </TableTabs>
        {disks.loading && !disks.data ? (
          <TableState loading title="Loading disks" />
        ) : !disks.data && disks.error ? (
          <TableState error={disks.error} onRetry={disks.reload} />
        ) : disks.data?.items.length ? (
          <TableViewport label="Your disks" minWidth={700}>
            <table aria-label="Your disks">
              <thead>
                <tr>
                  <th scope="col">Disk</th>
                  <th scope="col">Status</th>
                  <th scope="col">Workspaces</th>
                  <th scope="col">Attached VMs</th>
                  <th scope="col">Updated</th>
                  <th scope="col" className="actions-cell">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {disks.data.items.map((disk) => (
                  <tr key={disk.id}>
                    <td>
                      <TableIdentity
                        icon={<HardDrive size={17} />}
                        title={<Link href={'/disks/' + disk.id}>{disk.name}</Link>}
                        subtitle={disk.id.slice(0, 8)}
                      />
                    </td>
                    <td>
                      <DiskStatus disk={disk} />
                    </td>
                    <td>{disk.workspaceCount}</td>
                    <td>{disk.attachmentCount || 'None'}</td>
                    <td>{dateTime(disk.updatedAt)}</td>
                    <td className="actions-cell">
                      <Link href={'/disks/' + disk.id} className="table-open-link">
                        View disk <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="Give your agents a place to keep their work."
            description="Create a disk, then use it when starting a VM or Studio task."
          >
            <button className="button secondary" onClick={onCreate}>
              <Plus size={15} /> Create your first disk
            </button>
          </TableState>
        )}
        <TableFooter count={disks.data?.items.length} noun="disks">
          {disks.nextCursor && (
            <button
              type="button"
              className="text-button"
              disabled={disks.loadingMore}
              onClick={() => void disks.loadMore()}
            >
              {disks.loadingMore ? 'Loading…' : 'Load more disks'}
            </button>
          )}
        </TableFooter>
      </TablePanel>
      <ErrorBox error={(disks.data ? disks.error : '') || disks.moreError} />
      <p className="disk-footnote">Files stay on your disk after a VM stops.</p>
    </>
  );
}

export function DiskDetail({ id }: { id: string }) {
  const detail = useResource<DiskRecord>('/api/disks/' + encodeURIComponent(id), 5000),
    options = useDiskOptions(),
    navigate = useNavigate();
  const [action, setAction] = useState<'rename' | 'delete' | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const operation = useRef(crypto.randomUUID());
  const disk = detail.data?.disk;
  async function mutate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/disks/' + encodeURIComponent(id), {
        method: action === 'delete' ? 'DELETE' : 'PATCH',
        body: JSON.stringify({
          operationKey: operation.current,
          ...(action === 'rename' ? { name: name.trim() } : {}),
        }),
      });
      setAction(null);
      detail.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the disk.');
    } finally {
      setBusy(false);
    }
  }
  if (!disk || !detail.data)
    return detail.loading ? (
      <Spinner label="Loading disk" />
    ) : (
      <ErrorBox error={detail.error || 'Disk not found.'} retry={detail.reload} />
    );
  const { attachments, workspaces } = detail.data;
  const usable = disk.status === 'ready' && !disk.cleanupPending && options.data?.enabled;
  return (
    <div className="inventory-page disk-detail">
      <Link href="/disks" className="back-link">
        <ArrowLeft size={15} /> All disks
      </Link>
      <PageHeader
        eyebrow={'DISK · ' + id.slice(0, 8)}
        title={disk.name}
        description="Files persist after VMs stop."
      >
        <DiskStatus disk={disk} />
        <span className="disk-private">
          <LockKeyhole size={14} /> Private
        </span>
        {disk.status !== 'deleted' && (
          <button
            className="button secondary"
            onClick={() => {
              setName(disk.name);
              operation.current = crypto.randomUUID();
              setAction('rename');
              setError('');
            }}
          >
            Rename
          </button>
        )}
        {usable && (
          <Link className="button primary" href={'/new/vm?diskId=' + encodeURIComponent(id)}>
            Use in a new VM <ArrowRight size={15} />
          </Link>
        )}
      </PageHeader>
      <ErrorBox
        error={detail.error || disk.failureReason || ''}
        retry={detail.error ? detail.reload : undefined}
      />
      {disk.sourceMode === 'fixture' && (
        <p className="disk-footnote">Fixture demo · storage and attachments are simulated.</p>
      )}
      {disk.cleanupPending && (
        <div className="disk-info" role="status">
          <HardDrive size={18} />
          <p>
            An upstream operation needs reconciliation. Disk deletion is blocked while its outcome
            is unresolved.
          </p>
        </div>
      )}
      <DiskFiles key={id} disk={disk} />
      <TablePanel label="Attached VMs" className="disk-detail-panel">
        <TableTabs>
          <h2>
            Attached VMs <span className="quiet-badge">{attachments.length}</span>
          </h2>
        </TableTabs>
        {attachments.length ? (
          <TableViewport label="Attached VMs" minWidth={580}>
            <table aria-label="Attached VMs">
              <thead>
                <tr>
                  <th scope="col">VM</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="actions-cell">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {attachments.map((attachment) => (
                  <tr key={attachment.vmId}>
                    <td>
                      <TableIdentity
                        icon={<Server size={16} />}
                        title={
                          <Link href={'/vms/' + attachment.vmId}>
                            {attachment.vmName || attachment.vmId.slice(0, 8)}
                          </Link>
                        }
                        subtitle={attachment.vmId.slice(0, 8)}
                      />
                    </td>
                    <td>{cloudRouteName(attachment.provider)}</td>
                    <td>
                      <TableStatus tone={attachment.status === 'mounted' ? 'success' : 'neutral'}>
                        {attachment.status.replaceAll('_', ' ')}
                      </TableStatus>
                    </td>
                    <td className="actions-cell">
                      <Link href={'/vms/' + attachment.vmId} className="table-open-link">
                        View VM <ArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="No attached VMs"
            description="Use this disk when creating a VM or starting a Studio task."
          />
        )}
      </TablePanel>
      <TablePanel label="Agent workspaces" className="disk-detail-panel">
        <TableTabs
          actions={
            usable ? (
              <Link
                className="table-open-link"
                href={'/studio?new=1&diskId=' + encodeURIComponent(id)}
              >
                <Plus size={14} /> New task
              </Link>
            ) : undefined
          }
        >
          <h2>Workspaces</h2>
        </TableTabs>
        {workspaces.length ? (
          <TableViewport label="Agent workspaces" minWidth={620}>
            <table aria-label="Agent workspaces">
              <thead>
                <tr>
                  <th scope="col">Folder</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="actions-cell">
                    <span className="sr-only">Continue</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((workspace) => (
                  <tr key={workspace.id}>
                    <td>
                      <TableIdentity
                        icon={<Folder size={17} />}
                        title={workspace.name}
                        subtitle={<code>/workspaces/{workspace.id}</code>}
                      />
                    </td>
                    <td className="disk-repository">
                      {workspace.repositoryUrl.replace('https://github.com/', '')}
                    </td>
                    <td>
                      <TableStatus tone={workspace.status === 'available' ? 'success' : 'warning'}>
                        {workspace.status === 'available'
                          ? workspace.initialized
                            ? 'Available'
                            : 'Not initialized'
                          : 'In use'}
                      </TableStatus>
                    </td>
                    <td className="actions-cell">
                      {usable && workspace.status === 'available' && workspace.initialized ? (
                        <Link
                          className="table-open-link"
                          href={
                            '/studio?new=1&diskId=' +
                            encodeURIComponent(id) +
                            '&workspaceId=' +
                            encodeURIComponent(workspace.id)
                          }
                        >
                          Continue in Studio <ArrowRight size={14} />
                        </Link>
                      ) : (
                        <button
                          className="button secondary compact"
                          disabled
                          title="Continue after the previous task and its VM have stopped"
                        >
                          Continue
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <TableState
            title="No agent workspaces yet"
            description="Starting a Studio task on this disk creates its own persistent folder."
          />
        )}
        <TableFooter count={workspaces.length} noun="workspaces" />
      </TablePanel>
      <p className="disk-footnote">Continuing keeps existing files and starts a new task.</p>
      {disk.status !== 'deleted' && (
        <div className="disk-delete-area">
          <button
            className="button secondary danger-text"
            disabled={!disk.canDelete || busy}
            onClick={() => {
              operation.current = crypto.randomUUID();
              setAction('delete');
              setError('');
            }}
          >
            Delete disk
          </button>
          <span>
            {disk.canDelete
              ? 'Permanently removes this disk and its files.'
              : 'Finish pending requests and confirm all VM attachments are released before deleting.'}
          </span>
        </div>
      )}
      {action && (
        <MarketDialog titleId="disk-action-title" busy={busy} onClose={() => setAction(null)}>
          <form onSubmit={mutate}>
            <h2 id="disk-action-title">
              {action === 'rename' ? 'Rename disk' : 'Delete this disk?'}
            </h2>
            {action === 'rename' ? (
              <label className="field">
                <span>Disk name</span>
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    operation.current = crypto.randomUUID();
                  }}
                />
              </label>
            ) : (
              <p className="disk-action-copy">
                Deleting {disk.name} permanently removes its saved files and workspaces. This cannot
                be undone.
              </p>
            )}
            <ErrorBox error={error} />
            <div className="disk-dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setAction(null)}
              >
                Cancel
              </button>
              <button
                className={'button ' + (action === 'delete' ? 'danger' : 'primary')}
                disabled={busy || (action === 'rename' && !name.trim())}
              >
                {busy ? (
                  <Spinner label={action === 'delete' ? 'Requesting deletion' : 'Saving'} />
                ) : action === 'delete' ? (
                  'Delete disk and files'
                ) : (
                  'Save name'
                )}
              </button>
            </div>
          </form>
        </MarketDialog>
      )}
    </div>
  );
}
