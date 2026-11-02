import { ArrowRight, Layers3, ShieldCheck, Wallet } from 'lucide-react';
import type { CreditHistory, CreditWallet } from '../shared/agreements';
import { dateTime, money } from './api';
import {
  EmptyState,
  ErrorBox,
  Link,
  LoadMore,
  PageHeader,
  Spinner,
  StatCard,
  usePagedResource,
  useResource,
} from './components';
import { TableViewport } from './table';
import './market.css';

export function Credits() {
  const history = usePagedResource<CreditHistory['items'][number]>('/api/credits/history', 5000);
  const wallet = useResource<CreditWallet>('/api/credits', 5000);
  return (
    <>
      <PageHeader
        eyebrow="BROKER PILOT WALLET"
        title="Broker wallet"
        description="USD credit for agent and Studio task budgets. Token packs track your AI usage separately."
      >
        <Link href="/agents" className="button secondary">
          Manage agent budgets <ArrowRight size={15} />
        </Link>
      </PageHeader>
      <ErrorBox
        error={wallet.error || history.error}
        retry={() => {
          wallet.reload();
          history.reload();
        }}
      />
      {wallet.data && (
        <div className="stats-grid">
          <StatCard
            label="Available to reserve"
            value={money(wallet.data.availableCents)}
            note="Unreserved Broker pilot credit"
            icon={<Wallet size={18} />}
          />
          <StatCard
            label="Reserved credit"
            value={money(wallet.data.reservedCents)}
            note="Existing committed budgets"
            icon={<ShieldCheck size={18} />}
          />
          <StatCard
            label="Broker wallet balance"
            value={money(wallet.data.balanceCents)}
            note="USD · includes reserved credit"
            icon={<Layers3 size={18} />}
          />
        </div>
      )}
      <div className="market-notice">
        <Wallet size={19} />
        <p>
          Use wallet credit to fund an agent or Studio task budget. Your agent spends its budget on
          prepaid token packs; inference then consumes those tokens. This pilot uses
          administrator-funded credit. Studio task budgets cover compute and model purchases;
          standalone VM rentals keep their existing billing.
        </p>
      </div>
      <section className="card market-panel">
        <h2>Credit history</h2>
        {history.loading ? (
          <Spinner label="Loading credit history" />
        ) : history.data?.items.length ? (
          <TableViewport label="Wallet ledger" minWidth={760} className="market-table-scroll">
            <table className="market-table">
              <caption className="sr-only">Wallet ledger</caption>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th className="numeric-cell" scope="col">
                    Credit change
                  </th>
                  <th className="numeric-cell" scope="col">
                    Reserved change
                  </th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <strong>{e.kind.replaceAll('_', ' ')}</strong>
                      <div className="market-meta">{e.description}</div>
                      {e.agreementId && (
                        <Link className="text-link" href={`/orders/${e.agreementId}`}>
                          View historical booking <ArrowRight size={12} />
                        </Link>
                      )}
                    </td>
                    <td className="numeric-cell">
                      {e.amountCents > 0 ? '+' : ''}
                      {money(e.amountCents)}
                    </td>
                    <td className="numeric-cell">
                      {e.reservedDeltaCents > 0 ? '+' : ''}
                      {money(e.reservedDeltaCents)}
                    </td>
                    <td>{dateTime(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <EmptyState
            icon={<Wallet size={25} />}
            title="No credit entries yet"
            description="Credit grants, agent funding and task purchases will appear here."
          />
        )}
        <LoadMore
          available={!!history.nextCursor}
          loading={history.loadingMore}
          onLoad={() => void history.loadMore()}
          error={history.moreError}
        />
      </section>
    </>
  );
}
