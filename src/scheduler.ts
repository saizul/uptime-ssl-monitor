import type { Target } from './types.js';
import { jitteredDelay } from './util.js';

export interface SchedulerOptions {
  /** Jitter as a fraction of the interval. */
  jitter: number;
  rng?: () => number;
  /** Runs one check; resolves to true when a retry should come sooner than the normal interval. */
  run: (target: Target) => Promise<{ retrying: boolean }>;
  onError?: (target: Target, error: Error) => void;
}

/**
 * Runs each target on its own timer. The next run is only scheduled when the
 * previous one finished, so slow checks never overlap. Start times are
 * spread randomly and every interval gets a little jitter, which stops all
 * checks from firing in the same instant.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly rng: () => number;

  constructor(
    private readonly targets: Target[],
    private readonly opts: SchedulerOptions,
  ) {
    this.rng = opts.rng ?? Math.random;
  }

  /** Delay before the first run of a target: random within its interval (max 30s). */
  initialDelay(target: Target): number {
    return Math.round(this.rng() * Math.min(target.interval, 30_000));
  }

  nextDelay(target: Target, retrying: boolean): number {
    return retrying ? target.retryInterval : jitteredDelay(target.interval, this.opts.jitter, this.rng);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const t of this.targets) this.schedule(t, this.initialDelay(t));
  }

  private schedule(target: Target, delay: number): void {
    if (!this.running) return;
    const timer = setTimeout(() => {
      this.timers.delete(target.name);
      const job = this.runOnce(target).finally(() => this.inflight.delete(job));
      this.inflight.add(job);
    }, delay);
    this.timers.set(target.name, timer);
  }

  private async runOnce(target: Target): Promise<void> {
    let retrying = false;
    try {
      retrying = (await this.opts.run(target)).retrying;
    } catch (e) {
      this.opts.onError?.(target, e as Error);
    }
    this.schedule(target, this.nextDelay(target, retrying));
  }

  /** Stop scheduling and wait for checks that are already running. */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.inflight]);
  }

  get activeTimers(): number {
    return this.timers.size;
  }
}
