# Wick Broker TypeScript SDK

Customer access to Broker VM auctions, prepaid AI tokens, provider supply and owned environment terminals. Requires Node.js 22.12 or newer.

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

Order creation can reserve real paid infrastructure. This example requires an appropriately scoped key and a user-approved budget. SDK keys enforce per-operation maximums, not daily or lifetime spending budgets.

## Resource groups

| Group           | Operations                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `me`, `catalog` | Current account/key authority and approved configurations                    |
| `orders`        | Permanent Orders listing; auction create, detail, cancel, retry and wait     |
| `alternatives`  | Saved nonbinding intents, concrete proposals and explicit acceptance         |
| `vms`           | Owned environment list/detail, readiness wait, terminal and termination      |
| `billing`       | Wallet, credit history and instant invoices                                  |
| `provider`      | Dashboard, capacity, policy, requests/bids, offerings, activity and earnings |
| `muse`          | Reviewed VM translations, policy, bid, offering and alternative proposals    |

All paginated methods return one page and an optional opaque `nextCursor`. Pass the cursor unchanged; the SDK never fetches full histories automatically. `alternatives.list()` currently returns the latest 30 intents, matching the existing API.

The complete HTTP contract is served at `/api/openapi.json`. The SDK's typed resource methods call the same `/api` owners used by the UI. A low-level `request<T>(method, path, {body, query, operationKey, signal})` is available for contract-covered operations. It accepts only relative `/api/` paths on the configured origin.

## Retries, deadlines and errors

- Reads attempt at most three requests for transient errors. `Retry-After` delays up to ten seconds are observed; larger delays are returned to the caller rather than retried early.
- Mutations and model-proposal POSTs are never automatically retried. Durable mutations require a caller-supplied operation key. Replays retain the same key and exact payload.
- Wait helpers poll one resource every two seconds, have a finite 120-second default deadline (30 seconds for token orders) and accept `AbortSignal`. A timeout returns `{state:'pending', id, resource?}`; it never cancels, terminates or submits another resource.
- API requests have a 45-second default per-attempt timeout. Configure `requestTimeoutMs` from 1 to 120000. Wait deadlines also bound in-flight requests.
- `BrokerError` exposes `status`, `code`, `requestId`, `operationKey` and optional `retryAfterMs`. `requestId` correlates the HTTP request; `inferenceRequestId`, when present, identifies the persisted inference receipt. A transport timeout on a mutation means the outcome may be uncertain; keep its operation key.

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

## Prepaid Meta inference

Monetary `*Cents` fields support hundredths of a cent: `$1.2345` is `123.45`, and `$0.0001` is `0.01`. The field unit has not changed. Pass decimal values directly; do not round them to whole cents. Token counts and capacity remain integers. Version `0.3.0` includes the expanded money contracts.

An owner can buy tokens directly from **Purchased tokens → Buy tokens** using Broker wallet credit, then issue a batch-only key through **Connect** for an app, script, VM or agent. No agent is required for this browser purchase. Direct batches expire after two hours (at the expiry shown before purchase). Ordinary API keys cannot spend the wallet directly, and batch-only keys cannot buy more tokens.

For an agent that can purchase its own packs, the owner creates a funded AI grant in the browser and issues a key bound to it with `account:read`, `inference:read`, `tokens:buy` and `inference:use`. Key rotation retains the same grant; these agent keys cannot create a grant or raise its budget. Read `inference.catalog()` before buying: fixture mode is simulated, and an unqualified real provider route cannot serve inference.

```ts
const grant = await broker.inference.grant();
const order = await broker.inference.orders.create(
  {
    mode: 'auction',
    modelId: 'meta/muse-spark-open',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    maxTotalCents: Math.min(500, grant.availableCents, grant.maxPurchaseCents),
  },
  { operationKey: 'task-token-purchase-001' },
);
const outcome = await broker.inference.orders.wait(order.id); // default 30 seconds
if (outcome.state === 'complete' && outcome.resource?.order.status === 'awarded') {
  const result = await broker.inference.complete(
    {
      model: 'meta/muse-spark-open',
      messages: [{ role: 'user', content: 'Summarize this text.' }],
      max_tokens: 2048,
      stream: false,
    },
    { operationKey: 'task-completion-001' },
  );
  const choice = result.choices[0];
  const text = choice?.message.content?.trim() ?? '';
  if (!text || choice?.finish_reason === 'length') {
    console.warn(text ? 'Partial answer: output limit reached.' : 'No visible answer returned.');
    console.warn('Reported usage still consumes prepaid quota. No automatic retry was made.');
    if (text) console.log(text);
  } else {
    console.log(text);
  }
}
```

