# Four-provider live validation — 2026-10-28–29 UTC

**Final result: 20-VM compute PASS; 15 maintained terminals PASS; full four-provider terminal overlap FAIL.** The final cohort reached **20 unique native Micro VMs running together**, five per provider. E2B, Daytona and Modal maintained **15 real PTY/state/cwd/resize proofs for 31.092 seconds**, including fresh final proofs. Blaxel's diagnostic sockets were deliberately closed after their initial outcomes; no maintained Blaxel overlap was validated.

| Provider | Concurrent Micro VMs | Terminals validated through the maintained overlap | Terminal result |
| --- | --- | --- | --- |
| E2B | 5 | 5 | PTY, state/cwd and resize passed; fresh final proofs. |
| Daytona | 5 | 5 | PTY, state/cwd and resize passed; fresh final proofs. |
| Modal | 5 | 5 | PTY, state/cwd and resize passed; fresh final proofs. |
| Baseten / Blaxel | 5 | 0 | 3 initial diagnostics passed and were deliberately closed; 1 T0 and 1 T1 diagnostic failed. |
| Total | **20** | **15** | **No four-provider terminal-overlap pass.** |

The final runner reported `computeValidationPassed: true`, `validationPassed: false` and `passed: false`, with `ALL_PROVIDER_TERMINAL_OVERLAP_NOT_VALIDATED`. All **20 native termination acknowledgments** were confirmed, all **20 Broker VMs were terminated**, and final reconciliation found **zero unknown/pending resources and zero held capacity**. Termination acceptance does not establish physical purge. Earlier failed attempts remain documented below.

The first live window was **13:26:53–13:30:52 America/Vancouver** (**20:26:53–20:30:52 UTC**). Wick used real managed compute; Muse remained in fixture mode. The Baseten marketplace account used native **Blaxel**, `provider-blaxel`.

## First run: observed canary results

The runner created one finite, 15-minute Micro VM per provider through the hosted Broker's normal 30-second auctions. Native creation and start evidence was confirmed for all four VMs.

| Marketplace provider | Native route / region | Native VM started | Broker ready | Wick advertised terminal | Interactive socket proof |
| --- | --- | --- | --- | --- | --- |
| E2B | `e2b` / `us` | Yes | Yes | `true` | Not run |
| Daytona | `daytona` / `us` | Yes | Yes | `true` | Not run |
| Baseten | `provider-blaxel` / `us-pdx-1` | Yes | No | `false` | Not run |
| Modal | `modal` / `auto` | Yes | Yes | `true` | Not run |

Peak Broker-running count was **3**. The aggregate canary gate waited for all four VMs to become ready before opening sockets, so **zero interactive terminal socket proofs** ran. The attempt stopped with `BOUNDED_WAIT_TIMEOUT`; no bulk wave followed.

Complete production logs showed Blaxel launching in approximately **22.6 seconds**. Its frozen `featureCapabilities` omitted `interactive-terminal`, and Wick returned `terminal: false`. That policy gate prevented readiness; no native Blaxel WebSocket handshake was tested.

## First run: cleanup

Cleanup obtained native termination acknowledgments for **all 4 test VMs**. Final reconciliation reported **zero pending or unknown resources**, and Broker provider holds returned to their **zero baseline**. These acknowledgments do not prove asynchronous physical data purge.

Exact receipts remain in the private journal. This report excludes resource identities, credentials, transcripts and raw logs, and makes no settlement or payment claim.

## Follow-up state

Broker now rejects offers whose explicit capability list omits `interactive-terminal`. The two Blaxel listings were temporarily unapproved during investigation.

