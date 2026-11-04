import type { CatalogItem } from '../shared/types';
import type { Session } from './api';

export type DemoRole = 'buyer' | 'seller';
export function demoLocation(
  location = typeof window === 'undefined' ? '' : window.location.pathname + window.location.search,
) {
  const match = /^\/demo(?:\/(buyer|seller))?(\/[^?]*)?(\?.*)?$/.exec(location);
  if (!match) return null;
  const role: DemoRole = match[1] === 'seller' ? 'seller' : 'buyer';
  const path =
    !match[2] || match[2] === '/'
      ? role === 'seller'
        ? '/provider/capacity'
        : '/orders'
      : match[2];
  return { role, path, search: match[3] ?? '', prefix: `/demo/${role}` };
}
export const demoCatalog: CatalogItem[] = ['modal', 'daytona', 'e2b'].map((provider) => ({
  id: `demo-micro-${provider}`,
  name: `${provider === 'modal' ? 'Modal' : provider === 'daytona' ? 'Daytona' : 'E2B'} Micro`,
  description: 'Linux development environment with Python, Node.js and a browser terminal.',
  provider,
  profile: 'micro',
  region: 'us-east-1',
  cpu: 2,
  memoryGb: 4,
  durationMinutes: [15, 30, 60],
  approved: true,
  capabilities: ['terminal', 'shared-disk'],
}));

// These objects exist only in this tab. They never contain account data or usable credentials.
export interface DemoStore {
  role: DemoRole;
  now: string;
  buyer?: any;
  seller?: any;
  keys: any[];
  completed: string[];
  draft?: unknown;
  drafts: Record<string, unknown>;
}
let stores: Partial<Record<DemoRole, DemoStore>> = {};
export function getDemoStore(role: DemoRole): DemoStore {
  return (stores[role] ??= {
    role,
    now: new Date().toISOString(),
    keys: [],
    completed: [],
    drafts: {},
  });
}
export function resetDemoStores() {
  stores = {};
}
export const demoAwareDraftStorage = {
  getItem(key: string): string | null {
    const demo = demoLocation();
    return demo
      ? ((getDemoStore(demo.role).drafts[key] as string | undefined) ?? null)
      : sessionStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    const demo = demoLocation();
    if (demo) getDemoStore(demo.role).drafts[key] = value;
    else sessionStorage.setItem(key, value);
  },
  removeItem(key: string) {
    const demo = demoLocation();
    if (demo) delete getDemoStore(demo.role).drafts[key];
    else sessionStorage.removeItem(key);
  },
};
export class DemoError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function demoSession(role: DemoRole): Session {
  return {
    user:
      role === 'buyer'
        ? { id: 'demo-buyer', name: 'Alex Morgan', email: 'alex@example.invalid', role: 'buyer' }
        : {
            id: 'demo-seller',
            name: 'Sample Cloud',
            email: 'seller@example.invalid',
            role: 'provider',
            providerId: 'demo-provider',
          },
    modes: { wick: 'fixture', muse: 'fixture' },
    catalog: demoCatalog,
    commissionBps: 1500,
  };
}
export function demoHref(href: string, role: DemoRole) {
  if (
    !href.startsWith('/') ||
    href.startsWith('//') ||
    /^\/(demo(?:s|\/|$)|login(?:[/?]|$))/.test(href) ||
    href === '/'
  )
    return href;
  return `/demo/${role}${href}`;
}
export function demoDownloadHref(href: string, contents: string | null | undefined) {
  return demoLocation()
    ? `data:text/plain;charset=utf-8,${encodeURIComponent(contents ?? '')}`
    : href;
}
