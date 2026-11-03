import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Clock3,
  Code2,
  Cpu,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { Brand } from './brand';
import { Link } from './components';
import './homepage.css';

export function HomePage() {
  return (
    <div className="broker-home">
      <a className="skip-link" href="#marketplace-home">
        Skip to content
      </a>
      <header className="home-header">
        <Link href="/" aria-label="Wick Broker home">
          <Brand />
        </Link>
        <nav aria-label="Marketplace navigation">
          <Link href="/demos">Live demos</Link>
          <a href="#marketplace">Marketplace</a>
          <a href="#how-it-works">How it works</a>
          <Link href="/login" className="button secondary">
            Sign in <ArrowRight size={14} />
          </Link>
        </nav>
      </header>
      <main id="marketplace-home">
        <section className="home-hero" aria-labelledby="home-headline">
          <div className="home-hero-copy">
            <div className="home-eyebrow">
              <span /> THE CAPACITY MARKETPLACE
            </div>
            <h1 id="home-headline">
              Compute and AI. <br />
              <span>On your terms.</span>
            </h1>
            <p className="home-hero-description">
              Compare provider bids for Wick compute and Meta Muse tokens. Set your budget, launch a
              private workspace, or bring your next task to Muse Studio.
            </p>
            <div className="home-hero-actions">
              <Link href="/demos" className="button primary">
                Explore live demos <ArrowRight size={16} />
              </Link>
              <a
                href="https://app.wick-cloud.com/waitlist"
                className="button secondary"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Join buyer beta (opens in a new tab)"
              >
                Join buyer beta <ArrowUpRight size={16} />
              </a>
            </div>
            <p className="home-access-note">
              Try the platform without an account. Build with us in the buyer beta.
            </p>
            <div className="home-hero-facts">
              <span>
                <Clock3 size={15} /> 30-second auctions
              </span>
              <span>
                <ShieldCheck size={15} /> Your budget is the ceiling
              </span>
            </div>
          </div>
          <div className="home-hero-console">
            <section className="home-workload-card" aria-labelledby="home-workload-title">
              <div className="home-workload-topline">
                <span>
                  <span className="home-workload-dot" /> ONE MARKETPLACE
                </span>
                <span>BUILT FOR BUILDERS</span>
              </div>
              <div className="home-workload-intro">
                <span className="home-eyebrow">FROM IDEA TO EXECUTION</span>
                <h2 id="home-workload-title">
                  Everything your next
                  <br />
                  build runs on.
                </h2>
                <p>Bring the workload. Choose the capacity.</p>
              </div>
              <div className="home-workload-resources">
                <div>
                  <span className="home-resource-icon">
                    <Server size={23} />
                  </span>
                  <div>
                    <strong>Wick compute</strong>
                    <span>A private workspace for your code.</span>
                  </div>
                  <span className="home-workload-number">01</span>
                </div>
                <div>
                  <span className="home-resource-icon">
                    <Sparkles size={23} />
                  </span>
                  <div>
                    <strong>Meta Muse tokens</strong>
                    <span>Model access for your apps and agents.</span>
                  </div>
                  <span className="home-workload-number">02</span>
                </div>
                <div>
                  <span className="home-resource-icon">
                    <Bot size={23} />
                  </span>
                  <div>
                    <strong>Muse Studio</strong>
                    <span>Plan agent work with budgets in view.</span>
                  </div>
                  <span className="home-workload-number">03</span>
                </div>
              </div>
              <div className="home-workload-flow" aria-label="Marketplace workflow">
                <span>Your requirements</span>
                <ArrowRight size={13} />
                <span>Provider bids</span>
                <ArrowRight size={13} />
                <span>Your next build</span>
              </div>
              <Link href="/demos" className="home-workload-link">
                See it in action <ArrowUpRight size={16} />
              </Link>
            </section>
          </div>
        </section>

        <section
          className="home-market-section"
          id="marketplace"
          aria-labelledby="home-market-title"
        >
          <div className="home-section-heading">
            <div>
              <span className="home-eyebrow">01 / THE MARKET</span>
              <h2 id="home-market-title">Two resources. One way to buy.</h2>
            </div>
            <p>From a place to run your code to the model usage behind your apps and agents.</p>
          </div>
          <div className="home-products">
            <article className="home-product">
              <div className="home-product-heading">
                <span className="home-resource-icon">
                  <Server size={23} />
                </span>
                <span>COMPUTE</span>
                <span className="home-product-protocol">VM / TERMINAL</span>
              </div>
              <h3>Virtual machines</h3>
              <p>
                Choose resources, region and rental time. Providers bid to deliver a private
                environment for your work.
              </p>
              <dl className="home-product-specs">
                <div>
                  <dt>You define</dt>
                  <dd>CPU · memory · location · duration</dd>
                </div>
                <div>
                  <dt>You receive</dt>
                  <dd>Fixed rental total + private terminal</dd>
                </div>
              </dl>
              <Link href="/login?intent=buy" className="home-product-link">
                Find compute <ArrowRight size={16} />
              </Link>
            </article>
            <article className="home-product">
              <div className="home-product-heading">
                <span className="home-resource-icon">
                  <Sparkles size={23} />
                </span>
                <span>AI INFERENCE</span>
                <span className="home-product-protocol">TOKENS / API</span>
              </div>
              <h3>AI token packs</h3>
              <p>
                Buy prepaid input and output tokens from your wallet through an auction or an
                instant quote. Connect your app with a batch API key; no agent setup required.
              </p>
              <dl className="home-product-specs">
                <div>
                  <dt>You define</dt>
                  <dd>Input · output · provider · budget</dd>
                </div>
                <div>
                  <dt>You receive</dt>
                  <dd>Prepaid allowances + scoped API access</dd>
                </div>
              </dl>
              <Link href="/login?intent=buy" className="home-product-link">
                Find AI tokens <ArrowRight size={16} />
              </Link>
            </article>
          </div>
        </section>

        <section className="home-flow-section" id="how-it-works" aria-labelledby="home-flow-title">
          <div className="home-section-heading">
            <div>
              <span className="home-eyebrow">02 / BOTH SIDES OF THE ORDER</span>
              <h2 id="home-flow-title">Your requirements. Their capacity.</h2>
            </div>
            <p>
              The buyer sets the request. The seller sets the limits. Broker matches eligible bids.
            </p>
          </div>
          <div className="home-journeys">
            <article>
              <div className="home-journey-heading">
                <TerminalSquare size={19} />
                <h3>For buyers</h3>
                <span>Demand</span>
              </div>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <h4>Define the job</h4>
                    <p>
                      Review the resources, duration or token quantities, and your maximum total.
                    </p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <h4>Let providers compete</h4>
                    <p>
                      Eligible providers submit bids. The lowest eligible total wins at the close.
                    </p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <h4>Put the purchase to work</h4>
                    <p>
                      Open your VM terminal when ready, or connect your app to its prepaid tokens.
                    </p>
                  </div>
                </li>
              </ol>
              <Link href="/login?intent=buy">
                Enter buyer workspace <ArrowRight size={15} />
              </Link>
            </article>
            <article>
              <div className="home-journey-heading">
                <Cpu size={19} />
                <h3>For sellers</h3>
                <span>Supply</span>
              </div>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <h4>Publish your capacity</h4>
                    <p>
                      Make approved compute configurations or AI capacity available to the market.
                    </p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <h4>Set your bidding limits</h4>
                    <p>
                      Control your price floor, availability and automatic bids within approved
                      policy.
                    </p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <h4>Track what you win</h4>
                    <p>
                      Review awards, committed capacity and earnings records in your provider
                      workspace.
                    </p>
                  </div>
                </li>
              </ol>
              <Link href="/login?intent=sell">
                Enter seller workspace <ArrowRight size={15} />
              </Link>
            </article>
          </div>
        </section>

        <section className="home-more" aria-labelledby="home-more-title">
          <div className="home-more-title">
            <span className="home-eyebrow">BUILT AROUND YOUR WORK</span>
            <h2 id="home-more-title">Beyond a single purchase.</h2>
            <ArrowDown size={22} aria-hidden="true" />
          </div>
          <div className="home-more-features">
            <article>
              <Bot size={20} />
              <div>
                <h3>Muse Studio</h3>
                <p>
                  Bring compute and model budgets together for agent tasks, with review before
                  purchases.
                </p>
              </div>
            </article>
            <article>
              <Code2 size={20} />
              <div>
                <h3>Developer access</h3>
                <p>
                  Use scoped keys, the SDK, CLI or MCP to bring the marketplace into your existing
                  workflow.
                </p>
              </div>
            </article>
          </div>
        </section>

        <section className="home-final-cta" aria-label="Open your workspace">
          <div>
            <span className="home-eyebrow">READY WHEN YOU ARE</span>
            <h2>Bring demand. Bring supply.</h2>
            <p>Sign in to your invited buyer or provider account.</p>
          </div>
          <div className="home-hero-actions">
            <Link href="/login?intent=buy" className="button primary">
              Buy resources <ArrowRight size={16} />
            </Link>
            <Link href="/login?intent=sell" className="button secondary">
              Sell capacity <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </main>
      <footer className="home-footer">
        <Brand />
        <p>
          Pilot marketplace · Invite-only access
          <br />
          <span>
            Customer prices and earnings are pilot accounting records. Payments and provider payouts
            are not enabled.
          </span>
        </p>
        <a href="#marketplace-home">Back to top ↑</a>
      </footer>
    </div>
  );
}
