import { PROVIDER_REGISTRY } from '../src/shared/providers.js';
import type { ProviderMarketplaceSetup } from '../src/server/marketplace/configure-real.js';

/** Parse explicit selections without ever returning credentials in diagnostics. */
export function providerSetupOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
): ProviderMarketplaceSetup {
  let selection = env.REAL_PROVIDER_IDS ?? '';
  let mode: 'stage' | 'activate' = 'stage';
  let modeChosen = false;
  let updateExisting = false;
  let subsetChosen = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--providers' && !subsetChosen) {
      selection = args[++index] ?? '';
      subsetChosen = true;
      if (!selection || selection.startsWith('--'))
        throw new Error('Supply a comma-separated provider subset.');
    } else if ((arg === '--stage' || arg === '--activate') && !modeChosen) {
      mode = arg === '--activate' ? 'activate' : 'stage';
      modeChosen = true;
    } else if (arg === '--update-existing' && !updateExisting) {
      updateExisting = true;
    } else
      throw new Error(
        'Use --providers <ids>, optional --stage or --activate, and optional --update-existing.',
      );
  }
  const tokens = selection
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) throw new Error('Explicit --providers or REAL_PROVIDER_IDS is required.');
  const providers = tokens.map((token) => {
    const identity = PROVIDER_REGISTRY.find(
      (entry) => entry.id === token || entry.envKey.toLowerCase() === token,
    );
    if (!identity)
      throw new Error('Choose only registered native provider IDs or environment keys.');
    const prefix = `REAL_PROVIDER_${identity.envKey}`;
    const autoBid = env[`${prefix}_AUTO_BID`] ?? 'true';
    if (!['true', 'false'].includes(autoBid))
      throw new Error('Provider auto-bid must be true or false.');
    return {
      cloudProvider: identity.id,
      name: identity.name,
      email: env[`${prefix}_EMAIL`] ?? '',
      password: env[`${prefix}_PASSWORD`] || undefined,
      catalogIds: (env[`${prefix}_CATALOG_IDS`] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      capacity: Number(env[`${prefix}_CAPACITY`] ?? env.REAL_PROVIDER_CAPACITY ?? '1'),
      autoBid: autoBid === 'true',
    };
  });
  if (new Set(providers.map((provider) => provider.cloudProvider)).size !== providers.length)
    throw new Error('Choose each provider once.');
  return {
    providers,
    mode,
    updateExisting,
    retireSupplierEmails: (env.REAL_RETIRED_SUPPLIER_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
