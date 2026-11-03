# Homepage hackathon demo

The homepage provides one sponsored, anonymous journey: a real Baseten token
auction, a real Modal Micro compute auction, and a live terminal with a small
Python example. Judges do not need an account, payment details, Wick credentials,
or a Baseten service key. Both auctions retain their normal 30-second deadlines.
Each has exactly one eligible provider, disclosed in the interface. A missing
valid bid ends that attempt; the demo never invents competing bids or silently
switches provider or VM size.

## Judge experience

1. Open the public homepage and select **Try live demo**.
2. Watch the token and compute bids, countdowns, and award receipts on the page.
3. Once the VM and script are ready, issue and copy the demo token key.
4. Connect the browser terminal and run `python3 /workspace/hello_muse.py`.
5. Paste the key at the hidden prompt. The Python script calls the Broker's
   OpenAI-compatible gateway, which redeems the Baseten pack for Muse Spark Open.
6. Read the real response and usage, then select **End demo**. Reconnection uses
   the same VM. Closing the browser does not stop its lease or extend it.

The key remains in browser memory only, and the script uses `getpass` without
writing it to disk, shell history, or command arguments. Reloading the page may
require replacing the key; replacing it revokes the old key and preserves the
same remaining quota and request limit. Each run allows at most five key issuance
attempts. Requests with unknown upstream outcomes
retain their reservations and cannot be automatically retried.

## Fixed demo policy

| Resource          | Limit                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Compute           | Exact `modal:micro:auto`, 15-minute lease including setup, maximum $0.25 auction price       |
| Tokens            | Baseten only, 5,000 input / 2,048 output, maximum $0.05 purchase                             |
| Model requests    | At most two accepted attempts per run; at most 1,024 output tokens per request               |
| Disk              | One private disk per run, preloaded with `hello_muse.py` and instructions                    |
| Next run          | Both resources unlock 20 minutes after confirmed VM cleanup; pending cleanup remains blocked |
| Concurrent runs   | At most two globally, and one per anonymous identity or observed client IP                   |
| Daily sponsorship | $5 per America/New_York calendar day; reserve $0.50 per admitted run                         |

The conservative $0.50 reservation covers the compute and token purchase
ceilings plus $0.20 reserved for disk/operational overhead. Once a run attempts
resource work, its reservation remains counted for that day. It is a sponsorship
admission ceiling, not a measurement of upstream invoices. Operators must verify
the native route/storage costs against the reserve before public enablement and
retain their upstream account spending controls.

The anonymous cookie is opaque, HttpOnly and SameSite=Strict (Secure in
production). It authorizes only this demo and its own terminal, never the normal
buyer, Studio, provider, admin, funding, or general API-key workflows. Ordinary
signup remains disabled. Each visitor receives a distinct internal owner, and
each run has its own VM, disk, token grant and purchase receipts.

The server also enforces the cooldown against a keyed digest of the observed
client IP, so clearing cookies does not reset that IP's allowance. Visitors on a
shared network share that restriction. Raw IP addresses are not stored in demo
records. IP changes cannot bypass the global concurrency or daily sponsorship
ceiling. Repeated clicks, parallel tabs and retries cannot create extra resources
for an admitted run.

## Operator setup

Enable `LIVE_DEMO_ENABLED=true` only after deployment and qualification. Keep
`WICK_MODE=real`, `MUSE_MODE=real`, `INFERENCE_MARKET_MODE=real`, and
`DISKS_ENABLED=true`. Configure the existing server-only Wick/Baseten credentials,
an unexpired Baseten request-sized inference accounting certificate, published
automatic-bid token supply, and approved Modal Micro compute supply with a valid
current rate. Its fixed demo ceilings must cover the published offers. The
existing disk qualification requirements also apply.

For Railway's public HTTP edge, use the already-supported
`AUTH_TRUST_RAILWAY_PROXY=true` so abuse limits use the edge's sanitized
`X-Real-IP`. Do not enable that trust on unsanitized private/TCP ingress. Without
that setting the demo uses the direct socket address, ignoring arbitrary
forwarding chains.

No provider credential enters the browser or the demo disk. The service performs
one fixed, bounded script bootstrap in the allocated VM and verifies it before
exposing the terminal. It does not expose a public arbitrary-command API.

The durable demo worker reconciles auctions, provisioning, bootstrap, expiry,
key revocation, grant closure, VM cleanup and disk deletion after process
restarts. It deletes the disk only after confirmed detachment. Unknown native
outcomes remain blocked rather than releasing their global capacity early.
Turning off the feature blocks new admissions and key/terminal access while
cleanup continues.

## Verification and release gate

Offline checks use disposable PostgreSQL schemas and explicit fixture adapters.
They must remain labeled simulations; they do not prove provider availability.
The regression suite covers admission races, cooldown and daily reset,
cross-visitor isolation, cookie/header manipulation, fixed providers and limits,
key replacement, model-request concurrency, and cleanup recovery. Browser checks
cover the homepage at desktop and narrow mobile widths.

Before public enablement, complete one bounded live journey on the deployed
release: both actual auctions select the intended providers; Modal Micro mounts
the private disk; the preloaded Python script produces a real Baseten/Muse
response; quota and receipts update; and ending the demo confirms VM termination,
key rejection, disk deletion, and the paired cooldown. Include the homepage URL
and these judge instructions alongside the public GitHub repo and demo video.
