import { loadConfig } from '../src/server/config.js';
import { createPool, migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import {
  configureRealMarketplace,
  configureProviderMarketplace,
} from '../src/server/marketplace/configure-real.js';
import type { CloudProvider } from '../src/server/marketplace/provider-identity.js';
import { fixedQuote, managedPricing } from '../src/shared/pricing.js';

async function main() {
  const config = loadConfig();
  if (config.wickMode !== 'real' || config.museMode !== 'fixture')
    throw new Error('Setup requires explicit WICK_MODE=real and MUSE_MODE=fixture.');
  const command = process.argv[2];
  if (!['--list', '--apply', '--apply-providers'].includes(command ?? ''))
    throw new Error(
      'Use --list for a public rate preview, --apply for existing demo suppliers, or --apply-providers for explicitly configured provider accounts.',
    );
  const pool = createPool(config.databaseUrl);
  try {
    const catalog = await createWickAdapter(config, pool).catalog();
    if (command === '--list') {
      console.log(
        JSON.stringify(
          catalog
            .filter((item) => item.pricingMode === 'managed')
            .map((item) => ({
              id: item.id,
              provider: item.provider,
              profile: item.profile,
              region: item.region,
              cpu: item.cpu,
              memoryGb: item.memoryGb,
              resources: item.resources,
              rateMicrosPerSecond: item.rateMicrosPerSecond,
              rateRetrievedAt: item.rateRetrievedAt,
              quoteCents: Object.fromEntries(
                item.durationMinutes.map((duration) => [
                  duration,
                  fixedQuote(managedPricing(item), duration).totalPriceCents,
                ]),
              ),
            })),
          null,
          2,
        ),
      );
      return;
    }
    const list = (name: string) =>
      (process.env[name] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (command === '--apply-providers') {
      const identities: [CloudProvider, string, string][] = [
        ['e2b', 'E2B', 'E2B'],
        ['daytona', 'DAYTONA', 'Daytona'],
        ['provider-blaxel', 'BLAXEL', 'Baseten'],
        ['modal', 'MODAL', 'Modal'],
      ];
      await migrate(pool);
      const summary = await configureProviderMarketplace(pool, catalog, {
        providers: identities.map(([cloudProvider, key, name]) => ({
          cloudProvider,
          name,
          email: process.env[`REAL_PROVIDER_${key}_EMAIL`] ?? '',
          password: process.env[`REAL_PROVIDER_${key}_PASSWORD`] ?? '',
          catalogIds: list(`REAL_PROVIDER_${key}_CATALOG_IDS`),
          capacity: Number(process.env.REAL_PROVIDER_CAPACITY ?? '5'),
          autoBid: true,
        })),
        retireSupplierEmails: list('REAL_RETIRED_SUPPLIER_EMAILS'),
      });
      console.log(JSON.stringify({ ...summary, mode: 'real' }));
      return;
    }
    const catalogIds = list('REAL_CATALOG_IDS');
    const supplierEmails = list('REAL_SUPPLIER_EMAILS').map((email) => email.toLowerCase());
    if (!catalogIds.length || !supplierEmails.length)
      throw new Error(
        'Explicit REAL_CATALOG_IDS and REAL_SUPPLIER_EMAILS are required before setup.',
      );
    const capacity = Number(process.env.REAL_SUPPLIER_CAPACITY ?? '1');
    const autoBid = process.env.REAL_SUPPLIER_AUTO_BID ?? 'true';
    if (!['true', 'false'].includes(autoBid))
      throw new Error('REAL_SUPPLIER_AUTO_BID must be true or false.');
    await migrate(pool);
    const summary = await configureRealMarketplace(pool, catalog, {
      catalogIds,
      supplierEmails,
      capacity,
      autoBid: autoBid === 'true',
    });
    console.log(
      JSON.stringify({
        ...summary,
        mode: 'real',
        commissionBps: 1500,
        note: 'Explicit real configurations approved. Demo supplier allocations configured. Accounts, passwords, sessions, reservations and frozen quotes preserved. No VMs allocated; no payment due.',
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Real setup failed. Verify explicit configuration, service access, chosen catalog IDs and existing provider accounts. No authentication data was changed.',
  );
  process.exitCode = 1;
});
