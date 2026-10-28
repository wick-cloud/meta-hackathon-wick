import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  Box,
  ChevronDown,
  CircleDollarSign,
  Cpu,
  LayoutGrid,
  LogOut,
  Menu,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  X,
} from 'lucide-react';
import { api, post, type Session } from './api';
import { ErrorBox, Link, NavigationContext, SessionContext, Spinner } from './components';
import { NewEnvironment, RequestReview, AuctionPage, MyVMs, VMDetail, Invoices } from './buyer';
import { AlternativeComposer, AlternativeDetail, AlternativeList } from './negotiation';
import {
  ProviderCapacity,
  ProviderPolicy,
  ProviderRequests,
  ProviderOfferings,
  ProviderActivity,
  ProviderEarnings,
  AdminConfig,
} from './provider';

const buyerNavigation = [
  { path: '/new', label: 'New environment', icon: Plus },
  { path: '/alternatives', label: 'Alternatives', icon: Sparkles },
  { path: '/vms', label: 'My VMs', icon: LayoutGrid },
  { path: '/invoices', label: 'Invoices', icon: CircleDollarSign },
];
const providerNavigation = [
  { path: '/provider/capacity', label: 'Capacity', icon: Cpu },
  { path: '/provider/policy', label: 'Policy', icon: Settings2 },
  { path: '/provider/requests', label: 'Requests', icon: Box },
  { path: '/provider/offerings', label: 'Offerings', icon: LayoutGrid },
  { path: '/provider/earnings', label: 'Earnings', icon: CircleDollarSign },
  { path: '/provider/activity', label: 'Activity', icon: Activity },
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
  const [session, setSession] = useState<Session | null>(null),
    [bootError, setBootError] = useState(''),
    [path, setPath] = useState(window.location.pathname),
    [mobileOpen, setMobileOpen] = useState(false),
    [signingOut, setSigningOut] = useState(false);
  const navigate = (next: string) => {
    if (next !== window.location.pathname) window.history.pushState({}, '', next);
    setPath(next);
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
              : '/new',
        );
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Unable to reach Wick Broker.');
    }
  };
  useEffect(() => {
    void refreshSession();
    const onPop = () => {
      setPath(window.location.pathname);
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
  const navigation =
    user.role === 'provider'
      ? providerNavigation
      : user.role === 'admin'
        ? [{ path: '/admin', label: 'Configuration', icon: Settings2 }]
        : buyerNavigation;
  let content;
  if (user.role === 'buyer') {
    if (path === '/requests/review') content = <RequestReview />;
    else if (path === '/alternatives/new') content = <AlternativeComposer key={path} />;
    else if (path.startsWith('/alternatives/from/'))
      content = <AlternativeComposer key={path} sourceRequestId={path.split('/')[3]!} />;
    else if (path === '/alternatives') content = <AlternativeList />;
    else if (path.startsWith('/alternatives/'))
      content = <AlternativeDetail key={path} id={path.split('/')[2]!} />;
    else if (path.startsWith('/requests/')) content = <AuctionPage id={path.split('/')[2]!} />;
    else if (path.startsWith('/vms/')) content = <VMDetail id={path.split('/')[2]!} />;
    else if (path === '/vms') content = <MyVMs />;
    else if (path === '/invoices') content = <Invoices />;
    else content = <NewEnvironment />;
  } else if (user.role === 'provider') {
    if (path === '/provider/policy') content = <ProviderPolicy />;
    else if (path === '/provider/requests') content = <ProviderRequests />;
    else if (path === '/provider/offerings') content = <ProviderOfferings />;
    else if (path === '/provider/earnings') content = <ProviderEarnings />;
    else if (path === '/provider/activity') content = <ProviderActivity />;
    else content = <ProviderCapacity />;
  } else content = <AdminConfig onUpdated={() => void refreshSession()} />;
  const currentNav =
    navigation.find((item) => path === item.path || path.startsWith(item.path + '/'))?.label ||
    (path.startsWith('/requests/') ? 'New environment' : navigation[0]?.label);
  return (
    <NavigationContext.Provider value={navigate}>
      <SessionContext.Provider value={session}>
        <div className="app-shell">
          {mobileOpen && (
            <button
              className="sidebar-scrim"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            />
          )}
          <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
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
              <ChevronDown size={14} />
            </div>
            <div className="nav-label">
              {user.role === 'provider'
                ? 'MANAGE SUPPLY'
                : user.role === 'admin'
                  ? 'WORKSPACE SETTINGS'
                  : 'WORKSPACE'}
            </div>
            <nav aria-label="Main navigation">
              {navigation.map(({ path: to, label, icon: Icon }) => (
                <Link
                  key={to}
                  href={to}
                  className={`nav-item ${path === to || path.startsWith(to + '/') || (to === '/new' && path.startsWith('/requests/')) ? 'active' : ''}`}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {to === '/new' && <span className="nav-plus">+</span>}
                </Link>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="sidebar-muse">
                <span className="muse-mini-icon">
                  <Sparkles size={16} />
                </span>
                <strong>A little help from Muse</strong>
                <p>
                  {session.modes.muse === 'fixture'
                    ? 'Explicit fixture responses make this demo easy to explore.'
                    : 'From a simple description to a supported environment.'}
                </p>
                <span>
                  {session.modes.muse === 'fixture'
                    ? 'Fixture mode · no model calls'
                    : 'Powered by muse-wonder-1.0'}
                </span>
              </div>
              <div className="sidebar-footnote">
                <span className="green-dot" />
                Wick Broker v1<span>USD</span>
              </div>
            </div>
          </aside>
          <div className="main-shell">
            <header className="topbar">
              <div className="topbar-location">
                <button
                  className="icon-button mobile-only"
                  onClick={() => setMobileOpen(true)}
                  aria-label="Open navigation"
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
                <span className="environment-badge">
                  <span className="demo-dot" />
                  {session.modes.wick === 'real' ? 'Wick-backed demo supply' : 'Simulated supply'}
                </span>
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
            <main className="main-content">
              {bootError && <ErrorBox error={bootError} />}
              <div className="mode-banner">
                <span>
                  <span className="demo-dot" />
                  {session.modes.wick === 'fixture'
                    ? 'Fixture environments & terminal'
                    : 'Real Wick VMs · uses Wick credits'}
                </span>
                <span className="mode-banner-detail">
                  {session.modes.muse === 'fixture'
                    ? 'Muse fixture · no model calls'
                    : 'Muse API enabled'}
                  <span className="middle-dot">·</span>Demo quotes · no payment due
                </span>
              </div>
              {content}
            </main>
            <footer className="app-footer">
              <span>
                Wick Broker<span className="middle-dot">·</span>Environments on your terms.
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
