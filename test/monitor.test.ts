import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { MonitorService } from '../src/monitor.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import type { AlertEvent, CheckResult, Status, Target } from '../src/types.js';
import type { AlertChannel } from '../src/alerts/types.js';

const config = parseConfig(`
defaults: { retries: 1, recovery: 2 }
alerts:
  - { name: one, type: slack, webhookUrl: https://h.test/1 }
  - { name: two, type: slack, webhookUrl: https://h.test/2 }
targets:
  - { name: Site, type: http, url: "https://example.com", alerts: [one] }
  - { name: Db, type: tcp, host: db, port: 5432 }
`);
const site = config.targets[0]!;
const db = config.targets[1]!;

function setup() {
  const events: Array<{ channel: string; event: AlertEvent }> = [];
  const channels: AlertChannel[] = ['one', 'two'].map((name) => ({ name, send: async (event) => { events.push({ channel: name, event }); } }));
  let status: Status = 'up';
  let message = 'ok';
  let clock = 1_700_000_000_000;
  const store = new Store(':memory:');
  const checkFn = vi.fn(async (): Promise<CheckResult> => ({ status, latencyMs: 12, message }));
  const service = new MonitorService({ config, store, channels, checkFn, now: () => (clock += 60_000) });
  return { events, store, service, set: (s: Status, m: string = s) => { status = s; message = m; }, checkFn };
}

let ctx: ReturnType<typeof setup>;
beforeEach(() => { ctx = setup(); });
afterEach(() => ctx.store.close());

describe('MonitorService', () => {
  it('stores each result and tracks state', async () => {
    const o = await ctx.service.checkTarget(site);
    expect(o.state.status).toBe('up');
    expect(ctx.store.countResults('Site')).toBe(1);
    expect(ctx.store.getState('Site').status).toBe('up');
  });

  it('retries before alerting', async () => {
    await ctx.service.checkTarget(site);
    ctx.set('down', 'HTTP 500');
    const first = await ctx.service.checkTarget(site);
    expect(first.alert).toBeUndefined();
    expect(first.retrying).toBe(true);
    const second = await ctx.service.checkTarget(site);
    expect(second.alert?.kind).toBe('down');
    expect(second.alert?.message).toBe('HTTP 500');
    expect(ctx.events).toHaveLength(1);
  });

  it('routes alerts to the channels listed on the target', async () => {
    await ctx.service.checkTarget(site);
    ctx.set('down');
    await ctx.service.checkTarget(site);
    await ctx.service.checkTarget(site);
    expect(ctx.events.map((e) => e.channel)).toEqual(['one']);
  });

  it('sends to all channels when none are listed', async () => {
    await ctx.service.checkTarget(db);
    ctx.set('down');
    await ctx.service.checkTarget(db);
    await ctx.service.checkTarget(db);
    expect(ctx.events.map((e) => e.channel).sort()).toEqual(['one', 'two']);
  });

  it('sends a recovery alert', async () => {
    await ctx.service.checkTarget(site);
    ctx.set('down');
    await ctx.service.checkTarget(site);
    await ctx.service.checkTarget(site);
    ctx.set('up', 'back');
    await ctx.service.checkTarget(site);
    const r = await ctx.service.checkTarget(site);
    expect(r.alert).toMatchObject({ kind: 'recovered', from: 'down', to: 'up', target: 'Site', targetType: 'http' });
  });

  it('persists state between service instances', async () => {
    await ctx.service.checkTarget(site);
    ctx.set('down');
    await ctx.service.checkTarget(site);
    const fresh = new MonitorService({ config, store: ctx.store, channels: [], checkFn: ctx.checkFn, now: () => 1_800_000_000_000 });
    const o = await fresh.checkTarget(site);
    expect(o.alert?.kind).toBe('down');
  });

  it('works without a store', async () => {
    const service = new MonitorService({ config, checkFn: async () => ({ status: 'up', latencyMs: 1, message: 'ok' }) });
    expect((await service.checkTarget(site)).state.status).toBe('up');
    expect((await service.checkTarget(site)).state.status).toBe('up');
  });

  it('keeps going when an alert channel fails', async () => {
    const logs: string[] = [];
    const service = new MonitorService({
      config, store: ctx.store, checkFn: async () => ({ status: 'down', latencyMs: 0, message: 'x' }),
      channels: [{ name: 'one', send: async () => { throw new Error('smtp down'); } }],
      log: (l, m) => logs.push(`${l}:${m}`),
    });
    await service.checkTarget(site);
    const o = await service.checkTarget(site);
    expect(o.alert?.kind).toBe('down');
    expect(logs.some((l) => l.includes('smtp down'))).toBe(true);
  });

  it('checkAll runs every target', async () => {
    const outcomes = await ctx.service.checkAll();
    expect(outcomes.map((o) => o.target.name)).toEqual(['Site', 'Db']);
  });

  it('adds a flapping message with the number of changes', async () => {
    const cfg = parseConfig(`
defaults: { retries: 0, recovery: 1 }
flap: { window: 10m, threshold: 3 }
targets:
  - { name: F, type: tcp, host: h, port: 1 }
`);
    const events: AlertEvent[] = [];
    let n = 0;
    const service = new MonitorService({
      config: cfg, checkFn: async () => ({ status: n++ % 2 === 0 ? 'up' : 'down', latencyMs: 1, message: 'm' }),
      channels: [{ name: 'c', send: async (e) => { events.push(e); } }], now: () => 1000 * n,
    });
    for (let i = 0; i < 5; i++) await service.checkTarget(cfg.targets[0]!);
    expect(events.map((e) => e.kind)).toEqual(['down', 'recovered', 'flapping']);
    expect(events[2]!.message).toMatch(/keeps changing/);
  });
});

