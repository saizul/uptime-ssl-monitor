import type { StoredResult } from './store.js';
import type { Target } from './types.js';
import { formatDuration } from './util.js';

export interface Incident {
  /** Timestamp of the first failed check. */
  start: number;
  /** Timestamp of the first check that was no longer down; null while the incident is ongoing. */
  end: number | null;
  durationMs: number;
  /** Number of consecutive failed checks. */
  checks: number;
  /** Message of the first failed check. */
  message: string;
}

export interface TargetReport {
  name: string;
  type: Target['type'];
  checks: number;
  up: number;
  degraded: number;
  down: number;
  /** Percent of checks that were up or degraded (same definition as the status page), or null without data. */
  uptime: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  incidents: Incident[];
  downtimeMs: number;
  longestIncidentMs: number;
}

export interface Report {
  from: number;
  to: number;
  windowMs: number;
  targets: TargetReport[];
  /** Percent of all checks in the window that were up or degraded, or null without data. */
  overallUptime: number | null;
  warnings: string[];
}

export interface ReportInput {
  name: string;
  type: Target['type'];
  /** Results inside the window, in any order. */
  results: StoredResult[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/**
 * Group consecutive `down` results into incidents. An incident ends at the first later result that is
 * not down. An incident that is still open at `now` lasts until `now`.
 */
export function findIncidents(results: StoredResult[], now: number): Incident[] {
  const ordered = [...results].sort((a, b) => a.ts - b.ts);
  const incidents: Incident[] = [];
  let open: Incident | undefined;
  for (const r of ordered) {
    if (r.status === 'down') {
      if (open) open.checks += 1;
      else {
        open = { start: r.ts, end: null, durationMs: 0, checks: 1, message: r.message };
        incidents.push(open);
      }
    } else if (open) {
      open.end = r.ts;
      open.durationMs = Math.max(0, r.ts - open.start);
      open = undefined;
    }
  }
  if (open) open.durationMs = Math.max(0, now - open.start);
  return incidents;
}

export function buildTargetReport(input: ReportInput, now: number): TargetReport {
  const counts = { up: 0, degraded: 0, down: 0 };
  const latencies: number[] = [];
  for (const r of input.results) {
    counts[r.status] += 1;
    if (r.status !== 'down') latencies.push(r.latencyMs);
  }
  const checks = input.results.length;
  const incidents = findIncidents(input.results, now);
  const avg = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  return {
    name: input.name,
    type: input.type,
    checks,
    ...counts,
    uptime: checks > 0 ? round2(((counts.up + counts.degraded) / checks) * 100) : null,
    avgLatencyMs: avg,
    p95LatencyMs: percentile(latencies, 95),
    incidents,
    downtimeMs: incidents.reduce((sum, i) => sum + i.durationMs, 0),
    longestIncidentMs: incidents.reduce((max, i) => Math.max(max, i.durationMs), 0),
  };
}

export function buildReport(inputs: ReportInput[], now: number, windowMs: number, retentionDays?: number): Report {
  const targets = inputs.map((i) => buildTargetReport(i, now));
  const checks = targets.reduce((n, t) => n + t.checks, 0);
  const available = targets.reduce((n, t) => n + t.up + t.degraded, 0);
  const warnings: string[] = [];
  if (retentionDays !== undefined && windowMs > retentionDays * 86_400_000) {
    warnings.push(`The window is longer than retentionDays (${retentionDays}); older checks were pruned, so the numbers cover less than the full window.`);
  }
  for (const t of targets) {
    if (t.checks === 0) warnings.push(`No checks recorded for "${t.name}" in this window (run "monitor run", or "monitor check --record").`);
  }
  return {
    from: now - windowMs,
    to: now,
    windowMs,
    targets,
    overallUptime: checks > 0 ? round2((available / checks) * 100) : null,
    warnings,
  };
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${v.toFixed(2)}%`);
const ms = (v: number | null): string => (v === null ? 'n/a' : formatDuration(v));
const iso = (ts: number): string => new Date(ts).toISOString().replace('.000Z', 'Z');

/** Plain-text summary. `maxIncidents` limits the incident lines shown per target. */
export function formatReport(report: Report, maxIncidents = 5): string {
  const lines = [`Uptime report ${iso(report.from)} to ${iso(report.to)} (${formatDuration(report.windowMs)})`, ''];
  const width = Math.max(...report.targets.map((t) => t.name.length), 6);
  lines.push(`${'Target'.padEnd(width)}  ${'Uptime'.padStart(8)}  ${'Checks'.padStart(6)}  ${'Incidents'.padStart(9)}  ${'Downtime'.padStart(9)}  ${'Avg'.padStart(7)}  ${'p95'.padStart(7)}`);
  for (const t of report.targets) {
    lines.push(
      `${t.name.padEnd(width)}  ${pct(t.uptime).padStart(8)}  ${String(t.checks).padStart(6)}  ${String(t.incidents.length).padStart(9)}  ${(t.downtimeMs > 0 ? formatDuration(t.downtimeMs) : '-').padStart(9)}  ${ms(t.avgLatencyMs).padStart(7)}  ${ms(t.p95LatencyMs).padStart(7)}`,
    );
  }
  lines.push('', `Overall uptime: ${pct(report.overallUptime)}`);
  for (const t of report.targets.filter((x) => x.incidents.length > 0)) {
    lines.push('', `Incidents for ${t.name}:`);
    for (const i of t.incidents.slice(-maxIncidents)) {
      const span = i.end === null ? `${iso(i.start)} - ongoing` : `${iso(i.start)} - ${iso(i.end)}`;
      lines.push(`  ${span}  ${formatDuration(i.durationMs)}, ${i.checks} failed check(s): ${i.message}`);
    }
    if (t.incidents.length > maxIncidents) lines.push(`  ... ${t.incidents.length - maxIncidents} earlier incident(s) not shown (use --json for all)`);
  }
  for (const w of report.warnings) lines.push('', `Note: ${w}`);
  return lines.join('\n');
}
