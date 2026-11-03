import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRepositoryPreparation } from '../src/server/coding/preparation.js';

afterEach(() => vi.restoreAllMocks());
function pool(count = 0) {
  return { query: vi.fn(async () => ({ rowCount: count })) } as unknown as Pool;
}

describe('repository preparation admission', () => {
  it('rejects full job capacity before contacting GitHub', async () => {
    const verify = vi.fn(async () => 'verified');
    for (const kind of ['coding', 'studio'] as const)
      await expect(withRepositoryPreparation(pool(4), 'buyer', kind, verify)).rejects.toMatchObject(
        { statusCode: 429 },
      );
    expect(verify).not.toHaveBeenCalled();
  });

  it('shares the per-owner rate budget across task entry points and releases failed work', async () => {
    const db = pool();
    const verify = vi.fn(async () => {
      throw new Error('unavailable');
    });
    for (let i = 0; i < 12; i++)
      await expect(
        withRepositoryPreparation(db, 'buyer', i % 2 ? 'coding' : 'studio', verify),
      ).rejects.toThrow('unavailable');
    await expect(withRepositoryPreparation(db, 'buyer', 'studio', verify)).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(verify).toHaveBeenCalledTimes(12);
    expect(db.query).toHaveBeenCalledTimes(12);
  });

  it('bounds owner concurrency and preserves it when a rate window rolls over', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const db = pool();
    let done!: () => void;
    const gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    const first = withRepositoryPreparation(db, 'buyer', 'coding', () => gate);
    const second = withRepositoryPreparation(db, 'buyer', 'studio', () => gate);
    now += 60_001;
    await expect(
      withRepositoryPreparation(db, 'buyer', 'coding', async () => {}),
    ).rejects.toMatchObject({ statusCode: 429 });
    done();
    await Promise.all([first, second]);
    await expect(withRepositoryPreparation(db, 'buyer', 'studio', async () => 'ok')).resolves.toBe(
      'ok',
    );
  });

  it('bounds global concurrent preparation across owners', async () => {
    const db = pool();
    let done!: () => void;
    const gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
      withRepositoryPreparation(db, `buyer-${index}`, 'coding', () => gate),
    );
    await expect(
      withRepositoryPreparation(db, 'another-buyer', 'studio', async () => {}),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(db.query).toHaveBeenCalledTimes(8);
    done();
    await Promise.all(pending);
  });
});
