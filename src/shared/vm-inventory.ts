import type { Mode } from './types.js';

export const vmStatuses = [
  'provisioning',
  'running',
  'terminating',
  'terminated',
  'failed',
  'expired',
] as const;
export type VMStatus = (typeof vmStatuses)[number];
export interface VMInventoryItem {
  id: string;
  requestId: string;
  name: string;
  status: VMStatus;
  sourceMode: Mode;
  provider: string | null;
  providerName: string | null;
  cpu: number | null;
  memoryGb: number | null;
  gpu: string | null;
  region: string | null;
  createdAt: string;
  expiresAt: string | null;
  priceCents: number | null;
  cleanupPending: boolean;
  billingSource: 'instant_vm' | 'scheduled_capacity';
}
export interface VMInventoryPage {
  items: VMInventoryItem[];
  nextCursor?: string;
  previousCursor?: string;
  serverNow: string;
}
