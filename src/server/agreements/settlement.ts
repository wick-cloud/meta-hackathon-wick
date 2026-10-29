import type { AppContext } from '../context.js';
import { transaction } from '../marketplace/db.js';
import { revenueShare } from '../../shared/pricing.js';
import { applyCreditEntry } from './credits.js';
import { matchAgreement } from './matching.js';

/** A booked block is payable even when the customer chose zero manual starts. */
export async function settleWindow(ctx: AppContext, windowId: string) {
  await transaction(ctx.pool, async (db) => {
    const meta = (
      await db.query('SELECT agreement_id FROM broker_agreement_windows WHERE id=$1', [windowId])
    ).rows[0];
    if (!meta) return;
    const a = (
      await db.query('SELECT * FROM broker_agreements WHERE id=$1 FOR UPDATE', [meta.agreement_id])
    ).rows[0];
    const w = (
      await db.query(
        'SELECT *,clock_timestamp() at FROM broker_agreement_windows WHERE id=$1 FOR UPDATE',
        [windowId],
      )
    ).rows[0];
    if (w.settled_at || new Date(w.ends_at) > new Date(w.at)) return;
    const bookings = (
      await db.query(
        'SELECT * FROM broker_agreement_bookings WHERE window_id=$1 ORDER BY id FOR UPDATE',
        [windowId],
      )
    ).rows;
    let gross = 0,
      credit = 0;
    for (const b of bookings) {
      const g = b.quantity * b.unit_price_cents,
        c = Math.min(g, Number(b.adjustment_cents));
      gross += g;
      credit += c;
      await db.query(
        'INSERT INTO broker_agreement_charges(booking_id,agreement_id,window_id,buyer_id,provider_id,gross_cents,credit_cents,total_cents,revenue_share) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [b.id, a.id, w.id, a.buyer_id, b.provider_id, g, c, g - c, revenueShare(g - c)],
      );
    }
    if (gross)
      await applyCreditEntry(db, a.buyer_id, {
        operationKey: `agreement:${a.id}:window:${w.id}:settle`,
        kind: 'settle',
        balanceDeltaCents: -(gross - credit),
        reservedDeltaCents: -gross,
        agreementId: a.id,
        description:
          'Settled booked scheduled capacity, including idle slots; failed-start adjustments excluded.',
      });
    await db.query(
      'UPDATE broker_agreement_windows SET settled_at=clock_timestamp(),settled_cents=$2 WHERE id=$1',
      [w.id, gross - credit],
    );
    await db.query(
      'UPDATE broker_agreements SET reserved_cents=reserved_cents-$2,settled_cents=settled_cents+$3 WHERE id=$1',
      [a.id, gross, gross - credit],
    );
  });
}
async function expireAgreement(ctx: AppContext, id: string) {
  await transaction(ctx.pool, async (db) => {
    const a = (
      await db.query(
        "SELECT * FROM broker_agreements WHERE id=$1 AND expires_at<=clock_timestamp() AND(status IN('open','approved') OR(status='expired' AND reserved_cents>0)) FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!a) return;
    if (
      (
        await db.query(
          'SELECT 1 FROM broker_agreement_windows WHERE agreement_id=$1 AND settled_at IS NULL LIMIT 1',
          [id],
        )
      ).rowCount
    )
      return;
    if (
      (
        await db.query(
          'SELECT 1 FROM broker_agreement_activations WHERE agreement_id=$1 AND cleaned_at IS NULL LIMIT 1',
          [id],
        )
      ).rowCount
    ) {
      await db.query(
        "UPDATE broker_agreements SET status='expired',accepting_topups=false,blocked_reason='The term expired. Unmatched credit release is pending confirmed VM cleanup.',next_match_at=clock_timestamp()+interval '60 seconds' WHERE id=$1",
        [id],
      );
      return;
    }
    if (Number(a.reserved_cents))
      await applyCreditEntry(db, a.buyer_id, {
        operationKey: `agreement:${id}:expiry-release`,
        kind: 'release',
        balanceDeltaCents: 0,
        reservedDeltaCents: -Number(a.reserved_cents),
        agreementId: id,
        description: 'Released unused maximum-term credit at agreement expiry.',
      });
    await db.query(
      "UPDATE broker_agreements SET status='expired',accepting_topups=false,reserved_cents=0,blocked_reason=NULL,blocked_code=NULL WHERE id=$1",
      [id],
    );
  });
}
export async function maintainAgreements(ctx: AppContext) {
  const ended = (
    await ctx.pool.query(
      'SELECT id FROM broker_agreement_windows WHERE settled_at IS NULL AND ends_at<=clock_timestamp() ORDER BY ends_at,id LIMIT 50',
    )
  ).rows;
  for (const w of ended) await settleWindow(ctx, w.id);
  const expired = (
    await ctx.pool.query(
      "SELECT id FROM broker_agreements WHERE expires_at<=clock_timestamp() AND next_match_at<=clock_timestamp() AND(status IN('open','approved') OR(status='expired' AND reserved_cents>0)) ORDER BY next_match_at,id LIMIT 20",
    )
  ).rows;
  for (const a of expired) await expireAgreement(ctx, a.id);
  const due = (
    await ctx.pool.query(
      "SELECT id FROM broker_agreements WHERE source_mode=$1 AND status IN('open','approved') AND accepting_topups AND next_match_at<=clock_timestamp() AND expires_at>clock_timestamp() ORDER BY next_match_at,id LIMIT 20",
      [ctx.wick.mode],
    )
  ).rows;
  for (const a of due) await matchAgreement(ctx, a.id);
}
export async function startAgreementWorkers(ctx: AppContext) {
  const queue = 'broker-agreement-maintenance';
  await ctx.boss.createQueue(queue);
  await ctx.boss.work(queue, { localConcurrency: 1 }, async () => {
    await maintainAgreements(ctx);
  });
  await ctx.boss.schedule(queue, '* * * * *', {}, { tz: 'UTC' });
  await ctx.boss.send(queue, {}, { singletonKey: 'startup', retryLimit: 3, retryDelay: 5 });
}
