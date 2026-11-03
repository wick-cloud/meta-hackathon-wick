import { useEffect, useState } from 'react';
import { ArrowRight, Check, Compass, RotateCcw, X } from 'lucide-react';
import { Link } from './components';
import type { DemoRole } from './demo-store';
import './demo-console.css';

const guides = {
  buyer: [
    {
      label: 'Launch a VM',
      detail: 'Describe your resources and compare provider bids.',
      path: '/new/vm',
    },
    { label: 'Open a terminal', detail: 'Explore the running sample environment.', path: '/vms' },
    { label: 'Buy model access', detail: 'Fund an agent and purchase AI tokens.', path: '/agents' },
    {
      label: 'Try Muse Studio',
      detail: 'Run a sample task with one total budget.',
      path: '/studio',
    },
  ],
  seller: [
    {
      label: 'Set your capacity',
      detail: 'Manage the slots available for new workloads.',
      path: '/provider/capacity',
    },
    {
      label: 'Review your policy',
      detail: 'Control price floors and spare capacity.',
      path: '/provider/policy',
    },
    {
      label: 'Bid on a request',
      detail: 'Compete for a sample buyer workload.',
      path: '/provider/requests',
    },
    {
      label: 'Inspect earnings',
      detail: 'See the accepted price and 85/15 split.',
      path: '/provider/earnings',
    },
  ],
};

export function DemoConsoleToolbar({ role, onReset }: { role: DemoRole; onReset: () => void }) {
  const [guide, setGuide] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const previous = document.title;
    document.title = `Wick Broker · ${role === 'buyer' ? 'Buyer' : 'Seller'} demo`;
    return () => {
      document.title = previous;
    };
  }, [role]);
  return (
    <section className="demo-console-tools" aria-label="Demo controls">
      <div className="demo-console-toolbar">
        <div className="demo-console-caption">
          <span className="demo-dot" />
          <strong>Demo workspace</strong>
          <span>Sample data · Changes stay in this tab</span>
        </div>
        <div className="demo-console-actions">
          <nav className="demo-console-roles" aria-label="Demo perspective">
            <Link href="/demo/buyer" aria-current={role === 'buyer' ? 'page' : undefined}>
              Buyer
            </Link>
            <Link href="/demo/seller" aria-current={role === 'seller' ? 'page' : undefined}>
              Seller
            </Link>
          </nav>
          <button
            className="button secondary small"
            aria-expanded={guide}
            aria-controls="demo-console-guide"
            onClick={() => setGuide((value) => !value)}
          >
            <Compass size={13} />
            {guide ? 'Hide guide' : 'Show guide'}
          </button>
          <button
            className="button secondary small"
            onClick={() => {
              onReset();
              setNotice('Sample workspace reset.');
            }}
          >
            <RotateCcw size={13} />
            Reset demo
          </button>
          <Link href="/demos" className="demo-console-exit">
            <X size={14} />
            Exit demo
          </Link>
        </div>
      </div>
      {guide && (
        <div className="demo-console-guide" id="demo-console-guide">
          {guides[role].map((step, index) => (
            <Link key={step.path} href={step.path}>
              <span>{index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
              <ArrowRight size={14} />
            </Link>
          ))}
        </div>
      )}
      {notice && (
        <div className="demo-console-notice" role="status">
          <Check size={13} />
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss demo notice"
            onClick={() => setNotice('')}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </section>
  );
}
