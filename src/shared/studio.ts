import type { StudioUsage } from './studio-usage.js';
export type StudioStatus =
  | 'queued'
  | 'model_auction'
  | 'planning'
  | 'compute_auction'
  | 'provisioning'
  | 'running'
  | 'verifying'
  | 'cleaning_up'
  | 'needs_budget'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'stopped';
export interface StudioTask {
  id: string;
  diskId?: string;
  workspaceId?: string;
  continuingWorkspace?: boolean;
  patchLabel?: 'Workspace changes';
  goal: string;
  repositoryUrl: string;
  commitSha: string;
  status: StudioStatus;
  mode: 'fixture' | 'real';
  budgetCents: number;
  spentCents: number;
  reservedCents: number;
  availableCents: number;
  returnedCents: number;
  computeChargedCents: number;
  modelChargedCents: number;
  blockedReason: string | null;
  plan: StudioPlan | null;
  deadlineAt: string;
  createdAt: string;
  executionStartedAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  vmRequestId: string | null;
  codingJobId: string | null;
  summary: string | null;
  hasPatch: boolean;
}
export interface StudioPlan {
  catalogId: string;
  testCommand: string;
  explanation: string;
}
export interface StudioDetail {
  planning?: {
    attempt: number;
    requestId: string | null;
    requestStatus: string;
    finishReason: string | null;
    outputTokens: number | null;
    maximumOutputTokens: number;
    failureCode: string | null;
    canRetry: boolean;
    hasSavedResponse: boolean;
  } | null;
  usage?: StudioUsage | null;
  modelActivity: {
    id: string;
    provider: string;
    status: string;
    phase: 'planning' | 'execution';
    createdAt: string;
  }[];
  patch: string | null;
  task: StudioTask;
  events: { id: string; kind: string; title: string; message: string; createdAt: string }[];
  vm: { id: string; status: string; cleanupConfirmedAt: string | null } | null;
  computeAuction: {
    id: string;
    status: string;
    closesAt: string;
    bids: { provider: string; priceCents: number; status: string }[];
  } | null;
  modelPurchases: {
    id: string;
    status: string;
    provider: string | null;
    priceCents: number | null;
    closesAt: string;
  }[];
  tests: { output: string; exitCode: number; completedAt: string } | null;
}
