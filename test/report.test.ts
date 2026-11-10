import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { buildReport, buildTargetReport, findIncidents, formatReport, percentile } from '../src/report.js';
import { Store, type StoredResult } from '../src/store.js';
import { parseDuration } from '../src/util.js';

const MIN = 60_000;
const NOW = Date.UTC(2026, 5, 15, 12);
const r = (minutesAgo: number, status: StoredResult['status'], latencyMs = 100, message: string = status): StoredResult => ({
  target: 't',
  ts: NOW - minutesAgo * MIN,
  status,
  latencyMs,
  message,
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
  });
});

describe('findIncidents', () => {
  it('groups consecutive down checks and ends at the first recovery', () => {
    const results = [r(60, 'up'), r(50, 'down', 0, 'HTTP 500'), r(40, 'down', 0, 'timeout'), r(30, 'up'), r(20, 'degraded'), r(10, 'down', 0, 'refused'), r(5, 'up')];
    const inc = findIncidents(results, NOW);
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({ start: NOW - 50 * MIN, end: NOW - 30 * MIN, durationMs: 20 * MIN, checks: 2, message: 'HTTP 500' });
    expect(inc[1]).toMatchObject({ end: NOW - 5 * MIN, durationMs: 5 * MIN, checks: 1 });
  });

  it('treats degraded as the end of an incident and sorts unordered input', () => {
    const inc = findIncidents([r(10, 'degraded'), r(20, 'down')], NOW);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.durationMs).toBe(10 * MIN);
  });

  it('keeps an open incident running until now', () => {
    const inc = findIncidents([r(30, 'up'), r(20, 'down'), r(10, 'down')], NOW);
    expect(inc).toEqual([{ start: NOW - 20 * MIN, end: null, durationMs: 20 * MIN, checks: 2, message: 'down' }]);
  });

  it('returns nothing for healthy or empty input', () => {
    expect(findIncidents([], NOW)).toEqual([]);
    expect(findIncidents([r(2, 'up'), r(1, 'degraded')], NOW)).toEqual([]);
  });
});

describe('buildTargetReport', () => {
  it('computes uptime, latency and downtime', () => {
    const results = [r(50, 'up', 100), r(40, 'degraded', 300), r(30, 'down', 0), r(20, 'up', 200)];
    const t = buildTargetReport({ name: 't', type: 'http', results }, NOW);
    expect(t).toMatchObject({ checks: 4, up: 2, degraded: 1, down: 1, uptime: 75, avgLatencyMs: 200, p95LatencyMs: 300 });
    expect(t.downtimeMs).toBe(10 * MIN);
    expect(t.longestIncidentMs).toBe(10 * MIN);
  });

  it('has null metrics without data', () => {
    const t = buildTargetReport({ name: 't', type: 'tcp', results: [] }, NOW);
    expect(t).toMatchObject({ checks: 0, uptime: null, avgLatencyMs: null, p95LatencyMs: null, downtimeMs: 0, incidents: [] });
  });
});

describe('buildReport', () => {
  const inputs = [
    { name: 'a', type: 'http' as const, results: [r(2, 'up'), r(1, 'up')] },
    { name: 'b', type: 'tcp' as const, results: [r(2, 'down'), r(1, 'up')] },
    { name: 'c', type: 'tls' as const, results: [] },
  ];

  it('aggregates overall uptime and warns about empty targets', () => {
    const report = buildReport(inputs, NOW, 7 * 86_400_000, 30);
    expect(report.overallUptime).toBe(75);
    expect(report.from).toBe(NOW - 7 * 86_400_000);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('"c"');
  });

  it('warns when the window exceeds retention', () => {
    const report = buildReport(inputs.slice(0, 1), NOW, 40 * 86_400_000, 30);
    expect(report.warnings.join(' ')).toContain('retentionDays (30)');
  });

  it('has null overall uptime without any checks', () => {
    expect(buildReport([], NOW, 1000).overallUptime).toBeNull();
  });
});

