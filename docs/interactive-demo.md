# Interactive console demo

Visitors explore the regular Wick Broker console with an in-memory sample account. The demo renders the same navigation, pages, forms, tables, dialogs, and terminal panel as the authenticated console. A small toolbar provides the perspective switch, optional guide, reset, and exit.

| Perspective | Shareable route | Starting screen |
| ----------- | --------------- | --------------- |
| Buyer       | `/demo/buyer`   | Orders          |
| Seller      | `/demo/seller`  | Capacity        |

Internal links stay within the selected perspective, for example `/demo/buyer/vms` or `/demo/seller/provider/policy`. The homepage and `/demos` link to both workspaces.

## Mocked data, regular controls

`demo-store.ts` holds the sample session, catalog, and per-perspective state. `api.ts` explicitly routes requests made from a demo URL through `demo-api.ts`, which dispatches to the buyer or seller mock handler. An unsupported request returns an error and never falls back to the network. Mock responses are cloned so they behave like HTTP snapshots.

The buyer workspace includes sample orders, VMs, disks, token packs, agents, wallet history, invoices, and Studio tasks. Purchase and management actions update only the sample state. The seller workspace includes capacity, policy, requests, offerings, AI capacity, earnings, activity, and reviewed sales recommendations. Rental revenue uses the same 15% Broker / 85% provider calculation as the product.

The browser terminal uses the same xterm panel with a small local command interpreter. It never opens a terminal WebSocket in demo mode. Sample API keys are visibly invalid demo strings. Drafts stay in memory and do not overwrite a real account's browser draft. Patch download links contain local sample text, including when opened in a new tab; they never point to the live API.

No demo action signs in, contacts the marketplace backend, starts a model call, allocates infrastructure, or changes a real account. Loading the app still retrieves its normal static assets. State survives navigation and perspective switches within the tab. **Reset demo** and reloading restore the starting data; the state is never saved to browser storage or a server.

## Existing live demos

The terminal and guided Studio demos at `/demos` remain separate. They follow server availability, guest session limits, leases, and cooldowns, and use real resources when configured in real mode. Entering or resetting the console demo does not change a live demo session. See [live demo setup](homepage-demo.md).

## Verification

`tests/browser/interactive-demo.spec.ts` exercises the actual console with the mock transport, verifies no marketplace HTTP requests or terminal WebSockets, and checks navigation, forms, state changes, reset, mobile layout, and the existing authentication boundary. It needs only the frontend asset server.

Run `npx vite --host 127.0.0.1 --port 4317` in one terminal, then:

```sh
E2E_BASE_URL=http://127.0.0.1:4317 npx playwright test tests/browser/interactive-demo.spec.ts
```
