import { centsToUsd, usdToCents } from '../shared/money';
import { demoHref, demoLocation } from './demo-store';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  LoaderCircle,
  Sparkles,
} from 'lucide-react';
import type { Mode, Receipt } from '../shared/types';
import { api, museLabel, statusLabel, type Session } from './api';

export const NavigationContext = createContext<(path: string) => void>(() => {});
export const SessionContext = createContext<Session>({
  user: null,
  modes: { wick: 'fixture', muse: 'fixture' },
  catalog: [],
});
export const useSession = () => useContext(SessionContext);
export const useNavigate = () => useContext(NavigationContext);
export function Link({ href = '', onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const navigate = useNavigate();
  const demo = demoLocation();
  if (demo) href = demoHref(href, demo.role);
  return (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0 &&
          href.startsWith('/')
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    />
  );
}
export function useResource<T>(path: string, interval = 0) {
  const [state, setState] = useState<{
      path: string;
      data: T | null;
      error: string;
      loading: boolean;
      refreshing: boolean;
      updatedAt: number;
    }>({ path, data: null, error: '', loading: true, refreshing: false, updatedAt: 0 }),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false,
      inFlight = false;
    const controller = new AbortController();
    setState((old) =>
      old.path === path
        ? old
        : { path, data: null, error: '', loading: true, refreshing: false, updatedAt: 0 },
    );
    const fetchData = async () => {
      if (inFlight) return;
      inFlight = true;
      setState((old) => (old.path === path ? { ...old, refreshing: true } : old));
      try {
        const data = await api<T>(path, { signal: controller.signal });
        if (!cancelled)
          setState({
            path,
            data,
            error: '',
            loading: false,
            refreshing: false,
            updatedAt: Date.now(),
          });
      } catch (err) {
        if (!cancelled)
          setState((old) => ({
            path,
            data: old.path === path ? old.data : null,
            error: err instanceof Error ? err.message : 'Unable to load this page.',
            loading: false,
            refreshing: false,
            updatedAt: old.path === path ? old.updatedAt : 0,
          }));
      } finally {
        inFlight = false;
      }
    };
    void fetchData();
    const onVisible = () => {
      if (interval && document.visibilityState === 'visible') void fetchData();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = interval
      ? setInterval(() => {
          if (document.visibilityState !== 'hidden') void fetchData();
        }, interval)
      : undefined;
    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearInterval(timer);
    };
  }, [path, interval, version]);
  return state.path === path
    ? { ...state, reload: () => setVersion((v) => v + 1) }
    : {
        path,
        data: null,
        error: '',
        loading: true,
        refreshing: false,
        updatedAt: 0,
        reload: () => setVersion((v) => v + 1),
      };
}
export function usePagedResource<T extends { id: string }>(path: string, interval = 0) {
  const first = useResource<{ items: T[]; nextCursor?: string }>(path, interval);
  const [extra, setExtra] = useState<{
      path: string;
      items: T[];
      nextCursor?: string;
      loaded: boolean;
    }>({ path, items: [], loaded: false }),
    [loadingMore, setLoadingMore] = useState(false),
    [moreError, setMoreError] = useState('');
  const currentPath = useRef(path);
  currentPath.current = path;
  const additional = extra.path === path ? extra : { path, items: [], loaded: false };
  const items = Array.from(
    new Map(
      [...(additional.items || []), ...(first.data?.items || [])].map((item) => [item.id, item]),
    ).values(),
  ).sort((a, b) => {
    const aDate = (a as T & { createdAt?: string }).createdAt || '',
      bDate = (b as T & { createdAt?: string }).createdAt || '';
    return bDate.localeCompare(aDate) || b.id.localeCompare(a.id);
  });
  const nextCursor = additional.loaded ? additional.nextCursor : first.data?.nextCursor;
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const page = await api<{ items: T[]; nextCursor?: string }>(
        `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (currentPath.current === path)
        setExtra((old) => ({
          path,
          items: [...(old.path === path ? old.items : []), ...page.items],
          nextCursor: page.nextCursor,
          loaded: true,
        }));
    } catch (err) {
      if (currentPath.current === path)
        setMoreError(err instanceof Error ? err.message : 'Unable to load more items.');
    } finally {
      setLoadingMore(false);
    }
  }
  return {
    ...first,
    data: first.data ? { items, nextCursor } : null,
    nextCursor,
    loadingMore,
    moreError,
    loadMore,
    reload: () => {
      setExtra({ path, items: [], loaded: false });
      setMoreError('');
      first.reload();
    },
  };
}
export function LoadMore({
  available,
  loading,
  onLoad,
  error,
}: {
  available: boolean;
  loading: boolean;
  onLoad: () => void;
  error?: string;
}) {
  return (
    <>
      {error && <ErrorBox error={error} />}
      {available && (
        <div className="load-more">
          <button type="button" className="button secondary" disabled={loading} onClick={onLoad}>
            {loading ? <Spinner label="Loading more" /> : 'Load more'}
          </button>
        </div>
      )}
    </>
  );
}
export function useNow(active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
export function AuctionCountdown({ closesAt, now }: { closesAt: string; now: number }) {
  const seconds = Math.min(30, Math.max(0, Math.ceil((Date.parse(closesAt) - now) / 1000)));
  const elapsed = 30 - seconds;
  return (
    <>
      <div
        className="auction-countdown"
        role="timer"
        aria-label="Auction countdown"
        aria-live="off"
      >
        <span>{seconds.toString().padStart(2, '0')}</span>
        <div>
          <strong>{seconds === 0 ? 'Selecting your match' : 'seconds remaining'}</strong>
          <p>
            {seconds === 0
              ? 'The auction is closing. No further bids will be accepted.'
              : 'The winning bid will be selected automatically.'}
          </p>
        </div>
      </div>
      <div
        className="auction-progress"
        role="progressbar"
        aria-label="Auction time elapsed"
        aria-valuemin={0}
        aria-valuemax={30}
        aria-valuenow={elapsed}
      >
        <span style={{ width: `${(elapsed / 30) * 100}%` }} />
      </div>
    </>
  );
}
export function remaining(expiresAt: string | undefined | null, now: number) {
  if (!expiresAt) return 'Admission pending';
  const s = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner-line" role="status">
      <LoaderCircle className="spin" size={17} />
      {label}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="page-heading-actions">{children}</div>}
    </div>
  );
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return error ? (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <div>{error}</div>
      {retry && (
        <button type="button" className="text-button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  ) : null;
}
export function SuccessBox({ children }: { children: ReactNode }) {
  return (
    <div className="success-box" role="status">
      <Check size={17} />
      {children}
    </div>
  );
}
export function MarketDialog({
  titleId,
  onClose,
  busy,
  children,
  variant = 'modal',
  size = 'default',
}: {
  titleId: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  variant?: 'modal' | 'drawer';
  size?: 'default' | 'wide';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`market-dialog market-dialog-${variant}${size === 'wide' ? ' market-dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close.current();
      }}
    >
      {children}
    </dialog>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <CircleHelp size={25} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span />
      {statusLabel(status)}
    </span>
  );
}
export function ReceiptCard({
  receipt,
  mode,
  modelCalled,
}: {
  receipt: Receipt;
  mode?: Mode;
  modelCalled?: boolean;
}) {
  return (
    <div className="muse-receipt">
      <div className="muse-receipt-title">
        <Sparkles size={17} />
        <strong>Decision receipt</strong>
        <span className="tiny-label">
          {mode === 'fixture'
            ? 'Fixture · no model call'
            : modelCalled === false
              ? 'Validated locally · no model call'
              : mode === 'real' || modelCalled === true
                ? museLabel
                : 'Muse'}
        </span>
      </div>
      <div className="receipt-group">
        <span>Observed requirement</span>
        {receipt.observed.map((item, i) => (
          <p key={i}>{item}</p>
        ))}
      </div>
      <div className="receipt-group">
        <span>Decision</span>
        <p>{receipt.decision}</p>
      </div>
      <div className="receipt-group">
        <span>Constraints</span>
        <ul>
          {receipt.constraints.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
export function Steps({ active }: { active: number }) {
  return (
    <div className="steps" aria-label="Environment request progress">
      {['Describe', 'Review', 'Match & launch'].map((step, i) => (
        <div
          key={step}
          className={`step ${i === active ? 'current' : ''} ${i < active ? 'complete' : ''}`}
        >
          <span>{i < active ? <Check size={13} /> : i + 1}</span>
          {step}
          {i < 2 && <ChevronRight className="step-arrow" size={15} />}
        </div>
      ))}
    </div>
  );
}
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
export function ArrowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link href={to} className="arrow-link">
      {children}
      <ArrowRight size={15} />
    </Link>
  );
}
export function StatCard({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export function MoneyInput({
  id,
  label,
  value,
  onChange,
  min = 0,
  disabled = false,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (cents: number) => void;
  min?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => centsToUsd(value));
  const acceptedValue = useRef(value),
    input = useRef<HTMLInputElement>(null);
  const labelId = `${id}-label`,
    errorId = `${id}-error`;
  const amount = usdToCents(text);
  const validationMessage = !text
    ? ''
    : amount === undefined
      ? 'Enter a USD amount with at most four decimal places.'
      : amount < min
        ? `Enter at least $${centsToUsd(min)}.`
        : '';
  useEffect(() => {
    // External changes (for example a Muse draft) replace the value. Our own
    // keystrokes keep their decimal spelling until the field loses focus.
    if (acceptedValue.current !== value) {
      acceptedValue.current = value;
      setText(centsToUsd(value));
    }
  }, [value]);
  useEffect(() => {
    input.current?.setCustomValidity(validationMessage);
  }, [validationMessage]);
  return (
    <label className="field" htmlFor={id}>
      <span id={labelId}>{label}</span>
      <div className="input-affix">
        <span>$</span>
        <input
          id={id}
          ref={input}
          type="text"
          inputMode="decimal"
          aria-labelledby={labelId}
          aria-describedby={validationMessage ? errorId : undefined}
          aria-invalid={!!validationMessage || undefined}
          maxLength={100}
          min={centsToUsd(min)}
          step="0.0001"
          value={text}
          onChange={(e) => {
            const spelling = e.target.value;
            setText(spelling);
            // Invalid/empty edits must not submit a stale, previously valid price.
            const amount = usdToCents(spelling) ?? 0;
            acceptedValue.current = amount;
            onChange(amount);
          }}
          onBlur={() => {
            const amount = usdToCents(text);
            if (amount !== undefined) setText(centsToUsd(amount));
          }}
          disabled={disabled}
          required
        />
        <span>USD</span>
      </div>
      {validationMessage && (
        <span id={errorId} className="field-hint field-error" aria-live="polite">
          {validationMessage}
        </span>
      )}
    </label>
  );
}
