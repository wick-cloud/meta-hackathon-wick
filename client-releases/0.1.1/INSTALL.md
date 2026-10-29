# Wick Broker developer clients 0.1.1

These versioned client packages are available directly from Broker. No GitHub repository access or npm account is required to install them. Broker API keys are separate from Wick API keys.

Create a Broker key at https://meta-hackathon-wick-production.up.railway.app/keys. Choose buyer or provider permissions for that account. Secret values are shown once; keep them in your own secret store.

## Install all three packages

Run in your Node.js 22.12+ project:

```sh
npm install \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.1.1/wick-cloud-broker-sdk-0.1.1.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.1.1/wick-cloud-broker-cli-0.1.1.tgz \
  https://meta-hackathon-wick-production.up.railway.app/downloads/0.1.1/wick-cloud-broker-mcp-0.1.1.tgz

npx --no-install wick-broker auth login
npx --no-install wick-broker catalog list --json
```

Install all three tarballs together so their pinned local dependencies resolve before npm registry publication. The SDK can also be installed alone. The CLI accepts a hidden key prompt or stdin; never put the key in a command argument. WICK_BROKER_API_KEY and WICK_BROKER_API_URL are supported for secret-manager injection. WICK_API_KEY is never accepted.

## SDK

```ts
import { BrokerClient } from '@wick-cloud/broker-sdk';
const broker = new BrokerClient({
  baseUrl: 'https://meta-hackathon-wick-production.up.railway.app',
  apiKey: process.env.WICK_BROKER_API_KEY!,
});
console.log(await broker.orders.list({limit:25}));
```

## MCP

Configure your MCP host to launch `node` with the absolute path to this project's `node_modules/@wick-cloud/broker-mcp/dist/index.js`. It reads the same saved Broker profile or environment variables. The key never appears in tool arguments. stdout is reserved for MCP protocol messages.

This release supplies terminal access, not command-execution/file-transfer APIs or platform-run agents. Approval of scheduled capacity does not start VMs. Per-operation key limits are not aggregate spending budgets.

The API keys page provides the same SDK, CLI and MCP setup instructions.
API: https://meta-hackathon-wick-production.up.railway.app/api/openapi.json

Release 0.1.1 fixes SDK streamed cancellation and timeout reporting, oversized-response cleanup, and initial terminal dimension validation. The CLI preserves Unicode across input chunks and sends bounded terminal frames. MCP pins the updated SDK and CLI. SHA256SUMS records the package checksums.
