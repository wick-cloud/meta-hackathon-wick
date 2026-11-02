import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  Box,
  ChevronDown,
  CircleDollarSign,
  Cpu,
  LayoutGrid,
  ListOrdered,
  LogOut,
  Menu,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
  Wallet,
  KeyRound,
  Bot,
  Server,
} from 'lucide-react';
import {
  api,
  post,
  museLabel,
  MUSE_DISPLAY_NAME,
  MUSE_MODEL,
  MUSE_PROVIDER,
  type Session,
} from './api';
import { ErrorBox, Link, NavigationContext, SessionContext, Spinner } from './components';
import { NewEnvironment, RequestReview, AuctionPage, VMDetail, Invoices } from './buyer';
import { MyVMs } from './vm-inventory';
import { AlternativeComposer, AlternativeDetail, AlternativeList } from './negotiation';
import { Orders } from './orders';
import { AgreementDetail, RetiredScheduledVMs } from './agreements';
import { Credits } from './credits';
import { AdminCreditGrant } from './admin-credits';
import { DeveloperKeys } from './developer-keys';
import { Agents, AgentDetail, TokenComposer, TokenOrderPage, ProviderInference } from './inference';
import { PurchaseChooser } from './purchases';
import { TokenInventory } from './token-inventory';
import { CodingStudio, CodingJobPage } from './coding';
import { Studio, StudioTaskPage } from './studio';
import {
  ProviderCapacity,
  ProviderPolicy,
  ProviderRequests,
  ProviderOfferings,
  ProviderActivity,
  ProviderEarnings,
  AdminConfig,
} from './provider';

