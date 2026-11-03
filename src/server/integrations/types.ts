import type { WickDrives } from './drives.js';
import type {
  CatalogItem,
  Translation,
  Receipt,
  BidProposal,
  SupplierPolicy,
  OfferingProposal,
} from '../../shared/types.js';
import type { MusePricedCandidate } from '../../shared/muse-contracts.js';
export interface CreateEnvironmentInput {
  organizationId: string;
  groupId: string;
  name: string;
  provider: string;
  profile: string;
  region?: string;
  providerKeyId?: string;
  ttlSeconds: number;
  hardEndAt?: string;
  maximumPriceMicrosPerSecond?: number;
  visibility: 'private';
  workspaceDrive?: { driveId: string; accessMode: 'mount' };
}
export interface WickEnvironment {
  id: string;
  status: 'pending' | 'provisioning' | 'running' | 'terminating' | 'terminated' | 'failed';
  expiresAt: string | null;
  hardEndAt?: string;
  createdAt?: string;
  name?: string;
  organizationId?: string;
  groupId?: string;
  provider?: string;
  profile?: string;
  providerKeyId?: string;
  billingMode?: 'wick_managed' | 'byok';
  workspaceDrive?: {
    driveId: string;
    generation?: string;
    status?: string;
    attachmentMode?: 'exclusive' | 'shared';
    accessMode?: 'mount' | 'files';
    workspacePath?: string;
  };
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
  drives?: WickDrives;
  /** Structured execution, with native status/exit code. No command retries. */
  runCommand?(
    id: string,
    input: { command: string; cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; simulated?: boolean }>;
  catalog(): Promise<CatalogItem[]>;
  preview(input: CreateEnvironmentInput): Promise<unknown>;
  create(input: CreateEnvironmentInput, idempotencyKey: string): Promise<WickCreateResult>;
  get(id: string): Promise<WickEnvironment>;
  list?(input: {
    organizationId: string;
    groupId: string;
    search: string;
    provider: string;
    limit: 50;
    newest: true;
    archived: boolean;
    cursor?: string;
  }): Promise<{ items: WickEnvironment[]; nextCursor?: string }>;
  connections(id: string): Promise<WickConnections>;
  session(id: string): Promise<WickSession>;
  terminal(id: string, options?: WickTerminalOptions): Promise<WickTerminal>;
  terminate(id: string): Promise<void>;
}
export interface MuseAdapter {
  selectTokenPurchase?(
    input: import('../../shared/buying.js').MuseBuyingInput,
  ): Promise<import('../../shared/buying.js').MuseBuyingSelection>;
  mode: 'fixture' | 'real';
  translate(
    description: string,
    catalog: CatalogItem[],
  ): Promise<{
    proposal: Translation & { maxPriceCents?: number };
    receipt: Receipt;
    mode: 'fixture' | 'real';
  }>;
  proposeCapacityPolicy(input: {
    strategy: string;
    policy: SupplierPolicy;
    capacity: { total: number; held: number; available: number };
    catalogIds: string[];
  }): Promise<{
    policy: SupplierPolicy;
    receipt: Receipt;
    mode: 'fixture' | 'real';
    modelCalled: boolean;
  }>;
  selectCounteroffers(input: {
    requirements: {
      requirements: import('../../shared/types.js').Requirements;
      region: string;
      durationMinutes: number;
      maxPriceCents: number;
    };
    policy: SupplierPolicy;
    capacity: { total: number; held: number; available: number };
    candidates: MusePricedCandidate[];
  }): Promise<{
    selections: { candidateId: string; rationale: string }[];
    receipt: Receipt;
    mode: 'fixture' | 'real';
    modelCalled: boolean;
  }>;
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
    suggestedTotalPriceCents?: number;
    /** Internal remaining-auction budget; never included in the model prompt. */
    timeoutMs?: number;
  }): Promise<BidProposal>;
  proposeOfferings(input: {
    demand: unknown[];
    catalog: CatalogItem[];
    policy: SupplierPolicy;
    pricedCandidates?: {
      id: string;
      catalogId: string;
      durationMinutes: number;
      totalPriceCents: number;
    }[];
  }): Promise<{ proposals: OfferingProposal[]; receipt: Receipt; mode: 'fixture' | 'real' }>;
}
