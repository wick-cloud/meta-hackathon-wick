# Wick Broker TypeScript SDK

Customer access to Broker auctions, agreements, provider supply and owned environment terminals. Requires Node.js 22.12 or newer.

```sh
npm install @wick-cloud/broker-sdk
```

Create a **Broker API key** in the app's API keys page. A Broker key begins `wbk_` and is separate from Wick's private service key. Pass it through your secret manager or `WICK_BROKER_API_KEY`; never put it in source code. The client does not read `WICK_API_KEY` or environment variables automatically.

```ts
import { BrokerClient, BrokerError } from '@wick-cloud/broker-sdk';

const broker = new BrokerClient({
  baseUrl: process.env.WICK_BROKER_API_URL!,
  apiKey: process.env.WICK_BROKER_API_KEY!,
});

const { items: catalog } = await broker.catalog.list();
const selected = catalog.find((item) => item.approved && item.durationMinutes.includes(30));
if (!selected) throw new Error('No approved 30-minute configuration');

// Retain this operation key before sending. Reuse it only for the exact same request.
const operationKey = crypto.randomUUID();
const order = await broker.orders.create(
  {
    description: 'My development environment',
    catalogId: selected.id,
    region: selected.region,
    durationMinutes: 30,
    maxPriceCents: 100,
    requirements: { cpu: selected.cpu, memoryGb: selected.memoryGb },
  },
  { operationKey },
);

const outcome = await broker.orders.wait(order.id, { timeoutMs: 120_000 });
if (outcome.state === 'pending') console.log('Check this saved order later:', outcome.id);
else console.log(outcome.resource);
```

Order creation can reserve real paid infrastructure. This example requires an appropriately scoped key and a user-approved budget. SDK keys enforce per-operation maximums, not daily or lifetime spending budgets. Scheduled agreements continue to require sufficient Broker pilot credit and a certified native deadline route.

## Resource groups

| Group           | Operations                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `me`, `catalog` | Current account/key authority and approved configurations                                                            |
| `orders`        | Permanent Orders listing; auction create, detail, cancel, retry and wait                                             |
| `alternatives`  | Saved nonbinding intents, concrete proposals and explicit acceptance                                                 |
| `agreements`    | Authoritative preview, draft, create, detail, activation and cancel-unmatched                                        |
| `vms`           | Owned environment list/detail, readiness wait, terminal and termination                                              |
| `billing`       | Wallet, credit history, instant invoices and agreement charges                                                       |
| `provider`      | Dashboard, capacity, policy, requests/bids, offerings/schedules, demand, commitments/calendar, activity and earnings |
| `muse`          | Reviewed translations, schedules, policy, bid, offering and alternative proposals                                    |

`provider.calendar()` returns the same bounded commitment records as `provider.commitments()` for client calendar rendering. It does not infer unbooked native capacity.

All paginated methods return one page and an optional opaque `nextCursor`. Pass the cursor unchanged; the SDK never fetches full histories automatically. `alternatives.list()` currently returns the latest 30 intents, matching the existing API.

`agreements.preview()` accepts a full `AgreementInput`, including the review's operation key; it creates nothing. `agreements.create()` takes the reviewed input without `operationKey`, plus `{operationKey}` as its second argument. Create and cancel-unmatched return `AgreementDetail`, containing the agreement, bookings and activations.

The complete HTTP contract is served at `/api/openapi.json`. The SDK's typed resource methods call the same `/api` owners used by the UI. A low-level `request<T>(method, path, {body, query, operationKey, signal})` is available for contract-covered operations. It accepts only relative `/api/` paths on the configured origin.

## Retries, deadlines and errors

- Reads attempt at most three requests for transient errors. `Retry-After` delays up to ten seconds are observed; larger delays are returned to the caller rather than retried early.
- Mutations and model-proposal POSTs are never automatically retried. Durable mutations require a caller-supplied operation key. Replays retain the same key and exact payload.
- Wait helpers poll one resource every two seconds, have a finite 120-second default deadline and accept `AbortSignal`. A timeout returns `{state:'pending', id, resource?}`; it never cancels, terminates or submits another resource.
- API requests have a 45-second default per-attempt timeout. Configure `requestTimeoutMs` from 1 to 120000. Wait deadlines also bound in-flight requests.
- `BrokerError` exposes `status`, `code`, `requestId`, `operationKey` and optional `retryAfterMs`. A transport timeout on a mutation means the outcome may be uncertain; keep its operation key.

## Terminal access

Only environment access is supported; this package has no task runner, command-execution or file-transfer API. Your own agent can operate the terminal of its authorized environment.

```ts
const terminal = await broker.vms.terminal(vmId, { cols: 100, rows: 30 });
try {
  terminal.write('pwd\n');
  for await (const event of terminal) {
    if (event.type === 'output') {
      process.stdout.write(event.data);
      terminal.ack(event.data.byteLength); // acknowledge after consuming the output
    }
  }
} finally {
  terminal.close();
}
```

The client authenticates a Broker WebSocket using a Bearer header without a browser cookie or spoofed Origin. Native Wick tokens never reach the client. Output and unacknowledged data are bounded to 256 KiB; explicit overflow errors require reconnecting. The client does not silently drop output or reconnect. Closing a terminal handle never terminates the VM.

No secrets, terminal transcripts, prompts or raw upstream responses are logged by this package.
