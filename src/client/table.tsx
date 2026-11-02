import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  AlertCircle,
  Inbox,
  LoaderCircle,
} from 'lucide-react';
import './table.css';

/** Shared composition; callers continue to own filtering, paging, and mutations. */
export function TablePanel({
  children,
  className = '',
  label,
  embedded = false,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  embedded?: boolean;
}) {
  return (
    <section
      aria-label={label}
      className={`data-table-panel ${embedded ? 'is-embedded' : ''} ${className}`}
    >
      {children}
    </section>
  );
}

export function TableToolbar({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`data-table-toolbar ${className}`}
      role={label ? 'group' : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

export function TableTabs({
  children,
  actions,
  className = '',
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`data-table-tabs ${className}`}>
      <div className="data-table-tabs-content">{children}</div>
      {actions && <div className="data-table-tabs-actions">{actions}</div>}
    </div>
  );
}

export function TableFooter({
  children,
  count,
  noun = 'records',
  className = '',
}: {
  children?: ReactNode;
  count?: number;
  noun?: string;
  className?: string;
}) {
  const displayNoun =
    count === 1
      ? noun === 'entries'
        ? 'entry'
        : noun === 'batches'
          ? 'batch'
          : noun.endsWith('s')
            ? noun.slice(0, -1)
            : noun
      : noun;
  return (
    <div className={`data-table-footer ${className}`}>
      {count !== undefined && (
        <span className="data-table-count">
          {count.toLocaleString()} {displayNoun} shown
        </span>
      )}
      {children && <div className="data-table-pagination">{children}</div>}
    </div>
  );
}

export function TableIdentity({
  icon,
  title,
  subtitle,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="data-table-identity">
      {icon && (
        <span className="data-table-identity-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div>
        <strong>{title}</strong>
        {subtitle && <div className="data-table-identity-subtitle">{subtitle}</div>}
      </div>
    </div>
  );
}

export function TableActions({ children }: { children: ReactNode }) {
  return <div className="data-table-actions">{children}</div>;
}

export function TableStatus({
  children,
  tone = 'neutral',
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <span {...props} className={`table-status tone-${tone} ${className}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

export function TableState({
  loading,
  error,
  onRetry,
  title,
  description,
  children,
}: {
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="data-table-state" role={error ? 'alert' : loading ? 'status' : undefined}>
      {loading ? (
        <>
          <LoaderCircle size={20} className="spin" aria-hidden="true" />
          <span>{title ?? 'Loading records…'}</span>
        </>
      ) : error ? (
        <>
          <AlertCircle size={22} aria-hidden="true" />
          <strong>Unable to load records</strong>
          <p>{error}</p>
          {onRetry && (
            <button type="button" className="button secondary" onClick={onRetry}>
              Try again
            </button>
          )}
        </>
      ) : (
        <>
          <Inbox size={24} aria-hidden="true" />
          <h3>{title ?? 'No records yet'}</h3>
          {description && <p>{description}</p>}
          {children}
        </>
      )}
    </div>
  );
}

/** A keyboard-accessible viewport shared by every buyer, provider and admin table. */
export function TableViewport({
  label,
  minWidth = 680,
  className = '',
  children,
  onScroll,
  embedded = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: string; minWidth?: number; embedded?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null),
    hintId = useId();
  const [scroll, setScroll] = useState({ overflow: false, start: true, end: true });
  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { overflow: max > 1, start: el.scrollLeft <= 1, end: el.scrollLeft >= max - 1 };
    setScroll((old) =>
      old.overflow === next.overflow && old.start === next.start && old.end === next.end
        ? old
        : next,
    );
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [measure]);
  function move(direction: number) {
    const el = viewport.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * 0.75,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  return (
    <div
      className={`data-table-frame ${embedded ? 'is-embedded' : ''}`}
      style={{ '--table-min-width': `${minWidth}px` } as CSSProperties}
    >
      <div
        ref={viewport}
        className={`data-table-scroll ${className}`}
        tabIndex={0}
        role="region"
        aria-label={label}
        aria-describedby={scroll.overflow ? hintId : undefined}
        onScroll={(event) => {
          measure();
          onScroll?.(event);
        }}
        {...props}
      >
        {children}
      </div>
      {scroll.overflow && (
        <div className="data-table-navigation">
          <span id={hintId}>
            <ArrowLeftRight size={13} aria-hidden="true" /> Scroll to see all columns
          </span>
          <div>
            <button
              type="button"
              disabled={scroll.start}
              onClick={() => move(-1)}
              aria-label={`${label}: scroll left`}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              disabled={scroll.end}
              onClick={() => move(1)}
              aria-label={`${label}: scroll right`}
            >
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
