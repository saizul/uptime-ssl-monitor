import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { applyResult, initialState } from '../src/state.js';
import { buildStatusModel, classifyDay, renderStatusPage, writeStatusPage } from '../src/statuspage.js';
import { Store } from '../src/store.js';
import type { CheckResult, Status } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);
const config = parseConfig(`
statusPage: { title: "Acme <Status>", description: "Live & kicking" }
targets:
  - { name: Website, type: http, url: "https://example.com" }
  - { name: "API & Co", type: tcp, host: h, port: 1 }
  - { name: Secret, type: tcp, host: h, port: 2, hidden: true }
`);
const res = (status: Status, latencyMs = 100, message: string = status): CheckResult => ({ status, latencyMs, message });

let store: Store;
let dir: string | undefined;
afterEach(() => {
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function confirm(name: string, status: Status): void {
  const opts = { retries: 0, recovery: 1, flap: { windowMs: 1, threshold: 99 } };
  store.saveState(name, applyResult(initialState(), status, NOW, opts).state);
}

describe('classifyDay', () => {
  it.each([
    [0, 0, 0, 0, 'none'], [100, 100, 0, 0, 'up'], [100, 90, 10, 0, 'degraded'],
    [1000, 999, 0, 1, 'degraded'], [100, 90, 0, 10, 'down'], [100, 99, 0, 1, 'down'],
  ] as const)('total=%i up=%i degraded=%i down=%i is %s', (total, up, degraded, down, expected) => {
    expect(classifyDay(total, up, degraded, down)).toBe(expected);
  });
});

describe('buildStatusModel', () => {
  it('builds 90 day bars and the uptime figure', () => {
    store = new Store(':memory:');
    for (let i = 0; i < 10; i++) store.insertResult('Website', NOW - 2 * DAY + i, res('up'));
    store.insertResult('Website', NOW - DAY, res('up'));
    store.insertResult('Website', NOW - DAY + 1, res('down'));
    store.insertResult('Website', NOW, res('degraded', 900));
    confirm('Website', 'up');
    const model = buildStatusModel(config, store, NOW);
    const site = model.targets[0]!;
    expect(site.days).toHaveLength(90);
    expect(site.days.at(-1)).toMatchObject({ day: '2026-06-15', status: 'degraded' });
    expect(site.days.at(-2)).toMatchObject({ day: '2026-06-14', status: 'down', uptime: 50 });
    expect(site.days.at(-3)).toMatchObject({ status: 'up', uptime: 100, checks: 10 });
    expect(site.days[0]!.status).toBe('none');
    expect(site.uptime90).toBeCloseTo(((10 + 1 + 1) / 13) * 100, 1);
    expect(site.latencyMs).toBe(900);
  });

  it('hides hidden targets and reports unknown state without data', () => {
    store = new Store(':memory:');
    const model = buildStatusModel(config, store, NOW);
    expect(model.targets.map((t) => t.name)).toEqual(['Website', 'API & Co']);
    expect(model.targets[0]).toMatchObject({ status: 'unknown', uptime90: null, message: 'No data yet' });
    expect(model.overall).toBe('unknown');
  });

  it.each([
    [['up', 'up'], 'operational'], [['up', 'degraded'], 'degraded'], [['down', 'degraded'], 'outage'], [['up', 'down'], 'outage'],
  ] as const)('overall status for %j is %s', (states, overall) => {
    store = new Store(':memory:');
    confirm('Website', states[0]);
    confirm('API & Co', states[1]);
    expect(buildStatusModel(config, store, NOW).overall).toBe(overall);
  });
});

describe('renderStatusPage', () => {
  function render(): string {
    store = new Store(':memory:');
    store.insertResult('Website', NOW, res('up', 80, 'HTTP 200 in 80ms'));
    store.insertResult('API & Co', NOW, res('down', 0, '<script>alert(1)</script>'));
    confirm('Website', 'up');
    confirm('API & Co', 'down');
    return renderStatusPage(buildStatusModel(config, store, NOW));
  }

  it('produces a responsive HTML5 document with theme support', () => {
    const html = render();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('data-theme=dark');
    expect(html).toContain('@media (max-width:520px)');
    expect(html).toContain('id="theme"');
  });

  it('renders 90 bars per visible target', () => {
    const html = render();
    expect((html.match(/class="bar /g) ?? []).length).toBe(180);
    expect(html).toContain('class="bar up"');
    expect(html).toContain('class="bar none"');
  });

  it('shows the overall banner, status pills and uptime', () => {
    const html = render();
    expect(html).toContain('class="banner outage"');
    expect(html).toContain('Some systems are down');
    expect(html).toContain('<span class="pill up">Operational</span>');
    expect(html).toContain('<span class="pill down">Down</span>');
    expect(html).toContain('100% uptime');
  });

  it('escapes every piece of user supplied text', () => {
    const html = render();
    expect(html).toContain('<title>Acme &lt;Status&gt;</title>');
    expect(html).toContain('Live &amp; kicking');
    expect(html).toContain('API &amp; Co');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not list hidden targets', () => {
    expect(render()).not.toContain('Secret');
  });
});

describe('writeStatusPage', () => {
  it('writes index.html and status.json', () => {
    store = new Store(':memory:');
    store.insertResult('Website', NOW, res('up'));
    dir = mkdtempSync(join(tmpdir(), 'monitor-page-'));
    const out = join(dir, 'nested', 'site');
    const model = writeStatusPage(config, store, out, NOW);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<h1>Acme &lt;Status&gt;</h1>');
    const json = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
    expect(json.targets).toHaveLength(2);
    expect(json.generatedAt).toBe(NOW);
    expect(model.targets).toHaveLength(2);
  });
});
