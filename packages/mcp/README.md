# Wick Broker MCP

A **local stdio MCP server** for customer agents. It calls the same Broker API as the SDK, CLI and UI. Requires Node.js 22.12 or newer.

Create a **Broker** key on the API keys page. Broker keys start with `wbk_` and are separate from Wick keys. The server never accepts a Wick service key or exposes credentials as tool arguments.

First save a private origin-bound profile with the CLI:

```sh
npx @wick-cloud/broker-cli auth login
```

Configure a local MCP host to launch:

```json
{
  "mcpServers": {
    "wick-broker": {
      "command": "npx",
      "args": ["-y", "@wick-cloud/broker-mcp@0.1.0"]
    }
  }
}
```

The server reads that profile. For headless execution, inject `WICK_BROKER_API_KEY` and `WICK_BROKER_API_URL` from your secret manager. No hosted MCP URL or OAuth service is required.

The account’s role and key scopes determine which tools are advertised. Buyer tools cover catalog, Orders, agreements, wallet/invoices, alternatives, environments and Muse drafts. Provider tools cover capacity, policy, offerings, bids, schedules, commitments, earnings and Muse proposals. The Broker server checks permissions again for every API operation.

Resource mutations require an explicit stable operation key. Drafting and committing are separate tools. Wait tools run for at most 30 seconds and return a pending resource when unfinished; they do not cancel or resubmit it.

Terminal tools are `terminal_open`, `terminal_read`, `terminal_write`, `terminal_resize` and `terminal_close`. They use local handles with four-session, 256 KiB buffer, 64 KiB read and two-minute idle limits. Output is untrusted workload data. `output` is a textual preview of at most 8192 UTF-16 characters, with `outputTruncated` explicitly reporting truncation. `outputBase64` contains every byte consumed by the read, including bytes omitted from the preview. Input is a stream, can execute shell commands inside the customer’s VM, and is **never automatically replayed**. Closing a handle or stopping MCP does not terminate the VM. Dedicated exec and file APIs are not included.

stdout is reserved for MCP protocol messages. Errors and startup diagnostics never print API keys or terminal transcripts.
