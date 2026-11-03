import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, File, Folder, RefreshCw, X } from 'lucide-react';
import type { Disk, DiskFileEntry, DiskFilePage, DiskFilePreview } from '../shared/disks';
import { api } from './api';
import {
  TableFooter,
  TablePanel,
  TableState,
  TableTabs,
  TableToolbar,
  TableViewport,
} from './table';
import './disk-files.css';

function sizeLabel(size: number) {
  if (size < 1024) return `${size.toLocaleString()} ${size === 1 ? 'byte' : 'bytes'}`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function mergeEntries(existing: DiskFileEntry[], next: DiskFileEntry[]) {
  return [...new Map([...existing, ...next].map((entry) => [entry.key, entry])).values()].sort(
    (a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name),
  );
}

/** Read the disk directly, including while no VM is attached. */
export function DiskFiles({ disk }: { disk: Disk }) {
  const [prefix, setPrefix] = useState('');
  const [version, setVersion] = useState(0);
  const [listing, setListing] = useState<{
    entries: DiskFileEntry[];
    token?: string;
    loading: boolean;
    error: string;
    loadingMore: boolean;
    moreError: string;
  }>({ entries: [], loading: true, error: '', loadingMore: false, moreError: '' });
  const [selection, setSelection] = useState<DiskFileEntry | null>(null);
  const [preview, setPreview] = useState<{
    data: DiskFilePreview | null;
    loading: boolean;
    error: string;
  }>({ data: null, loading: false, error: '' });
  const [previewVersion, setPreviewVersion] = useState(0);
  const listingGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  const canBrowse = disk.status === 'ready' && !disk.cleanupPending;
  const base = '/api/disks/' + encodeURIComponent(disk.id);

  function closePreview(restoreFocus = true) {
    previewGeneration.current++;
    setSelection(null);
    setPreview({ data: null, loading: false, error: '' });
    if (restoreFocus && previewTrigger.current?.isConnected) previewTrigger.current.focus();
  }

  function navigate(next: string) {
    listingGeneration.current++;
    closePreview(false);
    setListing({ entries: [], loading: true, error: '', loadingMore: false, moreError: '' });
    setPrefix(next);
  }

  function refresh() {
    listingGeneration.current++;
    closePreview(false);
    setListing({ entries: [], loading: true, error: '', loadingMore: false, moreError: '' });
    setVersion((value) => value + 1);
  }

  useEffect(() => {
    const generation = ++listingGeneration.current;
    const controller = new AbortController();
    setListing({ entries: [], loading: canBrowse, error: '', loadingMore: false, moreError: '' });
    if (canBrowse) {
      const query = new URLSearchParams({ prefix });
      void api<DiskFilePage>(`${base}/files?${query}`, { signal: controller.signal }).then(
        (page) => {
          if (listingGeneration.current !== generation) return;
          setListing({
            entries: mergeEntries([], page.entries),
            token: page.nextContinuationToken,
            loading: false,
            error: '',
            loadingMore: false,
            moreError: '',
          });
        },
        (error) => {
          if (listingGeneration.current !== generation) return;
          setListing({
            entries: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Could not load the disk files.',
            loadingMore: false,
            moreError: '',
          });
        },
      );
    }
    return () => {
      listingGeneration.current++;
      controller.abort();
    };
  }, [base, prefix, version, canBrowse]);

  useEffect(() => {
    const generation = ++previewGeneration.current;
    const controller = new AbortController();
    setPreview({ data: null, loading: Boolean(selection && canBrowse), error: '' });
    if (selection && canBrowse) {
      const key = selection.key;
      const query = new URLSearchParams({ key });
      void api<DiskFilePreview>(`${base}/file?${query}`, { signal: controller.signal }).then(
        (data) => {
          if (previewGeneration.current !== generation) return;
          setPreview({ data, loading: false, error: '' });
        },
        (error) => {
          if (previewGeneration.current !== generation) return;
          setPreview({
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : 'Could not preview this file.',
          });
        },
      );
    }
    return () => {
      previewGeneration.current++;
      controller.abort();
    };
  }, [base, selection, previewVersion, canBrowse]);

  useEffect(() => {
    if (selection) previewHeading.current?.focus();
  }, [selection]);

  async function loadMore() {
    if (!listing.token || listing.loadingMore) return;
    const generation = listingGeneration.current;
    const token = listing.token;
    setListing((old) => ({ ...old, loadingMore: true, moreError: '' }));
    try {
      const query = new URLSearchParams({ prefix, continuationToken: token });
      const page = await api<DiskFilePage>(`${base}/files?${query}`);
      if (listingGeneration.current !== generation) return;
      setListing((old) => ({
        ...old,
        entries: mergeEntries(old.entries, page.entries),
        token: page.nextContinuationToken === token ? undefined : page.nextContinuationToken,
        loadingMore: false,
      }));
    } catch (error) {
      if (listingGeneration.current !== generation) return;
      setListing((old) => ({
        ...old,
        loadingMore: false,
        moreError: error instanceof Error ? error.message : 'Could not load more files.',
      }));
    }
  }

  const parts = prefix.split('/').filter(Boolean);
  const parent = parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : '');

  return (
    <TablePanel label="Disk files" className="disk-detail-panel disk-files-panel">
      <TableTabs
        actions={
          <button
            type="button"
            className="button secondary compact"
            disabled={!canBrowse || listing.loading}
            onClick={refresh}
            aria-label="Refresh files"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        }
      >
        <h2>
          <Folder size={16} aria-hidden="true" /> Files
        </h2>
      </TableTabs>
      {canBrowse ? (
        <>
          <TableToolbar className="disk-files-navigation">
            <nav aria-label="Disk folders" className="disk-files-breadcrumbs">
              <ol>
                <li>
                  <button type="button" onClick={() => navigate('')} disabled={!prefix}>
                    /workspace
                  </button>
                </li>
                {parts.map((part, index) => (
                  <li key={parts.slice(0, index + 1).join('/')}>
                    <ChevronRight size={13} aria-hidden="true" />
                    <button
                      type="button"
                      aria-current={index === parts.length - 1 ? 'page' : undefined}
                      disabled={index === parts.length - 1}
                      onClick={() => navigate(parts.slice(0, index + 1).join('/') + '/')}
                    >
                      {part}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            {prefix && (
              <button type="button" className="text-button" onClick={() => navigate(parent)}>
                <ArrowLeft size={14} /> Up one folder
              </button>
            )}
          </TableToolbar>
          {listing.loading ? (
            <TableState loading title="Loading files…" />
          ) : listing.error ? (
            <TableState error={listing.error} onRetry={refresh} />
          ) : listing.entries.length ? (
            <TableViewport label="Disk files" minWidth={400}>
              <table aria-label="Disk files">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="numeric-cell">
                      Size
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listing.entries.map((entry) => (
                    <tr key={entry.key}>
                      <td>
                        <button
                          type="button"
                          className="disk-file-name"
                          aria-label={
                            entry.kind === 'directory'
                              ? `Open folder ${entry.name}`
                              : `Preview ${entry.name}`
                          }
                          onClick={(event) => {
                            if (entry.kind === 'directory') navigate(entry.key);
                            else {
                              previewGeneration.current++;
                              previewTrigger.current = event.currentTarget;
                              setPreview({ data: null, loading: true, error: '' });
                              if (selection?.key === entry.key)
                                setPreviewVersion((value) => value + 1);
                              else setSelection(entry);
                            }
                          }}
                        >
                          {entry.kind === 'directory' ? (
                            <Folder size={17} aria-hidden="true" />
                          ) : (
                            <File size={17} aria-hidden="true" />
                          )}
                          <span>{entry.name}</span>
                        </button>
                      </td>
                      <td className="disk-file-kind">
                        {entry.kind === 'directory' ? 'Folder' : 'File'}
                      </td>
                      <td className="numeric-cell disk-file-size">
                        {entry.kind === 'file' && entry.size !== undefined
                          ? sizeLabel(entry.size)
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableViewport>
          ) : (
            <TableState
              title="This folder is empty"
              description="Files created by VMs and Studio tasks will appear here after they are saved to the disk."
            />
          )}
          {!listing.loading && !listing.error && (
            <TableFooter count={listing.entries.length} noun="entries">
              {listing.token && (
                <button
                  type="button"
                  className="text-button"
                  disabled={listing.loadingMore}
                  onClick={() => void loadMore()}
                >
                  {listing.loadingMore ? 'Loading…' : 'Load more files'}
                </button>
              )}
            </TableFooter>
          )}
          {listing.moreError && (
            <div className="disk-files-more-error" role="alert">
              <p>{listing.moreError}</p>
              <button type="button" className="text-button" onClick={() => void loadMore()}>
                Try loading more again
              </button>
            </div>
          )}
          {selection && (
            <section className="disk-file-preview" aria-label="File preview">
              <div className="disk-file-preview-head">
                <div>
                  <h3 ref={previewHeading} tabIndex={-1}>
                    {selection.name}
                  </h3>
                  <p>/workspace/{selection.key}</p>
                </div>
                <button
                  type="button"
                  className="button secondary compact"
                  aria-label="Close file preview"
                  onClick={() => closePreview()}
                >
                  <X size={15} /> Close
                </button>
              </div>
              {preview.loading ? (
                <TableState loading title="Loading file preview…" />
              ) : preview.error ? (
                <TableState error={preview.error} onRetry={() => setPreviewVersion((v) => v + 1)} />
              ) : preview.data ? (
                <>
                  <p className="disk-file-preview-meta">
                    {sizeLabel(preview.data.size)} · Read-only preview
                    {preview.data.truncated && ' · Showing the first 64 KiB'}
                  </p>
                  {preview.data.binary ? (
                    <TableState
                      title="No text preview"
                      description="This is a binary file. Its contents can be opened from a VM attached to this disk."
                    />
                  ) : preview.data.content === '' ? (
                    <TableState title="This file is empty" />
                  ) : (
                    <pre tabIndex={0} aria-label="File contents">
                      {preview.data.content}
                    </pre>
                  )}
                </>
              ) : null}
            </section>
          )}
          <p className="disk-files-note">Browse saved files even when no VMs are attached.</p>
        </>
      ) : (
        <TableState
          title="Files are unavailable"
          description={
            disk.status === 'deleted'
              ? 'This disk and its files have been deleted.'
              : 'Files can be browsed when the disk is ready and its pending operations are complete.'
          }
        />
      )}
    </TablePanel>
  );
}