describe('Scheduler', () => {
  const t = (name: string, interval: number, retryInterval = 1000): Target => ({ ...(db as Target), name, interval, retryInterval });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('staggers start times within the interval', () => {
    const s = new Scheduler([], { jitter: 0, rng: () => 0.5, run: async () => ({ retrying: false }) });
    expect(s.initialDelay(t('a', 10_000))).toBe(5000);
    expect(s.initialDelay(t('a', 600_000))).toBe(15_000);
  });

  it('runs each target on its own interval', async () => {
    const calls: string[] = [];
    const s = new Scheduler([t('fast', 1000), t('slow', 5000)], {
      jitter: 0, rng: () => 0, run: async (x) => { calls.push(x.name); return { retrying: false }; },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(5000);
    await s.stop();
    expect(calls.filter((c) => c === 'fast').length).toBeGreaterThanOrEqual(4);
    expect(calls.filter((c) => c === 'slow')).toHaveLength(2);
  });

  it('uses the retry interval while a failure is unconfirmed', async () => {
    const times: number[] = [];
    const s = new Scheduler([t('x', 60_000, 2000)], {
      jitter: 0, rng: () => 0, run: async () => { times.push(Date.now()); return { retrying: true }; },
    });
    const t0 = Date.now();
    s.start();
    await vi.advanceTimersByTimeAsync(6500);
    await s.stop();
    expect(times.map((x) => x - t0)).toEqual([0, 2000, 4000, 6000]);
  });

  it('never overlaps runs of the same target', async () => {
    let active = 0;
    let max = 0;
    const s = new Scheduler([t('x', 1000)], {
      jitter: 0, rng: () => 0,
      run: async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 3000)); active--; return { retrying: false }; },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const stopping = s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(max).toBe(1);
  });

  it('survives a failing run and reports it', async () => {
    const errors: string[] = [];
    let n = 0;
    const s = new Scheduler([t('x', 1000)], {
      jitter: 0, rng: () => 0, onError: (_t, e) => errors.push(e.message),
      run: async () => { if (n++ === 0) throw new Error('kaboom'); return { retrying: false }; },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3500);
    await s.stop();
    expect(errors).toEqual(['kaboom']);
    expect(n).toBeGreaterThan(2);
  });

  it('stops scheduling and clears timers', async () => {
    const run = vi.fn(async () => ({ retrying: false }));
    const s = new Scheduler([t('x', 1000), t('y', 1000)], { jitter: 0, rng: () => 0, run });
    s.start();
    expect(s.activeTimers).toBe(2);
    await s.stop();
    expect(s.activeTimers).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('applies jitter to the next delay', () => {
    const s = new Scheduler([], { jitter: 0.2, rng: () => 1, run: async () => ({ retrying: false }) });
    expect(s.nextDelay(t('x', 10_000), false)).toBe(12_000);
    expect(s.nextDelay(t('x', 10_000, 3000), true)).toBe(3000);
  });

  it('start is idempotent', async () => {
    const run = vi.fn(async () => ({ retrying: false }));
    const s = new Scheduler([t('x', 100_000)], { jitter: 0, rng: () => 0, run });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    await s.stop();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('maintenance windows', () => {
  function windowed(targets: string) {
    const cfg = parseConfig(`
defaults: { retries: 0, recovery: 1 }
maintenance:
  - { name: Upgrade, start: "2023-11-14T22:30:00Z", end: "2023-11-14T22:40:00Z", ${targets} }
alerts:
  - { name: one, type: slack, webhookUrl: https://h.test/1 }
targets:
  - { name: Site, type: http, url: "https://example.com" }
  - { name: Db, type: tcp, host: db, port: 5432 }
`);
    const events: AlertEvent[] = [];
    const channels: AlertChannel[] = [{ name: 'one', send: async (e) => { events.push(e); } }];
    let status: Status = 'up';
    let clock = Date.parse('2023-11-14T22:20:00Z');
    const logs: string[] = [];
    const service = new MonitorService({
      config: cfg,
      channels,
      checkFn: async () => ({ status, latencyMs: 1, message: status }),
      now: () => clock,
      log: (_l, m) => logs.push(m),
    });
    return { cfg, events, logs, service, set: (s: Status) => { status = s; }, at: (iso: string) => { clock = Date.parse(iso); } };
  }

  it('suppresses alerts for targets inside the window and reports why', async () => {
    const c = windowed('targets: [Site]');
    await c.service.checkTarget(c.cfg.targets[0]!);
    c.at('2023-11-14T22:35:00Z');
    c.set('down');
    const o = await c.service.checkTarget(c.cfg.targets[0]!);
    expect(o.state.status).toBe('down');
    expect(o.alert?.kind).toBe('down');
    expect(o.suppressedBy).toBe('Upgrade');
    expect(c.events).toHaveLength(0);
    expect(c.logs.some((m) => m.includes('suppressed by maintenance window "Upgrade"'))).toBe(true);
  });

  it('still alerts targets that are not listed', async () => {
    const c = windowed('targets: [Site]');
    await c.service.checkTarget(c.cfg.targets[1]!);
    c.at('2023-11-14T22:35:00Z');
    c.set('down');
    const o = await c.service.checkTarget(c.cfg.targets[1]!);
    expect(o.suppressedBy).toBeUndefined();
    expect(c.events.map((e) => e.target)).toEqual(['Db']);
  });

  it('alerts again once the window is over', async () => {
    const c = windowed('');
    await c.service.checkTarget(c.cfg.targets[0]!);
    c.at('2023-11-14T22:35:00Z');
    c.set('down');
    await c.service.checkTarget(c.cfg.targets[0]!);
    c.at('2023-11-14T22:41:00Z');
    c.set('up');
    const o = await c.service.checkTarget(c.cfg.targets[0]!);
    expect(o.alert?.kind).toBe('recovered');
    expect(o.suppressedBy).toBeUndefined();
    expect(c.events.map((e) => e.kind)).toEqual(['recovered']);
  });
});

