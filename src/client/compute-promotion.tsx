import { Gift } from 'lucide-react';
import type { CatalogItem, FixedQuote } from '../shared/types';
import {
  isSponsoredComputeQuote,
  managedPricing,
  requireFreshManagedRate,
  sponsoredComputeQuote,
} from '../shared/pricing';
import { money } from './api';
import './compute-promotion.css';

/** A preview is informational; the server still checks account policy and live capacity. */
export function modalPromotionPreview(
  item: CatalogItem,
  durationMinutes: number,
): FixedQuote | undefined {
  if (
    item.provider !== 'modal' ||
    !item.approved ||
    !item.durationMinutes.includes(durationMinutes)
  )
    return undefined;
  try {
    requireFreshManagedRate(item);
    return sponsoredComputeQuote(managedPricing(item), durationMinutes);
  } catch {
    return undefined;
  }
}

export function ComputePromotionNotice({
  available = false,
  pricing,
  audience = 'buyer',
}: {
  available?: boolean;
  pricing?: FixedQuote;
  audience?: 'buyer' | 'provider';
}) {
  const frozen = isSponsoredComputeQuote(pricing);
  if (!available && !frozen) return null;
  return (
    <div className="compute-promotion-notice" role="note" aria-label="Modal compute sponsorship">
      <Gift size={16} aria-hidden="true" />
      <div>
        <strong>Sponsored Modal compute · {money(1)} total</strong>
        <p>
          {frozen
            ? 'The operator’s Wick account funds upstream compute beyond this fixed buyer price. Sponsorship is recorded with this offer.'
            : audience === 'provider'
              ? 'Eligible Modal offers can charge buyers $0.01 while the operator’s Wick account funds remaining compute. Saved price limits, compatibility, capacity, and the sponsorship cap still apply. Other offers keep the ordinary compute cost floor.'
              : 'The operator’s Wick account funds the remaining compute. Compatibility and capacity still apply. Equal-price ties favor sponsored Modal offers.'}
        </p>
      </div>
    </div>
  );
}

export function ComputePromotionBadge({ pricing }: { pricing?: FixedQuote }) {
  return isSponsoredComputeQuote(pricing) ? (
    <span
      className="compute-promotion-badge"
      title="The operator’s Wick account funds upstream compute beyond the fixed $0.01 buyer price."
    >
      Operator-sponsored Modal
    </span>
  ) : null;
}
