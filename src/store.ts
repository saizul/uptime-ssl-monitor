import Database from 'better-sqlite3';
import type { KeyValueCache } from './checks/domain.js';
import { initialState, type TargetState } from './state.js';
import type { CheckResult, ConfirmedStatus, Status } from './types.js';

const DAY_MS = 86_400_000;

export interface StoredResult {
  target: string;
  ts: number;
  status: Status;
  latencyMs: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface DailyRow {
  day: string;
  total: number;
  up: number;
  degraded: number;
  down: number;
  avgLatencyMs: number;
}

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export class Store implements KeyValueCache {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        message TEXT NOT NULL,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_results_target_ts ON results (target, ts);
      CREATE TABLE IF NOT EXISTS daily (
        target TEXT NOT NULL,
        day TEXT NOT NULL,
        total INTEGER NOT NULL,
        up INTEGER NOT NULL,
        degraded INTEGER NOT NULL,
        down INTEGER NOT NULL,
        latency_sum INTEGER NOT NULL,
        PRIMARY KEY (target, day)
      );
      CREATE TABLE IF NOT EXISTS state (target TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  /** Store a raw check result and fold it into the daily rollup. */
  insertResult(target: string, ts: number, result: CheckResult): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO results (target, ts, status, latency_ms, message, details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(target, ts, result.status, result.latencyMs, result.message, result.details ? JSON.stringify(result.details) : null);
      this.db
        .prepare(
          `INSERT INTO daily (target, day, total, up, degraded, down, latency_sum) VALUES (?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT (target, day) DO UPDATE SET
             total = total + 1, up = up + excluded.up, degraded = degraded + excluded.degraded,
             down = down + excluded.down, latency_sum = latency_sum + excluded.latency_sum`,
        )
        .run(target, dayOf(ts), result.status === 'up' ? 1 : 0, result.status === 'degraded' ? 1 : 0, result.status === 'down' ? 1 : 0, result.latencyMs);
    });
    tx();
  }

  recentResults(target: string, limit = 50): StoredResult[] {
    const rows = this.db
      .prepare('SELECT target, ts, status, latency_ms, message, details FROM results WHERE target = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(target, limit) as Array<{ target: string; ts: number; status: Status; latency_ms: number; message: string; details: string | null }>;
    return rows.map((r) => ({
      target: r.target,
      ts: r.ts,
      status: r.status,
      latencyMs: r.latency_ms,
      message: r.message,
      ...(r.details ? { details: JSON.parse(r.details) as Record<string, unknown> } : {}),
    }));
  }

  latestResult(target: string): StoredResult | undefined {
    return this.recentResults(target, 1)[0];
  }

  countResults(target?: string): number {
    const row = (target
      ? this.db.prepare('SELECT COUNT(*) AS n FROM results WHERE target = ?').get(target)
      : this.db.prepare('SELECT COUNT(*) AS n FROM results').get()) as { n: number };
    return row.n;
  }

  /** Daily rollups for the last `days` days (oldest first, only days with data). */
  dailyUptime(target: string, days: number, now: number): DailyRow[] {
    const since = dayOf(now - (days - 1) * DAY_MS);
    const rows = this.db
      .prepare('SELECT day, total, up, degraded, down, latency_sum FROM daily WHERE target = ? AND day >= ? ORDER BY day')
      .all(target, since) as Array<{ day: string; total: number; up: number; degraded: number; down: number; latency_sum: number }>;
    return rows.map((r) => ({
      day: r.day,
      total: r.total,
      up: r.up,
      degraded: r.degraded,
      down: r.down,
      avgLatencyMs: r.total > 0 ? Math.round(r.latency_sum / r.total) : 0,
    }));
  }

  getState(target: string): TargetState {
    const row = this.db.prepare('SELECT json FROM state WHERE target = ?').get(target) as { json: string } | undefined;
    return row ? { ...initialState(), ...(JSON.parse(row.json) as Partial<TargetState>) } : initialState();
  }

  saveState(target: string, state: TargetState): void {
    this.db.prepare('INSERT INTO state (target, json) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET json = excluded.json').run(target, JSON.stringify(state));
  }

  confirmedStatus(target: string): ConfirmedStatus {
    return this.getState(target).status;
  }

  get(key: string): { value: string; expiresAt: number } | undefined {
    const row = this.db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as { value: string; expires_at: number } | undefined;
    return row ? { value: row.value, expiresAt: row.expires_at } : undefined;
  }

  set(key: string, value: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').run(key, value, expiresAt);
  }

  /**
   * Delete raw results older than `retentionDays`. Daily rollups are kept for
   * a year so the 90-day bars survive short raw retention. Expired RDAP cache
   * entries are kept for a week as stale fallbacks.
   */
  prune(now: number, retentionDays: number): { results: number } {
    const results = this.db.prepare('DELETE FROM results WHERE ts < ?').run(now - retentionDays * DAY_MS).changes;
    this.db.prepare('DELETE FROM daily WHERE day < ?').run(dayOf(now - 400 * DAY_MS));
    this.db.prepare('DELETE FROM cache WHERE expires_at < ?').run(now - 7 * DAY_MS);
    return { results: Number(results) };
  }

  close(): void {
    this.db.close();
  }
}
