# Wick Broker clients 0.5.0

Install these public client archives in a Node.js 22.12+ project. They contain no private Wick source or upstream credentials. Earlier `0.1.0`, `0.1.1`, `0.2.0`, `0.3.0` and `0.4.0` downloads remain immutable.

```sh
npm install \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-sdk-0.5.0.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-cli-0.5.0.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.5.0/wick-cloud-broker-mcp-0.5.0.tgz
```

Install all three together so their pinned dependencies resolve locally before npm registry publication. The SDK can also be installed alone. The download server verifies the published sizes and SHA-256 digests; inspect `SHA256SUMS` and `manifest.json` in this release directory. URLs become available when the Broker version containing this release is deployed.

Create ordinary buyer/provider keys in **API keys**, or create an owner-funded agent in **Agents** and issue its grant-bound key. Store keys in your secret manager, `WICK_BROKER_API_KEY`, or the CLI's hidden authentication prompt. Broker keys start with `wbk_`; Wick infrastructure keys are never accepted. An agent key cannot buy VMs, increase its budget, issue keys or call internal Muse proposal helpers.

```sh
npx --no-install wick-broker auth login
npx --no-install wick-broker inference models --json
npx --no-install wick-broker inference grant --json
```

```ts
import { BrokerClient } from '@wick-cloud/broker-sdk';

const broker = new BrokerClient({
  baseUrl: process.env.WICK_BROKER_API_URL!,
  apiKey: process.env.WICK_BROKER_API_KEY!,
});
const order = await broker.inference.orders.create(
  {
    mode: 'auction',
    inputTokens: 2000000,
    outputTokens: 512,
    maxTotalCents: 1000,
  },
  { operationKey: 'task-001-token-purchase-001' },
);
console.log(await broker.inference.orders.wait(order.id));
// Inspect purchase outcome before consuming its prepaid allowance.
```

The gateway is at `/api/v1`, with canonical model `meta/muse-spark-open`. V1 supports buffered text chat only, explicit `max_tokens` including reasoning, one choice, and no tools, images or streaming. Generic OpenAI clients must send a stable `Idempotency-Key` for each logical request and disable automatic POST retries. Purchases debit the funded grant once; calls consume bought input/output quota without a second money charge. An unknown generation keeps quota held. `BrokerError.inferenceRequestId` identifies its receipt; `requestId` is HTTP correlation. Completed replays return a receipt reference and never regenerate/store the transcript. After a transport timeout, reuse the identical request and operation key to discover the receipt, never a new key for replacement work.

For MCP, configure `node` with the absolute path to the installed `node_modules/@wick-cloud/broker-mcp/dist/index.js`. It reads the same origin-bound CLI profile or Broker environment variables. Only permitted tools are advertised, and stdout is reserved for MCP protocol messages. Current CLI/MCP commands cover VM auctions, AI token purchases and the related provider controls; retired scheduled VM tools are not advertised. Deprecated SDK methods retain access to historical records and already-approved funded bookings, while new scheduled agreements, previews, drafts and supply changes return HTTP 410. VM terminals remain available to appropriately scoped keys.

Inference defaults off. Fixture mode is explicitly simulated. Real Modal/Baseten purchases remain blocked until native endpoint identity, usage, reasoning and accounting bounds are qualified. Ordinary unused/expired prepaid quota is non-refundable; verified provider failure follows the documented reconciliation/refund policy. The provider fee is 15%, with no separate buyer fee. Payment collection and payouts are separate.

Money fields keep cents as their unit and accept hundredths of a cent: `$1.2345` is `123.45` cents; `$0.0001` is `0.01` cents. The SDK, CLI and MCP preserve fractional values. Token counts and resource quantities remain integers. Buyer-facing prices display up to four USD decimals; exact 15% provider fees remain stored in micro-USD. Existing purchases retain their frozen terms.

New token orders require at least $0.01 in total. Four-decimal USD amounts above that floor and finer credit/fee accounting remain supported. Compatible prepaid packs in one grant/provider/accounting contract can supply a call together; batch-scoped keys remain restricted to their own batch.

## Persistent disks

This release adds private shared disk management and optional `diskId` on VM requests. Use `disks options`, `disks list`, `disks create`, `disks get`, `disks workspaces`, `disks rename` and `disks delete`. SDK methods live under `broker.disks`; MCP tools use the `disk_` prefix. Buyer keys need the relevant `disks:read`, `disks:write` and `disks:use` scopes. Mutations require stable operation keys. Creation/deletion are asynchronous; inspect disk status for confirmation.

Disk bytes persist after VM cleanup. A disk is attached when a new VM starts; multiple qualified provider VMs may share it. Real support defaults off until native shared mounts are qualified on two provider routes. Studio continuation is available in the authenticated owner UI. No whole-machine persistence, hot attachment, storage-price tiers, or new inference-agent authority is implied.
