/** Native Wick IDs are stable identities; display names never select a route. */
export const CLOUD_PROVIDERS = [
  'e2b',
  'daytona',
  'provider-blaxel',
  'modal',
  'sail',
  'provider-tenki',
  'provider-freestyle',
  'boat',
] as const;

export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const PROVIDER_REGISTRY = [
  { id: 'e2b', name: 'E2B', envKey: 'E2B' },
  { id: 'daytona', name: 'Daytona', envKey: 'DAYTONA' },
  { id: 'provider-blaxel', name: 'Baseten', envKey: 'BLAXEL' },
  { id: 'modal', name: 'Modal', envKey: 'MODAL' },
  { id: 'sail', name: 'Sail', envKey: 'SAIL' },
  { id: 'provider-tenki', name: 'Tenki', envKey: 'TENKI' },
  { id: 'provider-freestyle', name: 'Freestyle', envKey: 'FREESTYLE' },
  { id: 'boat', name: 'Boat.dev', envKey: 'BOAT' },
] as const satisfies readonly { id: CloudProvider; name: string; envKey: string }[];

export const isCloudProvider = (value: string): value is CloudProvider =>
  (CLOUD_PROVIDERS as readonly string[]).includes(value);
