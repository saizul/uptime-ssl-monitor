import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, selectTargets } from '../src/cli.js';
import { Store } from '../src/store.js';
import { closedPort, startHttpServer } from './helpers/servers.js';

let server: Awaited<ReturnType<typeof startHttpServer>>;
let dir: string;
let stdout: string[];
let stderr: string[];

beforeAll(async () => { server = await startHttpServer(); });
afterAll(async () => { await server.close(); });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'monitor-cli-'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { stdout.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { stderr.push(String(s)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(targets: string, extra = ''): string {
  const path = join(dir, 'monitor.yaml');
  writeFileSync(path, `database: ${join(dir, 'm.db')}\n${extra}\ndefaults: { retries: 0, timeout: 2s }\ntargets:\n${targets}`);
  return path;
}

const goodTarget = (): string => `  - { name: Good, type: http, url: "http://127.0.0.1:${server.port}/ok" }\n`;
const badTarget = (): string => `  - { name: Bad, type: http, url: "http://127.0.0.1:${server.port}/error" }\n`;
const slowTarget = (): string => `  - { name: Slow, type: http, url: "http://127.0.0.1:${server.port}/slow", maxResponseTime: 20ms }\n`;

describe('monitor check', () => {
  it('exits 0 when everything is up', async () => {
    const code = await main(['check', '-c', writeConfig(goodTarget())]);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('[ UP ] Good');
    expect(stdout.join('')).toContain('1/1 healthy');
  });

  it('exits 1 when a target is down', async () => {
    const code = await main(['check', '-c', writeConfig(goodTarget() + badTarget())]);
    expect(code).toBe(1);
    expect(stdout.join('')).toContain('[DOWN] Bad');
    expect(stdout.join('')).toContain('1/2 healthy');
  });

  it('treats degraded as success unless --fail-on degraded', async () => {
    const path = writeConfig(slowTarget());
    expect(await main(['check', '-c', path])).toBe(0);
    expect(stdout.join('')).toContain('[WARN] Slow');
    expect(await main(['check', '-c', path, '--fail-on', 'degraded'])).toBe(1);
  });

  it('prints JSON', async () => {
    const code = await main(['check', '-c', writeConfig(goodTarget() + badTarget()), '--json']);
    const data = JSON.parse(stdout.join(''));
    expect(code).toBe(1);
    expect(data.map((d: { name: string; status: string }) => [d.name, d.status])).toEqual([['Good', 'up'], ['Bad', 'down']]);
  });

  it('can check a subset with --only', async () => {
    const code = await main(['check', '-c', writeConfig(goodTarget() + badTarget()), '--only', 'Good']);
    expect(code).toBe(0);
    expect(stdout.join('')).not.toContain('Bad');
  });

  it('adds ok and checkedAt to every JSON entry', async () => {
    const path = writeConfig(goodTarget() + slowTarget() + badTarget());
    await main(['check', '-c', path, '--json']);
    const data = JSON.parse(stdout.join(''));
    expect(data.map((d: { name: string; ok: boolean }) => [d.name, d.ok])).toEqual([['Good', true], ['Slow', true], ['Bad', false]]);
    for (const d of data) {
      expect(d).toEqual(expect.objectContaining({ type: 'http', latencyMs: expect.any(Number), message: expect.any(String) }));
      expect(new Date(d.checkedAt).toISOString()).toBe(d.checkedAt);
    }
    stdout.length = 0;
    await main(['check', '-c', path, '--json', '--fail-on', 'degraded']);
    const strict = JSON.parse(stdout.join(''));
    expect(strict.map((d: { ok: boolean }) => d.ok)).toEqual([true, false, false]);
  });

  it('filters JSON output with --only (repeated, comma separated, any case)', async () => {
    const path = writeConfig(goodTarget() + slowTarget() + badTarget());
    expect(await main(['check', '-c', path, '--json', '--only', 'good,BAD'])).toBe(1);
    expect(JSON.parse(stdout.join('')).map((d: { name: string }) => d.name)).toEqual(['Good', 'Bad']);
    stdout.length = 0;
    expect(await main(['check', '-c', path, '--json', '--only', 'Slow', '--only', 'Good'])).toBe(0);
    expect(JSON.parse(stdout.join('')).map((d: { name: string }) => d.name)).toEqual(['Good', 'Slow']);
  });

  it('lists the available targets when --only has an unknown name', async () => {
    expect(await main(['check', '-c', writeConfig(goodTarget() + badTarget()), '--only', 'Good,Nope'])).toBe(2);
    expect(stderr.join('')).toContain('Unknown target(s): Nope. Available: Good, Bad');
    expect(stdout.join('')).toBe('');
  });

  it('rejects unknown targets and bad --fail-on', async () => {
    const path = writeConfig(goodTarget());
    expect(await main(['check', '-c', path, '--only', 'Nope'])).toBe(2);
    expect(await main(['check', '-c', path, '--fail-on', 'maybe'])).toBe(2);
  });

  it('detects a closed port', async () => {
    const port = await closedPort();
    const code = await main(['check', '-c', writeConfig(`  - { name: Port, type: tcp, host: 127.0.0.1, port: ${port} }\n`)]);
    expect(code).toBe(1);
  });

  it('records results and alerts through the webhook when asked', async () => {
    const hook = await startHttpServer((_req, res) => { res.end('ok'); });
    try {
      const path = writeConfig(badTarget(), `alerts:\n  - { name: wh, type: webhook, url: "http://127.0.0.1:${hook.port}/h" }`);
      await main(['check', '-c', path, '--record', '--alerts']);
      const store = new Store(join(dir, 'm.db'));
      expect(store.countResults('Bad')).toBe(1);
      store.close();
      expect(hook.requests).toHaveLength(1);
      expect(JSON.parse(hook.requests[0]!.body)).toMatchObject({ event: 'down', target: 'Bad' });
    } finally {
      await hook.close();
    }
  });
});

describe('other commands', () => {
  it('validate accepts a good config and rejects a bad one', async () => {
    expect(await main(['validate', '-c', writeConfig(goodTarget())])).toBe(0);
    expect(stdout.join('')).toContain('OK: 1 target(s)');
    const bad = join(dir, 'bad.yaml');
    writeFileSync(bad, 'targets: []');
    expect(await main(['validate', '-c', bad])).toBe(2);
    expect(stderr.join('')).toContain('Configuration error');
  });

  it('reports a missing config file', async () => {
    expect(await main(['check', '-c', join(dir, 'missing.yaml')])).toBe(2);
    expect(stderr.join('')).toContain('Cannot read');
  });

  it('shows help and version, rejects unknown input', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(stdout.join('')).toContain('monitor status-page');
    expect(await main(['--version'])).toBe(0);
    expect(await main([])).toBe(2);
    expect(await main(['bogus'])).toBe(2);
    expect(await main(['check', '--nope'])).toBe(2);
  });

  it('status-page writes the static site from stored history', async () => {
    const path = writeConfig(goodTarget());
    await main(['check', '-c', path, '--record', '--alerts']);
    const out = join(dir, 'public');
    expect(await main(['status-page', '-c', path, '--out', out])).toBe(0);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('Good');
    expect(stdout.join('')).toContain('Wrote');
  });

  it('status-page needs an output directory', async () => {
    expect(await main(['status-page', '-c', writeConfig(goodTarget())])).toBe(2);
    expect(stderr.join('')).toContain('--out');
  });

  it('status-page uses statusPage.outDir from the config', async () => {
    const out = join(dir, 'from-config');
    const path = writeConfig(goodTarget(), `statusPage: { outDir: "${out}" }`);
    expect(await main(['status-page', '-c', path])).toBe(0);
    expect(existsSync(join(out, 'status.json'))).toBe(true);
  });
});

describe('selectTargets', () => {
  const t = (name: string): never => ({ name }) as never;
  const all = [t('Web'), t('API'), t('web')];

  it('returns everything without a filter', () => {
    expect(selectTargets(all, [])).toEqual({ targets: all, unknown: [] });
    expect(selectTargets(all, [' , '])).toEqual({ targets: all, unknown: [] });
  });

  it('prefers exact matches and falls back to case-insensitive', () => {
    expect(selectTargets(all, ['web']).targets).toEqual([all[2]]);
    expect(selectTargets(all, ['api']).targets).toEqual([all[1]]);
  });

  it('keeps config order, drops duplicates and reports unknown names', () => {
    const r = selectTargets(all, ['API,Web', 'api', 'x']);
    expect(r.targets).toEqual([all[0], all[1]]);
    expect(r.unknown).toEqual(['x']);
  });
});
