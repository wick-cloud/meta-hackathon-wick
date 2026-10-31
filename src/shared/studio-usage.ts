export interface UsageFeatures {
  goalBytes: number;
  scope: number;
  repositoryFiles: number;
  manifestBytes: number;
}
export interface UsageForecast {
  version: string;
  basis: 'cold_start' | 'learned';
  trainingSamples: number;
  targetUtilization: number;
  expectedInput: number;
  expectedOutput: number;
  expectedCalls: number;
  headroom: { inputMultiplier: number; outputMultiplier: number };
  validation: {
    samples: number;
    inputError: number;
    outputError: number;
  } | null;
}
export interface StudioUsage {
  forecast: UsageForecast;
  purchaseRound: number;
  purchaseInput: number;
  purchaseOutput: number;
  inputReservationFloor: number;
  outputReservationFloor: number;
  reservationLimited: boolean;
  settledInput: number;
  settledOutput: number;
  purchasedInput: number;
  purchasedOutput: number;
  unresolvedCalls: number;
}
