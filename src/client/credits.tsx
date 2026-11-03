import { ArrowRight, Layers3, ShieldCheck, Wallet } from 'lucide-react';
import type { CreditHistory, CreditWallet } from '../shared/agreements';
import { dateTime, money } from './api';
import {
  ErrorBox,
  Link,
  LoadMore,
  PageHeader,
  StatCard,
  usePagedResource,
  useResource,
} from './components';
import { TableViewport, TablePanel, TableTabs, TableFooter, TableState } from './table';
import './market.css';

export function Credits() {
  const history = usePagedResource<CreditHistory['items'][number]>('/api/credits/history', 5000);
  const wallet = useResource<CreditWallet>('/api/credits', 5000);
  return (
    <>
      <PageHeader
        eyebrow="BROKER PILOT WALLET"
        title="Broker wallet"
        description="Buy AI tokens directly or fund agent and Studio task budgets. Purchased tokens track usage separately."
      >
        <Link href="/agents" className="button secondary">
          Manage agent budgets <ArrowRight size={15} />
        </Link>
      </PageHeader>
      <ErrorBox
        error={wallet.error || (history.data ? history.error : '')}
        retry={() => {
          wallet.reload();
          history.reload();
        }}
      />
      {wallet.data && (
        <div className="stats-grid">
          <StatCard
            label="Available to spend"
            value={money(wallet.data.availableCents)}
            note="Unreserved Broker pilot credit"
            icon={<Wallet size={18} />}
          />
          <StatCard
            label="Reserved credit"
            value={money(wallet.data.reservedCents)}
            note="Purchase holds and committed budgets"
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
          Buy prepaid token packs directly with wallet credit, or reserve a budget for an agent or
          Studio task. Using purchased tokens consumes quota without another charge. This pilot uses
          administrator-funded credit. Studio task budgets cover compute and model purchases;
          standalone VM rentals keep their existing billing.
        </p>
      </div>
      <TablePanel label="Credit history">
        <TableTabs>
          <h2>Credit history</h2>
        </TableTabs>
        {history.loading ? (
          <TableState loading title="Loading credit history" />
        ) : history.error && !history.data ? (
          <TableState error={history.error} onRetry={history.reload} />
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
                      <strong>
                        {e.kind === 'agent_fund'
                          ? 'Credit reserved'
                          : e.kind === 'agent_release'
                            ? 'Credit released'
                            : e.kind.replaceAll('_', ' ')}
                      </strong>
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
          <TableState
            title="No credit entries yet"
            description="Credit grants, token purchases, agent funding and task purchases will appear here."
          />
        )}
        <TableFooter count={history.data?.items.length} noun="entries">
          <LoadMore
            available={!!history.nextCursor}
            loading={history.loadingMore}
            onLoad={() => void history.loadMore()}
            error={history.moreError}
          />
        </TableFooter>
      </TablePanel>
    </>
  );
}
