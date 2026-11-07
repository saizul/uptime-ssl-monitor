import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { initialState } from '../src/state.js';
import type { CheckResult } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);
const res = (status: CheckResult['status'], latencyMs = 100, message = 'm'): CheckResult => ({ status, latencyMs, message });

let store: Store;
afterEach(() => store?.close());

describe('Store results', () => {
  it('stores and returns results newest first', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW, res('up', 120, 'first'));
    store.insertResult('a', NOW + 1000, { ...res('down', 0, 'second'), details: { statusCode: 500 } });
    const rows = store.recentResults('a');
    expect(rows.map((r) => r.message)).toEqual(['second', 'first']);
    expect(rows[0]!.details).toEqual({ statusCode: 500 });
    expect(store.latestResult('a')?.status).toBe('down');
    expect(store.latestResult('missing')).toBeUndefined();
    expect(store.countResults()).toBe(2);
    expect(store.countResults('a')).toBe(2);
  });

  it('aggregates daily counters', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW, res('up', 100));
    store.insertResult('a', NOW + 1, res('up', 300));
    store.insertResult('a', NOW + 2, res('degraded', 200));
    store.insertResult('a', NOW + 3, res('down', 0));
    store.insertResult('a', NOW - DAY, res('up', 50));
    const days = store.dailyUptime('a', 90, NOW);
    expect(days).toEqual([
      { day: '2026-06-14', total: 1, up: 1, degraded: 0, down: 0, avgLatencyMs: 50 },
      { day: '2026-06-15', total: 4, up: 2, degraded: 1, down: 1, avgLatencyMs: 150 },
    ]);
  });

  it('limits daily rows to the requested window', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW - 100 * DAY, res('up'));
    store.insertResult('a', NOW - 10 * DAY, res('up'));
    expect(store.dailyUptime('a', 90, NOW)).toHaveLength(1);
    expect(store.dailyUptime('a', 120, NOW)).toHaveLength(2);
  });

  it('keeps targets separate', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW, res('up'));
    store.insertResult('b', NOW, res('down'));
    expect(store.dailyUptime('a', 7, NOW)[0]!.down).toBe(0);
    expect(store.dailyUptime('b', 7, NOW)[0]!.down).toBe(1);
  });
});

describe('Store retention', () => {
  it('prunes old raw results but keeps rollups', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW - 40 * DAY, res('up'));
    store.insertResult('a', NOW - 5 * DAY, res('up'));
    expect(store.prune(NOW, 30)).toEqual({ results: 1 });
    expect(store.countResults()).toBe(1);
    expect(store.dailyUptime('a', 90, NOW)).toHaveLength(2);
  });

  it('drops rollups older than a year', () => {
    store = new Store(':memory:');
    store.insertResult('a', NOW - 500 * DAY, res('up'));
    store.prune(NOW, 30);
    expect(store.dailyUptime('a', 800, NOW)).toHaveLength(0);
  });
});

describe('Store state and cache', () => {
  it('returns a fresh state for unknown targets and round-trips saved state', () => {
    store = new Store(':memory:');
    expect(store.getState('x')).toEqual(initialState());
    const s = { ...initialState(), status: 'down' as const, flapping: true, transitions: [1, 2], lastChange: 5 };
    store.saveState('x', s);
    expect(store.getState('x')).toEqual(s);
    expect(store.confirmedStatus('x')).toBe('down');
  });

  it('stores cache entries and overwrites them', () => {
    store = new Store(':memory:');
    expect(store.get('k')).toBeUndefined();
    store.set('k', 'v1', 100);
    store.set('k', 'v2', 200);
    expect(store.get('k')).toEqual({ value: 'v2', expiresAt: 200 });
  });

  it('persists on disk across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monitor-store-'));
    try {
      const path = join(dir, 'm.db');
      const first = new Store(path);
      first.insertResult('a', NOW, res('up'));
      first.close();
      store = new Store(path);
      expect(store.countResults('a')).toBe(1);
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
