import type { CheckResult, Target } from '../types.js';
import { checkDns, type DnsResolverLike } from './dns.js';
import { checkDomain, MemoryCache, type KeyValueCache } from './domain.js';
import { checkHttp } from './http.js';
import { checkTcp } from './tcp.js';
import { checkTls } from './tls.js';

export interface RunnerContext {
  rdap: { baseUrl: string; cacheHours: number };
  cache?: KeyValueCache;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Resolver used by DNS checks instead of one built from the target settings (tests). */
  dnsResolver?: DnsResolverLike;
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
      case 'dns':
        return await checkDns(target, ctx.dnsResolver ? { resolver: ctx.dnsResolver } : {});
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
