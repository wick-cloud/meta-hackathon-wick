import type { Pool } from 'pg';
import type { CatalogItem } from '../../shared/types.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import { transaction } from './db.js';

export interface RealSetupOptions {
  catalogIds: string[];
  supplierEmails: string[];
  capacity: number;
  autoBid: boolean;
}

/** Explicit opt-in only; this function never writes authentication or historical rental tables. */
export async function configureRealMarketplace(
  pool: Pool,
  catalog: CatalogItem[],
  options: RealSetupOptions,
) {
  if (
    !options.catalogIds.length ||
    new Set(options.catalogIds).size !== options.catalogIds.length ||
    !options.supplierEmails.length ||
    new Set(options.supplierEmails).size !== options.supplierEmails.length ||
    !Number.isSafeInteger(options.capacity) ||
    options.capacity < 0 ||
    options.capacity > 10000
  )
    throw new Error(
      'Choose distinct real catalog IDs, existing supplier emails, and valid demo capacity.',
    );
  const selected = options.catalogIds.map((id) => {
    const item = catalog.find((entry) => entry.id === id);
    if (!item) throw new Error('A chosen real catalog configuration is no longer available.');
    requireFreshManagedRate(item);
    const pricing = managedPricing(item);
    return { item, pricing, price: fixedQuote(pricing, 30).totalPriceCents };
  });
  return transaction(pool, async (db) => {
    // Lock the whole setup operation so parallel/repeated invocations are idempotent.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-configure-real'))");
    const users = (
      await db.query(
        'SELECT id,email FROM "user" WHERE email=ANY($1::text[]) AND role=\'provider\' FOR SHARE',
        [options.supplierEmails],
      )
    ).rows;
    if (users.length !== options.supplierEmails.length)
      throw new Error('Every selected supplier must already be an invited provider account.');
    for (const { item } of selected) {
      const old = (
        await db.query('SELECT source_mode FROM broker_catalog WHERE id=$1 FOR UPDATE', [item.id])
      ).rows[0];
      if (old && old.source_mode !== 'real')
        throw new Error('Real catalog IDs must not overwrite historical fixture configurations.');
      await db.query(
        `INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,true,'real')
        ON CONFLICT(id) DO UPDATE SET item=excluded.item,approved=true,updated_at=now()`,
        [item.id, { ...item, approved: true }],
      );
    }
    for (let index = 0; index < options.supplierEmails.length; index++) {
      const user = users.find((entry) => entry.email === options.supplierEmails[index])!;
      const name = `Demo supplier ${index + 1} · Wick-backed`;
      const policy = {
        autoBid: options.autoBid,
        minimumPriceCents: 1,
        basePriceCents: selected[0]!.price,
        maxPriceCents: 100000000,
        allowedCatalogIds: options.catalogIds,
      };
      const provider = (
        await db.query(
          `INSERT INTO broker_providers(user_id,name,total_capacity,policy,simulated)
        VALUES($1,$2,$3,$4,true) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,
        total_capacity=excluded.total_capacity,policy=excluded.policy,simulated=true RETURNING id`,
          [user.id, name, options.capacity, policy],
        )
      ).rows[0];
      for (const { item, pricing, price } of selected)
        await db.query(
          `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing)
          VALUES($1,$2,'Wick managed demo allocation',$3,$4,$5)
          ON CONFLICT(provider_id,catalog_id,name) DO UPDATE SET price_cents=excluded.price_cents,
          pricing=CASE WHEN (broker_offerings.pricing-'rateRetrievedAt') IS NOT DISTINCT FROM (excluded.pricing-'rateRetrievedAt')
            THEN broker_offerings.pricing ELSE excluded.pricing END,
          active=true,revision=broker_offerings.revision+
          CASE WHEN (broker_offerings.pricing-'rateRetrievedAt') IS DISTINCT FROM (excluded.pricing-'rateRetrievedAt')
            OR broker_offerings.active=false THEN 1 ELSE 0 END`,
          [
            provider.id,
            item.id,
            'Demo supplier allocation backed by Wick. Fixed gross rental quote; provider keeps 85% before compute costs and Broker receives 15%. No payment due.',
            price,
            pricing,
          ],
        );
    }
    return { approvedConfigurations: selected.length, demoSuppliers: users.length };
  });
}
