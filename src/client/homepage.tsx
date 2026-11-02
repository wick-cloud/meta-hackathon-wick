import { useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  Clock3,
  Code2,
  Cpu,
  Layers3,
  RotateCcw,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { Brand } from './brand';
import { Link } from './components';
import './homepage.css';

const sampleBids = [
  { name: 'Provider A', mark: 'A', price: '$0.1200', winner: false },
  { name: 'Provider B', mark: 'B', price: '$0.0900', winner: true },
  { name: 'Provider C', mark: 'C', price: '$0.1100', winner: false },
];

function ExampleAuction() {
  const [perspective, setPerspective] = useState<'buyer' | 'seller'>('buyer');
  const [awarded, setAwarded] = useState(false);
  const seller = perspective === 'seller';
  return (
    <section className="home-auction" aria-labelledby="example-auction-title">
      <div className="home-console-topline">
        <span>
          <span className="home-example-dot" /> Example auction
        </span>
        <span className="home-console-ref">REQ_0001</span>
      </div>
      <div className="home-perspective" role="group" aria-label="Auction perspective">
        <button type="button" aria-pressed={!seller} onClick={() => setPerspective('buyer')}>
          <TerminalSquare size={15} /> Buyer view
        </button>
        <button type="button" aria-pressed={seller} onClick={() => setPerspective('seller')}>
          <Server size={15} /> Seller view
        </button>
      </div>
      <div className="home-auction-heading">
        <span className="home-resource-icon">
          <Cpu size={22} />
        </span>
        <div>
          <h2 id="example-auction-title">Linux development environment</h2>
          <p>
            2 vCPU <span>·</span> 4 GiB RAM <span>·</span> 30 min
          </p>
        </div>
      </div>
      <dl className="home-auction-metrics">
        <div>
          <dt>Buyer budget</dt>
          <dd>$0.1500</dd>
        </div>
        <div>
          <dt>Eligible bids</dt>
          <dd>03</dd>
        </div>
        <div>
          <dt>{awarded ? 'Auction closed' : 'Auction window'}</dt>
          <dd className="home-auction-clock">
            <Clock3 size={15} /> {awarded ? '00:00' : '00:30'}
          </dd>
        </div>
      </dl>
      {seller && (
        <div className="home-example-policy">
          <ShieldCheck size={15} />
          <span>
            Your floor <strong>$0.0800</strong>
          </span>
          <span>
            Keep spare <strong>2 slots</strong>
          </span>
        </div>
      )}
      <div className="home-bid-list" role="table" aria-label="Example provider bids">
        <div className="home-bid-row home-bid-header" role="row">
          <span role="columnheader">Provider</span>
          <span role="columnheader">Total bid</span>
          <span role="columnheader">{seller ? 'Your position' : 'Status'}</span>
        </div>
        {sampleBids.map((bid) => (
          <div
            className={`home-bid-row ${bid.winner ? 'home-leading-bid' : ''}`}
            role="row"
            key={bid.mark}
          >
            <span role="cell" className="home-bid-provider">
              <span className="home-provider-mark">{bid.mark}</span>
              <span>
                {bid.name}
                {seller && bid.winner && <small>Your offering</small>}
              </span>
            </span>
            <span role="cell" className="home-bid-price">
              {bid.price}
            </span>
            <span role="cell" className={bid.winner ? 'home-bid-leading' : 'home-bid-muted'}>
              {bid.winner ? (
                <>
                  {awarded ? <Check size={13} /> : <span className="home-status-dot" />}
                  {awarded ? 'Awarded' : 'Lowest bid'}
                </>
              ) : awarded ? (
                'Not selected'
              ) : (
                'Eligible'
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="home-auction-outcome" aria-live="polite" aria-atomic="true">
        <span className={`home-outcome-icon ${awarded ? 'is-awarded' : ''}`}>
          {awarded ? <Check size={17} /> : <Layers3 size={17} />}
        </span>
        <div>
          <strong>
            {awarded
              ? seller
                ? 'Your bid wins. Capacity is committed.'
                : 'Provider B wins at $0.0900.'
              : seller
                ? 'Your bid is within your approved limits.'
                : 'The lowest eligible bid wins.'}
          </strong>
          <p>
            {awarded
              ? 'Provisioning follows the award. Terminal access follows readiness.'
              : seller
                ? 'One binding bid per provider. Existing reservations stay protected.'
                : 'Providers compete within your requirements and maximum total.'}
          </p>
        </div>
      </div>
      <div className="home-auction-footer">
        <span>Illustration only · no purchase</span>
        <button type="button" onClick={() => setAwarded((value) => !value)}>
          {awarded ? (
            <>
              <RotateCcw size={13} /> Replay example
            </>
          ) : (
            <>
              Show award <ArrowRight size={13} />
            </>
          )}
        </button>
      </div>
    </section>
  );
}

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
              Compute and AI tokens. <br />
              <span>Providers compete for your workload.</span>
            </h1>
            <p className="home-hero-description">
              Set the requirements. Name your budget. Let eligible providers compete in a 30-second
              auction.
            </p>
            <div className="home-hero-actions">
              <Link href="/login?intent=buy" className="button primary">
                Buy resources <ArrowRight size={16} />
              </Link>
              <Link href="/login?intent=sell" className="button secondary">
                Sell capacity <ArrowRight size={16} />
              </Link>
            </div>
            <p className="home-access-note">One marketplace. A workspace for each side.</p>
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
            <ExampleAuction />
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
            <p>From a place to run your code to the model usage behind your agents.</p>
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
                Give your agent a budget. Buy prepaid input and output tokens through an auction or
                an instant quote.
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
                      Open your VM terminal when ready, or connect your agent to its prepaid tokens.
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
