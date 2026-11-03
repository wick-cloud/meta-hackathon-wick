import type { Pool } from 'pg';
import { requestLimit } from '../request-limits.js';

interface PreparationState {
  active: number;
  owners: Map<string, { until: number; attempts: number; active: number }>;
}
const states = new WeakMap<Pool, PreparationState>();

/** Bound anonymous metadata calls before transactional job admission. */
export async function withRepositoryPreparation<T>(
  pool: Pool,
  ownerId: string,
  kind: 'coding' | 'studio',
  work: () => Promise<T>,
): Promise<T> {
  let state = states.get(pool);
  if (!state) {
    state = { active: 0, owners: new Map() };
    states.set(pool, state);
  }
  const now = Date.now();
  let owner = state.owners.get(ownerId);
  if (!owner || owner.until <= now) {
    if (state.owners.size >= 4000)
      for (const [id, entry] of state.owners)
        if (entry.until <= now && !entry.active) state.owners.delete(id);
    if (state.owners.size >= 4000 && !state.owners.has(ownerId)) throw requestLimit();
    if (owner) {
      owner.until = now + 60_000;
      owner.attempts = 0;
    } else owner = { until: now + 60_000, attempts: 0, active: 0 };
    state.owners.set(ownerId, owner);
  }
  if (owner.attempts >= 12) throw requestLimit(Math.max(1, Math.ceil((owner.until - now) / 1000)));
  if (state.active >= 8 || owner.active >= 2) throw requestLimit(1);
  owner.attempts++;
  owner.active++;
  state.active++;
  try {
    const capacity = await pool.query(
      kind === 'coding'
        ? "SELECT id FROM broker_coding_jobs WHERE status NOT IN('stopped','failed','ready') LIMIT 4"
        : "SELECT id FROM broker_studio_tasks WHERE status NOT IN('completed','failed','stopped') LIMIT 4",
    );
    if (capacity.rowCount === 4) throw requestLimit();
    // This is an early rejection only. The locked transaction remains authoritative.
    return await work();
  } finally {
    owner.active--;
    state.active--;
  }
}