type NavigationItem = { path: string; label: string; icon: typeof Box; group?: string };
const buyerNavigation: NavigationItem[] = [
  { path: '/orders', label: 'Orders', icon: ListOrdered, group: 'WORKSPACE' },
  { path: '/studio', label: 'Muse Studio', icon: Sparkles, group: 'WORKSPACE' },
  { path: '/vms', label: 'Virtual machines', icon: Server, group: 'WORKSPACE' },
  { path: '/tokens', label: 'Purchased tokens', icon: Sparkles, group: 'WORKSPACE' },
  { path: '/agents', label: 'Agents', icon: Bot, group: 'WORKSPACE' },
  { path: '/credits', label: 'Broker wallet', icon: Wallet, group: 'ACCOUNT' },
  { path: '/invoices', label: 'Invoices', icon: CircleDollarSign, group: 'ACCOUNT' },
  { path: '/keys', label: 'API keys', icon: KeyRound, group: 'ACCOUNT' },
];
const providerNavigation: NavigationItem[] = [
  { path: '/provider/capacity', label: 'Capacity', icon: Cpu },
  { path: '/provider/policy', label: 'Policy', icon: Settings2 },
  { path: '/provider/requests', label: 'Requests', icon: Box },
  { path: '/provider/offerings', label: 'Offerings', icon: LayoutGrid },
  { path: '/provider/inference', label: 'AI capacity', icon: Sparkles },
  { path: '/provider/earnings', label: 'Earnings', icon: CircleDollarSign },
  { path: '/provider/activity', label: 'Activity', icon: Activity },
  { path: '/keys', label: 'API keys', icon: KeyRound },
];

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        w
      </span>
      <span>
        wick
        <span className="brand-divider" /> <span className="brand-product">broker</span>
      </span>
    </div>
  );
}
function Login({ session, onSignedIn }: { session: Session; onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/api/auth/sign-in/email', { email, password });
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div className="login-story-content">
          <span className="label-on-dark">YOUR NEXT ENVIRONMENT, SORTED.</span>
          <h1>
            Less setup.
            <br />
            More possibility.
          </h1>
          <p>
            Describe what you need. Let providers compete. Open your terminal and take it from
            there.
          </p>
          <div className="login-visual">
            <div className="visual-window">
              <div className="visual-dots">
                <i />
                <i />
                <i />
                <span>your environment</span>
              </div>
              <div className="visual-command">
                <span>~</span> Ready when you are
                <span className="visual-cursor" />
              </div>
              <div className="visual-footer">
                <span>
                  <i />
                  Private environment
                </span>
                <span>Yours to explore</span>
              </div>
            </div>
            <div className="visual-float">
              <ShieldCheck size={19} />
              <div>
                <strong>A clear price. Your own terminal.</strong>
                <span>Finite rentals, no surprises.</span>
              </div>
            </div>
          </div>
        </div>
        <div className="login-story-footer">
          Built for a little less friction.<span>Wick Broker v1</span>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-form-wrap">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Your workspace awaits.</h2>
          <p>Sign in to your invited Wick Broker account.</p>
          <form onSubmit={submit}>
            <label className="field" htmlFor="email">
              <span>Email</span>
              <input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="field" htmlFor="password">
              <span>Password</span>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <ErrorBox error={error} />
            <button className="button primary full-width" disabled={busy}>
              {busy ? (
                <Spinner label="Signing in" />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="invite-note">
            <ShieldCheck size={16} />
            <span>Invite-only access. Ask your administrator for an account.</span>
          </div>
          {(session.modes.wick === 'fixture' || session.modes.muse === 'fixture') && (
            <div className="login-demo">
              <span className="demo-dot" />
              <div>
                <strong>Demo environment</strong>
                <p>
                  {session.modes.wick === 'fixture'
                    ? 'VMs and terminal use an explicit fixture. '
                    : ''}
                  {session.modes.muse === 'fixture'
                    ? 'Muse responses are fixtures, not model calls. '
                    : ''}
                  {session.modes.wick === 'real'
                    ? 'VMs use the configured Wick account’s credits. Customer invoices are demo records; no payment is collected.'
                    : 'Supply and customer pricing are simulated.'}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="login-bottom">Your commands stay between you and your environment.</div>
      </div>
    </div>
  );
}

export default function App() {
  const previousActor = useRef<string | null | undefined>(undefined);
  const sidebarRef = useRef<HTMLElement>(null);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const environmentRef = useRef<HTMLDetailsElement>(null);
  const [session, setSession] = useState<Session | null>(null),
    [bootError, setBootError] = useState(''),
    [location, setLocation] = useState(window.location.pathname + window.location.search),
    [mobileOpen, setMobileOpen] = useState(false),
    [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    environmentRef.current?.removeAttribute('open');
  }, [location]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]')
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const desktop = window.matchMedia('(min-width: 801px)');
    const onDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    desktop.addEventListener('change', onDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      desktop.removeEventListener('change', onDesktop);
      navigationToggleRef.current?.focus();
    };
  }, [mobileOpen]);
  const navigate = (next: string) => {
    if (next !== window.location.pathname + window.location.search)
      window.history.pushState({}, '', next);
    setLocation(window.location.pathname + window.location.search);
    setMobileOpen(false);
    window.scrollTo(0, 0);
  };
  const refreshSession = async () => {
    try {
      const result = await api<Session>('/api/me');
      if (
        previousActor.current !== undefined &&
        previousActor.current !== (result.user?.id ?? null)
      )
        sessionStorage.removeItem('wick-draft');
      previousActor.current = result.user?.id ?? null;
      setSession(result);
      setBootError('');
      if (
        result.user &&
        (window.location.pathname === '/' || window.location.pathname === '/login')
      )
        navigate(
          result.user.role === 'provider'
            ? '/provider/capacity'
            : result.user.role === 'admin'
              ? '/admin'
              : '/orders',
        );
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Unable to reach Wick Broker.');
    }
  };
  useEffect(() => {
    void refreshSession();
    const onPop = () => {
      setLocation(window.location.pathname + window.location.search);
      setMobileOpen(false);
    };
    window.addEventListener('popstate', onPop);
    const timer = setInterval(() => {
      void refreshSession();
    }, 30000);
    return () => {
      window.removeEventListener('popstate', onPop);
      clearInterval(timer);
    };
  }, []);
  async function signOut() {
    setSigningOut(true);
    try {
      await post('/api/auth/sign-out');
      sessionStorage.removeItem('wick-draft');
      previousActor.current = null;
      setSession((s) => (s ? { ...s, user: null } : s));
      navigate('/login');
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Unable to sign out.');
    } finally {
      setSigningOut(false);
    }
  }
  if (!session)
    return (
      <div className="boot-screen">
        <Brand />
        {bootError ? (
          <ErrorBox error={bootError} retry={() => void refreshSession()} />
        ) : (
          <Spinner label="Opening your workspace" />
        )}
      </div>
    );
  if (!session.user)
    return (
      <NavigationContext.Provider value={navigate}>
        <SessionContext.Provider value={session}>
          <Login session={session} onSignedIn={refreshSession} />
        </SessionContext.Provider>
      </NavigationContext.Provider>
    );
  const user = session.user;
  const path = location.split('?')[0]!;
  const search = location.includes('?') ? location.slice(location.indexOf('?')) : '';
  const navigation =
    user.role === 'provider'
      ? providerNavigation
      : user.role === 'admin'
        ? [{ path: '/admin', label: 'Configuration', icon: Settings2 } as NavigationItem]
        : buyerNavigation;
  let content;
  if (path === '/keys' && user.role !== 'admin') content = <DeveloperKeys key={user.id} />;
  else if (user.role === 'buyer') {
    if (path === '/orders') content = <Orders search={search} />;
    else if (path === '/studio') content = <Studio key={user.id} search={search} />;
    else if (path === '/studio/legacy') content = <CodingStudio key={user.id} search={search} />;
    else if (path.startsWith('/studio/tasks/'))
      content = <StudioTaskPage key={path} id={path.split('/')[3]!} />;
    else if (path.startsWith('/studio/jobs/'))
      content = <CodingJobPage key={path} id={path.split('/')[3]!} />;
    else if (path === '/agents') content = <Agents key={user.id} search={search} />;
    else if (path.startsWith('/agents/'))
      content = <AgentDetail key={`${user.id}:${path}`} id={path.split('/')[2]!} search={search} />;
    else if (path === '/tokens') content = <TokenInventory key={user.id} search={search} />;
    else if (path === '/token-orders/new')
      content = <TokenComposer key={location} search={search} />;
    else if (path.startsWith('/token-orders/'))
      content = <TokenOrderPage key={path} id={path.split('/')[2]!} />;
    else if (path.startsWith('/orders/'))
      content = <AgreementDetail key={path} id={path.split('/')[2]!} />;
    else if (path === '/agreements/new') content = <RetiredScheduledVMs />;
    else if (path.startsWith('/agreements/'))
      content = <AgreementDetail key={path} id={path.split('/')[2]!} />;
    else if (path === '/credits') content = <Credits />;
    else if (path === '/requests/review') content = <RequestReview />;
    else if (path === '/alternatives/new') content = <AlternativeComposer key={path} />;
    else if (path.startsWith('/alternatives/from/'))
      content = <AlternativeComposer key={path} sourceRequestId={path.split('/')[3]!} />;
    else if (path === '/alternatives') content = <AlternativeList />;
    else if (path.startsWith('/alternatives/'))
      content = <AlternativeDetail key={path} id={path.split('/')[2]!} />;
    else if (path.startsWith('/requests/')) content = <AuctionPage id={path.split('/')[2]!} />;
    else if (path.startsWith('/vms/')) content = <VMDetail id={path.split('/')[2]!} />;
    else if (path === '/vms') content = <MyVMs search={search} />;
    else if (path === '/invoices') content = <Invoices />;
    else if (path === '/new/vm' || (path === '/new' && new URLSearchParams(search).has('copy')))
      content = <NewEnvironment key={location} />;
    else content = <PurchaseChooser />;
  } else if (user.role === 'provider') {
    if (path === '/provider/policy') content = <ProviderPolicy />;
    else if (path === '/provider/requests') content = <ProviderRequests />;
    else if (path === '/provider/offerings') content = <ProviderOfferings />;
    else if (path === '/provider/scheduled') content = <RetiredScheduledVMs provider />;
    else if (path === '/provider/inference') content = <ProviderInference search={search} />;
    else if (path === '/provider/earnings') content = <ProviderEarnings />;
    else if (path === '/provider/activity') content = <ProviderActivity />;
    else content = <ProviderCapacity />;
  } else
    content = (
      <>
        <AdminConfig onUpdated={() => void refreshSession()} />
        <AdminCreditGrant />
      </>
    );
  const currentNav =
    navigation.find((item) => path === item.path || path.startsWith(item.path + '/'))?.label ||
    (path === '/new' && !new URLSearchParams(search).has('copy')
      ? 'New purchase'
      : path === '/requests/review' || path === '/new'
        ? 'Launch a VM'
        : path.startsWith('/requests/') ||
            path.startsWith('/agreements/') ||
            path.startsWith('/token-orders/')
          ? 'Orders'
          : navigation[0]?.label);
  const isNavActive = (to: string) =>
    path === to ||
    path.startsWith(to + '/') ||
    (to === '/new/vm' &&
      (path === '/requests/review' ||
        (path === '/new' && new URLSearchParams(search).has('copy')))) ||
    (to === '/orders' &&
      ((path.startsWith('/requests/') && path !== '/requests/review') ||
        (path.startsWith('/agreements/') && path !== '/agreements/new') ||
        (path.startsWith('/token-orders/') && path !== '/token-orders/new')));
  return (
    <NavigationContext.Provider value={navigate}>
      <SessionContext.Provider value={session}>
        <div className="app-shell">
          <a className="skip-link" href="#workspace-content">
            Skip to content
          </a>
          {mobileOpen && (
            <button
              className="sidebar-scrim"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            />
          )}
          <aside
            id="workspace-navigation"
            ref={sidebarRef}
            className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
            role={mobileOpen ? 'dialog' : undefined}
            aria-modal={mobileOpen || undefined}
            aria-label="Workspace navigation"
          >
            <div className="sidebar-brand">
              <Link href={navigation[0]!.path} aria-label="Wick Broker home">
                <Brand />
              </Link>
              <button
                className="icon-button mobile-only"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation"
              >
                <X size={20} />
              </button>
            </div>
            <div className="workspace-switch">
              <span className="workspace-symbol">
                {user.role === 'provider' ? (
                  <Cpu size={17} />
                ) : user.role === 'admin' ? (
                  <ShieldCheck size={17} />
                ) : (
                  <Box size={17} />
                )}
              </span>
              <div>
                <strong>
                  {user.role === 'provider'
                    ? 'Provider workspace'
                    : user.role === 'admin'
                      ? 'Administration'
                      : 'My workspace'}
                </strong>
                <span>{user.role === 'buyer' ? 'Customer account' : user.name}</span>
              </div>
            </div>
            {user.role === 'buyer' && (
              <Link
                href="/new"
                className="button primary buyer-new-purchase"
                aria-current={
                  path === '/new' && !new URLSearchParams(search).has('copy') ? 'page' : undefined
                }
              >
                <Plus size={15} /> New purchase <ArrowRight size={14} />
              </Link>
            )}
            {user.role !== 'buyer' && (
              <div className="nav-label">
                {user.role === 'provider'
                  ? 'MANAGE SUPPLY'
                  : user.role === 'admin'
                    ? 'WORKSPACE SETTINGS'
                    : 'WORKSPACE'}
              </div>
            )}
            <nav aria-label="Main navigation">
              {navigation.map(({ path: to, label, icon: Icon, group }, index) => (
                <Fragment key={to}>
                  {group && navigation[index - 1]?.group !== group && (
                    <div className="buyer-nav-heading">{group}</div>
                  )}
                  <Link
                    href={to}
                    className={`nav-item ${isNavActive(to) ? 'active' : ''}`}
                    aria-current={isNavActive(to) ? 'page' : undefined}
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                  </Link>
                </Fragment>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="sidebar-assistant">
                <span className="muse-mini-icon">
                  <Sparkles size={16} />
                </span>
                <div>
                  <strong>{MUSE_DISPLAY_NAME}</strong>
                  <span>
                    {session.modes.muse === 'fixture'
                      ? 'Fixture · no model calls'
                      : `${MUSE_PROVIDER} · AI drafts enabled`}
                  </span>
                </div>
              </div>
              <div className="sidebar-footnote">
                <span className="green-dot" />
                Wick Broker v1<span>USD</span>
              </div>
            </div>
          </aside>
          <div className="main-shell" inert={mobileOpen || undefined}>
            <header className="topbar">
              <div className="topbar-location">
                <button
                  className="icon-button mobile-only"
                  ref={navigationToggleRef}
                  onClick={() => setMobileOpen(true)}
                  aria-label="Open navigation"
                  aria-expanded={mobileOpen}
                  aria-controls="workspace-navigation"
                >
                  <Menu size={20} />
                </button>
                <span>
                  {user.role === 'buyer'
                    ? 'Workspace'
                    : user.role === 'provider'
                      ? 'Provider'
                      : 'Admin'}
                </span>
                <span className="slash">/</span>
                <strong>{currentNav}</strong>
              </div>
              <div className="topbar-account">
                <details
                  className="environment-status"
                  data-mode={session.modes.wick}
                  ref={environmentRef}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      event.currentTarget.open = false;
                  }}
                >
                  <summary aria-label="Environment mode">
                    <span className="demo-dot" />
                    {session.modes.wick === 'fixture' ? 'Demo environment' : 'Live VMs'}
                    <ChevronDown size={12} />
                  </summary>
                  <div className="environment-popover">
                    <strong>
                      {session.modes.wick === 'fixture'
                        ? 'Simulated environments'
                        : 'Real Wick environments'}
                    </strong>
                    <p>
                      {session.modes.wick === 'fixture'
                        ? 'VMs and terminals use fixtures. No real compute is allocated.'
                        : 'VM usage consumes the configured Wick account’s compute credits.'}
                    </p>
                    <p>
                      {session.modes.muse === 'fixture' ? (
                        'Muse fixture · no model calls'
                      ) : (
                        <>
                          {museLabel}
                          <br />
                          <code>{MUSE_MODEL}</code>
                        </>
                      )}
                    </p>
                    <p>Pilot pricing · no payment collected</p>
                  </div>
                </details>
                <div className="account-avatar">
                  {user.name
                    ?.split(' ')
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join('') || user.email[0]}
                </div>
                <div className="account-name">
                  <strong>{user.name || user.email}</strong>
                  <span>{user.role}</span>
                </div>
                <button
                  className="icon-button"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                  title="Sign out"
                  aria-label="Sign out"
                >
                  <LogOut size={17} />
                </button>
              </div>
            </header>
            <main className="main-content" id="workspace-content" tabIndex={-1}>
              {bootError && <ErrorBox error={bootError} />}
              {content}
            </main>
            <footer className="app-footer">
              <span>
                Wick Broker<span className="middle-dot">·</span>Compute and AI, on your terms.
              </span>
              <span>
                <ShieldCheck size={13} />
                Private by default
              </span>
            </footer>
          </div>
        </div>
      </SessionContext.Provider>
    </NavigationContext.Provider>
  );
}
