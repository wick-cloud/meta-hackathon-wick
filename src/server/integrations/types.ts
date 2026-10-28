import type {
  CatalogItem,
  Translation,
  Receipt,
  BidProposal,
  SupplierPolicy,
  OfferingProposal,
} from '../../shared/types.js';
export interface CreateEnvironmentInput {
  organizationId: string;
  groupId: string;
  name: string;
  provider: string;
  profile: string;
  region?: string;
  providerKeyId?: string;
  ttlSeconds: number;
  maximumPriceMicrosPerSecond?: number;
  visibility: 'private';
}
export interface WickEnvironment {
  id: string;
  status: 'pending' | 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed';
  expiresAt: string | null;
  createdAt?: string;
  raw?: unknown;
}
export interface WickCreateResult {
  environment: WickEnvironment;
  operation?: { id: string; status?: string };
  raw?: unknown;
}
export interface WickConnections {
  terminal: boolean;
}
export interface WickSession {
  token: string;
  terminalWebsocketUrl: string;
  expiresAt: string;
}
export type WickTerminalEvent =
  | { type: 'ready' }
  | { type: 'output'; data: Uint8Array }
  | { type: 'exit'; exitCode: number }
  | { type: 'pong' };
export interface WickTerminal extends AsyncIterable<WickTerminalEvent> {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  ack(bytes: number): void;
  close(): void;
}
export interface WickTerminalOptions {
  cols?: number;
  rows?: number;
  signal?: AbortSignal;
}
export interface WickAdapter {
  mode: 'fixture' | 'real';
  catalog(): Promise<CatalogItem[]>;
  preview(input: CreateEnvironmentInput): Promise<unknown>;
  create(input: CreateEnvironmentInput, idempotencyKey: string): Promise<WickCreateResult>;
  get(id: string): Promise<WickEnvironment>;
  connections(id: string): Promise<WickConnections>;
  session(id: string): Promise<WickSession>;
  terminal(id: string, options?: WickTerminalOptions): Promise<WickTerminal>;
  terminate(id: string): Promise<void>;
}
export interface MuseAdapter {
  mode: 'fixture' | 'real';
  translate(
    description: string,
    catalog: CatalogItem[],
  ): Promise<{ proposal: Translation; receipt: Receipt; mode: 'fixture' | 'real' }>;
  proposeBid(input: {
    request: {
      description: string;
      catalogId: string;
      region?: string;
      durationMinutes: number;
      maxPriceCents: number;
      requirements: unknown;
    };
    policy: SupplierPolicy;
    availableCapacity: number;
    catalog: CatalogItem[];
  }): Promise<BidProposal>;
  proposeOfferings(input: {
    demand: unknown[];
    catalog: CatalogItem[];
    policy: SupplierPolicy;
  }): Promise<{ proposals: OfferingProposal[]; receipt: Receipt; mode: 'fixture' | 'real' }>;
}
