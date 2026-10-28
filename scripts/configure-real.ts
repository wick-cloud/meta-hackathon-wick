import { loadConfig } from '../src/server/config.js';
import { createPool, migrate } from '../src/server/db.js';
import { createWickAdapter } from '../src/server/integrations/wick.js';
import { configureRealMarketplace } from '../src/server/marketplace/configure-real.js';
import { fixedQuote, managedPricing } from '../src/shared/pricing.js';

async function main() {
  const config = loadConfig();
  if (config.wickMode !== 'real' || config.museMode !== 'fixture')
    throw new Error('Setup requires explicit WICK_MODE=real and MUSE_MODE=fixture.');
  const command = process.argv[2];
  if (!['--list', '--apply'].includes(command ?? ''))
    throw new Error(
      'Use --list for a public rate preview, or --apply with explicit REAL_CATALOG_IDS and REAL_SUPPLIER_EMAILS.',
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
