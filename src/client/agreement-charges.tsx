import { TableViewport } from './table';
import { CalendarClock } from 'lucide-react';
import type { RevenueShare } from '../shared/types';
import { dateTime, money, moneyMicros } from './api';
import { EmptyState, ErrorBox, Link, LoadMore, Spinner, usePagedResource } from './components';
import { hourly } from './agreements';

interface AgreementCharge {
  id: string;
  agreementId: string;
  windowId: string;
  description: string;
  providerName: string;
  quantity: number;
  startsAt: string;
  discountEndsAt: string;
  endsAt: string;
  discountRateCentsPerHour: number;
  normalRateCentsPerHour: number;
  grossCents: number;
  creditCents: number;
  totalCents: number;
  feeCents: 0;
  revenueShare: RevenueShare;
  createdAt: string;
  currency: 'USD';
  status: 'pilot-credit';
  label: string;
}
export function AgreementCharges({ provider = false }: { provider?: boolean }) {
  const charges = usePagedResource<AgreementCharge>(
    provider ? '/api/provider/agreement-charges' : '/api/agreement-charges',
    5000,
  );
  return (
    <section className="card market-panel">
      <div className="section-heading">
        <h2>Scheduled agreement charges</h2>
        <span className="tiny-label">Broker pilot credit</span>
      </div>
      <p className="market-copy">
        Booked capacity settles by window, including idle slots. Failed-start credits reduce the
        settled charge. The 15% provider fee applies to the net settled charge, with no added buyer
        fee. No external payment or payout occurs.
      </p>
      <ErrorBox error={charges.error} retry={charges.reload} />
      {charges.loading ? (
        <Spinner label="Loading agreement charges" />
      ) : charges.data?.items.length ? (
        <TableViewport
          label="Scheduled agreement charges"
          minWidth={provider ? 1120 : 900}
          className="market-table-scroll"
        >
          <table className="market-table">
            <caption className="sr-only">Scheduled agreement charges</caption>
            <thead>
              <tr>
                <th scope="col">Agreement / capacity window</th>
                <th className="numeric-cell" scope="col">
                  Slots / rates
                </th>
                <th className="numeric-cell" scope="col">
                  Booked / credit
                </th>
                <th className="numeric-cell" scope="col">
                  Settled charge
                </th>
                {provider && (
                  <>
                    <th className="numeric-cell" scope="col">
                      Broker · 15%
                    </th>
                    <th className="numeric-cell" scope="col">
                      You keep · 85%
                    </th>
                  </>
                )}
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {charges.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {provider ? (
                      <strong>{c.description}</strong>
                    ) : (
                      <Link className="text-link" href={`/orders/${c.agreementId}`}>
                        {c.description}
                      </Link>
                    )}
                    <div className="market-meta">
                      {c.providerName}
                      <br />
                      Opens {dateTime(c.startsAt)}
                      <br />
                      Discount ends {dateTime(c.discountEndsAt)}
                      <br />
                      Hard end {dateTime(c.endsAt)}
                    </div>
                  </td>
                  <td className="numeric-cell">
                    {c.quantity} slots
                    <div className="market-meta">
                      {hourly(c.discountRateCentsPerHour)}
                      <br />
                      Normal {hourly(c.normalRateCentsPerHour)}
                    </div>
                  </td>
                  <td className="numeric-cell">
                    {money(c.grossCents)} booked
                    <div className="market-meta">−{money(c.creditCents)} failed-start credit</div>
                  </td>
                  <td className="numeric-cell">
                    <strong>{money(c.totalCents)}</strong>
                    <div className="market-meta">
                      Buyer fee {money(c.feeCents)}
                      <br />
                      {dateTime(c.createdAt)}
                    </div>
                  </td>
                  {provider && (
                    <>
                      <td className="numeric-cell">
                        {moneyMicros(c.revenueShare.brokerFeeMicros)}
                      </td>
                      <td className="numeric-cell">
                        {moneyMicros(c.revenueShare.providerNetMicros)}
                        <div className="market-meta">Before compute costs</div>
                      </td>
                    </>
                  )}
                  <td>
                    <span className="quiet-badge">Pilot credit · no payout</span>
                    <div className="market-meta">{c.label}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : (
        <EmptyState
          icon={<CalendarClock size={24} />}
          title="No settled capacity windows yet"
          description="Reservations are visible in the wallet and capacity calendar. Settled window charges appear here after reconciliation; they do not create a separate invoice per VM."
        />
      )}
      <LoadMore
        available={!!charges.nextCursor}
        loading={charges.loadingMore}
        onLoad={() => void charges.loadMore()}
        error={charges.moreError}
      />
    </section>
  );
}
