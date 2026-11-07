import { describe, expect, it } from 'vitest';
import { applyResult, initialState, type StateOptions, type TargetState } from '../src/state.js';
import type { Status } from '../src/types.js';

const opts: StateOptions = { retries: 2, recovery: 2, flap: { windowMs: 600_000, threshold: 4 } };

function run(statuses: Status[], o: StateOptions = opts, start = initialState(), t0 = 0, step = 60_000) {
  let state: TargetState = start;
  return statuses.map((s, i) => {
    const u = applyResult(state, s, t0 + i * step, o);
    state = u.state;
    return u;
  });
}

describe('state machine', () => {
  it('confirms a healthy first check without alerting', () => {
    const [u] = run(['up']);
    expect(u!.state.status).toBe('up');
    expect(u!.alert).toBeUndefined();
    expect(u!.transition).toEqual({ from: 'unknown', to: 'up' });
  });

  it('needs retries + 1 consecutive failures before going down', () => {
    const r = run(['up', 'down', 'down', 'down']);
    expect(r[1]!.state.status).toBe('up');
    expect(r[2]!.state.status).toBe('up');
    expect(r[2]!.state.pendingCount).toBe(2);
    expect(r[3]!.state.status).toBe('down');
    expect(r[3]!.alert).toEqual({ kind: 'down', from: 'up', to: 'down' });
  });

  it('forgets a blip that recovers before confirmation', () => {
    const r = run(['up', 'down', 'down', 'up', 'down', 'down']);
    expect(r.every((u) => u.state.status === 'up')).toBe(true);
    expect(r.every((u) => !u.alert)).toBe(true);
  });

  it('needs several good checks to recover', () => {
    const r = run(['up', 'down', 'down', 'down', 'up', 'up']);
    expect(r[4]!.state.status).toBe('down');
    expect(r[5]!.state.status).toBe('up');
    expect(r[5]!.alert?.kind).toBe('recovered');
  });

  it('a failed check resets recovery progress', () => {
    const r = run(['up', 'down', 'down', 'down', 'up', 'down', 'up', 'up']);
    expect(r[4]!.state.pendingCount).toBe(1);
    expect(r[5]!.state.pendingStatus).toBeNull();
    expect(r[7]!.alert?.kind).toBe('recovered');
  });

  it('alerts when a first check keeps failing', () => {
    const r = run(['down', 'down', 'down']);
    expect(r[0]!.state.status).toBe('unknown');
    expect(r[2]!.state.status).toBe('down');
    expect(r[2]!.alert?.kind).toBe('down');
  });

  it('does not alert for the initial unknown -> up transition', () => {
    expect(run(['up', 'up'])[0]!.alert).toBeUndefined();
  });

  it('supports degraded as a middle state', () => {
    const r = run(['up', 'degraded', 'degraded', 'degraded', 'up', 'up']);
    expect(r[3]!.state.status).toBe('degraded');
    expect(r[3]!.alert).toEqual({ kind: 'degraded', from: 'up', to: 'degraded' });
    expect(r[5]!.alert).toEqual({ kind: 'recovered', from: 'degraded', to: 'up' });
  });

  it('escalates degraded to down after confirmation', () => {
    const r = run(['up', 'degraded', 'degraded', 'degraded', 'down', 'down', 'down']);
    expect(r[6]!.alert).toEqual({ kind: 'down', from: 'degraded', to: 'down' });
  });

  it('steps down from down to degraded using the recovery threshold', () => {
    const r = run(['up', 'down', 'down', 'down', 'degraded', 'degraded']);
    expect(r[4]!.state.status).toBe('down');
    expect(r[5]!.state.status).toBe('degraded');
    expect(r[5]!.alert?.kind).toBe('degraded');
  });

  it('respects retries = 0', () => {
    const r = run(['up', 'down'], { ...opts, retries: 0, recovery: 1 });
    expect(r[1]!.alert?.kind).toBe('down');
  });

  it('keeps a stable down state quiet', () => {
    const r = run(['up', 'down', 'down', 'down', 'down', 'down', 'down']);
    expect(r.filter((u) => u.alert)).toHaveLength(1);
  });
});

describe('flap protection', () => {
  const fast: StateOptions = { retries: 0, recovery: 1, flap: { windowMs: 600_000, threshold: 4 } };

  it('mutes alerts once a target flaps and announces it once', () => {
    const r = run(['up', 'down', 'up', 'down', 'up', 'down', 'up'], fast, initialState(), 0, 1000);
    expect(r.map((u) => u.alert?.kind)).toEqual([undefined, 'down', 'recovered', 'down', 'flapping', undefined, undefined]);
    expect(r[6]!.state.flapping).toBe(true);
  });

  it('announces when the target has been stable for a full window', () => {
    const flapped = run(['up', 'down', 'up', 'down', 'up'], fast, initialState(), 0, 1000);
    const last = flapped[4]!.state;
    const quiet = applyResult(last, 'up', 4000 + 600_001, fast);
    expect(quiet.alert).toEqual({ kind: 'flap-ended', from: 'up', to: 'up' });
    expect(quiet.state.flapping).toBe(false);
  });

  it('stays muted while transitions are still inside the window', () => {
    const flapped = run(['up', 'down', 'up', 'down', 'up'], fast, initialState(), 0, 1000);
    const later = applyResult(flapped[4]!.state, 'up', 4000 + 300_000, fast);
    expect(later.alert).toBeUndefined();
    expect(later.state.flapping).toBe(true);
  });

  it('does not count slow changes as flapping', () => {
    const r = run(['up', 'down', 'up', 'down', 'up', 'down', 'up'], fast, initialState(), 0, 400_000);
    expect(r.some((u) => u.alert?.kind === 'flapping')).toBe(false);
  });
});
