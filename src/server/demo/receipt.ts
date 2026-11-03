import type { Row } from '../marketplace/data.js';
import type { DemoBid } from '../../shared/demo.js';
import { iso } from '../marketplace/data.js';
import { centsToUsd } from '../../shared/money.js';
import { isSponsoredComputeQuote } from '../../shared/pricing.js';
import { PROVIDER_REGISTRY } from '../../shared/providers.js';

/** The awarded VM's public price, exactly as the homepage receipt shows it. */
export function demoVmPrice(vm: Row | undefined) {
  const quote = vm?.quote_snapshot;
  return {
    priceCents: quote?.demoSponsorship?.effectivePriceCents ?? quote?.totalPriceCents ?? null,
    ...(isSponsoredComputeQuote(quote?.pricing) ? { operatorSponsored: true } : {}),
    ...(quote?.demoSponsorship
      ? {
          grossPriceCents: Number(quote.totalPriceCents),
          sponsorCreditCents: quote.demoSponsorship.sponsorCreditCents,
        }
      : {}),
  } as { priceCents: number | null; operatorSponsored?: boolean } & Partial<
    Pick<DemoBid, 'grossPriceCents' | 'sponsorCreditCents'>
  >;
}

/** One accepted compute bid, exactly as the homepage receipt shows it. */
export function demoBidView(b: Row): DemoBid {
  const snapshot = b.offering_snapshot;
  return {
    provider: snapshot?.catalog?.provider ?? snapshot?.cloudProvider ?? 'modal',
    priceCents: snapshot?.demoSponsorship?.effectivePriceCents ?? Number(b.total_price_cents),
    ...(isSponsoredComputeQuote(snapshot?.pricing) ? { operatorSponsored: true } : {}),
    ...(snapshot?.demoSponsorship
      ? {
          grossPriceCents: Number(b.total_price_cents),
          sponsorCreditCents: snapshot.demoSponsorship.sponsorCreditCents,
          catalogId: snapshot.catalog.id,
        }
      : {}),
    acceptedAt: iso(b.created_at)!,
  };
}

const providerName = (id: string) => PROVIDER_REGISTRY.find((p) => p.id === id)?.name ?? id;
/** Muse token routes, which are separate from the compute registry's display labels. */
const tokenSellerName = (id: string) =>
  ({ baseten: 'Baseten', modal: 'Modal' })[id as 'baseten' | 'modal'] ?? id;
/** Display-only; an unexpected amount is omitted rather than failing demo setup. */
const usd = (cents: number | string | null | undefined) => {
  if (cents === null || cents === undefined) return null;
  try {
    return `$${centsToUsd(Number(cents))}`;
  } catch {
    return null;
  }
};

/**
 * Compact public facts written next to hello_muse.py, so Muse can explain the judge's own
 * purchase. Only values the homepage already shows this visitor; no identifiers or secrets.
 */
export function demoReceiptFacts(input: {
  vm: Row;
  bids: Row[];
  tokenPriceCents: unknown;
  tokenProvider: string | null;
  leaseMinutes: number;
  inputTokens: number;
  outputTokens: number;
}) {
  const catalog = input.vm.catalog_snapshot ?? {};
  const price = demoVmPrice(input.vm);
  return {
    compute: {
      winner: providerName(catalog.provider ?? 'modal'),
      size: catalog.profile === 'micro' ? 'Micro' : String(catalog.name ?? 'VM').slice(0, 40),
      cpu: Number(catalog.cpu),
      memoryGb: Number(catalog.memoryGb),
      leaseMinutes: input.leaseMinutes,
      paid: usd(price.priceCents),
      ...(price.grossPriceCents !== undefined
        ? { grossBid: usd(price.grossPriceCents), sponsorCredit: usd(price.sponsorCreditCents) }
        : {}),
      ...(price.operatorSponsored ? { providerPromotion: true } : {}),
      bids: input.bids
        .slice(0, 8)
        .map(demoBidView)
        .map((b) => [providerName(b.provider), usd(b.priceCents)]),
    },
    tokens: {
      seller: input.tokenProvider ? tokenSellerName(input.tokenProvider) : null,
      model: 'Muse Spark Open',
      input: input.inputTokens,
      output: input.outputTokens,
      paid: usd(input.tokenPriceCents as number | null),
    },
  };
}
export type DemoReceiptFacts = ReturnType<typeof demoReceiptFacts>;
