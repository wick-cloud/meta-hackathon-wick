# Broker SDK, CLI and MCP — production validation

On **October 29, 2026, 11:29–11:32 PDT (UTC−07:00)**, three bounded customer journeys passed against the [production Broker app](https://meta-hackathon-wick-production.up.railway.app/).

- Run interval: `2026-10-29T18:29:40.929Z`–`2026-10-29T18:32:04.594Z`.
- Deployed source: [`70ffbe40967ae1fd0a002acfe276cc94d6b76a8e`](https://github.com/wick-cloud/meta-hackathon-wick/commit/70ffbe40967ae1fd0a002acfe276cc94d6b76a8e).
- The Railway deployment identifier and account-owned resource links are retained in the private run journal; public evidence is tied to the source commit above.
- Downloaded and independently installed packages: `@wick-cloud/broker-sdk`, `@wick-cloud/broker-cli` and `@wick-cloud/broker-mcp`, each **0.1.0**.
- Client runtime: Node.js **24.7.0**; the interactive CLI ran through a local macOS PTY.
- Infrastructure mode: **real**. These were actual customer orders, provider bids, native environments and terminal connections.

## Results

Each client placed one 30-second auction for a **15-minute Micro environment, 1 vCPU and 2 GB RAM**. Each exact replay returned the original order, leaving **one logical order and one environment per client**.

| Client | Real bids | Winner  | Accepted quote | Logical orders | VMs |
| ------ | --------- | ------- | -------------- | -------------- | --- |
| SDK    | 3         | Daytona | $0.05          | 1              | 1   |
| CLI    | 3         | E2B     | $0.05          | 1              | 1   |
| MCP    | 3         | E2B     | $0.05          | 1              | 1   |

Every auction received non-simulated automatic bids from **Daytona ($0.05), E2B ($0.05) and Modal ($0.08)**. Accepted quotes stayed within the reviewed buyer ceiling. The orders were visible through the shared UI history with Broker API-key attribution.

### Terminal checks

- **SDK:** real VM readiness receipt, split `printf` markers and `uname -s` confirmed a Linux shell. `stty size` confirmed **37 rows × 111 columns** after resize. Output was acknowledged after consumption, and the terminal was closed. The SDK order-to-proof journey took 38.145 seconds, including 2.108 seconds for terminal validation.
- **CLI:** a real interactive PTY confirmed the shell marker and Linux kernel. Resize was reflected as **39 rows × 117 columns**. Detach exited successfully, and both TTY flags and the complete local termios state were restored.
- **MCP:** the local stdio server placed and replayed the order, waited for readiness, opened the terminal, wrote the proof once, read the Linux result, resized and closed the terminal. The VM remained running after terminal close, before controller-owned cleanup.
- MCP emitted **17 JSON-RPC messages** with no non-protocol stdout and **zero stderr bytes**. Credential-absence checks passed for the captured transport.

The proof commands were limited to harmless shell markers, kernel identification and terminal-size inspection. Broker did not launch customer agents, inspect repositories or run retained workloads.

## Quote and invoice records

The three accepted quotes and invoice records totaled **$0.15**, with **$0 added buyer fees**.

Each $0.05 record preserved the exact provider revenue split:

| Record field        | Value per VM                                      |
| ------------------- | ------------------------------------------------- |
| Gross rental        | $0.05                                             |
| Broker provider fee | 15% = $0.0075 (`7500` micro-USD)                  |
| Provider share      | $0.0425 (`42500` micro-USD), before compute costs |

These are accepted quotes and Broker invoice records. They do not establish external payment collection, provider payouts or the final native compute charge.

## Cleanup and credential lifecycle

All three owned test VMs reached `terminated` with confirmed Broker cleanup:

| Client | `cleanupConfirmedAt` (UTC) |
| ------ | -------------------------- |
| SDK    | `2026-10-29T18:30:24.492Z` |
| CLI    | `2026-10-29T18:31:16.482Z` |
| MCP    | `2026-10-29T18:32:02.495Z` |

The controller reconciled native termination acknowledgments and confirmed **zero active VMs owned by this run**. An acknowledgment confirms the provider accepted termination; it does not prove asynchronous physical erasure.

The temporary **Broker** API key was revoked, and a subsequent authenticated request returned **HTTP 401**. The private authentication file was deleted and the cleanup watchdog exited. No key, cookie, native credential or terminal transcript is included in this report.

## Evidence boundaries

- Live bid coverage includes **Daytona, E2B and Modal**. Actual VM and terminal coverage in this run includes **Daytona and E2B**; Modal did not win an allocation.
- This is not four-provider validation, a concurrency benchmark or evidence for Blaxel/Baseten allocations.
- The release exposes terminal access only. It has no customer command-execution or file-transfer API.
- The prior **562 fixture tests and 33 passing browser checks** (with four environment-dependent skips) validated the exact deployed source tree separately. They are not counted as additional live provider checks.
- The production probe completed with **zero recorded failures**. An independent cleanup watchdog was armed as a backstop; forced watchdog recovery was not exercised.

For setup, scopes and client examples, see [developer access](developer-access.md).
