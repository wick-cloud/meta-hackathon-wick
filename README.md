# Wick — the OpenRouter for sandboxes

Wick gives developers and AI agents one platform to access and manage sandbox providers. **This repo is Wick Broker, the marketplace we built on top of Wick during the hackathon.**

[Wick platform](https://wick-cloud.com) · [Live demos](https://meta-hackathon-wick-production.up.railway.app/demos) · [Mock buyer demo](https://meta-hackathon-wick-production.up.railway.app/demo/buyer) · [Mock seller demo](https://meta-hackathon-wick-production.up.railway.app/demo/seller)

## Run locally

With **Node 24**, run from the repo folder:

```sh
npm ci
npm run demo
```

Open [localhost:5173](http://localhost:5173) and choose **Buyer** or **Seller**. No database, Docker, `.env`, or API keys needed.

The local demo uses sample data and simulated actions. Try an auction, terminal, or Muse Studio task as a buyer; manage capacity and bids as a seller. Reset or reload to start fresh.

## What we built during the hackathon

- **Already existed:** Wick's hosted sandbox platform and provider integrations.
- **Built during the hackathon, in this repo:** Broker's buyer/seller marketplace, compute and token auctions, Muse workflows, and demos.
- **Also built during the hackathon, in the main platform:** shared-file support, allowing a buyer's sandboxes across supported providers to access the same workspace files.

**The main Wick platform repository is private and cannot be shared with this submission.** This repo includes Broker's integration with it; the shared-file infrastructure lives in that private platform.

We kept Broker standalone for the hackathon. Conversations with people in the industry helped us see a practical use case, and we plan to integrate Broker into the main Wick platform.

## Why Wick

AI agents need an isolated place to run code, install dependencies, and work with files away from your laptop. That's what sandboxes provide.

We started by [building our own sandbox provider](https://medium.com/@harsha0116/we-gave-every-workload-its-own-kernel-e890bb5a9d03). Repeatedly handling different providers' APIs, credentials, and VM lifecycles led us to build one platform that brings them together.

The hosted platform is Wick's core value: unified provider access and infrastructure management. The local demo shows the experience of using that service.

## Why we chose this for the hackathon

Sandbox infrastructure is drawing serious attention, from [Vercel's sandbox launch](https://vercel.com/blog/vercel-sandbox-is-now-generally-available) to [E2B's discussion of infrastructure built around agents](https://e2b.dev/resources/sandboxes-are-dead). We see a crowded, expanding provider landscape and expect many more entrants. That made this hackathon the right moment to explore the next opportunity: how all that supply reaches the agents that need it.

**Our bet: agents will increasingly become the buyers of compute and model tokens.** A person sets the goal, budget, and permissions; the agent finds resources, purchases them, and gets to work. We want Wick to become the marketplace those agents turn to.

**Agentic work can be asynchronous.** A background coding task, evaluation, or batch analysis can often wait through a **30-second auction window** if competing bids produce substantially cheaper compute or tokens. That wait happens before provisioning; it is a deliberate trade between time and cost. Work with a flexible deadline gives providers room to compete and agents room to optimize their spending.

**The moat we aim to build is the market itself:** broad provider supply, recurring agent demand, useful price discovery, and shared workspaces that let work continue across supported providers. Broker is our first experiment in that future—bringing resource purchasing into the agent's workflow and making providers compete for the work.

## How we used Meta Muse

Meta Muse Spark Open helps buyers describe what they need, sellers decide how to offer capacity, and coding agents work inside sandboxes. Our proposal integration uses Muse through Baseten.

- **Provider rules and bidding:** we created and manage seller accounts for each integrated provider in the hosted demo. Muse helped turn goals such as “fill idle machines, keep two slots spare, and never quote below $0.05 per rental” into editable policies. We reviewed the price limits, spare capacity, allowed configurations, and automatic-bidding settings before applying them. Bids then follow those saved rules. In the regular marketplace, Muse can also choose a server-calculated discount when capacity permits; the public live demos use saved base prices and sponsorship without a model call for every bid.
- **Buyer setup and purchasing:** Muse translates a workload description into a proposed configuration from the approved catalog, which the buyer reviews before starting an auction. For funded agents, it can recommend a token purchase or waiting, based on available offers, remaining budget, and expiry. Automatic purchases require an owner-enabled buying policy.
- **Seller recommendations:** the **Improve my sales** flow uses recent demand and the seller's own activity to compare policy alternatives. Muse explains which changes could help match more requests, such as enabling automatic bids or adjusting a base price within existing limits. The seller reviews and applies each change.
- **Muse Studio:** given a public repository, task, and budget, Muse selects an eligible compute configuration and proposes a verification command. Broker purchases the resources; Muse then proposes file reads, edits, and test actions that Studio executes inside the sandbox. Studio requires passing checks after the final edit and exposes the patch, test output, and purchase receipts for review.

**What judges can try live:** the terminal demo asks Muse to explain the actual VM and auction receipt, then answer a question. The guided Studio demo has Muse generate a small Hello World program that the VM executes and verifies. This is a bounded introduction to the broader repository workflow.

Broker validates model output and enforces price limits, capacity, and budgets. Local demo responses are explicitly simulated. See the [Muse integration](docs/MUSE.md) and [Studio workflow](docs/studio-task-budgets.md) for implementation details.

**During development,** we also used Meta models extensively for coding assistance while building Broker. **For the demo video,** Meta Code helped prepare the script and articulate the most important features so the walkthrough was clearer for judges.

## Mock vs. live

- **Mock:** simulated data, terminal output, and model responses. Runs locally or through the mock links above, with no real resource allocation.
- **Live:** real auctions, a sponsored Modal VM, terminal access, and Muse calls. No signup or payment details required.

Hackathon rules don't allow us to share platform credentials, so we built two hosted live demos: **a terminal demo** and **a guided Muse Studio Hello World demo**. Judges can try real infrastructure without signing in or receiving platform credentials.

Live demos allow a **15-minute lease including setup**, **two model calls**, and a **20-minute cooldown after confirmed cleanup**. Shared capacity limits also apply. [Live demo instructions](docs/homepage-demo.md).

[Developer setup](docs/local-development.md) · [Architecture and operations](docs/broker-reference.md) · [Shared files](docs/persistent-disks.md) · [MIT license](LICENSE)
