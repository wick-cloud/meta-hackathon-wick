import { useEffect } from 'react';
import { ArrowRight, ArrowUpRight, Cpu, TerminalSquare } from 'lucide-react';
import { Brand } from './brand';
import { Link } from './components';
import './homepage.css';
import './demos.css';
import './local-demo.css';

/** The standalone frontend never mounts the hosted demo's session or allocation controls. */
export function LocalDemoLanding() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'Wick Broker · Local demo';
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="broker-home broker-demos local-demo">
      <a className="skip-link" href="#local-demo-content">
        Skip to content
      </a>
      <header className="home-header">
        <Link href="/" aria-label="Wick Broker home">
          <Brand />
        </Link>
        <a className="local-demo-platform" href="https://wick-cloud.com">
          Visit Wick <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </header>
      <main id="local-demo-content">
        <section className="demos-intro" aria-labelledby="local-demo-title">
          <span className="home-eyebrow">
            <span /> LOCAL DEMO · SAMPLE DATA
          </span>
          <h1 id="local-demo-title">Explore Wick Broker</h1>
          <p>
            A marketplace for sandbox compute and AI tokens, built during the hackathon on top of
            the existing Wick platform. Try both sides of the service with a guided workspace.
          </p>
          <div className="demos-intro-meta">
            <span>No account or API keys</span>
            <span>No database setup</span>
            <span>No real resources allocated</span>
          </div>
        </section>

        <section className="demos-interactive" aria-labelledby="local-demo-perspectives">
          <div className="demos-interactive-heading">
            <div>
              <span className="home-eyebrow">CHOOSE YOUR WORKSPACE</span>
              <h2 id="local-demo-perspectives">See both sides of the market.</h2>
              <p>
                Use the regular console with simulated purchases, terminals, and model responses.
                Changes stay in this tab. Reset the demo or reload to start fresh.
              </p>
            </div>
          </div>
          <div className="demos-interactive-options">
            <Link
              href="/demo/buyer"
              className="demos-interactive-option"
              aria-label="Explore as a buyer"
            >
              <span className="demos-interactive-icon" aria-hidden="true">
                <TerminalSquare size={22} />
              </span>
              <span>
                <strong>Explore as a buyer</strong>
                <span>Launch a sample VM, try the terminal, and run a Muse Studio task.</span>
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <Link
              href="/demo/seller"
              className="demos-interactive-option"
              aria-label="Explore as a seller"
            >
              <span className="demos-interactive-icon" aria-hidden="true">
                <Cpu size={22} />
              </span>
              <span>
                <strong>Explore as a seller</strong>
                <span>Set capacity, bid on a request, and inspect sample earnings.</span>
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className="demos-beta" aria-labelledby="local-demo-hosted">
          <div>
            <span className="home-eyebrow">CONNECTED TO REAL INFRASTRUCTURE</span>
            <h2 id="local-demo-hosted">Try the hosted service.</h2>
            <p>
              Real auctions, a live VM, and Muse calls through Wick. The sponsored demo has runtime,
              usage, and cooldown limits.
            </p>
          </div>
          <a
            href="https://meta-hackathon-wick-production.up.railway.app/demos"
            className="button primary"
          >
            Try the hosted live demo <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </section>
      </main>
      <footer className="home-footer">
        <Brand />
        <p>
          Wick is the platform. Broker is the hackathon application built on it. This local demo
          simulates the experience; the hosted service connects it to sandbox providers.
        </p>
      </footer>
    </div>
  );
}