describe('formatReport', () => {
  it('renders a table, incidents and notes', () => {
    const report = buildReport(
      [
        { name: 'api', type: 'http', results: [r(60, 'up', 120), r(30, 'down', 0, 'HTTP 503'), r(20, 'up', 180)] },
        { name: 'idle', type: 'tcp', results: [] },
      ],
      NOW,
      86_400_000,
    );
    const text = formatReport(report);
    expect(text).toContain('Uptime report 2026-06-14T12:00:00Z to 2026-06-15T12:00:00Z (24h 0m)');
    expect(text).toMatch(/api\s+66\.67%\s+3\s+1\s+10m 0s/);
    expect(text).toMatch(/idle\s+n\/a\s+0\s+0/);
    expect(text).toContain('Incidents for api:');
    expect(text).toContain('2026-06-15T11:30:00Z - 2026-06-15T11:40:00Z  10m 0s, 1 failed check(s): HTTP 503');
    expect(text).toContain('Note: No checks recorded for "idle"');
  });

  it('shows ongoing incidents and truncates long lists', () => {
    const results = Array.from({ length: 8 }, (_, i) => [r(200 - i * 20, 'down'), r(190 - i * 20, 'up')]).flat();
    results.push(r(5, 'down'));
    const text = formatReport(buildReport([{ name: 'x', type: 'http', results }], NOW, 86_400_000), 3);
    expect(text).toContain('- ongoing');
    expect(text).toContain('6 earlier incident(s) not shown');
  });
});

describe('parseDuration weeks', () => {
  it('accepts a w unit', () => {
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
  });
});

describe('Store.resultsBetween', () => {
  it('returns the window oldest first and per target', () => {
    const store = new Store(':memory:');
    store.insertResult('a', NOW - 3 * MIN, { status: 'up', latencyMs: 1, message: 'old' });
    store.insertResult('a', NOW - 1 * MIN, { status: 'down', latencyMs: 0, message: 'new', details: { code: 500 } });
    store.insertResult('b', NOW - 1 * MIN, { status: 'up', latencyMs: 1, message: 'other' });
    const rows = store.resultsBetween('a', NOW - 2 * MIN, NOW);
    expect(rows.map((x) => x.message)).toEqual(['new']);
    expect(rows[0]!.details).toEqual({ code: 500 });
    expect(store.resultsBetween('a', 0, NOW).map((x) => x.message)).toEqual(['old', 'new']);
    store.close();
  });
});

describe('monitor report', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-report-'));
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { stdout.push(String(s)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { stderr.push(String(s)); return true; });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(): string {
    const db = join(dir, 'm.db');
    const store = new Store(db);
    const now = Date.now();
    store.insertResult('Site', now - 3 * 86_400_000, { status: 'up', latencyMs: 100, message: 'ok' });
    store.insertResult('Site', now - 2 * 86_400_000, { status: 'down', latencyMs: 0, message: 'HTTP 500' });
    store.insertResult('Site', now - 2 * 86_400_000 + 5 * MIN, { status: 'up', latencyMs: 120, message: 'ok' });
    store.insertResult('Site', now - 30 * 86_400_000, { status: 'down', latencyMs: 0, message: 'ancient' });
    store.close();
    const path = join(dir, 'monitor.yaml');
    writeFileSync(path, `database: ${db}\ntargets:\n  - { name: Site, type: http, url: "http://127.0.0.1:9/" }\n  - { name: Other, type: tcp, host: 127.0.0.1, port: 9 }\n`);
    return path;
  }

  it('prints a text summary for the default 7 day window', async () => {
    expect(await main(['report', '-c', setup()])).toBe(0);
    const text = stdout.join('');
    expect(text).toMatch(/Site\s+66\.67%\s+3\s+1/);
    expect(text).toContain('HTTP 500');
    expect(text).not.toContain('ancient');
    expect(text).toContain('No checks recorded for "Other"');
  });

  it('honours --since, --only and --json', async () => {
    const path = setup();
    expect(await main(['report', '-c', path, '--since', '1d', '--only', 'site', '--json'])).toBe(0);
    const data = JSON.parse(stdout.join('')) as { windowMs: number; targets: Array<{ name: string; checks: number }> };
    expect(data.windowMs).toBe(86_400_000);
    expect(data.targets).toEqual([expect.objectContaining({ name: 'Site', checks: 0 })]);
  });

  it('rejects bad input with exit code 2', async () => {
    const path = setup();
    expect(await main(['report', '-c', path, '--since', 'soon'])).toBe(2);
    expect(await main(['report', '-c', path, '--since', '0d'])).toBe(2);
    expect(await main(['report', '-c', path, '--only', 'nope'])).toBe(2);
    expect(stderr.join('')).toContain('Unknown target(s): nope');
  });
});
