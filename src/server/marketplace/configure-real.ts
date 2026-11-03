import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { CatalogItem } from '../../shared/types.js';
import { fixedQuote, managedPricing, requireFreshManagedRate } from '../../shared/pricing.js';
import { transaction } from './db.js';
import { centsFromUnits, moneyUnits } from '../../shared/money.js';
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
  /** Required only when creating a new credential account. Existing passwords are never reset. */
  password?: string;
  catalogIds: string[];
  capacity: number;
  autoBid: boolean;
}

export interface ProviderMarketplaceSetup {
  providers: ProviderAccountSetup[];
  retireSupplierEmails: string[];
  /** Stage is the default. Activation is an explicit operator action after qualification. */
  mode?: 'stage' | 'activate';
  /** Explicitly replace selected provider defaults and selected offering prices. */
  updateExisting?: boolean;
}

/** Twenty percent above the cost-covered quote, rounded upward to $0.0001. */
export function providerSetupBasePrice(costCoveredCents: number): number {
  return centsFromUnits((moneyUnits(costCoveredCents) * 120n + 99n) / 100n);
}

/** Operator-only onboarding; retries preserve existing settings unless explicitly activated/updated. */
export async function configureProviderMarketplace(
  pool: Pool,
  catalog: CatalogItem[],
  options: ProviderMarketplaceSetup,
) {
  const mode = options.mode ?? 'stage';
  const activate = mode === 'activate';
  const updateExisting = options.updateExisting ?? false;
  if (
    !options.providers.length ||
    options.providers.length > CLOUD_PROVIDERS.length ||
    !['stage', 'activate'].includes(mode) ||
    typeof updateExisting !== 'boolean'
  )
    throw new Error('Choose a bounded subset of registered providers and a valid setup mode.');
  const inputs = options.providers.map((provider) => ({
    ...provider,
    email: provider.email.trim().toLowerCase(),
    password: provider.password || undefined,
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
        (provider.password !== undefined &&
          (provider.password.length < 12 || provider.password.length > 128)) ||
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
      'Provider setup requires distinct identities, valid optional passwords and bounded configurations.',
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
      const costCoveredPrice = fixedQuote(pricing, 30).totalPriceCents;
      return {
        provider: provider.cloudProvider,
        item,
        pricing,
        costCoveredPrice,
        price: providerSetupBasePrice(costCoveredPrice),
      };
    }),
  );
  // Bounded by the registry; hashing never runs under database locks.
  const prepared = await Promise.all(
    inputs.map(async (provider) => ({
      ...provider,
      id: randomUUID(),
      passwordHash: provider.password ? await hashPassword(provider.password) : undefined,
    })),
  );
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
    if (
      prepared.some(
        (input) => !existingUsers.some((user) => user.email === input.email) && !input.passwordHash,
      )
    )
      throw new Error('A private password is required for each new provider account.');
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
    const retired = (
      await db.query(
        'SELECT p.id,p.cloud_provider,u.role FROM broker_providers p JOIN "user" u ON u.id=p.user_id WHERE u.email=ANY($1::text[]) FOR UPDATE OF p',
        [retiredEmails],
      )
    ).rows;
    if (
      retired.length !== retiredEmails.length ||
      retired.some((p) => p.role !== 'provider' || p.cloud_provider)
    )
      throw new Error('Retirement must explicitly select existing unbound supplier accounts.');
    const existingCatalog = (
      await db.query(
        'SELECT id,source_mode FROM broker_catalog WHERE id=ANY($1::text[]) FOR UPDATE',
        [selected.map(({ item }) => item.id)],
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
    for (const user of created)
      await db.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,'credential',$2,$3)`,
        [randomUUID(), user.id, prepared.find((input) => input.email === user.email)!.passwordHash],
      );
    const users = (
      await db.query(
        'SELECT id,email,role,"providerId" FROM "user" WHERE email=ANY($1::text[]) FOR UPDATE',
        [emails],
      )
    ).rows;
    if (users.length !== emails.length || users.some((user) => user.role !== 'provider'))
      throw new Error('Provider account creation collided with another role.');
    const credentials = (
      await db.query(
        `SELECT "userId" FROM account WHERE "providerId"='credential' AND "accountId"=ANY($1::text[]) AND "userId"="accountId" AND password IS NOT NULL FOR SHARE`,
        [users.map((user) => user.id)],
      )
    ).rows;
    if (users.some((user) => !credentials.some((credential) => credential.userId === user.id)))
      throw new Error(
        'An existing provider account has no credential login; existing authentication was preserved.',
      );
    for (const { item } of selected)
      await db.query(
        `INSERT INTO broker_catalog(id,item,approved,source_mode) VALUES($1,$2,$3,'real')
       ON CONFLICT(id) DO UPDATE SET item=CASE WHEN $4 THEN excluded.item ELSE broker_catalog.item END,
         approved=CASE WHEN $3 THEN true ELSE broker_catalog.approved END,
         updated_at=CASE WHEN $4 THEN now() ELSE broker_catalog.updated_at END`,
        [item.id, { ...item, approved: activate }, activate, activate || updateExisting],
      );
    const providerResults = [];
    for (const input of prepared) {
      const user = users.find((entry) => entry.email === input.email)!;
      const own = selected.filter((entry) => entry.provider === input.cloudProvider);
      const defaultPolicy = {
        autoBid: activate && input.autoBid,
        minimumPriceCents: 1,
        basePriceCents: Math.min(...own.map((entry) => entry.price)),
        maxPriceCents: 100000000,
        reserveSlots: 0,
        allowedCatalogIds: input.catalogIds,
      };
      const inserted = (
        await db.query(
          `INSERT INTO broker_providers(user_id,name,cloud_provider,total_capacity,policy,simulated)
         VALUES($1,$2,$3,$4,$5,false) ON CONFLICT(user_id) DO NOTHING RETURNING *`,
          [user.id, input.name, input.cloudProvider, input.capacity, defaultPolicy],
        )
      ).rows[0];
      let provider =
        inserted ??
        (await db.query('SELECT * FROM broker_providers WHERE user_id=$1 FOR UPDATE', [user.id]))
          .rows[0];
      if (provider.cloud_provider !== input.cloudProvider)
        throw new Error('An existing provider account has a different upstream binding.');
      if (!inserted && (updateExisting || activate)) {
        const policy = updateExisting
          ? defaultPolicy
          : {
              ...provider.policy,
              autoBid: input.autoBid,
              ...(Array.isArray(provider.policy.allowedCatalogIds)
                ? {
                    allowedCatalogIds: [
                      ...new Set([...provider.policy.allowedCatalogIds, ...input.catalogIds]),
                    ],
                  }
                : {}),
            };
        provider = (
          await db.query(
            `UPDATE broker_providers SET name=CASE WHEN $2 THEN $3 ELSE name END,
           total_capacity=CASE WHEN $2 THEN $4 ELSE total_capacity END,policy=$5 WHERE id=$1 RETURNING *`,
            [provider.id, updateExisting, input.name, input.capacity, policy],
          )
        ).rows[0];
      }
      await db.query(
        'UPDATE "user" SET "providerId"=$2 WHERE id=$1 AND "providerId" IS DISTINCT FROM $2',
        [user.id, provider.id],
      );
      for (const { item, pricing, price, costCoveredPrice } of own) {
        const name = `${input.name} allocation`;
        const existing = (
          await db.query(
            'SELECT * FROM broker_offerings WHERE provider_id=$1 AND catalog_id=$2 ORDER BY created_at,id FOR UPDATE',
            [provider.id, item.id],
          )
        ).rows;
        const offering =
          existing.find((row) => row.name === name) ??
          (existing.length === 1 ? existing[0] : undefined);
        if (!existing.length) {
          await db.query(
            `INSERT INTO broker_offerings(provider_id,catalog_id,name,description,price_cents,pricing,active)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              provider.id,
              item.id,
              name,
              `Operator-managed allocation via Wick. Underlying route: ${input.cloudProvider}. Provider keeps 85% before compute costs; Broker receives 15%. Demo billing; no payment due.`,
              price,
              pricing,
              activate,
            ],
          );
        } else if (activate || updateExisting) {
          if (!offering)
            throw new Error(
              'Multiple customized offerings exist; select and update them in the provider console.',
            );
          const nextPrice = updateExisting ? price : Number(offering.price_cents);
          if (activate && nextPrice < costCoveredPrice)
            throw new Error(
              'The existing offering is below the current managed cost floor; explicitly update its price before activation.',
            );
          await db.query(
            `UPDATE broker_offerings SET price_cents=$2,pricing=$3,active=CASE WHEN $4 THEN true ELSE active END,
             revision=revision+CASE WHEN price_cents<>$2 OR (pricing-'rateRetrievedAt') IS DISTINCT FROM ($3::jsonb-'rateRetrievedAt') OR ($4 AND NOT active) THEN 1 ELSE 0 END
             WHERE id=$1`,
            [offering.id, nextPrice, pricing, activate],
          );
        }
      }
      providerResults.push({
        name: provider.name,
        email: input.email,
        cloudProvider: input.cloudProvider,
        capacity: provider.total_capacity,
        autoBid: provider.policy.autoBid,
        basePriceCents: provider.policy.basePriceCents,
        catalogIds: input.catalogIds,
      });
    }
    await db.query(
      `UPDATE broker_offerings o SET active=false,revision=revision+1 FROM broker_catalog c
       WHERE o.catalog_id=c.id AND c.source_mode='real' AND o.active AND o.provider_id=ANY($1::uuid[])`,
      [retired.map((p) => p.id)],
    );
    await db.query(
      `UPDATE broker_providers SET policy=jsonb_set(policy,'{autoBid}','false'::jsonb)
       WHERE id=ANY($1::uuid[]) AND policy->>'autoBid' IS DISTINCT FROM 'false'`,
      [retired.map((p) => p.id)],
    );
    const approved = (
      await db.query(
        'SELECT count(*)::int n FROM broker_catalog WHERE id=ANY($1::text[]) AND approved',
        [selected.map(({ item }) => item.id)],
      )
    ).rows[0].n;
    return {
      setupMode: mode,
      updateExisting,
      approvedConfigurations: approved,
      createdAccounts: created.length,
      providers: providerResults,
      retiredSuppliers: retired.length,
      commissionBps: 1500,
      note: 'Operator-managed Wick allocations. Existing credentials, sessions, reservations and frozen history preserved. No VMs allocated; demo billing only.',
    };
  });
}
