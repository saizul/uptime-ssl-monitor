import type { MaintenanceWindow } from './types.js';

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse "500ms", "30s", "5m", "2h", "1d", "1w" or a plain number (milliseconds). */
export function parseDuration(value: unknown, label = 'duration'): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/.exec(value);
    if (m) return Math.round(Number(m[1]) * (UNITS[m[2] as string] as number));
  }
  throw new Error(`Invalid ${label}: ${JSON.stringify(value)} (use e.g. "30s", "5m", "1h")`);
}

/** Delay for the next run: interval plus/minus up to `jitter` (fraction) of it. */
export function jitteredDelay(intervalMs: number, jitter: number, rng: () => number = Math.random): number {
  const spread = intervalMs * jitter;
  const delay = intervalMs + (rng() * 2 - 1) * spread;
  return Math.max(1, Math.round(delay));
}

/** Whole days between two timestamps (floor); negative when `to` is in the past. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / 86_400_000);
}

/** Does certificate name `pattern` (maybe `*.example.com`) cover `host`? */
export function nameMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1);
    return h.endsWith(suffix) && h.slice(0, -suffix.length).length > 0 && !h.slice(0, -suffix.length).includes('.');
  }
  return false;
}

/** Match an HTTP status against numbers and class patterns such as "2xx". */
export function statusMatches(code: number, expected: Array<number | string>): boolean {
  return expected.some((e) => {
    if (typeof e === 'number') return e === code;
    const m = /^([1-5])xx$/i.exec(e);
    if (m) return Math.floor(code / 100) === Number(m[1]);
    return Number(e) === code;
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** The first maintenance window that covers `target` at time `now`, if any. */
export function activeMaintenance(windows: MaintenanceWindow[], target: string, now: number): MaintenanceWindow | undefined {
  return windows.find((w) => now >= w.start && now < w.end && (w.targets.length === 0 || w.targets.includes(target)));
}
