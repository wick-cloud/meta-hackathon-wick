import { usdToCents, isMoneyCents } from '../shared/money';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Wallet } from 'lucide-react';
import type { CreditWallet } from '../shared/agreements';
import { money, post } from './api';
import { ErrorBox, LoadMore, Spinner, SuccessBox, usePagedResource } from './components';
import './market.css';

export function AdminCreditGrant() {
  const buyers = usePagedResource<{ id: string; name: string; email: string }>(
    '/api/admin/credit-buyers',
  );
  const [buyerId, setBuyerId] = useState(''),
    [amount, setAmount] = useState(''),
    [description, setDescription] = useState(''),
    [review, setReview] = useState<{
      buyerId: string;
      amountCents: number;
      description: string;
      operationKey: string;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  function prepare(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');
    const cents = usdToCents(amount);
    if (!isMoneyCents(cents) || cents <= 0) {
      setError('Enter a positive USD credit amount.');
      return;
    }
    setReview({ buyerId, amountCents: cents, description, operationKey: crypto.randomUUID() });
  }
  async function grant() {
    if (!review || busy) return;
    setBusy(true);
    setError('');
    try {
      const wallet = await post<CreditWallet>('/api/admin/credits', review);
      setSuccess(
        `${money(review.amountCents)} Broker pilot credit granted. Buyer available balance: ${money(wallet.availableCents)}. Wick compute credit is unchanged.`,
      );
      setReview(null);
      setAmount('');
      setDescription('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not grant credit.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card market-panel">
      <span className="market-kicker">
        <Wallet size={16} />
        BROKER PILOT CREDIT
      </span>
      <h2>Grant buyer wallet credit</h2>
      <p className="market-copy">
        These grants fund scheduled Broker commitments. They do not top up Wick compute or collect a
        payment.
      </p>
      <ErrorBox error={buyers.error} retry={buyers.reload} />
      {review ? (
        <>
          <p>
            Grant <strong>{money(review.amountCents)}</strong> to{' '}
            <strong>
              {buyers.data?.items.find((b) => b.id === review.buyerId)?.email ?? review.buyerId}
            </strong>
            ?
          </p>
          <p className="market-copy">{review.description}</p>
          <ErrorBox error={error} />
          <div className="market-button-row">
            <button className="button secondary" disabled={busy} onClick={() => setReview(null)}>
              Edit grant
            </button>
            <button className="button primary" disabled={busy} onClick={() => void grant()}>
              {busy ? <Spinner label="Granting credit" /> : 'Grant Broker credit'}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={prepare}>
          <div className="market-form-grid">
            <label className="field">
              <span>Buyer account</span>
              <select
                aria-label="Buyer account"
                required
                value={buyerId}
                onChange={(e) => setBuyerId(e.target.value)}
              >
                <option value="" disabled>
                  Choose a buyer
                </option>
                {buyers.data?.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Credit amount (USD)</span>
              <input
                type="number"
                min="0.0001"
                max="100000"
                step="0.0001"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          </div>
          <LoadMore
            available={!!buyers.nextCursor}
            loading={buyers.loadingMore}
            onLoad={() => void buyers.loadMore()}
            error={buyers.moreError}
          />
          <label className="field">
            <span>Grant reason</span>
            <input
              required
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Pilot scheduled-capacity credit"
            />
          </label>
          <ErrorBox error={error} />
          <button
            className="button primary"
            disabled={buyers.loading || !buyers.data?.items.length}
          >
            Review credit grant <ArrowRight size={15} />
          </button>
        </form>
      )}
      {success && <SuccessBox>{success}</SuccessBox>}
    </section>
  );
}
