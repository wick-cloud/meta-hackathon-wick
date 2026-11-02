import { ArrowLeft, ArrowRight, Archive, Layers3, Server, Wallet } from 'lucide-react';
import type { AgreementDetail as AgreementDetailDTO } from '../shared/agreements';
import { dateTime, money } from './api';
import {
  EmptyState,
  ErrorBox,
  Link,
  PageHeader,
  Spinner,
  StatCard,
  StatusPill,
  useResource,
} from './components';
import { TableViewport } from './table';
import './market.css';

export const hourly = (cents: number) => `${money(cents)} / VM-hour`;
export const zonedTime = (date: string, timeZone: string) =>
  new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  });

export function RetiredScheduledVMs({ provider = false }: { provider?: boolean }) {
  return (
    <>
      <PageHeader
        eyebrow="VIRTUAL MACHINES"
        title="Scheduled VMs have been removed"
        description="VM rentals now use the instant 30-second auction. Existing billing records remain available."
      />
      <section className="card market-panel">
        <EmptyState
          icon={<Server size={26} />}
          title="Choose an instant VM rental"
          description="Set the resources and rental time, then let available providers compete."
        >
          <Link href={provider ? '/provider/offerings' : '/new/vm'} className="button primary">
            {provider ? 'Manage VM offers' : 'Launch a VM'} <ArrowRight size={15} />
          </Link>
          <Link href={provider ? '/provider/earnings' : '/orders'} className="button secondary">
            {provider ? 'View earnings' : 'View orders'}
          </Link>
        </EmptyState>
      </section>
    </>
  );
}

/** Read-only access to existing financial records; no scheduling or activation controls. */
export function AgreementDetail({ id }: { id: string }) {
  const detail = useResource<AgreementDetailDTO>(`/api/agreements/${encodeURIComponent(id)}`, 5000);
  if (detail.loading && !detail.data) return <Spinner label="Loading historical booking" />;
  if (!detail.data)
    return (
      <ErrorBox error={detail.error || 'Historical booking unavailable.'} retry={detail.reload} />
    );
  const { agreement: a, bookings, activations } = detail.data;
  return (
    <>
      <Link href="/orders" className="back-link">
        <ArrowLeft size={15} /> Back to Orders
      </Link>
      <PageHeader
        eyebrow="HISTORICAL CAPACITY BOOKING"
        title={a.description}
        description={`AG-${a.id.slice(0, 8).toUpperCase()} · Created ${dateTime(a.createdAt)}`}
      >
        <StatusPill status={a.status} />
      </PageHeader>
      <ErrorBox error={detail.error} retry={detail.reload} />
      <div className="market-notice">
        <Archive size={19} />
        <p>
          Scheduled VMs have been removed. This read-only record preserves your bookings,
          environments and billing history.
        </p>
      </div>
      <div className="stats-grid">
        <StatCard
          label="Reserved credit"
          value={money(a.reservedCents)}
          note="Existing wallet reservation"
          icon={<Wallet size={18} />}
        />
        <StatCard
          label="Booked commitment"
          value={money(a.committedCents)}
          note="Accepted capacity"
          icon={<Layers3 size={18} />}
        />
        <StatCard
          label="Settled amount"
          value={money(a.settledCents)}
          note={`${money(a.adjustmentCents)} in adjustments`}
          icon={<Archive size={18} />}
        />
      </div>
      <section className="card market-panel">
        <h2>Booking history</h2>
        {bookings.length ? (
          <TableViewport
            label="Historical capacity bookings"
            minWidth={860}
            className="market-table-scroll"
          >
            <table className="market-table">
              <caption className="sr-only">Historical capacity bookings</caption>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Access window</th>
                  <th>Quantity</th>
                  <th className="numeric-cell">Accepted total</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.providerName}</strong>
                      <div className="market-meta">{b.catalogId}</div>
                    </td>
                    <td>
                      {zonedTime(b.startsAt, a.timeZone)}
                      <div className="market-meta">Until {zonedTime(b.endsAt, a.timeZone)}</div>
                    </td>
                    <td>{b.quantity} slots</td>
                    <td className="numeric-cell">
                      {money(b.totalCents)}
                      <div className="market-meta">
                        {hourly(b.discountRateCentsPerHour)} · normal{' '}
                        {hourly(b.normalRateCentsPerHour)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : (
          <EmptyState
            icon={<Archive size={24} />}
            title="No capacity was booked"
            description="This record has no accepted provider commitments."
          />
        )}
      </section>
      {activations.length > 0 && (
        <section className="card market-panel">
          <h2>Environment history</h2>
          <TableViewport
            label="Historical booking environments"
            minWidth={700}
            className="market-table-scroll"
          >
            <table className="market-table">
              <caption className="sr-only">Historical booking environments</caption>
              <thead>
                <tr>
                  <th>Environment</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Rental end</th>
                </tr>
              </thead>
              <tbody>
                {activations.map((activation) => (
                  <tr key={activation.id}>
                    <td>
                      {activation.vmId ? (
                        <Link href={`/vms/${activation.vmId}`} className="text-link">
                          Open environment <ArrowRight size={13} />
                        </Link>
                      ) : (
                        <code>{activation.id.slice(0, 8)}</code>
                      )}
                    </td>
                    <td>
                      <StatusPill status={activation.status} />
                      {activation.failureReason && (
                        <div className="market-meta">{activation.failureReason}</div>
                      )}
                    </td>
                    <td>{dateTime(activation.createdAt)}</td>
                    <td>{dateTime(activation.endsAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        </section>
      )}
    </>
  );
}
