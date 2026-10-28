# Explicitly authorized live scale validation

This runner allocates paid real Wick VMs only after the parent authorizes execution. The implementation and offline tests do not demonstrate live capacity or terminal success. Muse always remains explicitly `fixture`. No preview process or preview database is used, restarted, migrated, seeded, or reset by this runner.

The runner starts exactly one Broker process itself. Use a **fresh local PostgreSQL database** named, for example, `broker_scale_<unique_suffix>`. The selected database must have no existing users or requests and must differ from the private preview `DATABASE_URL`. A runner advisory lock and a peer-connection check reject competing applications. Never launch another Broker against this database: normal worker startup clears leases.

The parent must supply a reviewed managed configuration. Defaults pin Boat / small / auto and `boat:small:auto`; the runner will fail rather than choose a fallback. The real catalog is read dynamically, explicitly approved through the admin HTTP API, and a demo supplier allocation is created. This account does not represent an independent real provider. The fixed 15-minute quote uses the offering's frozen rate and configured markup. Invoices are unique, quote-matching records labeled **No payment due**; they do not assert settled Wick usage.

Prerequisites: Node 24, installed dependencies, local PostgreSQL, and the Linux `flock` executable (util-linux). Do not invoke `db:seed` or `seed:production`. Build output for review is `.verify-dist`, preserving the preview's existing `dist` files.

## Environment names

Supply values privately; never paste credentials into commands, reports, Git, or captured terminal output:

- `TEST_DATABASE_URL`, `SCALE_ISOLATED_DATABASE_NAME`
- `BETTER_AUTH_SECRET`
- `WICK_MODE` (`real`), `MUSE_MODE` (`fixture`)
- `WICK_API_KEY`, `WICK_ORGANIZATION_ID`, `WICK_GROUP_ID`
- `WICK_API_BASE` (optional; official API by default)
- `SCALE_APP_URL` (a loopback HTTP origin on an unused port other than 3000)
- `SCALE_JOURNAL` (a new absolute JSONL path inside `/home/user/wick-workspace/.broker-run/real-wick-20261028`)
- `SCALE_APPROVED_PROVIDER`, `SCALE_APPROVED_PROFILE`, `SCALE_APPROVED_REGION`, `SCALE_APPROVED_CATALOG_ID` (optional reviewed overrides)
- `BROKER_TARGET_MARKUP_BPS` (optional; application default 2000 means 20%)
- `SCALE_LIVE_APPROVED` (required **only** for `run`, literal `20-real-vms-15-minutes`)

`DATABASE_URL` may remain the private preview value; the runner compares it against `TEST_DATABASE_URL` and passes only the test URL into its app. Test passwords are generated in memory, hashed into the fresh test database, and never written to the journal. The watchdog requires the same scoped Wick credential and approval metadata, but it needs no buyer cookie or password.

## Review and launch commands

Run all commands from the repository. The parent creates the isolated database and supplies the environment first. The journal directory must already exist with private permissions. `prepare` writes only a private journal header and allocates nothing:

```bash
npx tsx scripts/live-scale.ts prepare
```

Launch the independent watchdog **before** `run`. This is a separate process, so it survives runner failure; do not put it in the runner's process group or kill it when the runner exits:

```bash
umask 077
setsid --fork node --import tsx scripts/live-scale.ts watchdog > "$SCALE_JOURNAL.watchdog.log" 2>&1 < /dev/null
```

The watchdog refreshes `$SCALE_JOURNAL.watchdog-ready`. The runner checks the matching run UUID, PID, freshness, and absence of a stop condition before admitting any new native create. A stale/absent watchdog fails closed. With explicit parent live authorization set:

```bash
npx tsx scripts/live-scale.ts run
```