The [guard change](https://github.com/wick-cloud/meta-hackathon-wick/commit/b8e7f1d29e2dd3b39127d72428b58f87d7278c1d) is deployed on the [Railway app](https://meta-hackathon-wick-production.up.railway.app/). Health and catalog synchronization succeeded.

The API key's staff inspection returned **403**. Refreshing the existing Google sign-in restored browser staff access. Read-only inspection confirmed that Blaxel revision 5 supports interactive terminals but had them disabled. With user approval, revision **6** was saved and routing re-enabled. The only saved changes were enabling `interactive-terminal` and restricting that feature to Broker's organization. UI round-trip comparison confirmed all other fields unchanged, including profiles, prices, settings and other feature policies. Existing VM authorization snapshots remain intact.

Fresh customer catalog and managed execution previews in Broker's exact organization and group advertised terminals for all four Micro providers at unchanged rates, with no fallback, BYOK or external-compute route. Both Blaxel listings were re-approved.

## Second run: four canaries, no bulk allocation

The retry used an independent cleanup watchdog and made **4 allocation attempts**, counted within its 20-request ceiling. All four native VMs started.

| Provider | Terminal evidence |
| --- | --- |
| E2B | T0/T1 PTY, shell state, working-directory persistence and resize proofs succeeded. |
| Daytona | T0/T1 PTY, shell state, working-directory persistence and resize proofs succeeded. |
| Baseten / Blaxel | Broker and native VM running; frozen terminal capability was `true`. No T0 proof arrived within 35 seconds. |
| Modal | Native VM started; no terminal socket opened because its readiness subgroup remained blocked behind Blaxel's proof. |

The retry ended with `BOUNDED_WAIT_TIMEOUT`; the remaining 16 requests were not attempted. Complete scoped production logs showed Blaxel launch in approximately **23 seconds**, session creation returning **HTTP 201 in about 80 ms**, and cleanup in approximately **1.15 seconds**. A successful session response is not an interactive shell proof.

Cleanup obtained native termination acknowledgments for **all 4 retry VMs**, with **zero pending or unknown resources** and provider holds at their **zero baseline**. These acknowledgments do not prove physical purge. The original run's four attempts, zero socket proofs and cleanup above remain separate evidence.

## Third run: newline-framed canaries

An offline fixture using the [terminal proof parser](../scripts/live-scale/terminal-proof.ts) reproduced a false negative when an unterminated prompt prefixes a successfully printed marker. The third four-canary attempt added leading newlines while retaining exact-line and command-echo rejection checks. It still stopped at Blaxel's proof wait, with no bulk wave.

E2B and Daytona passed T0/T1, persistent shell-state and resize proofs. Blaxel's gateway reported ready; the runner sent one T0 input frame and observed an open socket and pong. **116 output bytes** arrived, but no T0 proof. Leading-newline framing did not resolve the live failure in this cohort. Modal terminal behavior was not established by this cohort. Native termination acknowledgments were confirmed for **all 4 canaries**; no 20-VM overlap was attempted.

## Focused one-VM diagnostics

Each diagnostic used one fresh owned Micro VM and remained separate from the canary and scale cohorts.

| Diagnostic | Observed terminal evidence | Cleanup |
| --- | --- | --- |
| Blaxel, initial diagnostic | Immediate phase A produced no markers. Phase B, sent 5 seconds after initial output, passed stdin/stdout TTY, export and working-directory markers. After resize, C's begin and persistent-state markers were absent while its resize and end markers arrived. CR worked for B/C; no LF flush was needed. | Native termination acknowledgment confirmed. |
| Modal | Immediate input, stdin/stdout TTY, persistent shell state, working directory and resize proofs passed. | Native termination acknowledgment confirmed. |

These partial Blaxel observations did not distinguish unexecuted input from missing output. Native protocol source review found no input/resize contract mismatch. The [pinned native session manager](https://github.com/blaxel-ai/sandbox/blob/b24ad755c4ff8c5c86cfce928a312e17e7ed1881/sandbox-api/src/handler/terminal/session_manager.go#L198-L211) has a silent-drop path when a subscriber's 64-chunk queue fills, but neither queue overflow nor the exact deployed native implementation has been established as the live cause.

## Blaxel receipt corroboration diagnostic

The [focused diagnostic](../scripts/hosted-terminal-diagnostic.ts) exclusively prepared one private receipt file on the verified owned VM before opening its terminal. Each phase captured descriptor flags before file redirection and appended entry, print-return-status and completion records. After terminal markers were missing, the runner rechecked the exact native environment identity and independently read only that file through Wick HTTPS, with **8 KiB response** and **4 KiB content** limits. File evidence could not replace the original stdout gates.

| Phase | Terminal output | Independent file evidence |
| --- | --- | --- |
| A | All phase markers and stdin/stdout TTY checks passed. | No additional claim needed for this observed output. |
| B | No B markers arrived, including substring matches. The run stopped with `SECOND_PROBE_TIMEOUT`. | Phase completed; stdin/stdout TTY flags were both `1`, export and working-directory actions both returned success, and all **6 marker-print commands returned 0**. |
| C | Not attempted. | Not attempted. |

The reported aggregate validation, full-PTY and immediate-readiness pass flags were all **false** because the diagnostic ended before final acceptance. Phase A's observed success remains distinct from those aggregate flags.

The stream contained **683 bytes**; the private capped capture retained **656 bytes** and was not truncated. No shell-error or non-TTY indication was observed. The independent B receipts corroborate execution and successful stdout writes without the corresponding markers reaching the observed terminal stream. They do not locate where bytes were lost or filtered, or establish the native queue as the cause. This diagnostic remains a **terminal validation failure**, not a pass inferred from a file.

Cleanup confirmed the **one VM's native termination acknowledgment**, **zero unknown or pending resources** and provider holds at **zero**, at **2026-10-28 23:25:26 UTC** (**16:25:26 America/Vancouver**). This acknowledgment does not prove physical purge.

## 20-VM collection attempt: aborted at 12 simultaneous VMs

The collection run started **2026-10-28 21:43 America/Vancouver** (**2026-10-29 04:43 UTC**), targeting **20 simultaneous Micro VMs, five per provider**, with an independent cleanup watchdog. It made **16 request attempts** and reached a peak of **12 simultaneous native VMs**. Four requests were canceled before VM creation; the remaining four target requests were not attempted.

| Provider | Native VMs reached | Initial terminal proofs | Still-open sockets with earlier proof at abort |
| --- | --- | --- | --- |
| E2B | 5 | 5 | 5 |
| Daytona | 1 | 1 | 1 |
| Modal | 1 | 1 | 1 |
| Baseten / Blaxel | 5 | 3 | 2 |
| Total | **12** | **10** | **9** |

Two Blaxel terminals failed T0. A third Blaxel terminal that had passed its initial proof subsequently emitted an error and closed at approximately **60 seconds**, before its refresh. The runner stopped with **`TERMINAL_ENDED`**; `computeValidationPassed` and the overall result were **false**. Earlier proofs and open sockets do not establish a final 30-second terminal overlap. The run did not reach 20-VM overlap or final 20-invoice/commission verification.

Cleanup confirmed native termination acknowledgments for **all 12 VMs**, with **zero unknown or pending resources** and provider holds at **zero**, at **2026-10-29 04:48:30 UTC** (**2026-10-28 21:48:30 America/Vancouver**). Acknowledgments do not prove physical purge.

A scoped AWS log retrieval for this aborted attempt failed with **`aws_read_failed`** and was incomplete. Missing events from that failed retrieval cannot establish an absence of API, worker or provider errors. That terminal closure's cause remains unproven.

## Final focused run: 20 compute / 15 maintained terminals

The final run used **finite, 15-minute Micro VMs** and a fresh prepared policy, `compute-with-blaxel-diagnostics`. Its window was **2026-10-29 04:56:04–05:05:59 UTC** (**2026-10-28 21:56:04–22:05:59 America/Vancouver**). Requests ran in **waves of at most four**, beginning with **four provider-pinned canaries** followed by **16 cross-provider matchmaking requests**. There were **20 request attempts, 20 unique native VMs and a peak of 20 running simultaneously**, distributed five per provider.

All **15 E2B/Daytona/Modal terminals** passed real PTY, persistent shell-state, working-directory and resize proofs through a **31,092 ms** maintained interval and fresh final challenges. There were **15 resize proofs and zero resize-unavailable results**. Blaxel recorded **three actual initial passes**, then deliberately closed those diagnostic sockets; the other two diagnostics failed **T0 once and T1 once**. Its maintained-overlap proof count was **zero**. Known failures and intentional closures were recorded separately; the full four-provider terminal result stayed **false**.

All **20 application demo invoices** matched their frozen winning quotes and the configured **15% provider commission calculation**; buyer fees were **zero**. This verifies invoice calculations only; no payment settlement or provider payout is established.

Observed request-to-ready times for this one cohort were **p50 40.704 s, p95 87.375 s and maximum 100.375 s**. These intervals include the **30-second auctions** and describe only this cohort.

Final reconciliation at **2026-10-29 05:06:21 UTC** (**2026-10-28 22:06:21 America/Vancouver**) confirmed **20 native termination acknowledgments**, **20 terminated Broker VMs**, `unknown: 0`, `pending: 0` and `holdsReleased: true`. These acknowledgments do not prove asynchronous physical purge.

The [public commit](https://github.com/wick-cloud/meta-hackathon-wick/commit/58967bcb20865d0f5df9e378911678c17abc3207) changes only the controller and tests. Before launch, **45 focused offline tests passed**, including **12 collection-policy tests**, plus fresh compilation, TypeScript, formatting and diff checks. These checks do not establish a live result. Run artifact fingerprints:

- Public controller source SHA-256: `90aff2781789615e08e2c60e8202584d0bb315736c14e6417a73dd7252372715`.
- Compiled controller SHA-256: `ff33b98acd526bc760b68df983f8fb8a63f8645be415af5d9ae93c01e4bdd8c7`.

## Current availability and verification boundaries

Both Broker **Blaxel Micro and Small listings are now paused** (`approved: false`). **E2B, Daytona and Modal remain available; their Micro profiles were verified here.** Other approved profiles remain live-unverified in this exercise. Each of the four provider dashboards shows **total 5, held 0, available 5**; the admin unresolved count is **zero**. Health reports **Wick real / Muse fixture**.

Wick's approved organization-restricted revision 6 policy is unchanged. A private readiness-hardening proposal has passed local checks but remains **undeployed and unproven as a fix for the live failure**. No private Wick source, credentials, resource identities or terminal transcripts are included here.

The policy covers the configured Micro and Small shapes, but this live exercise tests **Micro only**. Small terminal behavior remains live-unverified.

## Runner and verification boundary

For the first run, the [hosted runner](../scripts/hosted-scale.ts) used SHA-256 `6fd34ef064b8e77253cb186af97fb50e9f75f3709683f26dbc1df321397e16d5`. Use reviewed private absolute `--settings` and `--journal` paths with `prepare`, independent `watchdog`, `run`, and recovery-only `cleanup` modes.

Full four-provider acceptance requires:

1. Verify capacity and scope; count the four canaries within one cumulative 20-request ceiling.
2. Pass each canary's actual PTY and shell-state proofs before capacity-bounded cross-provider auction waves.
3. Observe 20 VMs running together, five per provider, with 20 authenticated terminals open for at least 30 seconds. Require decoded random output, fresh pongs and preserved state; report resize results explicitly.
4. Verify unique invoices against frozen prices and the 15% commission, then confirm exact-resource cleanup and baseline holds.

Separately, **2 hosted-runner safety tests**, **5 terminal-marker parser tests**, and TypeScript checks passed before the first attempt. They cover post-intent stop fencing, exact cleanup during a Broker outage, and bounded output parsing that rejects command echo. These are offline results.

After the first attempt, the runner was changed to prove each ready canary independently while retaining the all-four gate before bulk allocation. That updated source has SHA-256 `464a8ecbde1bed5f6e0a2e0a492ec37509c636d44f86d58279e5958c5f125637`. **116 offline tests across seven relevant suites passed**, including two new inert scenarios for early canary progress and the all-four gate. TypeScript checks passed. The deployed guard's production build passed. These changes do not add any live terminal proof to the first failed attempt.

The receipt diagnostic subsequently passed **25 offline tests across three diagnostic/safety/parser suites**, TypeScript, formatting and diff checks, plus local generated-shell syntax and receipt-append checks. Its public source SHA-256 is `bfbc2c1078bd8cfb9e1cfd1e27e4e0ed19042e4bb5fbef22281cd4f611cb7140`. Separately, the earlier collection policy passed **6 offline tests**. Local fixture results remain separate from the live outcomes above and do not certify native terminal delivery.

The earlier [20-VM E2B-only result](live-scale-results.md) has a different provider and deployment scope and does not complete this four-provider validation.
