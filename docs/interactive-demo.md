# Interactive console demo

Visitors explore the regular Wick Broker console with an in-memory sample account. The demo renders the same navigation, pages, forms, tables, dialogs, and terminal panel as the authenticated console. A small toolbar provides the perspective switch, walkthrough, reset, and exit.

| Perspective | Shareable route | Starting screen |
| ----------- | --------------- | --------------- |
| Buyer       | `/demo/buyer`   | Orders          |
| Seller      | `/demo/seller`  | Capacity        |

Internal links stay within the selected perspective, for example `/demo/buyer/vms` or `/demo/seller/provider/policy`. The hosted homepage and `/demos` link to both workspaces.

## Local quickstart

Use Node 24 and run these commands from the repository root:

```sh
npm ci
npm run demo
```

Open [http://localhost:5173](http://localhost:5173). This starts Vite in an explicit local demo mode, without the Broker server, PostgreSQL, `.env`, accounts, or service credentials. Both `/` and `/demos` show a chooser for the buyer and seller workspaces, plus a link to the hosted live demo. Home and **Exit demo** return to the chooser. Other non-demo destinations show the chooser instead of trying to sign in.

The browser downloads local frontend assets and uses Vite's development connection; demo actions make no marketplace API requests or terminal WebSocket connections. The live-demo link opens the hosted service only when selected. The regular backend `npm run dev` and `npm start` commands remain separate; see [full-stack local development](local-development.md).

## Guided first steps

A compact three-step walkthrough opens above the console for each perspective. Buyers can launch a sample VM, try the ready-to-use terminal, and run a Muse Studio task. Sellers can change capacity, submit a sample bid, and inspect earnings. Each step includes concrete instructions and a link to the relevant screen. Next and Previous navigate between step screens; advancing only changes the guide and never submits a form or starts a purchase.

Visitors can hide the guide, reopen it from **Show guide**, or replay it after the last step. Each perspective keeps its own position and visibility while navigating within the tab. **Reset demo** restarts both walkthroughs along with their sample data; reload also starts fresh. The guide never blocks or replaces the regular console controls.

## Mocked data, regular controls

`demo-store.ts` holds the sample session, catalog, and per-perspective state. `api.ts` explicitly routes requests made from a demo URL through `demo-api.ts`, which dispatches to the buyer or seller mock handler. An unsupported request returns an error and never falls back to the network. Mock responses are cloned so they behave like HTTP snapshots.

The buyer workspace includes sample orders, VMs, disks, token packs, agents, wallet history, invoices, and Studio tasks. Purchase and management actions update only the sample state. The seller workspace includes capacity, policy, requests, offerings, AI capacity, earnings, activity, and reviewed sales recommendations. Rental revenue uses the same 15% Broker / 85% provider calculation as the product.

The browser terminal uses the same xterm panel with a small local command interpreter. It never opens a terminal WebSocket in demo mode. Sample API keys are visibly invalid demo strings. Drafts stay in memory and do not overwrite a real account's browser draft. Patch download links contain local sample text, including when opened in a new tab; they never point to the live API.

No demo action signs in, contacts the marketplace backend, starts a model call, allocates infrastructure, or changes a real account. Loading the app still retrieves its normal static assets. State survives navigation and perspective switches within the tab. **Reset demo** and reloading restore the starting data; the state is never saved to browser storage or a server.

## Existing live demos

The terminal and guided Studio demos at the hosted `/demos` remain separate. In local demo mode, `/demos` is the offline chooser and links out to that hosted page. They follow server availability, guest session limits, leases, and cooldowns, and use real resources when configured in real mode. Entering or resetting the console demo does not change a live demo session. See [live demo setup](homepage-demo.md).

## Verification

Install Chromium once, then run the dedicated frontend demo suite:

```sh
npx playwright install --with-deps chromium
npm run test:demo
```

The command starts its own frontend server without a database or credentials. Tests cover chooser entry, buyer and seller journeys, deep links, history, reload, exit, reset, and mobile layout. They fail on backend requests, terminal WebSockets, or uncaught browser errors; Vite's development connection is allowed.

The existing `tests/browser/interactive-demo.spec.ts` also exercises the normal console and its hosted authentication boundary. Those checks remain part of the regular browser suite. See [testing notes](testing.md).
