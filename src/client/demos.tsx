import { useEffect } from 'react';
import { ArrowRight, ArrowUpRight, Bot, Clock3, RefreshCw, Sparkles } from 'lucide-react';
import { Brand } from './brand';
import { Link } from './components';
import {
  DemoAction,
  StudioDemoTask,
  DemoError,
  DemoOverview,
  HomepageDemoSession,
  useHomepageDemo,
} from './homepage-demo';
import './homepage.css';
import './demos.css';

/** Public demo entry point. Visiting this page only reads an existing guest session. */
export function DemoLanding() {
  const demo = useHomepageDemo();
  const fixtureMode = demo.data?.mode === 'fixture';
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id === 'live-demo' || id === 'demo-overview')
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [demo.data?.run?.id]);
  return (
    <div className="broker-home broker-demos">
      <a className="skip-link" href="#demos-content">
        Skip to content
      </a>
      <header className="home-header">
        <Link href="/" aria-label="Wick Broker home">
          <Brand />
        </Link>
        <nav aria-label="Marketplace navigation">
          <Link href="/">Marketplace</Link>
          <Link href="/demos" aria-current="page">
            Live demos
          </Link>
          <Link href="/login" className="button secondary">
            Sign in <ArrowRight size={14} />
          </Link>
        </nav>
      </header>
      <main id="demos-content">
        <section className="demos-intro" aria-labelledby="demos-title">
          <span className="home-eyebrow">
            <span /> WICK, IN ACTION
          </span>
          <h1 id="demos-title">
            Meet the market. <br />
            <span>Then put it to work.</span>
          </h1>
          <p>
            {fixtureMode
              ? 'Explore simulated provider bids, environments, and model responses. This preview does not allocate real resources.'
              : 'Follow real provider bids into a working environment. Explore the demos below, then bring your next build to Wick.'}
          </p>
          <div className="demos-intro-meta">
            <span>
              <Sparkles size={14} /> {fixtureMode ? 'Fixture preview' : 'Free during the hackathon'}
            </span>
            <span>No account or payment needed</span>
          </div>
        </section>

        {fixtureMode && (
          <p className="demo-fixture-note" role="status">
            Fixture preview · Resources, model responses, and execution are simulated.
          </p>
        )}
        {!demo.data?.run && <DemoError demo={demo} />}
        {!demo.data?.run && !demo.error && (
          <div className="demos-status-action">
            <button
              className="button secondary small"
              disabled={demo.refreshing || !!demo.busy}
              onClick={() => void demo.refresh()}
            >
              <RefreshCw size={14} />
              {demo.refreshing ? 'Checking demo status…' : 'Check demo status'}
            </button>
          </div>
        )}
        <div className={`demos-options ${demo.data?.run ? 'has-active-demo' : ''}`}>
          <section className="demos-terminal-choice" aria-label="Terminal demo">
            <div className="demos-choice-action">
              <DemoAction demo={demo} />
              <p>
                {demo.data?.run
                  ? 'Your guest session is saved. Return to this page to resume it.'
                  : fixtureMode
                    ? 'A simulated VM, demo disk, and fixture model responses.'
                    : 'A real VM, your own disk, and a small Meta Muse allowance.'}
              </p>
            </div>
            <DemoOverview demo={demo} />
          </section>
          <section
            id="studio-demo"
            className="demos-studio-choice"
            aria-labelledby="studio-demo-title"
          >
            <div className="demos-studio-topline">
              <span>GUIDED MUSE STUDIO</span>
              <span className="demo-sponsored">Sponsored</span>
            </div>
            <div className="demos-studio-body">
              <span className="demos-studio-icon">
                <Bot size={32} />
              </span>
              <h2 id="studio-demo-title">
                Let Muse write it.
                <br />
                Watch Python run.
              </h2>
              <p>
                {fixtureMode
                  ? 'Preview a Python Hello World task with fixture source, simulated VM execution, and an explicit test receipt.'
                  : 'Give Meta Muse one task: write a Python Hello World file. Watch it generate the code, run in your VM, and verify the output.'}
              </p>
              <div className="demos-studio-preview">
                <span>Generate Python</span>
                <ArrowRight size={13} />
                <span>Run in your VM</span>
                <ArrowRight size={13} />
                <span>Check the result</span>
              </div>
              <p className="demos-studio-notice">
                A guided Hello World task with visible source and execution results. Then explore
                the files in your terminal. No API key to copy.
              </p>
              <StudioDemoTask />
              <DemoAction demo={demo} kind="studio" />
            </div>
          </section>
        </div>

        <p className="demos-shared-allowance">
          <Clock3 size={15} />
          <span>
            Choose one demo per session. Both share a {demo.data?.limits.durationMinutes ?? 15}
            -minute VM lease, up to {demo.data?.limits.maxRequests ?? 2} model calls, and a{' '}
            {demo.data?.limits.cooldownMinutes ?? 20}-minute cooldown after the VM ends. You can’t
            switch demos during an active run.
          </span>
        </p>

        <HomepageDemoSession demo={demo} />

        <section className="demos-beta" aria-label="Join the buyer beta">
          <div>
            <span className="home-eyebrow">YOUR NEXT BUILD STARTS HERE</span>
            <h2>Like what you can do?</h2>
            <p>Join the buyer beta for access to the marketplace.</p>
          </div>
          <a
            href="https://app.wick-cloud.com/waitlist"
            className="button primary"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Join buyer beta (opens in a new tab)"
          >
            Join buyer beta <ArrowUpRight size={16} />
          </a>
        </section>
      </main>
      <footer className="home-footer">
        <Brand />
        <p>Hands-on demos · Real resources when available</p>
        <Link href="/">
          Back to marketplace <ArrowRight size={13} />
        </Link>
      </footer>
    </div>
  );
}
