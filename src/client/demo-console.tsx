import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Compass, RotateCcw, X } from 'lucide-react';
import { Link, useNavigate } from './components';
import type { DemoRole } from './demo-store';
import './demo-console.css';

const guides = {
  buyer: [
    {
      label: 'Launch a sample VM',
      detail:
        'Choose “A lightweight Linux workspace”, set a $0.20 maximum, then select Review manually and Start 30-second auction. Watch providers compete for your workload.',
      path: '/new/vm',
      action: 'Open VM setup',
    },
    {
      label: 'Try the terminal',
      detail:
        'Open Terminal for the running API development workspace, select Connect terminal, and try pwd or ls. This sample VM is ready even if you skipped the auction.',
      path: '/vms',
      action: 'Open virtual machines',
    },
    {
      label: 'Try Muse Studio',
      detail:
        'Select New task if needed. Enter a small task, use https://github.com/octocat/Hello-World as the public repository, and set a $0.20 maximum. Review and start the task, then inspect Changes and Tests.',
      path: '/studio?new=1',
      action: 'Open Muse Studio',
    },
  ],
  seller: [
    {
      label: 'Set your capacity',
      detail:
        'Set Total VM slots to 12, then select Save capacity. Watch the available capacity update. These slots are what you can offer to buyers.',
      path: '/provider/capacity',
      action: 'Open capacity',
    },
    {
      label: 'Bid on a request',
      detail:
        'Select Review bid for API integration tests, keep the $0.10 bid, and select Submit bid. An accepted bid reserves capacity for the buyer.',
      path: '/provider/requests',
      action: 'Open buyer requests',
    },
    {
      label: 'See your earnings',
      detail:
        'Review Rental revenue to see each accepted price, the 15% Broker fee, and the 85% you keep. If you placed a bid, your new rental appears here too.',
      path: '/provider/earnings',
      action: 'Open earnings',
    },
  ],
};

function freshGuides() {
  return {
    buyer: { open: true, step: 0, complete: false },
    seller: { open: true, step: 0, complete: false },
  };
}

export function DemoConsoleToolbar({ role, onReset }: { role: DemoRole; onReset: () => void }) {
  const navigate = useNavigate();
  const [walkthroughs, setWalkthroughs] = useState(freshGuides);
  const [notice, setNotice] = useState('');
  const guideToggle = useRef<HTMLButtonElement>(null);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(false);
  const guide = walkthroughs[role];
  const steps = guides[role];
  const step = steps[guide.step]!;
  const roleLabel = role === 'buyer' ? 'Buyer' : 'Seller';
  function updateGuide(update: Partial<typeof guide>) {
    setWalkthroughs((current) => ({ ...current, [role]: { ...current[role], ...update } }));
  }
  function goToStep(index: number) {
    focusStep.current = true;
    updateGuide({ step: index, complete: false, open: true });
    navigate(steps[index]!.path);
  }
  function dismissGuide() {
    updateGuide({ open: false });
    guideToggle.current?.focus();
  }
  useEffect(() => {
    if (focusStep.current && guide.open) {
      guideHeading.current?.focus({ preventScroll: true });
      focusStep.current = false;
    }
  }, [role, guide.step, guide.complete, guide.open]);
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
            ref={guideToggle}
            className="button secondary small"
            aria-expanded={guide.open}
            aria-controls="demo-console-guide"
            onClick={() => updateGuide({ open: !guide.open })}
          >
            <Compass size={13} />
            {guide.open ? 'Hide guide' : 'Show guide'}
          </button>
          <button
            className="button secondary small"
            onClick={() => {
              onReset();
              setWalkthroughs(freshGuides());
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
      {guide.open && (
        <section
          className="demo-console-guide"
          id="demo-console-guide"
          aria-label={`${roleLabel} walkthrough`}
        >
          <div className="demo-guide-card">
            <div className="demo-guide-heading">
              <span className="demo-guide-eyebrow">
                <Compass size={14} aria-hidden="true" /> {roleLabel} walkthrough
              </span>
              <button
                className="icon-button"
                aria-label="Dismiss walkthrough"
                title="Skip walkthrough"
                onClick={dismissGuide}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="demo-guide-copy" aria-live="polite" aria-atomic="true">
              <span className="demo-guide-progress">
                {guide.complete
                  ? 'All 3 steps covered'
                  : `Step ${guide.step + 1} of ${steps.length}`}
              </span>
              <h2 ref={guideHeading} tabIndex={-1}>
                {guide.complete ? 'You’re ready to explore' : step.label}
              </h2>
              <p>
                {guide.complete
                  ? 'Keep exploring the console at your own pace. Everything here uses sample data, and you can reset the demo or replay this walkthrough anytime.'
                  : step.detail}
              </p>
            </div>
            <div className="demo-guide-footer">
              {guide.complete ? (
                <>
                  <button className="button primary small" onClick={dismissGuide}>
                    Keep exploring <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button className="button secondary small" onClick={() => goToStep(0)}>
                    <RotateCcw size={14} aria-hidden="true" /> Replay walkthrough
                  </button>
                </>
              ) : (
                <>
                  <Link href={step.path} className="button primary small">
                    {step.action} <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                  <div className="demo-guide-navigation">
                    <button
                      className="button secondary small"
                      disabled={guide.step === 0}
                      onClick={() => goToStep(guide.step - 1)}
                    >
                      <ArrowLeft size={14} aria-hidden="true" /> Previous step
                    </button>
                    <button
                      className="button secondary small"
                      onClick={() => {
                        if (guide.step === steps.length - 1) {
                          focusStep.current = true;
                          updateGuide({ complete: true });
                        } else goToStep(guide.step + 1);
                      }}
                    >
                      {guide.step === steps.length - 1 ? 'Finish walkthrough' : 'Next step'}
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
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
