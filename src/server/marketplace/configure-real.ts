import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { CatalogItem } from '../../shared/types.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import { transaction } from './db.js';
import { CLOUD_PROVIDERS, type CloudProvider } from './provider-identity.js';

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
    if (
      (
        await db.query(
          'SELECT id FROM broker_providers WHERE user_id=ANY($1::text[]) AND cloud_provider IS NOT NULL LIMIT 1',
          [users.map((user) => user.id)],
        )
      ).rowCount
    )
      throw new Error('Bound provider accounts require the provider-specific setup command.');
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

export interface ProviderAccountSetup {
  cloudProvider: CloudProvider;
  name: string;
  email: string;
  password: string;
  catalogIds: string[];
  capacity: number;
  autoBid: boolean;
}

export interface ProviderMarketplaceSetup {
  providers: ProviderAccountSetup[];
  retireSupplierEmails: string[];
}

/** Operator-only bootstrap. No session, existing credential, rental or ledger is rewritten. */
export async function configureProviderMarketplace(
  pool: Pool,
  catalog: CatalogItem[],
  options: ProviderMarketplaceSetup,
) {
  if (!options.providers.length || options.providers.length > CLOUD_PROVIDERS.length)
    throw new Error('Choose one to four provider accounts.');
  const inputs = options.providers.map((provider) => ({
    ...provider,
    email: provider.email.trim().toLowerCase(),
  }));
  const emails = inputs.map((provider) => provider.email);
  const retiredEmails = options.retireSupplierEmails.map((email) => email.trim().toLowerCase());
  if (
    new Set(emails).size !== emails.length ||
    new Set(inputs.map((provider) => provider.cloudProvider)).size !== inputs.length ||
    retiredEmails.length > 16 ||
    new Set(retiredEmails).size !== retiredEmails.length ||
    retiredEmails.some((email) => emails.includes(email)) ||
    [...emails, ...retiredEmails].some((email) => !/^\S+@\S+\.\S+$/.test(email)) ||
    inputs.some(
      (provider) =>
        !CLOUD_PROVIDERS.includes(provider.cloudProvider) ||
        !provider.name.trim() ||
        provider.name.length > 160 ||
        provider.password.length < 12 ||
        provider.password.length > 128 ||
        !Number.isSafeInteger(provider.capacity) ||
        provider.capacity < 0 ||
        provider.capacity > 10000 ||
        typeof provider.autoBid !== 'boolean' ||
        !provider.catalogIds.length ||
        provider.catalogIds.length > 100 ||
        new Set(provider.catalogIds).size !== provider.catalogIds.length,
    )
  )
    throw new Error(
      'Provider setup requires distinct identities, supplied passwords and bounded configurations.',
    );
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const selected = inputs.flatMap((provider) =>
    provider.catalogIds.map((id) => {
      const item = catalogById.get(id);
      if (!item || item.provider !== provider.cloudProvider)
        throw new Error(
          'Each selected configuration must belong to its assigned upstream provider.',
        );
      requireFreshManagedRate(item);
      const pricing = managedPricing(item);
      return {
        provider: provider.cloudProvider,
        item,
        pricing,
        price: fixedQuote(pricing, 30).totalPriceCents,
      };
    }),
  );
  // Password hashing is bounded to four accounts and never runs under database locks.
  const prepared = await Promise.all(
    inputs.map(async (provider) => ({
      ...provider,
      id: randomUUID(),
      passwordHash: await hashPassword(provider.password),
    })),
  );
  const catalogIds = selected.map(({ item }) => item.id);
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('broker-configure-real'))");
    const existingUsers = (
      await db.query(
        'SELECT id,email,role,"providerId" FROM "user" WHERE email=ANY($1::text[]) FOR UPDATE',
        [emails],
      )
    ).rows;
    if (existingUsers.some((user) => user.role !== 'provider'))
      throw new Error('A requested provider email is already assigned to another role.');
    const existingProviders = (
      await db.query(
        'SELECT p.*,u.email FROM broker_providers p JOIN "user" u ON u.id=p.user_id WHERE u.email=ANY($1::text[]) FOR UPDATE OF p',
        [emails],
      )
    ).rows;
    for (const provider of existingProviders) {
      const input = prepared.find((entry) => entry.email === provider.email)!;
      const user = existingUsers.find((entry) => entry.id === provider.user_id)!;
      if (
        provider.cloud_provider !== input.cloudProvider ||
        (user.providerId && user.providerId !== provider.id)
      )
        throw new Error('An existing provider account has a different upstream binding.');
    }
    const credentials = (
      await db.query(
        'SELECT "userId" FROM account WHERE "providerId"=\'credential\' AND "accountId"=ANY($1::text[]) AND "userId"="accountId" AND password IS NOT NULL FOR SHARE',
        [existingUsers.map((user) => user.id)],
      )
    ).rows;
    if (
      existingUsers.some((user) => !credentials.some((credential) => credential.userId === user.id))
    )
      throw new Error(
        'An existing provider account has no credential login; existing authentication was preserved.',
      );
    const retired = (
      await db.query(
        'SELECT p.id,p.cloud_provider,u.role FROM broker_providers p JOIN "user" u ON u.id=p.user_id WHERE u.email=ANY($1::text[]) FOR UPDATE OF p',
        [retiredEmails],
      )
    ).rows;
    if (
      retired.length !== retiredEmails.length ||
      retired.some((provider) => provider.role !== 'provider' || provider.cloud_provider)
    )
      throw new Error('Retirement must explicitly select existing unbound supplier accounts.');
    const existingCatalog = (
      await db.query(
        'SELECT id,source_mode FROM broker_catalog WHERE id=ANY($1::text[]) FOR UPDATE',
        [catalogIds],
      )
    ).rows;
    if (existingCatalog.some((item) => item.source_mode !== 'real'))
      throw new Error('Real configuration IDs must not overwrite historical fixtures.');
    const created = (
      await db.query(
        `INSERT INTO "user"(id,email,name,role,"emailVerified")
       SELECT id,email,name,'provider',true FROM jsonb_to_recordset($1::jsonb) AS x(id text,email text,name text)
       ON CONFLICT(email) DO NOTHING RETURNING id,email`,
        [JSON.stringify(prepared.map(({ id, email, name }) => ({ id, email, name })))],
      )
    ).rows;
    const users = (
      await db.query(
        'SELECT id,email,role,"providerId" FROM "user" WHERE email=ANY($1::text[]) FOR UPDATE',
        [emails],
      )
    ).rows;
    if (users.length !== emails.length || users.some((user) => user.role !== 'provider'))
      throw new Error('Provider account creation collided with another role.');
    await db.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password)
       SELECT id,user_id,'credential',user_id,password FROM jsonb_to_recordset($1::jsonb) AS x(id text,user_id text,password text)`,
      [
        JSON.stringify(
          created.map((user) => ({
            id: randomUUID(),
            user_id: user.id,
            password: prepared.find((input) => input.email === user.email)!.passwordHash,
          })),
        ),
      ],
    );
    await db.query(
      `INSERT INTO broker_catalog(id,item,approved,source_mode)
       SELECT id,item,true,'real' FROM jsonb_to_recordset($1::jsonb) AS x(id text,item jsonb)
       ON CONFLICT(id) DO UPDATE SET item=excluded.item,approved=true,updated_at=now()`,
      [
        JSON.stringify(
          selected.map(({ item }) => ({ id: item.id, item: { ...item, approved: true } })),
        ),
      ],
    );
    const providerRecords = prepared.map((input) => ({
      user_id: users.find((user) => user.email === input.email)!.id,
      name: input.name,
      cloud_provider: input.cloudProvider,
      total_capacity: input.capacity,
      policy: {
        autoBid: input.autoBid,
        minimumPriceCents: 1,
        basePriceCents: Math.max(
          1,
          Math.min(
            ...selected
              .filter((item) => item.provider === input.cloudProvider)
              .map((item) => item.price),
          ),
        ),
        maxPriceCents: 100000000,
        reserveSlots: 0,
        allowedCatalogIds: input.catalogIds,
      },
    }));
    const providers = (
      await db.query(
        `INSERT INTO broker_providers(user_id,name,cloud_provider,total_capacity,policy,simulated)
       SELECT user_id,name,cloud_provider,total_capacity,policy,false FROM jsonb_to_recordset($1::jsonb)
       AS x(user_id text,name text,cloud_provider text,total_capacity integer,policy jsonb)
       ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,total_capacity=excluded.total_capacity,policy=excluded.policy,simulated=false
       RETURNING id,user_id,cloud_provider`,
        [JSON.stringify(providerRecords)],
      )
    ).rows;
    await db.query(
      'UPDATE "user" u SET "providerId"=p.id::text FROM broker_providers p WHERE p.user_id=u.id AND u.id=ANY($1::text[]) AND u."providerId" IS DISTINCT FROM p.id::text',
      [users.map((user) => user.id)],
    );
    const offerings = selected.map(({ provider, item, pricing, price }) => ({
      provider_id: providers.find((entry) => entry.cloud_provider === provider)!.id,
      catalog_id: item.id,
      name: `${prepared.find((input) => input.cloudProvider === provider)!.name} allocation`,
      description: `Operator-managed allocation via Wick. Underlying route: ${provider}. Provider keeps 85% before compute costs; Broker receives 15%. Demo billing; no payment due.`,
      price_cents: price,
      pricing,
    }));
    await db.query(
      `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing)
       SELECT provider_id,catalog_id,name,description,price_cents,pricing FROM jsonb_to_recordset($1::jsonb)
       AS x(provider_id uuid,catalog_id text,name text,description text,price_cents integer,pricing jsonb)
       ON CONFLICT(provider_id,catalog_id,name) DO UPDATE SET description=excluded.description,price_cents=excluded.price_cents,
       pricing=CASE WHEN (broker_offerings.pricing-'rateRetrievedAt') IS NOT DISTINCT FROM (excluded.pricing-'rateRetrievedAt') THEN broker_offerings.pricing ELSE excluded.pricing END,
       active=true,revision=broker_offerings.revision+CASE WHEN (broker_offerings.pricing-'rateRetrievedAt') IS DISTINCT FROM (excluded.pricing-'rateRetrievedAt') OR broker_offerings.active=false THEN 1 ELSE 0 END`,
      [JSON.stringify(offerings)],
    );
    await db.query(
      `UPDATE broker_offerings o SET active=false,revision=revision+1 FROM broker_catalog c
       WHERE o.catalog_id=c.id AND c.source_mode='real' AND o.active AND o.provider_id=ANY($1::uuid[])`,
      [retired.map((provider) => provider.id)],
    );
    await db.query(
      `UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false'::jsonb)
       WHERE id=ANY($1::uuid[]) AND policy->>'autoBid' IS DISTINCT FROM 'false'`,
      [retired.map((provider) => provider.id)],
    );
    return {
      approvedConfigurations: selected.length,
      createdAccounts: created.length,
      providers: prepared.map((input) => ({
        name: input.name,
        email: input.email,
        cloudProvider: input.cloudProvider,
        capacity: input.capacity,
        catalogIds: input.catalogIds,
      })),
      retiredSuppliers: retired.length,
      commissionBps: 1500,
      note: 'Operator-managed Wick allocations. Existing credentials, sessions, reservations and frozen history preserved. No VMs allocated; demo billing only.',
    };
  });
}
