# Muse integration

Wick Broker uses Meta's `muse-wonder-1.0` through the server-side Chat Completions API. Set `MUSE_MODE=real`, `META_API_KEY`, and optionally `META_API_BASE` (default `https://api.meta.ai/v1`). Keys and the upstream URL are never accepted from a browser. An explicitly selected `MUSE_MODE=fixture` uses deterministic demo rules and every receipt says that no Meta model call was made. Failure in real mode never switches to fixture mode.

## Three bounded uses

1. `POST /api/muse/translate` accepts a buyer's environment description and returns an editable proposal with approved catalog ID, region, exact duration, CPU, memory and optional GPU requirements. It does not create an auction or VM. Explicit numeric resources and rental duration are checked independently of the model; GPU aliases normalize to the selected catalog's exact GPU label.
2. `ctx.muse.proposeBid` considers one supplier's own capacity and private pricing policy, plus the immutable request and approved configuration. It proposes a fixed total price in integer USD cents or declines. Deterministic ineligibility can decline without calling Meta. Manual and automatic submission still run through the marketplace's atomic capacity-hold path; a proposal itself reserves nothing.
3. `POST /api/provider/offerings/propose` obtains the authenticated supplier's policy and aggregates the latest 200 recorded `no_offers` requests into at most 40 resource/region/duration groups. It proposes at most three existing administrator-approved configurations that match those groups. The supplier must review and publish using the ordinary offering controls. Nothing creates a configuration, setup script, preparation job or customer workload.

Receipts are deterministic observed facts, the validated decision and enforced constraints. They do not expose hidden reasoning. Manual controls remain available after model failures.

## Contract and validation

Each call is one `POST /v1/chat/completions`, with no retries, no tools, a 1,600 completion-token ceiling, an eight-second deadline (including response body consumption), a 64 KiB response limit and at most six concurrent calls per process. Interactive translation/offering routes share a ten-request-per-minute per-user limiter. The auction worker is independently bounded by its durable-job lifecycle. HTTP failures, refusals, truncated completions, invalid JSON, invalid schemas and domain violations are visible errors.

All three request schemas use `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`. Every object has `additionalProperties: false` and every property is required; nullable fields express the documented strict subset. The adapter reads the JSON string from `choices[0].message.content` and rejects incomplete finish reasons. A schema-valid response still must pass deterministic application checks:

- Approved existing catalog choices only, with exact supported 15-, 30- or 60-minute duration and matching region/resources.
- Bid catalog cannot change the immutable request; price respects integer-cent bounds, buyer budget, own supplier floor/ceiling, capacity and catalog allowlist. An omitted allowlist permits approved choices; an empty allowlist permits none.
- Offering suggestions must be unique, match recorded demand and stay within the authenticated supplier's price/catalog policy. Extra fields such as generated setup code are rejected.

Only explicitly projected fields reach Meta. Wick organization/group identifiers, API keys, authentication cookies, terminal input/output, buyer identities and other suppliers' private policies are excluded. Translation/bid free text is length limited and common pasted credential patterns (named secrets, authorization values, private keys and URL credentials) are redacted before transmission. This pattern filter is not a general secret detector; environment descriptions should contain requirements only. Offering suggestions use aggregate demand dimensions, without buyer free text. The adapter does not log request/response bodies or retain model reasoning.

## Evidence and remaining verification

Public documentation was fetched on 2026-10-28:

- [Meta models](https://dev.meta.ai/docs/models) lists `muse-wonder-1.0`, Chat Completions and structured output support.
- [Meta structured output](https://dev.meta.ai/docs/structured-output) documents `response_format.json_schema`, strict schema rules, and JSON in `choices[0].message.content`.
- [Meta Chat Completions protocol](https://dev.meta.ai/docs/protocols/chat-completions) documents `max_completion_tokens` and `finish_reason`.

No paid or authenticated Meta request was made during this build. Offline Vitest tests exercise the documented wire envelope and adversarial/error responses through injected `fetch`, plus fixture eligibility, credential exclusion, deadline/concurrency bounds and route authorization. These tests do not establish account access, observed model latency, live schema acceptance or model output quality. Before enabling real mode, an authorized operator must provide a server-side key and verify those properties against their own Meta account; any failed real request remains a visible error.

Run `npx vitest run tests/muse.test.ts tests/muse-routes.test.ts` for these offline tests.
