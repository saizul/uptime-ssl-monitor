import type { CheckResult, Target } from '../types.js';
import { checkDomain, MemoryCache, type KeyValueCache } from './domain.js';
import { checkHttp } from './http.js';
import { checkTcp } from './tcp.js';
import { checkTls } from './tls.js';

export interface RunnerContext {
  rdap: { baseUrl: string; cacheHours: number };
  cache?: KeyValueCache;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const fallbackCache = new MemoryCache();

/** Run a single check for any target type. Never throws. */
export async function runCheck(target: Target, ctx: RunnerContext): Promise<CheckResult> {
  try {
    switch (target.type) {
      case 'http':
        return await checkHttp(target);
      case 'tcp':
        return await checkTcp(target);
      case 'tls':
        return await checkTls(target, ctx.now);
      case 'domain':
        return await checkDomain(target, {
          baseUrl: ctx.rdap.baseUrl,
          cacheHours: ctx.rdap.cacheHours,
          cache: ctx.cache ?? fallbackCache,
          ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
          ...(ctx.now ? { now: ctx.now } : {}),
        });
    }
  } catch (e) {
    return { status: 'down', latencyMs: 0, message: `Check crashed: ${(e as Error).message}` };
  }
}
