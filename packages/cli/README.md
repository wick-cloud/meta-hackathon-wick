# Wick Broker CLI

`wick-broker` is the command-line interface to the Broker marketplace. It uses **Broker API keys**, not Wick service keys. It shares all pricing, matching, ownership and lifecycle rules with the Broker UI.

Requires Node.js 22.12 or newer.

```sh
npm install -g @wick-cloud/broker-cli
wick-broker auth login
wick-broker catalog list --json
wick-broker orders list --status active --json
```

Create a key on Broker’s **API keys** page. `auth login` reads the key using a hidden prompt; `auth login --stdin` is available for secret-manager pipes. Never put a secret in a command argument. Credentials are saved privately for the selected API origin. Changing `--api-url` does not reuse a saved key from another origin.

Headless clients can instead supply `WICK_BROKER_API_KEY` and `WICK_BROKER_API_URL` through their secret environment. `WICK_API_KEY` is never read. Local logout only removes the saved credential; revoke access in the Broker UI.

```sh
wick-broker orders create --file order.json \
  --operation-key order-20261029-001 --wait --json
wick-broker vms wait <vm-id> --timeout 120 --json
wick-broker vms terminal <vm-id>
wick-broker vms terminate <vm-id> --operation-key cleanup-001 --json
```

Supply an exact approved catalog configuration in `order.json`. Noninteractive mutations need a stable `--operation-key` or `operationKey` in their JSON file. Reuse the key and identical input after an uncertain result. A wait timeout does not cancel, terminate or create another resource. Inspect the returned resource state; a completed wait can include a failed auction.

Terminal access requires a TTY. Ctrl-] detaches, while Ctrl-C reaches the guest. Detaching does not terminate the VM. Terminal input is a stream and is **never automatically replayed** after a connection failure.

Run `wick-broker --help` for buyer, agreement, billing, provider and Muse commands. Payload-bearing commands use `--file` (maximum 64 KiB); Muse commands also accept `--description`, `--strategy` or `--prompt`. List commands support bounded pagination with `--limit` and `--cursor`. `--json` keeps results on stdout and diagnostics off stdout.

See the repository’s [developer access guide](https://github.com/wick-cloud/meta-hackathon-wick/blob/main/docs/developer-access.md) for examples and the public HTTP contract.

## Token market and inference

Use a browser-created grant key with `account:read`, `inference:read`, `tokens:buy` and `inference:use`. The grant owns the budget across key rotation; the CLI cannot fund or enlarge it.

```sh
wick-broker inference models --json
wick-broker inference grant --json
wick-broker inference quote --file token-amounts.json --json
wick-broker tokens create --file token-order.json --operation-key tokens-001 --wait --json
wick-broker tokens get <order-id> --json
wick-broker tokens wait <order-id> --timeout 30 --json
wick-broker inference packs --limit 20 --json
wick-broker inference complete --file completion.json --operation-key completion-001 --json
wick-broker inference receipt <request-id> --json
```

`token-amounts.json` contains positive `inputTokens` and `outputTokens`. `token-order.json` also contains `mode` (`auction` or `instant`), `maxTotalCents`, and an exact `quoteId` for instant purchase. `modelId` defaults to the server’s approved Meta contract. Read the catalog’s route qualification and fixture/real mode before placing an order.

`completion.json` contains `model`, text-only `messages`, a positive `max_tokens` cap including reasoning, and optionally `stream: false`. Streaming, tools and images are not supported. Every completion consumes prepaid quota, is sent once, and requires its own stable operation key. A completed-key replay returns a receipt-only error; an uncertain outcome should be inspected through `inference receipt`, never retried with a new key. Refills require an explicit purchase and remain within the original grant budget. Ordinary unused pack quota is non-refundable.

Completion JSON errors expose `inferenceRequestId` for `inference receipt`; `requestId` remains the HTTP correlation ID. If a transport timeout has no receipt ID, explicitly repeat the exact payload with its original `--operation-key` to recover that identifier without redispatching an existing invocation.

Providers use `provider inference get`, `provider inference update --file offering.json --operation-key offering-001`, and `provider inference packs`. Updating supply requires its current `expectedRevision` and never rewrites accepted packs.
