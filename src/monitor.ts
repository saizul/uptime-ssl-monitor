import { dispatchAlert } from './alerts/index.js';
import type { AlertChannel } from './alerts/types.js';
import { runCheck, type RunnerContext } from './checks/index.js';
import { applyResult, type StateOptions, type TargetState } from './state.js';
import type { Store } from './store.js';
import type { AlertEvent, CheckResult, Config, Target } from './types.js';

export interface MonitorDeps {
  config: Config;
  store?: Store;
  channels?: AlertChannel[];
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Replace the real checks (tests). */
  checkFn?: (target: Target) => Promise<CheckResult>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface CheckOutcome {
  target: Target;
  result: CheckResult;
  state: TargetState;
  alert?: AlertEvent;
  /** True while a failure is waiting for confirmation, so the next check should come sooner. */
  retrying: boolean;
}

/** Runs checks, updates the state machine, stores results and sends alerts. */
export class MonitorService {
  private readonly cfg: Config;
  private readonly store: Store | undefined;
  private readonly channels: AlertChannel[];
  private readonly now: () => number;
  private readonly log: NonNullable<MonitorDeps['log']>;
  private readonly runner: RunnerContext;
  private readonly checkFn: ((t: Target) => Promise<CheckResult>) | undefined;
  private readonly memoryState = new Map<string, TargetState>();

  constructor(deps: MonitorDeps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.channels = deps.channels ?? [];
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.checkFn = deps.checkFn;
    this.runner = {
      rdap: deps.config.rdap,
      now: this.now,
      ...(deps.store ? { cache: deps.store } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
  }

  private stateOptions(t: Target): StateOptions {
    return { retries: t.retries, recovery: t.recovery, flap: this.cfg.flap };
  }

  private loadState(name: string): TargetState {
    return this.store ? this.store.getState(name) : (this.memoryState.get(name) ?? this.freshState());
  }

  private freshState(): TargetState {
    return { status: 'unknown', pendingStatus: null, pendingCount: 0, flapping: false, transitions: [], lastChange: null };
  }

  async checkTarget(target: Target): Promise<CheckOutcome> {
    const result = this.checkFn ? await this.checkFn(target) : await runCheck(target, this.runner);
    const ts = this.now();
    const update = applyResult(this.loadState(target.name), result.status, ts, this.stateOptions(target));

    if (this.store) {
      this.store.insertResult(target.name, ts, result);
      this.store.saveState(target.name, update.state);
    } else {
      this.memoryState.set(target.name, update.state);
    }

    const outcome: CheckOutcome = {
      target,
      result,
      state: update.state,
      retrying: update.state.pendingStatus !== null && update.state.pendingStatus !== 'up',
    };

    if (update.alert) {
      const event: AlertEvent = {
        kind: update.alert.kind,
        target: target.name,
        targetType: target.type,
        from: update.alert.from,
        to: update.alert.to,
        message: update.alert.kind === 'flapping' ? `Status keeps changing (${update.state.transitions.length} changes in ${Math.round(this.cfg.flap.windowMs / 60000)} min). Alerts are muted until it settles. Latest: ${result.message}` : result.message,
        timestamp: ts,
        ...(result.details ? { details: result.details } : {}),
      };
      outcome.alert = event;
      this.log('info', `alert ${event.kind}: ${target.name}`);
      const { failed } = await dispatchAlert(this.channels, target.alerts, event, (channel, err) =>
        this.log('error', `alert channel ${channel} failed: ${err.message}`),
      );
      if (failed.length > 0) this.log('warn', `${failed.length} alert channel(s) failed for ${target.name}`);
    }
    return outcome;
  }

  /** Check every target once, concurrently. */
  async checkAll(targets: Target[] = this.cfg.targets): Promise<CheckOutcome[]> {
    return Promise.all(targets.map((t) => this.checkTarget(t)));
  }
}
