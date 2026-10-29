import { BrokerError } from './errors.js';
import { BrokerTerminal, type TerminalOptions } from './terminal.js';
import type * as T from './types.js';
import type * as A from './agreements.js';
import type { OrdersPage, OrderKind, OrderStatusFilter, OrderCreatedFilter } from './orders.js';
export * from './types.js';
export * from './agreements.js';
export * from './orders.js';
export * from './errors.js';
export * from './terminal.js';

export interface BrokerClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}
export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  operationKey?: string;
  signal?: AbortSignal;
}
export interface ReadOptions {
  signal?: AbortSignal;
}
export interface MutationOptions extends ReadOptions {
  operationKey: string;
}
export interface WaitOptions extends ReadOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}
export interface BrokerWaitResult<T> {
  state: 'complete' | 'pending';
  id: string;
  resource?: T;
}
export interface OrdersQuery extends T.Pagination {
  kind?: 'all' | OrderKind;
  status?: OrderStatusFilter;
  created?: OrderCreatedFilter;
}
export interface CommitmentQuery extends T.Pagination {
  from?: string;
  to?: string;
}
const segment = (id: string) => encodeURIComponent(id);
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new BrokerError('Broker request was cancelled.', { code: 'cancelled' }));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new BrokerError('Broker request was cancelled.', { code: 'cancelled' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Broker keys authenticate this client. The private Wick service key is never a client input. */
export class BrokerClient {
  readonly baseUrl: string;
  #apiKey: string;
  #fetch: typeof fetch;
  #requestTimeoutMs: number;
  constructor(options: BrokerClientOptions) {
    const base = new URL(options.baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    )
      throw new BrokerError(
        'Broker baseUrl must be an HTTPS origin (HTTP is allowed only on loopback).',
        { code: 'invalid_configuration' },
      );
    if (
      typeof options.apiKey !== 'string' ||
      !/^wbk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(options.apiKey)
    )
      throw new BrokerError('Use a Broker API key beginning wbk_; Wick API keys are separate.', {
        code: 'invalid_api_key',
      });
    const timeout = options.requestTimeoutMs ?? 45000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
      throw new BrokerError('requestTimeoutMs must be 1–120000 milliseconds.', {
        code: 'invalid_configuration',
      });
    this.baseUrl = base.origin;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = timeout;
  }
  async request<R>(method: string, path: string, options: RequestOptions = {}): Promise<R> {
    const verb = method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb))
      throw new BrokerError('Unsupported Broker HTTP method.', { code: 'invalid_input' });
    const url = new URL(path, this.baseUrl);
    if (
      !path.startsWith('/api/') ||
      url.origin !== this.baseUrl ||
      !url.pathname.startsWith('/api/') ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new BrokerError(
        'Broker requests must target a relative /api/ resource on the configured origin.',
        { code: 'invalid_input' },
      );
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const op = options.operationKey;
    if (op !== undefined && !/^[-A-Za-z0-9_:./]{8,160}$/.test(op))
      throw new BrokerError('Use a unique operationKey of 8–160 safe characters.', {
        code: 'invalid_input',
        operationKey: op,
      });
    const body =
      options.body === undefined
        ? op && verb !== 'GET'
          ? { operationKey: op }
          : undefined
        : op && options.body && typeof options.body === 'object' && !Array.isArray(options.body)
          ? { ...options.body, operationKey: op }
          : options.body;
    if (op && options.body && typeof options.body === 'object' && !Array.isArray(options.body)) {
      const inputKey = (options.body as Record<string, unknown>).operationKey;
      if (inputKey !== undefined && inputKey !== op)
        throw new BrokerError('Body and request operation keys must match.', {
          code: 'invalid_input',
          operationKey: op,
        });
    }
    const attempts = verb === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (options.signal?.aborted)
        throw new BrokerError('Broker request was cancelled.', {
          code: 'cancelled',
          operationKey: op,
        });
      const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: verb,
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(op ? { 'Idempotency-Key': op } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        if (options.signal?.aborted)
          throw new BrokerError('Broker request was cancelled.', {
            code: 'cancelled',
            operationKey: op,
          });
        if (attempt + 1 < attempts) {
          await delay(250 * 2 ** attempt, options.signal);
          continue;
        }
        throw new BrokerError(
          timeout.aborted
            ? 'Broker request timed out. The operation may still be in progress.'
            : 'Broker is unavailable. Retry an uncertain mutation only with the same operation key.',
          { code: timeout.aborted ? 'timeout' : 'unavailable', operationKey: op },
        );
      }
      const retryMs = retryAfter(response.headers.get('retry-after'));
      if (
        !response.ok &&
        attempt + 1 < attempts &&
        retryableStatuses.has(response.status) &&
        (retryMs ?? 0) <= 10000
      ) {
        await response.body?.cancel().catch(() => {});
        await delay(retryMs ?? 250 * 2 ** attempt, options.signal);
        continue;
      }
      let value: unknown;
      try {
        if (response.status === 204) value = undefined;
        else {
          const declared = Number(response.headers.get('content-length'));
          if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
            await response.body?.cancel().catch(() => {});
            throw new Error();
          }
          // Bounded API pages are small. Read incrementally to also bound chunked responses.
          if (!response.body) throw new Error();
          const reader = response.body.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 2 * 1024 * 1024) {
                await reader.cancel();
                throw new Error();
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      } catch {
        // A fetch can resolve its headers before its body is interrupted. Preserve
        // cancellation and uncertain-mutation recovery semantics through body reads.
        if (options.signal?.aborted)
          throw new BrokerError('Broker request was cancelled.', {
            code: 'cancelled',
            operationKey: op,
          });
        if (timeout.aborted)
          throw new BrokerError(
            'Broker request timed out. The operation may still be in progress.',
            { code: 'timeout', operationKey: op },
          );
        throw new BrokerError('Broker returned an invalid or oversized API response.', {
          status: response.status,
          code: 'invalid_response',
          requestId: response.headers.get('x-request-id') ?? undefined,
          operationKey: op,
        });
      }
      if (!response.ok) {
        const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const message =
          typeof data.error === 'string'
            ? data.error.replaceAll(this.#apiKey, '[redacted]')
            : `Broker request failed (${response.status}).`;
        throw new BrokerError(message, {
          status: response.status,
          code: typeof data.code === 'string' ? data.code : 'request_failed',
          requestId:
            typeof data.requestId === 'string'
              ? data.requestId
              : (response.headers.get('x-request-id') ?? undefined),
          operationKey: op,
          ...(retryMs === undefined ? {} : { retryAfterMs: retryMs }),
        });
      }
      return value as R;
    }
    throw new BrokerError('Broker request failed.', { code: 'unavailable', operationKey: op });
  }
  async #write<R>(
    method: string,
    path: string,
    body: unknown,
    options: MutationOptions,
  ): Promise<R> {
    if (!options?.operationKey)
      throw new BrokerError('A stable operationKey is required for this mutation.', {
        code: 'operation_key_required',
      });
    return this.request(method, path, { ...options, body: body ?? {} });
  }
  async #wait<R>(
    id: string,
    read: (signal: AbortSignal) => Promise<R>,
    finished: (resource: R) => boolean,
    options: WaitOptions = {},
  ): Promise<BrokerWaitResult<R>> {
    const timeoutMs = options.timeoutMs ?? 120000,
      interval = options.pollIntervalMs ?? 2000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 900000 ||
      !Number.isInteger(interval) ||
      interval < 100 ||
      interval > 30000
    )
      throw new BrokerError('Wait timeout must be 1–900000 ms and polling interval 100–30000 ms.', {
        code: 'invalid_input',
      });
    const deadline = AbortSignal.timeout(timeoutMs),
      signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let resource: R | undefined;
    try {
      for (;;) {
        resource = await read(signal);
        if (finished(resource)) return { state: 'complete', id, resource };
        await delay(interval, signal);
      }
    } catch (error) {
      if (options.signal?.aborted)
        throw new BrokerError('Broker wait was cancelled. The resource remains unchanged.', {
          code: 'cancelled',
        });
      if (deadline.aborted)
        return { state: 'pending', id, ...(resource === undefined ? {} : { resource }) };
      throw error;
    }
  }
  me = (options: ReadOptions = {}) => this.request<T.Session>('GET', '/api/me', options);
  catalog = {
    list: (options: ReadOptions = {}) =>
      this.request<{ items: T.CatalogItem[] }>('GET', '/api/catalog', options),
  };
  orders = {
    list: (query: OrdersQuery = {}, options: ReadOptions = {}) =>
      this.request<OrdersPage>('GET', '/api/orders', { ...options, query: { ...query } }),
    requests: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.EnvironmentRequest>>('GET', '/api/requests', {
        ...options,
        query: { ...query },
      }),
    create: (input: T.CreateOrderInput, options: MutationOptions) =>
      this.#write<T.EnvironmentRequest>('POST', '/api/requests', input, options),
    get: (id: string, options: ReadOptions = {}) =>
      this.request<T.OrderDetail>('GET', `/api/requests/${segment(id)}`, options),
    cancel: (id: string, options: MutationOptions) =>
      this.#write<{ cancelled: boolean }>(
        'POST',
        `/api/requests/${segment(id)}/cancel`,
        {},
        options,
      ),
    retry: (id: string, options: MutationOptions) =>
      this.#write<T.EnvironmentRequest>('POST', `/api/requests/${segment(id)}/retry`, {}, options),
    wait: (id: string, options: WaitOptions = {}) =>
      this.#wait(
        id,
        (signal) => this.orders.get(id, { signal }),
        (r) => !['open', 'provisioning'].includes(r.request.status),
        options,
      ),
  };
  alternatives = {
    list: (options: ReadOptions = {}) =>
      this.request<T.Page<T.Intent>>('GET', '/api/intents', options),
    create: (input: T.IntentInput, options: MutationOptions) =>
      this.#write<T.Intent>('POST', '/api/intents', input, options),
    get: (id: string, options: ReadOptions = {}) =>
      this.request<T.IntentDetail>('GET', `/api/intents/${segment(id)}`, options),
    propose: (id: string, options: ReadOptions = {}) =>
      this.request<T.AlternativesResult>('POST', `/api/intents/${segment(id)}/propose`, {
        ...options,
        body: {},
      }),
    accept: (id: string, offerId: string, options: MutationOptions) =>
      this.#write<T.AcceptAlternativeResult>(
        'POST',
        `/api/intents/${segment(id)}/offers/${segment(offerId)}/accept`,
        {},
        options,
      ),
  };
  agreements = {
    preview: (input: A.AgreementInput, options: ReadOptions = {}) =>
      this.request<A.AgreementPreview>('POST', '/api/agreements/preview', {
        ...options,
        body: input,
      }),
    create: (input: Omit<A.AgreementInput, 'operationKey'>, options: MutationOptions) =>
      this.#write<A.AgreementDetail>('POST', '/api/agreements', input, options),
    get: (id: string, options: ReadOptions = {}) =>
      this.request<A.AgreementDetail>('GET', `/api/agreements/${segment(id)}`, options),
    activate: (
      id: string,
      input: Omit<A.ActivateAgreementInput, 'operationKey'>,
      options: MutationOptions,
    ) =>
      this.#write<A.ActivateAgreementResult>(
        'POST',
        `/api/agreements/${segment(id)}/activate`,
        input,
        options,
      ),
    cancelUnmatched: (id: string, options: MutationOptions) =>
      this.#write<A.AgreementDetail>(
        'POST',
        `/api/agreements/${segment(id)}/cancel-unmatched`,
        {},
        options,
      ),
    draft: (prompt: string, options: ReadOptions = {}) =>
      this.request<A.AgreementDraftResult<A.AgreementInput>>('POST', '/api/agreements/draft', {
        ...options,
        body: { prompt },
      }),
  };
  vms = {
    list: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.VM>>('GET', '/api/vms', { ...options, query: { ...query } }),
    get: (id: string, options: ReadOptions = {}) =>
      this.request<T.VM>('GET', `/api/vms/${segment(id)}`, options),
    wait: (id: string, options: WaitOptions = {}) =>
      this.#wait(
        id,
        (signal) => this.vms.get(id, { signal }),
        (r) => ['running', 'failed', 'expired', 'terminated'].includes(r.status),
        options,
      ),
    terminate: (id: string, options: MutationOptions) =>
      this.#write<{ accepted: boolean; message: string }>(
        'POST',
        `/api/vms/${segment(id)}/terminate`,
        {},
        options,
      ),
    terminal: (id: string, options: TerminalOptions = {}) => {
      const url = new URL(`/api/vms/${segment(id)}/terminal`, this.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return BrokerTerminal.connect(url, this.#apiKey, options);
    },
  };
  billing = {
    wallet: (options: ReadOptions = {}) =>
      this.request<A.CreditWallet>('GET', '/api/credits', options),
    history: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<A.CreditHistory>('GET', '/api/credits/history', {
        ...options,
        query: { ...query },
      }),
    invoices: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.Invoice>>('GET', '/api/invoices', { ...options, query: { ...query } }),
    agreementCharges: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.AgreementCharge>>('GET', '/api/agreement-charges', {
        ...options,
        query: { ...query },
      }),
  };
  provider = {
    dashboard: (options: ReadOptions = {}) =>
      this.request<T.ProviderDashboard>('GET', '/api/provider/dashboard', options),
    capacity: (input: { total: number; expectedRevision?: number }, options: MutationOptions) =>
      this.#write<{ total: number; policyRevision: number }>(
        'PUT',
        '/api/provider/capacity',
        input,
        options,
      ),
    requests: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.ProviderRequest>>('GET', '/api/provider/requests', {
        ...options,
        query: { ...query },
      }),
    bids: {
      submit: (requestId: string, input: T.BidInput, options: MutationOptions) =>
        this.#write<T.Bid>(
          'POST',
          `/api/provider/requests/${segment(requestId)}/bids`,
          input,
          options,
        ),
      propose: (requestId: string, options: ReadOptions = {}) =>
        this.request<T.BidProposal>(
          'POST',
          `/api/provider/requests/${segment(requestId)}/propose`,
          { ...options, body: {} },
        ),
    },
    policy: {
      propose: (strategy: string, options: ReadOptions = {}) =>
        this.request<T.PolicyProposal>('POST', '/api/provider/policy/propose', {
          ...options,
          body: { strategy },
        }),
      apply: (input: T.ApplyPolicyInput, options: MutationOptions) =>
        this.#write<T.PolicyResult>('PUT', '/api/provider/policy', input, options),
    },
    offerings: {
      list: (query: T.Pagination = {}, options: ReadOptions = {}) =>
        this.request<T.Page<T.Offering>>('GET', '/api/provider/offerings', {
          ...options,
          query: { ...query },
        }),
      create: (input: T.OfferingInput, options: MutationOptions) =>
        this.#write<T.Offering>('POST', '/api/provider/offerings', input, options),
      update: (id: string, input: { active: boolean }, options: MutationOptions) =>
        this.#write<T.Offering>('PATCH', `/api/provider/offerings/${segment(id)}`, input, options),
      propose: (options: ReadOptions = {}) =>
        this.request<T.OfferingsProposal>('POST', '/api/provider/offerings/propose', {
          ...options,
          body: {},
        }),
    },
    scheduledOfferings: {
      list: (query: T.Pagination = {}, options: ReadOptions = {}) =>
        this.request<T.Page<A.ScheduledOffering>>('GET', '/api/provider/scheduled-offerings', {
          ...options,
          query: { ...query },
        }),
      create: (input: Omit<A.ScheduledOfferingInput, 'operationKey'>, options: MutationOptions) =>
        this.#write<A.ScheduledOffering>(
          'POST',
          '/api/provider/scheduled-offerings',
          input,
          options,
        ),
      update: (
        id: string,
        input: { active: boolean; expectedRevision: number },
        options: MutationOptions,
      ) =>
        this.#write<A.ScheduledOffering>(
          'PATCH',
          `/api/provider/scheduled-offerings/${segment(id)}`,
          input,
          options,
        ),
      draft: (prompt: string, options: ReadOptions = {}) =>
        this.request<A.AgreementDraftResult<A.ScheduledOfferingInput>>(
          'POST',
          '/api/provider/scheduled-offerings/draft',
          { ...options, body: { prompt } },
        ),
    },
    demand: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<A.AgreementDemand>>('GET', '/api/provider/agreement-demand', {
        ...options,
        query: { ...query },
      }),
    commitments: (query: CommitmentQuery = {}, options: ReadOptions = {}) =>
      this.request<T.Page<A.ProviderCommitment>>('GET', '/api/provider/commitments', {
        ...options,
        query: { ...query },
      }),
    calendar: (query: CommitmentQuery = {}, options: ReadOptions = {}) =>
      this.request<T.Page<A.ProviderCommitment>>('GET', '/api/provider/commitments', {
        ...options,
        query: { ...query },
      }),
    earnings: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.ProviderEarning>>('GET', '/api/provider/earnings', {
        ...options,
        query: { ...query },
      }),
    agreementCharges: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.AgreementCharge>>('GET', '/api/provider/agreement-charges', {
        ...options,
        query: { ...query },
      }),
    activity: (query: T.Pagination = {}, options: ReadOptions = {}) =>
      this.request<T.Page<T.Activity>>('GET', '/api/provider/activity', {
        ...options,
        query: { ...query },
      }),
  };
  muse = {
    translate: (description: string, options: ReadOptions = {}) =>
      this.request<T.TranslationResult>('POST', '/api/muse/translate', {
        ...options,
        body: { description },
      }),
    draftAgreement: (prompt: string, options: ReadOptions = {}) =>
      this.agreements.draft(prompt, options),
    draftOffering: (prompt: string, options: ReadOptions = {}) =>
      this.provider.scheduledOfferings.draft(prompt, options),
    proposePolicy: (strategy: string, options: ReadOptions = {}) =>
      this.provider.policy.propose(strategy, options),
    proposeOfferings: (options: ReadOptions = {}) => this.provider.offerings.propose(options),
    proposeBid: (requestId: string, options: ReadOptions = {}) =>
      this.provider.bids.propose(requestId, options),
    proposeAlternatives: (intentId: string, options: ReadOptions = {}) =>
      this.alternatives.propose(intentId, options),
  };
}
