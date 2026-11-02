import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Server,
  Sparkles,
  TerminalSquare,
  Wallet,
} from 'lucide-react';
import { Link, PageHeader } from './components';
import './purchases.css';

export function PurchaseContext({ kind }: { kind: 'vm' | 'tokens' }) {
  return (
    <div className="purchase-context">
      <Link href="/new">
        <ArrowLeft size={14} /> All purchase options
      </Link>
      <span className="purchase-context-divider" />
      <span>
        {kind === 'vm' ? <Server size={14} /> : <Sparkles size={14} />}
        {kind === 'vm' ? 'Virtual machine' : 'AI token pack'}
      </span>
    </div>
  );
}

export function PurchaseCards({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`purchase-choices ${compact ? 'is-compact' : ''}`}
      aria-label="Choose what to buy"
    >
      <section
        className="purchase-choice"
        aria-labelledby={compact ? 'quick-vm-title' : 'vm-choice-title'}
      >
        <div className="purchase-choice-top">
          <span className="purchase-choice-icon">
            <Server size={22} />
          </span>
          <span className="purchase-category">COMPUTE</span>
          {!compact && <span className="purchase-choice-badge">Your own terminal</span>}
        </div>
        <h2 id={compact ? 'quick-vm-title' : 'vm-choice-title'}>Launch a VM</h2>
        <p>
          {compact
            ? 'Set your resources and budget. Providers compete in a 30-second auction.'
            : 'A private environment for your code. Choose the resources, region and rental time.'}
        </p>
        {!compact && (
          <>
            <div className="purchase-illustration purchase-terminal" aria-hidden="true">
              <div>
                <i />
                <i />
                <i />
                <span>your workspace</span>
                <TerminalSquare size={13} />
              </div>
              <p>
                <span>~</span> ready to build<span className="purchase-cursor">▌</span>
              </p>
            </div>
            <ul className="purchase-features">
              <li>
                <Check size={14} /> CPU, memory and a private terminal
              </li>
              <li>
                <Check size={14} /> Providers bid in a 30-second auction
              </li>
              <li>
                <Check size={14} /> Start working when your VM is ready
              </li>
            </ul>
          </>
        )}
        <div className="purchase-choice-actions">
          <Link href="/new/vm" className="button primary">
            Configure VM <ArrowRight size={15} />
          </Link>
        </div>
      </section>
      <section
        className="purchase-choice"
        aria-labelledby={compact ? 'quick-tokens-title' : 'tokens-choice-title'}
      >
        <div className="purchase-choice-top">
          <span className="purchase-choice-icon">
            <Sparkles size={22} />
          </span>
          <span className="purchase-category">AI INFERENCE</span>
          {!compact && <span className="purchase-choice-badge">Meta Muse Spark Open</span>}
        </div>
        <h2 id={compact ? 'quick-tokens-title' : 'tokens-choice-title'}>Buy AI tokens</h2>
        <p>
          {compact
            ? 'Auction prepaid input and output tokens for your agent, or review an instant price.'
            : 'Prepaid model usage for your agent. Buy input and output tokens within a budget you control.'}
        </p>
        {!compact && (
          <>
            <div className="purchase-illustration purchase-token-diagram" aria-hidden="true">
              <span>
                <Bot size={18} />
                <small>Your agent</small>
              </span>
              <ArrowRight size={15} />
              <span className="purchase-token-model">
                <Sparkles size={18} />
                <small>Meta Muse</small>
              </span>
              <ArrowRight size={15} />
              <span>
                <Check size={18} />
                <small>Metered usage</small>
              </span>
            </div>
            <ul className="purchase-features">
              <li>
                <Check size={14} /> Separate input and output allowances
              </li>
              <li>
                <Check size={14} /> 30-second auction or an instant price
              </li>
              <li>
                <Check size={14} /> A budget-limited API key for your agent
              </li>
            </ul>
          </>
        )}
        <div className="purchase-choice-actions">
          <Link href="/token-orders/new" className="button primary">
            Buy a token pack <ArrowRight size={15} />
          </Link>
          {!compact && (
            <Link href="/agents" className="purchase-secondary-link">
              <Bot size={14} /> Manage agent budgets
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}

export function PurchaseChooser() {
  return (
    <div className="purchase-workspace">
      <PageHeader
        eyebrow="NEW PURCHASE"
        title="What do you need?"
        description="Compute for your code, or model tokens for your agent. Choose where to start."
      >
        <Link href="/orders" className="button secondary">
          View orders <ArrowRight size={15} />
        </Link>
      </PageHeader>
      <PurchaseCards />
      <section className="purchase-wallet-guide" aria-labelledby="purchase-wallet-title">
        <span className="purchase-wallet-icon">
          <Wallet size={21} />
        </span>
        <div>
          <h2 id="purchase-wallet-title">Wallet credits and token packs do different jobs.</h2>
          <p>
            Wallet credits fund agent and Studio task budgets. A token pack gives an agent prepaid
            AI usage. Your orders keep a record of every purchase.
          </p>
        </div>
        <Link href="/credits">
          Open wallet <ArrowRight size={14} />
        </Link>
      </section>
    </div>
  );
}

export function TokenPurchaseSteps({ hasAgent }: { hasAgent: boolean }) {
  return (
    <ol className="purchase-steps" aria-label="AI token setup">
      <li
        className={hasAgent ? 'is-complete' : 'is-current'}
        aria-current={!hasAgent ? 'step' : undefined}
      >
        <span>{hasAgent ? <Check size={13} /> : '1'}</span>
        <div>
          Set an agent budget<small>Reserve wallet credit</small>
        </div>
      </li>
      <li className={hasAgent ? 'is-current' : ''} aria-current={hasAgent ? 'step' : undefined}>
        <span>2</span>
        <div>
          Buy a token pack<small>Auction or instant price</small>
        </div>
      </li>
      <li>
        <span>3</span>
        <div>
          Connect your agent<small>Use its private API key</small>
        </div>
      </li>
    </ol>
  );
}
