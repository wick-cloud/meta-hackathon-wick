import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Check,
  Clock3,
  Copy,
  HardDrive,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
} from 'lucide-react';
import type { DemoState, DemoKeyResponse, DemoKind, DemoRun } from '../shared/demo';
import { PROVIDER_REGISTRY } from '../shared/providers';
import { api, money, post } from './api';
import './homepage-demo.css';

const TerminalPanel = lazy(() =>
  import('./terminal').then((module) => ({ default: module.TerminalPanel })),
);
type DemoKey = DemoKeyResponse;
const ongoing = (status?: string) => !!status && !['ended', 'failed'].includes(status);
const command = 'python3 /workspace/hello_muse.py';
const count = (n: number) => n.toLocaleString('en-US');
/** Compute sellers use the native registry; Muse token sellers are Baseten and Modal. */
const PROVIDER_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.id, p.name])),
  baseten: 'Baseten',
  modal: 'Modal',
};
const providerName = (provider: string | null | undefined) =>
  provider ? (PROVIDER_NAMES[provider] ?? provider) : 'Pending';
function catalogLabel(catalogId?: string) {
  if (!catalogId) return null;
  const [, size, region] = catalogId.split(':');
  return [size ? `${size[0]!.toUpperCase()}${size.slice(1)}` : null, region]
    .filter(Boolean)
    .join(' · ');
}
function clock(until: string | null | undefined, now: number) {
  const seconds = Math.max(0, Math.ceil(((until ? Date.parse(until) : now) - now) / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** The homepage only renders server receipts. Opening it never starts a purchase. */
export function useHomepageDemo() {
  const [data, setData] = useState<DemoState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<'start' | 'end' | 'key' | null>(null);
  const [startKind, setStartKind] = useState<DemoKind | null>(null);
  const [key, setKey] = useState<DemoKey | null>(null);
  const [keyUncertain, setKeyUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const offset = useRef(0),
    readController = useRef<AbortController | null>(null);
  const revision = useRef(0),
    mounted = useRef(true),
    actionLock = useRef(false);
  const startOperation = useRef(crypto.randomUUID()),
    endOperation = useRef(crypto.randomUUID());
  const attemptedKind = useRef<DemoKind | null>(null);
  const attemptedName = useRef('');
  const keyRun = useRef<string | null>(null);
  const wasCooling = useRef(false);
  const accept = useCallback((next: DemoState) => {
    offset.current = Date.parse(next.serverTime) - Date.now();
    setNow(Date.now() + offset.current);
    if (keyRun.current !== next.run?.id || !ongoing(next.run?.status)) {
      setKey(null);
      setKeyUncertain(false);
    }
    keyRun.current = next.run?.id ?? null;
    if (attemptedKind.current && ongoing(next.run?.status)) {
      attemptedKind.current = null;
      startOperation.current = crypto.randomUUID();
      setStartKind(null);
    }
    setData(next);
  }, []);
  const refresh = useCallback(async () => {
    if (readController.current) return;
    const controller = new AbortController(),
      readRevision = revision.current;
    readController.current = controller;
    setRefreshing(true);
    try {
      const next = await api<DemoState>('/api/demo', { signal: controller.signal });
      if (mounted.current && readRevision === revision.current) {
        accept(next);
        setError('');
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'The live demo could not be reached.');
    } finally {
      if (readController.current === controller) readController.current = null;
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [accept]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      readController.current?.abort();
      readController.current = null;
    };
  }, [refresh]);
  const active = ongoing(data?.run?.status);
  const blockedWithoutRun = !!data?.enabled && !data.run && !data.available;
  const cooldown = !!data?.cooldownUntil && Date.parse(data.cooldownUntil) > now;
  useEffect(() => {
    if (wasCooling.current && !cooldown && !actionLock.current) void refresh();
    wasCooling.current = cooldown;
  }, [cooldown, refresh]);
  useEffect(() => {
    // A paused demo still needs to show the cleanup of an existing run.
    // A blocked no-run response can precede a pending start's guest cookie after navigation.
    if (!active && (!data?.enabled || (!cooldown && !blockedWithoutRun))) return;
    const poll = () => {
      if (document.visibilityState !== 'hidden' && !actionLock.current) void refresh();
    };
    const timer = setInterval(poll, active || blockedWithoutRun ? 2500 : 15000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [data?.enabled, active, cooldown, blockedWithoutRun, refresh]);
  useEffect(() => {
    if (!active && !cooldown) return;
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(timer);
  }, [active, cooldown]);
  async function act(action: 'start' | 'end' | 'key', kind: DemoKind = 'terminal', demoName = '') {
    if (actionLock.current) return;
    if (action === 'start') {
      // An uncertain start must retry the same kind with the same operation key.
      if (attemptedKind.current && attemptedKind.current !== kind) return;
      if (!attemptedKind.current) attemptedName.current = demoName.trim();
      attemptedKind.current = kind;
      setStartKind(kind);
    }
    if (action === 'key' && data?.run?.kind === 'studio') return;
    actionLock.current = true;
    revision.current++;
    readController.current?.abort();
    readController.current = null;
    setBusy(action);
    setError('');
    try {
      if (action === 'key') {
        // The server reveals a key once. A lost response needs an explicit replacement.
        setKey(null);
        const issued = await post<DemoKey>('/api/demo/key', { operationKey: crypto.randomUUID() });
        if (mounted.current) {
          setKey(issued);
          setKeyUncertain(false);
        }
      } else {
        const next = await post<DemoState>(`/api/demo/${action}`, {
          operationKey: action === 'start' ? startOperation.current : endOperation.current,
          ...(action === 'start'
            ? {
                kind: attemptedKind.current,
                ...(attemptedKind.current === 'studio' && attemptedName.current
                  ? { demoName: attemptedName.current }
                  : {}),
              }
            : {}),
        });
        if (mounted.current) {
          accept(next);
          if (action === 'start') {
            startOperation.current = crypto.randomUUID();
            endOperation.current = crypto.randomUUID();
            attemptedKind.current = null;
            setStartKind(null);
          }
        }
      }
    } catch (e) {
      if (mounted.current) {
        if (action === 'key') setKeyUncertain(true);
        setError(
          e instanceof Error
            ? e.message
            : 'The request could not be confirmed. Check its status before trying again.',
        );
      }
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  return {
    data,
    error,
    loading,
    refreshing,
    busy,
    startKind,
    key,
    keyUncertain,
    now,
    active,
    cooldown,
    refresh,
    act,
  };
}
export type HomepageDemo = ReturnType<typeof useHomepageDemo>;

export function StudioDemoTask({ name = '' }: { name?: string }) {
  return (
    <label className="demo-task-box">
      <span>Your Muse task</span>
      <textarea
        aria-label="Your Muse task"
        value={`Create hello_world.py that prints Hello, ${name.trim() || 'World'}! Run it and verify the output.`}
        readOnly
        rows={3}
      />
      <small>Fixed Hello World task for this hackathon demo · Up to 2 model calls</small>
    </label>
  );
}

export function DemoAction({
  demo,
  kind = 'terminal',
  demoName = '',
}: {
  demo: HomepageDemo;
  kind?: DemoKind;
  demoName?: string;
}) {
  const { data, loading, busy, active, cooldown } = demo;
  if (data?.run && (active || cooldown)) {
    if ((data.run.kind ?? 'terminal') !== kind)
      return (
        <button className="button secondary" disabled>
          {active ? 'Another demo is active' : 'Shared cooldown'}
        </button>
      );
    return (
      <a className="button primary" href="#live-demo">
        {active
          ? kind === 'studio'
            ? 'Return to Muse Studio demo'
            : 'Return to your demo'
          : 'View your demo receipt'}{' '}
        <ArrowDown size={16} />
      </a>
    );
  }
  return (
    <button
      className="button primary"
      onClick={() => void demo.act('start', kind, demoName)}
      disabled={
        loading ||
        !!busy ||
        !data?.available ||
        !data?.enabled ||
        (!!demo.startKind && demo.startKind !== kind) ||
        (kind === 'studio' && !/^[\p{L}\p{N} .'-]{0,40}$/u.test(demoName.trim()))
      }
    >
      {busy === 'start' && demo.startKind === kind ? (
        <>
          <LoaderCircle size={16} className="demo-spinner" /> Starting your demo
        </>
      ) : (
        <>
          {kind === 'studio' ? 'Start Muse Studio demo' : 'Try live demo'} <ArrowRight size={16} />
        </>
      )}
    </button>
  );
}

/** The terminal demo's choice card. The start action renders in its footer. */
export function DemoOverview({ demo, children }: { demo: HomepageDemo; children?: ReactNode }) {
  const { data } = demo;
  const fixture = data?.mode === 'fixture';
  return (
    <section id="demo-overview" className="demos-card" aria-labelledby="demo-overview-title">
      <div className="demo-card-top">
        <span>
          <i className="demo-live-dot" /> {fixture ? 'TERMINAL DEMO · FIXTURE' : 'TERMINAL DEMO'}
        </span>
        <span className="demo-sponsored">Sponsored</span>
      </div>
      <div className="demos-card-body">
        <span className="demos-card-icon" aria-hidden="true">
          <SquareTerminal size={26} />
        </span>
        <h2 id="demo-overview-title">
          From auction to <br />
          “Hello, Muse.”
        </h2>
        <p>
          {fixture
            ? 'A simulated VM. Fixture model responses. Explore the flow without live resources.'
            : 'A real VM. Real Meta inference. Watch providers bid, then Muse explains what you bought and answers one question.'}
        </p>
        <div className="demos-card-flow" aria-label="How the terminal demo works">
          <span>Win two auctions</span>
          <ArrowRight size={13} />
          <span>Run hello_muse.py</span>
          <ArrowRight size={13} />
          <span>Ask Muse</span>
        </div>
        <div className="demo-included">
          <div>
            <span className="demo-resource-icon">
              <Server size={20} />
            </span>
            <div>
              <strong>Private Linux VM</strong>
              <span>
                Modal Micro · {data?.limits.durationMinutes ?? 15} minutes including setup
              </span>
              <span>1¢ after demo sponsorship · $0 to you</span>
            </div>
            <span className="demo-included-mark">01</span>
          </div>
          <div>
            <span className="demo-resource-icon">
              <Sparkles size={20} />
            </span>
            <div>
              <strong>Meta Muse token pack</strong>
              <span>Muse Spark Open · up to {data?.limits.maxRequests ?? 2} calls</span>
            </div>
            <span className="demo-included-mark">02</span>
          </div>
          <div>
            <span className="demo-resource-icon">
              <HardDrive size={20} />
            </span>
            <div>
              <strong>Your own demo disk</strong>
              <span>hello_muse.py and your auction receipt</span>
            </div>
            <span className="demo-included-mark">03</span>
          </div>
        </div>
      </div>
      <div className="demos-card-footer">
        {children}
        <p>
          <ShieldCheck size={14} /> No account or payment needed. Paste a demo key when the script
          asks.
        </p>
      </div>
    </section>
  );
}

/** Shared availability for both demos: they share one session, lease and cooldown. */
export function DemoAvailability({ demo }: { demo: HomepageDemo }) {
  const { data, loading, active, cooldown, now } = demo;
  return (
    <div className="demo-availability" role="status">
      {loading ? (
        <>
          <LoaderCircle size={13} className="demo-spinner" /> Checking live availability…
        </>
      ) : active ? (
        <>
          <i className="demo-live-dot" /> Your demo is in progress below
        </>
      ) : cooldown ? (
        <>
          <Clock3 size={13} /> Next demo in {clock(data?.cooldownUntil, now)}
        </>
      ) : data?.available && data.enabled ? (
        <>
          <i className="demo-live-dot" /> Ready when you are
        </>
      ) : (
        <>
          <Clock3 size={13} /> {data?.reason || 'Live demo is currently unavailable.'}
        </>
      )}
    </div>
  );
}

function AuctionCard({ type, demo }: { type: 'compute' | 'tokens'; demo: HomepageDemo }) {
  const resource = type === 'compute' ? demo.data?.run?.vm : demo.data?.run?.tokens;
  const compute = type === 'compute';
  const won =
    resource?.priceCents != null &&
    !!(compute ? demo.data?.run?.vm?.id : demo.data?.run?.tokens?.packId);
  const deadline = resource?.auctionEndsAt;
  const open = deadline && Date.parse(deadline) > demo.now && !won;
  const bids = [...(resource?.bids ?? [])].sort(
    (a, b) =>
      a.priceCents - b.priceCents ||
      (compute ? Number(b.provider === 'modal') - Number(a.provider === 'modal') : 0) ||
      Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt),
  );
  const winner = won
    ? bids.findIndex(
        (bid) =>
          bid.provider === resource!.provider &&
          bid.priceCents === resource!.priceCents &&
          (!compute || !bid.catalogId || bid.catalogId === demo.data?.run?.vm?.catalogId),
      )
    : -1;
  return (
    <article
      className="demo-auction-card"
      aria-label={compute ? 'Compute auction' : 'Token auction'}
    >
      <div className="demo-auction-heading">
        <span className="demo-resource-icon">
          {compute ? <Server size={20} /> : <Sparkles size={20} />}
        </span>
        <div>
          <span className="demo-small-label">{compute ? 'COMPUTE AUCTION' : 'TOKEN AUCTION'}</span>
          <h3>{compute ? 'Your Linux workspace' : 'Your Meta Muse allowance'}</h3>
        </div>
        <span className={`demo-state-tag ${won ? 'is-success' : ''}`}>
          {won ? (
            <>
              <Check size={12} /> Awarded
            </>
          ) : open ? (
            <>
              <Clock3 size={12} /> {clock(deadline, demo.now)}
            </>
          ) : resource ? (
            'Awaiting result'
          ) : (
            'Preparing'
          )}
        </span>
      </div>
      <p className="demo-auction-spec">
        {compute
          ? `Micro VM · ${demo.data?.limits.durationMinutes ?? 15}-minute rental · private disk`
          : '5,000 input + 2,048 output tokens · up to 2 calls'}
      </p>
      <div className="demo-bid-heading">
        <span>Provider</span>
        <span>{compute ? 'Demo bid' : 'Bid total'}</span>
        <span>Status</span>
      </div>
      {bids.length ? (
        bids.map((bid, index) => (
          <div
            className={`demo-provider-bid ${index === winner ? 'is-selected' : ''}`}
            key={`${bid.provider}:${bid.catalogId ?? ''}:${bid.acceptedAt}`}
          >
            <span>
              <b className="demo-provider-mark" aria-hidden="true">
                {providerName(bid.provider).slice(0, 1)}
              </b>
              <span className="demo-bid-provider">
                <span>{providerName(bid.provider)}</span>
                {compute && bid.catalogId && <small>{catalogLabel(bid.catalogId)}</small>}
              </span>
            </span>
            <span className="demo-bid-price">
              <strong>{compute && bid.priceCents === 1 ? '1¢' : money(bid.priceCents)}</strong>
              {compute &&
                ((bid.sponsorCreditCents ?? 0) > 0 ? (
                  <small>after demo sponsorship</small>
                ) : bid.operatorSponsored && (bid.sponsorCreditCents ?? 0) === 0 ? (
                  <small>provider promotion</small>
                ) : null)}
            </span>
            <span className="demo-bid-status">
              {index === winner
                ? 'Selected'
                : won
                  ? 'Not selected'
                  : index === 0 && (compute || bids.length > 1)
                    ? 'Lowest bid'
                    : 'Bid received'}
            </span>
            {compute && bid.grossPriceCents != null && (bid.sponsorCreditCents ?? 0) > 0 && (
              <p className="demo-bid-sponsorship">
                {money(bid.grossPriceCents)} provider price − {money(bid.sponsorCreditCents!)} demo
                sponsorship
              </p>
            )}
          </div>
        ))
      ) : (
        <p className="demo-bids-empty">
          {won
            ? 'The award is confirmed. Bid details are not available.'
            : 'Waiting for accepted provider bids.'}
        </p>
      )}
      <p className="demo-auction-note">
        {compute
          ? 'Every qualified Micro seller is invited. Actual bids, ranked by demo price; Modal has sponsored priority on equal bids. '
          : 'Every qualified Muse seller is invited; the lowest bid wins. '}
        {won
          ? 'The awarded price is covered for you.'
          : 'The winner is confirmed after the 30-second auction closes.'}
      </p>
    </article>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setError('');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Copy unavailable. Select and copy the text below.');
    }
  }
  return (
    <span className="demo-copy-control">
      <button className="button secondary small" onClick={() => void copy()} aria-label={label}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied' : label}
      </button>
      <span role="status" className={error ? 'demo-copy-error' : 'sr-only'}>
        {error || (copied ? `${label} copied` : '')}
      </span>
    </span>
  );
}

export function DemoError({ demo }: { demo: HomepageDemo }) {
  if (!demo.error) return null;
  return (
    <div className="demo-error" role="alert">
      <p>{demo.error}</p>
      <button
        className="button secondary small"
        disabled={demo.refreshing || !!demo.busy}
        onClick={() => void demo.refresh()}
      >
        <RefreshCw size={14} />
        {demo.refreshing ? 'Checking…' : 'Check demo status'}
      </button>
    </div>
  );
}

function GuidedStudio({
  run,
  mode,
  maxRequests,
  terminalReady,
}: {
  run: DemoRun;
  mode: DemoState['mode'];
  maxRequests: number;
  terminalReady: boolean;
}) {
  const studio = run.studio;
  const status = studio?.status ?? 'waiting';
  const verified =
    status === 'passed' &&
    studio?.exitCode === 0 &&
    !!studio.verifiedAt &&
    studio.stdout === `Hello, ${run.demoName || 'World'}!\n`;
  const finished = verified || status === 'needs_attention';
  const label = verified
    ? mode === 'fixture'
      ? 'Fixture check passed'
      : 'Native check passed'
    : status === 'needs_attention'
      ? 'Needs attention'
      : status === 'generating'
        ? 'Muse is writing Python'
        : status === 'running'
          ? 'Running and checking in the VM'
          : 'Waiting for the guided task';
  return (
    <section className="demo-studio" aria-labelledby="demo-studio-title">
      <div className="demo-studio-heading">
        <div>
          <span className="demo-small-label">GUIDED MUSE STUDIO</span>
          <h3 id="demo-studio-title">A small task. A visible result.</h3>
        </div>
        <span className={`demo-state-tag ${verified ? 'is-success' : ''}`} role="status">
          {verified ? (
            <Check size={13} />
          ) : status === 'needs_attention' ? (
            <RefreshCw size={13} />
          ) : (
            <LoaderCircle size={13} className="demo-spinner" />
          )}
          {label}
        </span>
      </div>
      <p className="demo-studio-task">
        The task: write <code>hello_world.py</code> to print{' '}
        <code>Hello, {run.demoName || 'World'}!</code>, then run it and check the result.
      </p>
      <p className="demo-studio-explanation">
        This guided demo generates one Python file. It uses the purchased Muse allowance
        automatically, with up to {maxRequests} calls including a repair attempt.
      </p>
      <div className="demo-studio-evidence">
        <section aria-label="Generated Python source">
          <div className="demo-studio-file-heading">
            <strong>{studio?.filename ?? 'hello_world.py'}</strong>
            <span>
              {mode === 'fixture'
                ? 'Fixture source'
                : verified
                  ? 'Verified file'
                  : 'Muse model output'}
            </span>
          </div>
          {studio?.source != null ? (
            <pre>
              <code>{studio.source}</code>
            </pre>
          ) : (
            <p className="demo-studio-pending">
              The generated file will appear here after Muse responds.
            </p>
          )}
        </section>
        <section aria-label="Python execution result">
          <div className="demo-studio-file-heading">
            <strong>Command output</strong>
            <span>{mode === 'fixture' ? 'Simulated execution' : 'Native VM execution'}</span>
          </div>
          {studio?.stdout != null ? (
            <pre>{studio.stdout || '(No output)'}</pre>
          ) : (
            <p className="demo-studio-pending">Waiting for the VM’s execution receipt.</p>
          )}
          <dl className="demo-studio-result">
            <div>
              <dt>Exit code</dt>
              <dd>{studio?.exitCode ?? 'Pending'}</dd>
            </div>
            <div>
              <dt>Model calls used</dt>
              <dd>
                {studio?.requestsUsed ?? 0} / {maxRequests}
              </dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                {verified
                  ? mode === 'fixture'
                    ? 'Simulated pass'
                    : 'Output matches the task'
                  : 'Not confirmed'}
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <div className="demo-studio-next">
        <div>
          <strong>
            {status === 'needs_attention'
              ? terminalReady
                ? 'Inspect your workspace in the terminal.'
                : 'Your Studio result needs attention.'
              : finished && terminalReady
                ? 'Keep building in your terminal.'
                : finished
                  ? 'Your Studio result is saved.'
                  : 'The guided task is running for you.'}
          </strong>
          <p>
            {status === 'needs_attention'
              ? `The task is unverified, and the generated file may not have been installed. ${terminalReady ? 'Your terminal remains available until the session timer expires.' : 'The saved result remains available.'}`
              : terminalReady
                ? 'Inspect or edit the files, then run Python or shell commands until the session timer expires.'
                : finished
                  ? 'The source and execution receipt stay available after your VM ends.'
                  : 'Terminal access opens when this check finishes. No API key is needed.'}
          </p>
        </div>
        {verified && terminalReady && (
          <CopyButton text="python3 /workspace/hello_world.py" label="Copy run command" />
        )}
      </div>
      {verified && terminalReady && (
        <code className="demo-studio-command">python3 /workspace/hello_world.py</code>
      )}
    </section>
  );
}

export function HomepageDemoSession({ demo }: { demo: HomepageDemo }) {
  const { data, key, busy, now } = demo;
  const run = data?.run;
  const [confirmEnd, setConfirmEnd] = useState(false),
    [confirmKey, setConfirmKey] = useState(false),
    [showKey, setShowKey] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    previousRun = useRef(run?.id);
  useEffect(() => {
    if (run?.id && !previousRun.current) heading.current?.focus({ preventScroll: false });
    previousRun.current = run?.id;
  }, [run?.id]);
  useEffect(() => {
    setConfirmEnd(false);
    setConfirmKey(false);
    setShowKey(false);
  }, [run?.id]);
  if (!run || !data) return null;
  const isStudio = run.kind === 'studio';
  const studioFinished = ['passed', 'needs_attention'].includes(run.studio?.status ?? 'waiting');
  const ready = run.status === 'ready',
    ending = run.status === 'ending',
    done = run.status === 'ended',
    failed = run.status === 'failed';
  const terminalReady =
    ready &&
    !!run.vm?.id &&
    !!run.vm.terminalPath &&
    Date.parse(run.expiresAt ?? '') > now &&
    (!isStudio || studioFinished);
  const step = ready ? 2 : ending || done || failed ? 3 : run.status === 'provisioning' ? 1 : 0;
  const callsRemaining = run.tokens
    ? Math.max(0, data.limits.maxRequests - run.tokens.requestsUsed)
    : 0;
  const museCallsUsed = terminalReady && !!run.tokens && callsRemaining === 0;
  const title = ready
    ? isStudio
      ? 'Your guided Studio workspace.'
      : 'Your live workspace is ready.'
    : ending
      ? 'Wrapping up your demo.'
      : done
        ? 'One small script. The whole marketplace.'
        : failed
          ? 'This demo needs another look.'
          : run.status === 'provisioning'
            ? 'Preparing your private workspace.'
            : 'Your resources, going once…';
  return (
    <section id="live-demo" className="homepage-demo-session" aria-labelledby="live-demo-title">
      <div className="demo-session-heading">
        <div>
          <span className="home-eyebrow">
            {isStudio ? 'YOUR GUIDED STUDIO DEMO' : 'YOUR TERMINAL DEMO'} <span />{' '}
            {run.id.slice(0, 8)}
          </span>
          <h2 id="live-demo-title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <p>{run.message}</p>
        </div>
        <div className="demo-session-actions">
          <span className="demo-sponsored">$0 to you</span>
          <button
            className="demo-refresh"
            onClick={() => void demo.refresh()}
            disabled={demo.refreshing || !!busy}
            aria-label="Refresh demo status"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {data.mode === 'fixture' && (
        <p className="demo-fixture-note">
          Fixture environment · resources and inference are simulated.
        </p>
      )}
      {isStudio && <StudioDemoTask name={run.demoName} />}
      <ol className="demo-progress" aria-label="Demo progress">
        {[
          'Live auctions',
          'Prepare workspace',
          isStudio ? 'Generate & verify' : 'Run Hello, Muse',
          'Finish & cooldown',
        ].map((label, i) => (
          <li
            key={label}
            className={i === step ? 'is-current' : i < step ? 'is-complete' : ''}
            aria-current={i === step ? 'step' : undefined}
          >
            <span>{i < step ? <Check size={12} /> : `0${i + 1}`}</span>
            {label}
          </li>
        ))}
      </ol>
      <DemoError demo={demo} />
      {!ready && !ending && !done && !failed && (
        <>
          <div className="demo-auctions">
            <AuctionCard type="compute" demo={demo} />
            <AuctionCard type="tokens" demo={demo} />
          </div>
          <div className="demo-preparation">
            <HardDrive size={17} />
            <div>
              <strong>{run.disk ? run.disk.name : 'Your private demo disk'}</strong>
              <p>
                {run.status === 'provisioning'
                  ? isStudio
                    ? 'Waiting for the private disk and guided task environment.'
                    : 'Waiting for the disk mount and hello_muse.py setup to be confirmed.'
                  : 'Your script and workspace will be prepared after the awards.'}
              </p>
            </div>
            <LoaderCircle className="demo-spinner" size={16} />
          </div>
          <p className="demo-patience">
            You can leave this page and return to the same demo. Refreshing never starts another
            purchase.
          </p>
        </>
      )}
      {ready && (
        <>
          <div className="demo-workspace-strip">
            <span>
              <i className="demo-live-dot" /> Modal Micro
            </span>
            <span>
              <Clock3 size={14} /> {clock(run.expiresAt, now)} rental remaining
            </span>
            <span>
              <HardDrive size={14} />
              {run.disk?.name ?? 'Your demo disk'}
            </span>
            <span>
              <Sparkles size={14} />
              {isStudio ? (
                `${run.studio?.requestsUsed ?? run.tokens?.requestsUsed ?? 0} / ${data.limits.maxRequests} model calls used`
              ) : (
                <>
                  {callsRemaining} {callsRemaining === 1 ? 'call' : 'calls'} left
                </>
              )}
            </span>
          </div>
          {museCallsUsed ? (
            <div className="demo-allowance-used" role="status">
              <Sparkles size={18} />
              <div>
                <strong>Muse calls used. Your terminal is still available.</strong>
                <p>
                  Keep inspecting or editing files, or run Python and shell commands until the
                  session timer expires.
                </p>
              </div>
            </div>
          ) : !isStudio ? (
            <div className="demo-run-instructions">
              <div className="demo-instruction">
                <span className="demo-step-number">1</span>
                <div>
                  <strong>Get your Muse key</strong>
                  <p>This key uses only the token pack you won.</p>
                </div>
                {key ? (
                  <CopyButton label="Copy key" text={key.token} />
                ) : (
                  <button
                    className="button secondary small"
                    disabled={!run.canIssueKey || !terminalReady || !!busy}
                    onClick={() => {
                      if (run.keyIssued || demo.keyUncertain) setConfirmKey(true);
                      else void demo.act('key');
                    }}
                  >
                    <KeyRound size={14} />
                    {busy === 'key'
                      ? 'Issuing…'
                      : run.keyIssued || demo.keyUncertain
                        ? 'Replace key'
                        : 'Get demo key'}
                  </button>
                )}
              </div>
              <div className="demo-instruction">
                <span className="demo-step-number">2</span>
                <div>
                  <strong>Run your script in the terminal</strong>
                  <code>{command}</code>
                </div>
                <CopyButton text={command} label="Copy command" />
              </div>
            </div>
          ) : null}
          {isStudio && (
            <GuidedStudio
              run={run}
              mode={data.mode}
              maxRequests={data.limits.maxRequests}
              terminalReady={terminalReady}
            />
          )}
          {key && !museCallsUsed && !isStudio && (
            <div className="demo-key-reveal">
              <button className="demo-text-button" onClick={() => setShowKey(!showKey)}>
                {showKey ? 'Hide key' : 'Reveal key'}
              </button>
              {showKey && (
                <input
                  aria-label="Your demo token key"
                  readOnly
                  value={key.token}
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                />
              )}
              <p>
                Paste your key when the script asks. Input stays hidden; the script does not save
                it.
              </p>
            </div>
          )}
          {confirmKey && !museCallsUsed && !isStudio && (
            <div className="demo-confirm" role="group" aria-label="Replace demo key">
              <p>
                Replacing this key immediately revokes the previous one. Update the key in your
                script’s next run.
              </p>
              <div>
                <button className="button secondary small" onClick={() => setConfirmKey(false)}>
                  Keep current key
                </button>
                <button
                  className="button primary small"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmKey(false);
                    void demo.act('key');
                  }}
                >
                  Replace demo key
                </button>
              </div>
            </div>
          )}
          {run.vm?.id && (!isStudio || studioFinished) && (
            <Suspense
              fallback={
                <section className="terminal-panel">
                  <div className="terminal-empty" role="status">
                    <LoaderCircle className="demo-spinner" size={20} />
                    <p>Loading terminal…</p>
                  </div>
                </section>
              }
            >
              <TerminalPanel
                vmId={run.vm.id}
                enabled={terminalReady}
                status={run.vm.status}
                mode={data.mode}
              />
            </Suspense>
          )}
          <div className="demo-usage">
            <span>
              <Sparkles size={15} />
              Meta Muse · {providerName(run.tokens?.provider)}
            </span>
            <span>
              {count(run.tokens?.availableInput ?? 0)} input {museCallsUsed ? 'unused' : 'left'}
            </span>
            <span>
              {count(run.tokens?.availableOutput ?? 0)} output {museCallsUsed ? 'unused' : 'left'}
            </span>
            <span>
              {museCallsUsed
                ? 'Muse call limit reached'
                : isStudio
                  ? 'Studio uses this allowance automatically'
                  : `Up to ${data.limits.maxOutputTokens} output tokens per call`}
            </span>
          </div>
        </>
      )}
      {(ending || done || failed) && (
        <div className={`demo-finish ${failed ? 'is-failed' : ''}`}>
          <span className="demo-finish-icon">
            {ending ? (
              <LoaderCircle className="demo-spinner" size={25} />
            ) : failed ? (
              <RefreshCw size={25} />
            ) : (
              <Check size={27} />
            )}
          </span>
          <div>
            <h3>
              {ending
                ? 'Confirming resource cleanup'
                : done
                  ? 'Your demo has finished'
                  : 'Your run is saved'}
            </h3>
            <p>
              {ending
                ? 'The terminal is closed. We’re waiting for confirmed VM and disk cleanup before the demo is finished.'
                : failed
                  ? 'Check the saved status below. A new run is available only when the server confirms it is safe to start.'
                  : 'Your VM has ended. Keep exploring the marketplace while the demo allowance resets.'}
            </p>
          </div>
          <div className="demo-cooldown">
            <span>VM + TOKEN DEMO</span>
            <strong>
              {demo.cooldown
                ? clock(data.cooldownUntil, now)
                : ending
                  ? 'Cleaning up'
                  : 'Ready when available'}
            </strong>
            <small>
              {demo.cooldown ? 'until your next run' : 'Availability is checked by the server'}
            </small>
          </div>
        </div>
      )}
      {isStudio && !ready && (ending || done || failed) && (
        <GuidedStudio
          run={run}
          mode={data.mode}
          maxRequests={data.limits.maxRequests}
          terminalReady={false}
        />
      )}
      <details className="demo-receipts">
        <summary>Auction receipts & resource status</summary>
        <div className="demo-receipt-grid">
          <dl>
            <div>
              <dt>Compute provider</dt>
              <dd>
                {run.vm?.id && run.vm.priceCents != null
                  ? providerName(run.vm.provider)
                  : 'Not awarded'}
              </dd>
            </div>
            {run.vm?.id && run.vm.grossPriceCents != null && (
              <div>
                <dt>Provider compute price</dt>
                <dd>{money(run.vm.grossPriceCents)}</dd>
              </div>
            )}
            {run.vm?.id && run.vm.sponsorCreditCents != null && (
              <div>
                <dt>Demo sponsorship credit</dt>
                <dd>
                  {run.vm.sponsorCreditCents > 0 ? '−' : ''}
                  {money(run.vm.sponsorCreditCents)}
                </dd>
              </div>
            )}
            <div>
              <dt>Accepted compute bid</dt>
              <dd>
                {run.vm?.id && run.vm.priceCents != null ? (
                  <>
                    {run.vm.priceCents === 1 ? '1¢' : money(run.vm.priceCents)}
                    {(run.vm.sponsorCreditCents ?? 0) > 0 ? (
                      <small className="demo-receipt-note">after demo sponsorship</small>
                    ) : run.vm.operatorSponsored && (run.vm.sponsorCreditCents ?? 0) === 0 ? (
                      <small className="demo-receipt-note">operator-sponsored provider price</small>
                    ) : null}
                  </>
                ) : (
                  'Pending'
                )}
              </dd>
            </div>
            <div>
              <dt>VM cleanup</dt>
              <dd>
                {run.vm?.cleanupConfirmed
                  ? 'Confirmed'
                  : ending
                    ? 'Awaiting confirmation'
                    : done
                      ? 'No VM to clean up'
                      : 'Not complete'}
              </dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Model provider</dt>
              <dd>
                {run.tokens?.packId && run.tokens.priceCents != null
                  ? providerName(run.tokens.provider)
                  : 'Not awarded'}
              </dd>
            </div>
            <div>
              <dt>Accepted token bid</dt>
              <dd>
                {run.tokens?.packId && run.tokens.priceCents != null
                  ? money(run.tokens.priceCents)
                  : 'Pending'}
              </dd>
            </div>
            <div>
              <dt>Model calls used</dt>
              <dd>
                {run.tokens?.requestsUsed ?? 0} / {data.limits.maxRequests}
              </dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Disk</dt>
              <dd>{run.disk?.name ?? 'Not created'}</dd>
            </div>
            <div>
              <dt>Disk status</dt>
              <dd>{run.disk?.status ?? 'Pending'}</dd>
            </div>
            <div>
              <dt>You pay</dt>
              <dd>$0 · sponsored demo</dd>
            </div>
          </dl>
        </div>
      </details>
      {demo.active && !ending && (
        <div className="demo-end-row">
          {confirmEnd ? (
            <div className="demo-confirm">
              <p>End this run? The terminal will close and cleanup will begin.</p>
              <div>
                <button className="button secondary small" onClick={() => setConfirmEnd(false)}>
                  Keep demo running
                </button>
                <button
                  className="button secondary small"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmEnd(false);
                    void demo.act('end');
                  }}
                >
                  Confirm end demo
                </button>
              </div>
            </div>
          ) : (
            <>
              <p>Done exploring? End the demo to release its resources.</p>
              <button
                className="button secondary small"
                disabled={!!busy}
                onClick={() => setConfirmEnd(true)}
              >
                <Square size={13} />
                End demo
              </button>
            </>
          )}
        </div>
      )}
      {!demo.active && !demo.cooldown && (
        <div className="demo-again">
          <DemoAction demo={demo} kind={run.kind ?? 'terminal'} />
          <p>{data.reason || 'A fresh run uses a new VM and token allowance.'}</p>
        </div>
      )}
    </section>
  );
}
