import type { Mode, SupplierPolicy } from './types.js';

export interface SalesEvidence {
  id: string;
  label: string;
  detail: string;
}

export interface SalesComparison {
  sampledRequests: number;
  currentMatches: number;
  proposedMatches: number;
}

export interface SalesCandidate {
  id: string;
  title: string;
  description: string;
  policy: SupplierPolicy;
  comparison: SalesComparison;
  evidenceIds: string[];
}

export interface SalesAdviceInput {
  goal: string;
  currentPolicy: SupplierPolicy;
  capacity: { total: number; held: number; available: number };
  evidence: SalesEvidence[];
  candidates: SalesCandidate[];
}

export interface SalesAdviceSelection {
  summary: string;
  recommendations: { candidateId: string; explanation: string; evidenceIds: string[] }[];
  mode: Mode;
  modelCalled: boolean;
}

export interface SalesReport {
  providerId: string;
  generatedAt: string;
  baseRevision: number;
  currentPolicy: SupplierPolicy;
  capacity: SalesAdviceInput['capacity'];
  mode: Mode;
  sourceMode: Mode;
  modelCalled: boolean;
  summary: string;
  evidence: SalesEvidence[];
  recommendations: (SalesCandidate & { explanation: string })[];
  limitations: string[];
  catalogNames: Record<string, string>;
}
