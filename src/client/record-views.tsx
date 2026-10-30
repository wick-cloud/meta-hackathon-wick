import { Archive } from 'lucide-react';
import type { ReactNode } from 'react';
import './record-views.css';

export type RecordView = 'all' | 'active' | 'archive';

export function RecordViews({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RecordView | null;
  onChange: (view: RecordView) => void;
}) {
  return (
    <div className="record-view-tabs" role="group" aria-label={label}>
      {(['all', 'active', 'archive'] as const).map((view) => (
        <button
          key={view}
          className={value === view ? 'selected' : ''}
          aria-pressed={value === view}
          onClick={() => onChange(view)}
        >
          {view === 'archive' && <Archive size={13} aria-hidden="true" />}
          {view === 'all' ? 'All' : view === 'active' ? 'Active' : 'Archive'}
        </button>
      ))}
    </div>
  );
}

export function ArchiveNote({ children }: { children: ReactNode }) {
  return (
    <p className="record-archive-note">
      <Archive size={15} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
