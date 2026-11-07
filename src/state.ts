import { SEVERITY, type AlertKind, type ConfirmedStatus, type Status } from './types.js';

export interface TargetState {
  /** Confirmed status (what we have told people about). */
  status: ConfirmedStatus;
  /** Raw status currently being confirmed, if different from `status`. */
  pendingStatus: Status | null;
  pendingCount: number;
  flapping: boolean;
  /** Timestamps of recent confirmed transitions, used for flap detection. */
  transitions: number[];
  lastChange: number | null;
}

export interface StateOptions {
  /** Re-checks of a failure before it is confirmed (confirmed after retries + 1 bad checks). */
  retries: number;
  /** Consecutive better checks needed to step down in severity. */
  recovery: number;
  flap: { windowMs: number; threshold: number };
}

export interface StateUpdate {
  state: TargetState;
  /** Set when a confirmed change happened. */
  transition?: { from: ConfirmedStatus; to: ConfirmedStatus };
  /** Set when a notification should be sent. */
  alert?: { kind: AlertKind; from: ConfirmedStatus; to: ConfirmedStatus };
}

export function initialState(): TargetState {
  return { status: 'unknown', pendingStatus: null, pendingCount: 0, flapping: false, transitions: [], lastChange: null };
}

function required(current: ConfirmedStatus, next: Status, opts: StateOptions): number {
  if (current === 'unknown') return next === 'up' ? 1 : opts.retries + 1;
  return SEVERITY[next] > SEVERITY[current] ? opts.retries + 1 : opts.recovery;
}

function alertKind(from: ConfirmedStatus, to: ConfirmedStatus): AlertKind | null {
  if (to === 'down') return 'down';
  if (to === 'degraded') return 'degraded';
  if (to === 'up' && from !== 'unknown') return 'recovered';
  return null;
}

/**
 * Feed one raw check result into the state machine.
 *
 * - A worse status is only confirmed after `retries + 1` consecutive bad checks.
 * - Recovery needs `recovery` consecutive better checks.
 * - When a target changes confirmed status `threshold` times inside `windowMs`
 *   it is marked flapping: one "flapping" alert is sent and the individual
 *   transitions are muted until it has been stable for a full window.
 */
export function applyResult(prev: TargetState, raw: Status, now: number, opts: StateOptions): StateUpdate {
  const state: TargetState = { ...prev, transitions: prev.transitions.filter((t) => now - t < opts.flap.windowMs) };
  const update: StateUpdate = { state };

  if (raw === state.status) {
    state.pendingStatus = null;
    state.pendingCount = 0;
  } else {
    if (state.pendingStatus === raw) state.pendingCount += 1;
    else {
      state.pendingStatus = raw;
      state.pendingCount = 1;
    }
    if (state.pendingCount >= required(state.status, raw, opts)) {
      const from = state.status;
      state.status = raw;
      state.pendingStatus = null;
      state.pendingCount = 0;
      state.lastChange = now;
      update.transition = { from, to: raw };

      if (from !== 'unknown') state.transitions.push(now);
      const kind = alertKind(from, raw);
      if (!state.flapping && state.transitions.length >= opts.flap.threshold) {
        state.flapping = true;
        update.alert = { kind: 'flapping', from, to: raw };
      } else if (!state.flapping && kind) {
        update.alert = { kind, from, to: raw };
      }
    }
  }

  if (state.flapping && !update.transition && state.transitions.length === 0) {
    state.flapping = false;
    update.alert = { kind: 'flap-ended', from: state.status, to: state.status };
  }
  return update;
}
