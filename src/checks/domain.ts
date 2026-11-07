import type { CheckResult, DomainTarget } from '../types.js';
import { daysBetween } from '../util.js';

export interface KeyValueCache {
  get(key: string): { value: string; expiresAt: number } | undefined;
  set(key: string, value: string, expiresAt: number): void;
}

export class MemoryCache implements KeyValueCache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  get(key: string): { value: string; expiresAt: number } | undefined {
    return this.store.get(key);
  }
  set(key: string, value: string, expiresAt: number): void {
    this.store.set(key, { value, expiresAt });
  }
}

export interface RdapInfo {
  domain: string;
  expiresAt: number | null;
  registrar?: string;
  status: string[];
}

export interface RdapOptions {
  baseUrl: string;
  cacheHours: number;
  cache: KeyValueCache;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeout?: number;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, Array<[string, unknown, string, unknown]>];
}

/** Extract the facts we need from an RDAP domain response. */
export function parseRdap(domain: string, json: unknown): RdapInfo {
  const doc = json as { events?: Array<{ eventAction?: string; eventDate?: string }>; entities?: RdapEntity[]; status?: string[] };
  const expiry = doc.events?.find((e) => e.eventAction?.toLowerCase() === 'expiration');
  const parsed = expiry?.eventDate ? Date.parse(expiry.eventDate) : NaN;
  const registrarEntity = doc.entities?.find((e) => e.roles?.includes('registrar'));
  const fn = registrarEntity?.vcardArray?.[1]?.find((p) => p[0] === 'fn');
  const info: RdapInfo = {
    domain,
    expiresAt: Number.isNaN(parsed) ? null : parsed,
    status: doc.status ?? [],
  };
  if (typeof fn?.[3] === 'string') info.registrar = fn[3];
  return info;
}

/** Look up a domain through RDAP, using the cache when it is still fresh. */
export async function lookupDomain(domain: string, opts: RdapOptions): Promise<{ info: RdapInfo; cached: boolean; stale: boolean }> {
  const now = (opts.now ?? Date.now)();
  const key = `rdap:${domain}`;
  const hit = opts.cache.get(key);
  if (hit && hit.expiresAt > now) return { info: JSON.parse(hit.value) as RdapInfo, cached: true, stale: false };

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.baseUrl + encodeURIComponent(domain), {
      headers: { accept: 'application/rdap+json, application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeout ?? 10_000),
    });
    if (!res.ok) throw new Error(`RDAP responded with HTTP ${res.status}`);
    const info = parseRdap(domain, await res.json());
    opts.cache.set(key, JSON.stringify(info), now + opts.cacheHours * 3_600_000);
    return { info, cached: false, stale: false };
  } catch (e) {
    // A stale answer beats no answer: registrations change rarely.
    if (hit) return { info: JSON.parse(hit.value) as RdapInfo, cached: true, stale: true };
    throw e;
  }
}

export function evaluateDomain(target: DomainTarget, info: RdapInfo, now: number): CheckResult {
  if (info.expiresAt === null) {
    return { status: 'degraded', latencyMs: 0, message: 'RDAP response has no expiration date', details: { registrar: info.registrar } };
  }
  const daysLeft = daysBetween(now, info.expiresAt);
  const details = { daysLeft, expiresAt: new Date(info.expiresAt).toISOString(), registrar: info.registrar, status: info.status };
  if (info.expiresAt <= now) return { status: 'down', latencyMs: 0, message: `Domain expired ${Math.abs(daysLeft)} day(s) ago`, details };
  if (daysLeft <= target.criticalDays) return { status: 'down', latencyMs: 0, message: `Domain expires in ${daysLeft} day(s)`, details };
  if (daysLeft <= target.warnDays) return { status: 'degraded', latencyMs: 0, message: `Domain expires in ${daysLeft} day(s)`, details };
  return { status: 'up', latencyMs: 0, message: `Domain valid for ${daysLeft} more day(s)`, details };
}

export async function checkDomain(
  target: DomainTarget,
  opts: Omit<RdapOptions, 'timeout'> & { timeout?: number },
): Promise<CheckResult> {
  const started = performance.now();
  try {
    const { info, cached, stale } = await lookupDomain(target.domain, { ...opts, timeout: opts.timeout ?? target.timeout });
    const result = evaluateDomain(target, info, (opts.now ?? Date.now)());
    result.latencyMs = Math.round(performance.now() - started);
    result.details = { ...result.details, cached, stale };
    return result;
  } catch (e) {
    // An unreachable registry should not page anyone as "down": the domain itself is not known to be broken.
    return {
      status: 'degraded',
      latencyMs: Math.round(performance.now() - started),
      message: `RDAP lookup failed: ${(e as Error).message}`,
    };
  }
}
