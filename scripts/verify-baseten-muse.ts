import 'dotenv/config';
import assert from 'node:assert/strict';
import { createMuseAdapter } from '../src/server/integrations/muse.js';
import { MUSE_MODEL } from '../src/shared/muse.js';
import type { CatalogItem } from '../src/shared/types.js';

// Explicit, bounded inference-only diagnostic. No database, Wick adapter, VM or policy writes.
if (!process.argv.includes('--live'))
  throw new Error('Pass --live to authorize five real Baseten model calls.');
const key = process.env.BASETEN_API_KEY || process.env.META_API_KEY;
if (!key) throw new Error('Set BASETEN_API_KEY privately before running the live diagnostic.');
const muse = createMuseAdapter({
  museMode: 'real',
  metaApiKey: key,
  metaApiBase: 'https://inference.baseten.co/v1',
});
const catalog: CatalogItem[] = [
  {
    id: 'smoke-small',
    name: 'Synthetic Small',
    description: 'Synthetic inference diagnostic; no native allocation',
    provider: 'diagnostic',
    profile: 'small',
    region: 'us-east',
    cpu: 2,
    memoryGb: 4,
    durationMinutes: [15, 30, 60],
    approved: true,
  },
];
const policy = {
  autoBid: true,
  minimumPriceCents: 5,
  basePriceCents: 8,
  maxPriceCents: 20,
  reserveSlots: 0,
  allowedCatalogIds: ['smoke-small'],
};
const capacity = { total: 5, held: 0, available: 5 };
const checks: [string, () => Promise<void>][] = [
  [
    'buyer-translation',
    async () => {
      const result = await muse.translate('2 CPUs, 4 GiB RAM for 30 minutes in us-east', catalog);
      assert.equal(result.mode, 'real');
      assert.equal(result.proposal.catalogId, 'smoke-small');
      assert.equal(result.proposal.durationMinutes, 30);
    },
  ],
  [
    'provider-capacity',
    async () => {
      const result = await muse.proposeCapacityPolicy({
        strategy: 'Fill idle machines, keep two slots spare, never quote below $0.05.',
        policy,
        capacity,
        catalogIds: ['smoke-small'],
      });
      assert.equal(result.modelCalled, true);
      assert.equal(result.policy.reserveSlots, 2);
      assert.equal(result.policy.minimumPriceCents, 5);
    },
  ],
  [
    'provider-bid',
    async () => {
      const result = await muse.proposeBid({
        request: {
          description: '2 CPUs and 4 GiB RAM for 30 minutes in us-east',
          catalogId: 'smoke-small',
          region: 'us-east',
          durationMinutes: 30,
          maxPriceCents: 15,
          requirements: { cpu: 2, memoryGb: 4 },
        },
        policy,
        availableCapacity: 5,
        suggestedTotalPriceCents: 8,
        discountTotalPriceCents: 7.2,
        catalog,
      });
      assert.equal(result.modelCalled, true);
      assert.equal(result.decision, 'bid');
      assert.ok([7.2, 8].includes(result.totalPriceCents!));
    },
  ],
  [
    'provider-offerings',
    async () => {
      const result = await muse.proposeOfferings({
        demand: [
          {
            region: 'us-east',
            durationMinutes: 30,
            requirements: { cpu: 2, memoryGb: 4 },
            count: 3,
          },
        ],
        catalog,
        policy,
        pricedCandidates: [
          { id: 'priced-small', catalogId: 'smoke-small', durationMinutes: 30, totalPriceCents: 8 },
        ],
      });
      assert.equal(result.mode, 'real');
      assert.equal(result.proposals.length, 1);
      assert.equal(result.proposals[0]?.priceCents, 8);
    },
  ],
  [
    'buyer-alternatives',
    async () => {
      const result = await muse.selectCounteroffers({
        requirements: {
          requirements: { cpu: 2, memoryGb: 4 },
          region: 'us-east',
          durationMinutes: 30,
          maxPriceCents: 15,
        },
        policy,
        capacity,
        candidates: [
          {
            id: 'approved-alternative',
            catalogId: 'smoke-small',
            region: 'us-east',
            durationMinutes: 30,
            requirements: { cpu: 2, memoryGb: 4 },
            totalPriceCents: 8,
          },
        ],
      });
      assert.equal(result.modelCalled, true);
      assert.equal(result.selections[0]?.candidateId, 'approved-alternative');
    },
  ],
];
let failures = 0;
for (const [name, run] of checks) {
  const started = performance.now();
  try {
    await run();
    console.log(
      JSON.stringify({
        check: name,
        passed: true,
        model: MUSE_MODEL,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  } catch (error) {
    failures += 1;
    // Upstream bodies, prompts, responses and reasoning are intentionally omitted.
    console.error(
      JSON.stringify({
        check: name,
        passed: false,
        error: error instanceof Error ? error.name : 'Error',
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
}
console.log(
  JSON.stringify({
    checks: checks.length,
    passed: checks.length - failures,
    failed: failures,
    vmAllocations: 0,
    databaseWrites: 0,
  }),
);
process.exitCode = failures ? 1 : 0;