An awarded pack charges its displayed price once. Completions consume that pack’s independent input/output quota without another wallet charge.

The output cap includes both reasoning and visible answer tokens. Start with `max_tokens: 2048` when the qualified route and available prepaid quota support it; a larger cap improves answer headroom but does not guarantee a final answer. Check the route’s minimum/maximum output limits and available quota before calling. A smaller cap can be consumed entirely by reasoning, returning HTTP 200 with empty content and `finish_reason: "length"`; reported usage still settles and consumes quota. Inspect both `finish_reason` and nonempty text before treating the response as a usable answer.

Both token reservations must fit compatible prepaid quota; quotas cannot be combined across providers. Ordinary unused quota is non-refundable. Exhaustion requires an explicit new purchase, within the same grant budget. The client never buys automatically. It also never automatically repeats a completion to obtain a visible answer. After a settled empty or partial response, the caller may explicitly choose a new call with a larger supported cap and a new operation key; that call consumes additional quota. This differs from recovering a timeout or unknown outcome, which retains the original operation key.

`inference.quote({inputTokens, outputTokens})` returns expiring instant quotes without a financial commitment. An instant order additionally requires `mode: 'instant'` and the reviewed `quoteId`. Use `inference.packs({limit, cursor})` to inspect held and available quota, and `inference.receipt(requestId)` to inspect settlement. Provider methods are `provider.inference.offering()`, `updateOffering(input, {operationKey})` and `packs({limit, cursor})`.

This release supports buffered text messages only. Streaming, image/audio inputs and tool calls are not supported. The gateway base is `/api/v1`; generic OpenAI clients must send a fresh stable `Idempotency-Key` for each logical completion and disable automatic POST retries. Reusing a completed key returns `completed_without_result` with a receipt reference, not a stored transcript. After a timeout or unknown outcome, inspect its receipt; do not generate a replacement key to retry the same call. Prompts and completion transcripts are not retained for replay.

Use the receipt identifier rather than the HTTP correlation identifier when recovering:

```ts
import { BrokerError } from '@wick-cloud/broker-sdk';

try {
  await broker.inference.complete(input, { operationKey: 'task-completion-001' });
} catch (error) {
  if (!(error instanceof BrokerError) || !error.inferenceRequestId) throw error;
  const receipt = await broker.inference.receipt(error.inferenceRequestId);
  console.log(receipt.status);
}
```

If a transport timeout provides no receipt identifier, explicitly repeat the identical completion with its original operation key to recover the persisted identifier. The server never dispatches an existing invocation again. Do not replace the operation key to bypass a pending or completed result.

## Legacy scheduled VM compatibility

Version `0.4.0` removes scheduled VM workflows from current discovery. Deprecated SDK methods and historical types remain so existing integrations can read records, cancel unmatched capacity and honor already-approved funded bookings. New agreements, previews, scheduled drafts and supply changes return HTTP 410. Legacy billing and capacity records remain readable; this compatibility does not enable new scheduling.

## Persistent workspace disks (0.5.0)

`broker.disks.options()`, `list()`, `get(id)`, `workspaces(id)`, `create({name}, {operationKey})`, `rename(id, {name}, {operationKey})`, and `delete(id, {operationKey})` call the same owner-scoped Broker APIs. Disk creation/deletion are asynchronous. Poll `get(id)` for the current disk status. Pass `diskId` to `orders.create` to mount an owned ready disk when a new VM starts; disk-backed alternative intents carry `desired.diskId`. Buyer keys need the relevant `disks:read`, `disks:write` and `disks:use` scopes. Disks persist after VM termination. Real shared mounts require operator-qualified routes.
