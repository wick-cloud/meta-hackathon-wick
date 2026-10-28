# Four-provider live scale attempt — 2026-10-28

**Result: incomplete.** The first four canaries exposed a Blaxel terminal policy blocker. The remaining 16 allocations were not attempted, and this run does not establish a 15–20 VM scale or terminal pass across all four providers.

The live window was **13:26:53–13:30:52 America/Vancouver** (**20:26:53–20:30:52 UTC**). Wick used real managed compute; Muse remained in fixture mode. The Baseten marketplace account used native **Blaxel**, `provider-blaxel`.

## Observed canary results

The runner created one finite, 15-minute Micro VM per provider through the hosted Broker's normal 30-second auctions. Native creation and start evidence was confirmed for all four VMs.

| Marketplace provider | Native route / region | Native VM started | Broker ready | Wick advertised terminal | Interactive socket proof |
| --- | --- | --- | --- | --- | --- |
| E2B | `e2b` / `us` | Yes | Yes | `true` | Not run |
| Daytona | `daytona` / `us` | Yes | Yes | `true` | Not run |
| Baseten | `provider-blaxel` / `us-pdx-1` | Yes | No | `false` | Not run |
| Modal | `modal` / `auto` | Yes | Yes | `true` | Not run |

Peak Broker-running count was **3**. The aggregate canary gate waited for all four VMs to become ready before opening sockets, so **zero interactive terminal socket proofs** ran. The attempt stopped with `BOUNDED_WAIT_TIMEOUT`; no bulk wave followed.

Complete production logs showed Blaxel launching in approximately **22.6 seconds**. Its frozen `featureCapabilities` omitted `interactive-terminal`, and Wick returned `terminal: false`. That policy gate prevented readiness; no native Blaxel WebSocket handshake was tested.

## Cleanup

Cleanup obtained native termination acknowledgments for **all 4 test VMs**. Final reconciliation reported **zero pending or unknown resources**, and Broker provider holds returned to their **zero baseline**. These acknowledgments do not prove asynchronous physical data purge.

Exact receipts remain in the private journal. This report excludes resource identities, credentials, transcripts and raw logs, and makes no settlement or payment claim.

## Follow-up state

Broker now rejects offers whose explicit capability list omits `interactive-terminal`. The two Blaxel listings were temporarily unapproved and remain unavailable for new matches.

The [guard change](https://github.com/wick-cloud/meta-hackathon-wick/commit/b8e7f1d29e2dd3b39127d72428b58f87d7278c1d) is deployed on the [Railway app](https://meta-hackathon-wick-production.up.railway.app/). Health and catalog synchronization succeeded; E2B, Daytona and Modal remain approved. No Wick provider policy was changed.

The API key's staff inspection returned **403**. Refreshing the existing Google sign-in restored browser staff access. Read-only inspection confirmed that Blaxel revision 5 supports interactive terminals but has them disabled. An unsaved change enables terminals only for Broker's organization, on the configured Micro and Small shapes. Saving immediately replaces the current provider revision with a draft and pauses new Blaxel routing until the revision is enabled again. Production access-policy approval is pending; no Wick configuration has been saved. Existing VM authorization snapshots remain intact. A correction needs fresh canaries before bulk allocation. This live attempt covers Micro only; Small terminal behavior has not been live-verified here.

## Runner and verification boundary

The [hosted runner](../scripts/hosted-scale.ts) used SHA-256 `6fd34ef064b8e77253cb186af97fb50e9f75f3709683f26dbc1df321397e16d5`. Use reviewed private absolute `--settings` and `--journal` paths with `prepare`, independent `watchdog`, `run`, and recovery-only `cleanup` modes.

A successful rerun must:

1. Verify capacity and scope; count the four canaries within one cumulative 20-request ceiling.
2. Pass each canary's actual PTY and shell-state proofs before capacity-bounded cross-provider auction waves.
3. Observe 20 VMs running together, five per provider, with 20 authenticated terminals open for at least 30 seconds. Require decoded random output, fresh pongs and preserved state; report resize results explicitly.
4. Verify unique invoices against frozen prices and the 15% commission, then confirm exact-resource cleanup and baseline holds.

Separately, **2 hosted-runner safety tests**, **5 terminal-marker parser tests**, and TypeScript checks passed before this attempt. They cover post-intent stop fencing, exact cleanup during a Broker outage, and bounded output parsing that rejects command echo. These are offline results.

After the attempt, the runner was changed to prove each ready canary independently while retaining the all-four gate before bulk allocation. The updated source has SHA-256 `464a8ecbde1bed5f6e0a2e0a492ec37509c636d44f86d58279e5958c5f125637`. **116 offline tests across seven relevant suites passed**, including two new inert scenarios for early canary progress and the all-four gate. TypeScript checks passed. The deployed guard's production build passed. These changes do not add any live terminal proof to the failed attempt.

The earlier [20-VM E2B-only result](live-scale-results.md) has a different provider and deployment scope and does not complete this four-provider validation.
