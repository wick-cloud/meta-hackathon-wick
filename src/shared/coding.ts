export const CODING_STATUSES = [
  'queued',
  'running',
  'paused',
  'needs_allowance',
  'uncertain',
  'stopping',
  'stopped',
  'failed',
  'ready',
] as const;
export type CodingStatus = (typeof CODING_STATUSES)[number];
export interface CodingJob {
  id: string;
  vmId: string;
  diskId?: string;
  workspaceId?: string;
  continuingWorkspace?: boolean;
  grantId: string;
  repositoryUrl: string;
  commitSha: string;
  baseRef: string;
  goal: string;
  testCommand: string;
  mode: 'fixture' | 'real';
  status: CodingStatus;
  blockedReason: string | null;
  requestedAction: 'pause' | 'stop' | null;
  modelCalls: number;
  maxCalls: number;
  maxOutputTokens: number;
  testsPassed: boolean;
  deadlineAt: string;
  createdAt: string;
  artifactsExpireAt: string;
}
export interface CodingStep {
  id: string;
  sequence: number;
  kind: 'model' | 'command';
  status: string;
  action: string;
  result: Record<string, unknown> | null;
  inferenceRequestId: string | null;
  receipt?: import('./inference.js').InferenceReceipt;
}
export interface CodingDetail {
  job: CodingJob;
  steps: CodingStep[];
  artifactsExpired: boolean;
  parentTask?: {
    id: string;
    status: import('./studio.js').StudioStatus;
    blockedReason: string | null;
    completedAt: string | null;
  } | null;
  vm?: {
    status: string;
    expiresAt: string | null;
    cleanupConfirmedAt: string | null;
  } | null;
}
