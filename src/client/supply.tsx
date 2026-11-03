import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { TokenOffering, TokenOfferingInput } from '../shared/inference';
import { dateTime, money, post } from './api';
import { DetailRow, ErrorBox, Spinner } from './components';
import { FormPanel, FormSection } from './form-layout';
import './buying.css';

interface SupplyProposal {
  mode: 'fixture' | 'real';
  modelCalled: boolean;
  expectedRevision: number;
  explanation: string;
  proposal: null | {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    estimatedPriceCents: number;
    inputRateMicrosPerMillion: number;
    outputRateMicrosPerMillion: number;
  };
}
const count = (n: number) => n.toLocaleString('en-US');
export function ProviderSupply({
  offering,
  onApply,
}: {
  offering: TokenOffering;
  onApply: (
    input: Pick<TokenOfferingInput, 'inputRateMicrosPerMillion' | 'outputRateMicrosPerMillion'>,
  ) => void;
}) {
  const [proposal, setProposal] = useState<SupplyProposal | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function propose() {
    setBusy(true);
    setError('');
    try {
      setProposal(await post<SupplyProposal>('/api/provider/inference/propose', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Supply recommendation failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="supply-allocation">
        {(['input', 'output'] as const).map((kind) => {
          const total =
              kind === 'input'
                ? offering.maxOutstandingInputTokens
                : offering.maxOutstandingOutputTokens,
            committed =
              kind === 'input' ? offering.outstandingInputTokens : offering.outstandingOutputTokens;
          return (
            <FormPanel key={kind}>
              <FormSection>
                <div className="section-heading">
                  <h2>{kind === 'input' ? 'Input' : 'Output'} token allocation</h2>
                  <span className="quiet-badge">Configured supply</span>
                </div>
                <DetailRow label="Committed">{count(committed)}</DetailRow>
                <div
                  className="supply-meter"
                  role="meter"
                  aria-label={`${kind} token commitments`}
                  aria-valuenow={committed}
                  aria-valuemin={0}
                  aria-valuemax={total}
                >
                  <span style={{ width: `${Math.min(100, (committed / total) * 100)}%` }} />
                </div>
                <DetailRow label="Uncommitted">{count(Math.max(0, total - committed))}</DetailRow>
                <DetailRow label="Maximum outstanding">{count(total)}</DetailRow>
                <p className="field-hint">
                  Configured sale limits, not a measurement of spare upstream GPU capacity.
                </p>
              </FormSection>
            </FormPanel>
          );
        })}
      </div>
      <FormPanel className="provider-supply-recommendation">
        <FormSection>
          <div className="section-heading">
            <span className="buying-muse">
              <Sparkles size={16} /> Muse supply assistant
            </span>
            <span className="quiet-badge">Review before publishing</span>
          </div>
          <div className="form-section-heading">
            <h2>Offer capacity within your own limits.</h2>
            <p>
              Muse selects a server-priced option using your rates and uncommitted allowance. Every
              rate covers the configured compute cost after Broker’s 15% fee.
            </p>
          </div>
          <ErrorBox error={error} />
          <div className="form-actions">
            <button
              className="button primary"
              disabled={busy || !offering.route.qualified}
              onClick={() => void propose()}
            >
              {busy ? (
                <Spinner label="Preparing supply suggestion" />
              ) : (
                <>
                  <Sparkles size={15} /> Draft with Muse
                </>
              )}
            </button>
          </div>
          {proposal && (
            <div className="supply-proposal">
              <h3>
                {proposal.mode === 'fixture' ? 'Fixture supply proposal' : 'Muse supply proposal'}
              </h3>
              <p>{proposal.explanation}</p>
              {proposal.proposal && (
                <>
                  <DetailRow label="Example pack">
                    {count(proposal.proposal.inputTokens)} input ·{' '}
                    {count(proposal.proposal.outputTokens)} output
                  </DetailRow>
                  <DetailRow label="Gross pack price">
                    {money(proposal.proposal.estimatedPriceCents)}
                  </DetailRow>
                  <DetailRow label="Packs within free allocation">
                    {proposal.proposal.calls}
                  </DetailRow>
                  <div className="form-actions">
                    <button
                      className="button secondary"
                      disabled={proposal.expectedRevision !== offering.revision}
                      onClick={() => {
                        onApply(proposal.proposal!);
                        setProposal(null);
                      }}
                    >
                      Apply rates to draft
                    </button>
                  </div>
                  {proposal.expectedRevision !== offering.revision && (
                    <p className="buying-warning">
                      The offering changed. Request a fresh proposal.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </FormSection>
      </FormPanel>
    </>
  );
}

export function SupplyWindow({
  draft,
  onChange,
}: {
  draft: TokenOfferingInput;
  onChange: (field: 'salesStartAt' | 'salesEndAt', value: string | null) => void;
}) {
  const local = (value: string | null | undefined) => {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  return (
    <div className="supply-window">
      <h3>Selling window</h3>
      <p className="field-hint">
        Optional dated window for new sales. Existing purchased packs retain their full expiry.
        Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}.
      </p>
      <div className="field-grid">
        <label className="field">
          <span>Start accepting sales</span>
          <input
            type="datetime-local"
            value={local(draft.salesStartAt)}
            onChange={(e) =>
              onChange(
                'salesStartAt',
                e.target.value ? new Date(e.target.value).toISOString() : null,
              )
            }
          />
        </label>
        <label className="field">
          <span>Stop accepting sales</span>
          <input
            type="datetime-local"
            value={local(draft.salesEndAt)}
            onChange={(e) =>
              onChange('salesEndAt', e.target.value ? new Date(e.target.value).toISOString() : null)
            }
          />
        </label>
      </div>
      {draft.salesEndAt && (
        <small>
          New sales close {dateTime(draft.salesEndAt)}. Service for accepted packs continues until
          each pack’s deadline.
        </small>
      )}
    </div>
  );
}