The 10-minute admission deadline, bounded API timeouts, and native 900-second TTL limit the run. Every create uses the original persisted idempotency key and an exact private journaled body. A separate guard rejects the 21st distinct key even if Broker's global limit fails. Shared journal-backed `flock` pacing limits active native create starts to five per second. The stop, deadline, and watchdog checks run immediately after pacing and before every dispatch, including retries of previously started keys. A failure stops all create dispatches; there are no replacement allocations. Guard and receipt-write failures remain uncertain admissions and never authorize early hold release.

After a crash or unresolved exit, retain the test database and journal. Stop the runner (or wait for its heartbeat to expire), then run:

```bash
npx tsx scripts/live-scale.ts cleanup
```

Cleanup **never calls create**, including same-key replay. A durable intent or start record cannot prove the original request reached Wick. Create-result IDs are journaled only after name, organization, group, provider, profile, and creation-time ownership checks. Known IDs are checked against that same ownership evidence again before termination or accepting terminated status; an unrelated response never authorizes cleanup. Owned unexpected BYOK environments can still be terminated. Missing receipts are discovered only through the official SDK environment list, scoped to the approved organization/group/provider and unique run prefix, with at most three 50-item pages each for active and archived environments. A candidate must exactly match journaled name, organization, group, provider, profile and provider-key identity; its creation timestamp must fall between five seconds before intent and 120 seconds after the last recorded start (or intent if no start exists). Duplicate matches remain unresolved. No broad deletion is permitted.

Every intent is accounted for, even if a crash occurred before transport or no native ID was recorded. An absent match stays **UNKNOWN** with the finite 900-second native TTL as a backstop. Only exact-ID confirmed termination clears uncertainty; an empty list of recorded results cannot claim success. Cleanup reports unresolved keys/IDs only in the private journal. The independent cleanup command reports upstream termination separately from **unverified Broker hold release**; it does not start a second application or modify holds in SQL. If the app died, Broker hold release remains a parent-coordinated recovery blocker. **Never restart an unguarded real Broker (including ordinary `npm start`) against this test database**: pending jobs could allocate fresh keys. Any recovery process must stop open auctions and reject every create, including retries, before one isolated process/admin reconciliation checks hold release. Native TTL is never a claimed cleanup confirmation.

## What a successful run measures

1. One canary completes the real 30-second auction, reaches native running/terminal capability, and proves decoded output plus pong through an actual authenticated Broker WebSocket before the remaining 19 requests are submitted.
2. The other 19 requests use actual buyer/provider HTTP routes, valid manual frozen-price bids, and unchanged 30-second auction deadlines. No SQL deadline shortening is used.
3. The checkpoint observes 20 Broker VMs and 20 distinct upstream environments running. Twenty Broker terminal sockets use Cookie and exact Origin, require `ready` with mode `real`, decode output, acknowledge bytes, prove a bounded unique marker using an incremental ANSI-aware exact-line parser, and remain simultaneously open for at least 30 seconds. Unexpected closes fail the run after initial proof too; the final checkpoint requires fresh pongs and all 20 sockets still open. Shell transcripts are discarded.
4. While all 20 remain active, request 21 first proves supplier capacity rejection at 20. Capacity is then set to 21 through the provider API and a valid bid is accepted before its original deadline. Auction close must reject the global limit with no VM, no native create key, and no extra invoice.
5. Broker termination routes perform normal cleanup; native terminated state and zero provider holds are independently checked. The finally path and detached watchdog retain exact-resource fallback cleanup.

Private `$SCALE_JOURNAL.report.json` contains observed peak running/connections, hold duration, actual timestamps, nearest-rank p50/p95/max auction queue/provision/request-to-ready latency, quote/invoice checks, cleanup status, and the unchanged worker concurrency (close 2, auto-bid 4, provision 2, cleanup 2). It contains no native IDs or private organization metadata. The private journal necessarily retains exact create bodies and native IDs for recovery. Keep all sidecars outside Git. An interrupted or incomplete journal fails closed and requires inspection; unresolved resources are explicitly recorded.

Offline guard/cleanup regression command (zero real adapter calls):

```bash
npx vitest run tests/live-scale-safety.test.ts
```
