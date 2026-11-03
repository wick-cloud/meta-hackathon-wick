import { describe, expect, it, vi } from 'vitest';
import type { WipData } from 'pg-boss';
import { createReadinessProbe, workersReady } from '../src/server/readiness.js';

function worker(patch: Partial<WipData> = {}): WipData {
  return {
    id: 'one',
    workId: 'one',
    name: 'auctions',
    options: {},
    state: 'active',
    count: 0,
    createdOn: 100000,
    lastFetchedOn: 100000,
    lastJobStartedOn: null,
    lastJobEndedOn: null,
    lastJobDuration: null,
    lastError: null,
    lastErrorOn: null,
    ...patch,
  };
}

describe('worker and dependency readiness', () => {
  const expected = new Set(['auctions']);
  it('rejects missing, stopped and stalled consumers, but accepts current polling', () => {
    expect(workersReady([], expected, 110000)).toBe(false);
    expect(workersReady([worker()], new Set(), 110000)).toBe(false);
    expect(workersReady([worker({ state: 'stopping' })], expected, 110000)).toBe(false);
    expect(workersReady([worker()], expected, 200000)).toBe(false);
    expect(workersReady([worker()], expected, 110000)).toBe(true);
  });
  it('allows a bounded running job without mistaking it for a stalled idle poll', () => {
    const running = worker({ count: 1, lastJobStartedOn: 100000 });
    expect(workersReady([running], expected, 200000)).toBe(true);
    expect(workersReady([running], expected, 1100000)).toBe(false);
  });
  it('requires both pools and recovers after queue connection failure', async () => {
    const db = vi.fn().mockResolvedValue({});
    const queue = vi.fn().mockRejectedValueOnce(Error('queue down')).mockResolvedValue({});
    const probe = createReadinessProbe(db, queue, { cacheMs: 0 });
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(true);
    expect(queue).toHaveBeenCalledTimes(2);
  });
  it('bounds response time and coalesces slow queries across repeated public requests', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = vi.fn(() => pending),
      queue = vi.fn().mockResolvedValue({});
    const probe = createReadinessProbe(db, queue, { timeoutMs: 10 });
    expect(await Promise.all(Array.from({ length: 20 }, () => probe()))).toEqual(
      Array(20).fill(false),
    );
    expect(await probe()).toBe(false);
    expect(db).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    release();
    expect(await probe()).toBe(true);
  });
  it('does not release a pending probe when the other database fails first', async () => {
    let release!: () => void;
    const db = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const queue = vi.fn().mockRejectedValue(Error('queue disconnected'));
    const probe = createReadinessProbe(db, queue, { timeoutMs: 10 });
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
    expect(db).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    release();
    expect(await probe()).toBe(false);
  });
});
