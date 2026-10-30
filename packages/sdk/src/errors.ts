export interface BrokerErrorOptions {
  status?: number;
  code?: string;
  requestId?: string;
  inferenceRequestId?: string;
  operationKey?: string;
  retryAfterMs?: number;
}
export class BrokerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly inferenceRequestId?: string;
  readonly operationKey?: string;
  readonly retryAfterMs?: number;
  constructor(message: string, options: BrokerErrorOptions = {}) {
    super(message);
    this.name = 'BrokerError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'request_failed';
    this.requestId = options.requestId;
    this.inferenceRequestId = options.inferenceRequestId;
    this.operationKey = options.operationKey;
    this.retryAfterMs = options.retryAfterMs;
  }
  toJSON() {
    return {
      error: this.message,
      code: this.code,
      status: this.status,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.inferenceRequestId ? { inferenceRequestId: this.inferenceRequestId } : {}),
      ...(this.operationKey ? { operationKey: this.operationKey } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}
