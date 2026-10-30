/** Broker credentials are independent of Wick's upstream service credentials. */
export const BROKER_SCOPES = [
  'account:read',
  'catalog:read',
  'muse:propose',
  'orders:read',
  'orders:write',
  'agreements:read',
  'agreements:write',
  'agreements:activate',
  'vms:read',
  'vms:terminal',
  'vms:terminate',
  'billing:read',
  'provider:read',
  'provider:bids:write',
  'provider:capacity:write',
  'provider:policy:write',
  'provider:offerings:write',
  'inference:read',
  'inference:use',
  'tokens:buy',
] as const;
export type BrokerScope = (typeof BROKER_SCOPES)[number];
export interface BrokerKeyLimits {
  maxAuctionCents?: number;
  maxAgreementReservationCents?: number;
  maxActivationQuantity?: number;
}
export interface BrokerKeyAuthority {
  id: string;
  grantId?: string;
  packId?: string;
  scopes: BrokerScope[];
  limits: BrokerKeyLimits;
}
export interface BrokerKeySummary {
  id: string;
  grantId?: string;
  packId?: string;
  name: string;
  prefix: string;
  scopes: BrokerScope[];
  limits: BrokerKeyLimits;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export const buyerScopes: readonly BrokerScope[] = BROKER_SCOPES.filter(
  (s) => !s.startsWith('provider:') && !s.startsWith('inference:') && s !== 'tokens:buy',
);
export const agentScopes: readonly BrokerScope[] = [
  'account:read',
  'inference:read',
  'inference:use',
  'tokens:buy',
];
export const packScopes: readonly BrokerScope[] = [
  'account:read',
  'inference:read',
  'inference:use',
];
/** Batch keys can redeem and inspect their batch, never manage or purchase other resources. */
export function packKeyRoute(method: string, path: string | undefined) {
  return [
    'GET /api/me',
    'GET /api/openapi.json',
    'GET /api/inference/models',
    'GET /api/inference/packs',
    'GET /api/inference/packs/:id',
    'GET /api/inference/requests/:id',
    'GET /api/v1/models',
    'POST /api/v1/chat/completions',
  ].includes(`${method} ${path}`);
}
export const providerScopes: readonly BrokerScope[] = BROKER_SCOPES.filter(
  (s) => ['account:read', 'catalog:read', 'muse:propose'].includes(s) || s.startsWith('provider:'),
);
export function scopesForRole(role: string): readonly BrokerScope[] {
  return role === 'buyer' ? buyerScopes : role === 'provider' ? providerScopes : [];
}
export function defaultScopes(role: string): BrokerScope[] {
  return scopesForRole(role).filter((s) => s.endsWith(':read'));
}
export interface BrokerPublicRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  scope: BrokerScope;
  mutation?: boolean;
}
const route = (
  method: BrokerPublicRoute['method'],
  path: string,
  scope: BrokerScope,
  mutation = false,
): BrokerPublicRoute => ({ method, path, scope, ...(mutation ? { mutation: true } : {}) });
/** Explicit machine-access allowlist. Missing routes fail closed, including admin and auth. */
export const BROKER_PUBLIC_ROUTES: readonly BrokerPublicRoute[] = [
  route('GET', '/api/inference/models', 'inference:read'),
  route('GET', '/api/inference/grant', 'inference:read'),
  route('GET', '/api/inference/packs', 'inference:read'),
  route('GET', '/api/inference/packs/:id', 'inference:read'),
  route('POST', '/api/inference/packs/:id/keys', 'tokens:buy', true),
  route('POST', '/api/inference/quotes', 'inference:read'),
  route('POST', '/api/token-orders', 'tokens:buy', true),
  route('GET', '/api/token-orders/:id', 'inference:read'),
  route('POST', '/api/token-orders/:id/cancel', 'tokens:buy', true),
  route('GET', '/api/inference/requests/:id', 'inference:read'),
  route('GET', '/api/v1/models', 'inference:read'),
  route('POST', '/api/v1/chat/completions', 'inference:use', true),
  route('GET', '/api/provider/inference/offering', 'provider:read'),
  route('PUT', '/api/provider/inference/offering', 'provider:offerings:write', true),
  route('GET', '/api/provider/inference/packs', 'provider:read'),
  route('GET', '/api/me', 'account:read'),
  route('GET', '/api/catalog', 'catalog:read'),
  route('GET', '/api/orders', 'orders:read'),
  route('GET', '/api/requests', 'orders:read'),
  route('GET', '/api/requests/:id', 'orders:read'),
  route('POST', '/api/requests', 'orders:write', true),
  route('POST', '/api/requests/:id/cancel', 'orders:write', true),
  route('POST', '/api/requests/:id/retry', 'orders:write', true),
  route('GET', '/api/intents', 'orders:read'),
  route('GET', '/api/intents/:id', 'orders:read'),
  route('POST', '/api/intents', 'orders:write', true),
  route('POST', '/api/intents/:id/propose', 'muse:propose'),
  route('POST', '/api/intents/:id/offers/:offerId/accept', 'orders:write', true),
  route('POST', '/api/agreements/preview', 'agreements:read'),
  route('POST', '/api/agreements', 'agreements:write', true),
  route('GET', '/api/agreements/:id', 'agreements:read'),
  route('POST', '/api/agreements/:id/cancel-unmatched', 'agreements:write', true),
  route('POST', '/api/agreements/:id/activate', 'agreements:activate', true),
  route('GET', '/api/vms', 'vms:read'),
  route('GET', '/api/vms/:id', 'vms:read'),
  route('GET', '/api/vms/:id/terminal', 'vms:terminal'),
  route('POST', '/api/vms/:id/terminate', 'vms:terminate', true),
  route('GET', '/api/credits', 'billing:read'),
  route('GET', '/api/credits/history', 'billing:read'),
  route('GET', '/api/invoices', 'billing:read'),
  route('GET', '/api/agreement-charges', 'billing:read'),
  route('POST', '/api/muse/translate', 'muse:propose'),
  route('POST', '/api/agreements/draft', 'muse:propose'),
  route('GET', '/api/provider/dashboard', 'provider:read'),
  route('GET', '/api/provider/requests', 'provider:read'),
  route('GET', '/api/provider/offerings', 'provider:read'),
  route('GET', '/api/provider/activity', 'provider:read'),
  route('GET', '/api/provider/earnings', 'provider:read'),
  route('GET', '/api/provider/scheduled-offerings', 'provider:read'),
  route('GET', '/api/provider/agreement-demand', 'provider:read'),
  route('GET', '/api/provider/commitments', 'provider:read'),
  route('GET', '/api/provider/agreement-charges', 'provider:read'),
  route('PUT', '/api/provider/capacity', 'provider:capacity:write', true),
  route('PUT', '/api/provider/policy', 'provider:policy:write', true),
  route('POST', '/api/provider/requests/:id/bids', 'provider:bids:write', true),
  route('POST', '/api/provider/offerings', 'provider:offerings:write', true),
  route('PATCH', '/api/provider/offerings/:id', 'provider:offerings:write', true),
  route('POST', '/api/provider/scheduled-offerings', 'provider:offerings:write', true),
  route('PATCH', '/api/provider/scheduled-offerings/:id', 'provider:offerings:write', true),
  route('POST', '/api/provider/policy/propose', 'muse:propose'),
  route('POST', '/api/provider/requests/:id/propose', 'muse:propose'),
  route('POST', '/api/provider/offerings/propose', 'muse:propose'),
  route('POST', '/api/provider/scheduled-offerings/draft', 'muse:propose'),
];
export function publicRoute(
  method: string,
  path: string | undefined,
): BrokerPublicRoute | undefined {
  return BROKER_PUBLIC_ROUTES.find((r) => r.method === method && r.path === path);
}
