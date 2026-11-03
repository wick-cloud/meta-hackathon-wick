/** Public, guest-scoped demo receipts. Never contains upstream identifiers or secrets. */
export type DemoKind = 'terminal' | 'studio';
export interface DemoBid {
  provider: string;
  /** Price after any explicit demo sponsorship. */
  priceCents: number;
  grossPriceCents?: number;
  sponsorCreditCents?: number;
  operatorSponsored?: boolean;
  catalogId?: string;
  acceptedAt: string;
}
export interface DemoRun {
  id: string;
  /** Older saved receipts without a kind are terminal demos. */
  kind?: DemoKind;
  demoName?: string;
  status: 'starting' | 'auction' | 'provisioning' | 'ready' | 'ending' | 'ended' | 'failed';
  message: string;
  createdAt: string;
  expiresAt: string | null;
  endedAt: string | null;
  vm: {
    id: string | null;
    status: string;
    provider: 'modal';
    catalogId: 'modal:micro:auto';
    terminalPath: string | null;
    priceCents: number | null;
    grossPriceCents?: number | null;
    sponsorCreditCents?: number | null;
    operatorSponsored?: boolean;
    auctionEndsAt: string | null;
    bids: DemoBid[];
    cleanupConfirmed: boolean;
  } | null;
  tokens: {
    orderId: string;
    status: string;
    provider: 'baseten';
    packId: string | null;
    inputTokens: number;
    outputTokens: number;
    availableInput: number;
    availableOutput: number;
    requestsUsed: number;
    priceCents: number | null;
    auctionEndsAt: string | null;
    bids: DemoBid[];
  } | null;
  disk: { id: string; name: string; status: string } | null;
  canIssueKey: boolean;
  keyIssued: boolean;
  studio?: {
    status: 'waiting' | 'generating' | 'running' | 'passed' | 'needs_attention';
    filename: 'hello_world.py';
    source: string | null;
    stdout: string | null;
    exitCode: number | null;
    requestsUsed: number;
    verifiedAt: string | null;
  } | null;
}
export interface DemoState {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  mode: 'real' | 'fixture';
  serverTime: string;
  cooldownUntil: string | null;
  limits: {
    durationMinutes: number;
    cooldownMinutes: number;
    maxRequests: number;
    maxOutputTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
  run: DemoRun | null;
}
export interface DemoKeyResponse {
  token: string;
  connection: { packId: string; baseUrl: string; model: string; expiresAt: string };
}
