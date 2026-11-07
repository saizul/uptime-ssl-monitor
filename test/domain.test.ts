import { describe, expect, it, vi } from 'vitest';
import { checkDomain, evaluateDomain, lookupDomain, MemoryCache, parseRdap } from '../src/checks/domain.js';
import { domainTarget } from './helpers/servers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 1);
const iso = (ms: number): string => new Date(ms).toISOString();

const rdapDoc = (expiresAt: number): unknown => ({
  objectClassName: 'domain',
  ldhName: 'EXAMPLE.COM',
  status: ['client transfer prohibited'],
  events: [
    { eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' },
    { eventAction: 'expiration', eventDate: iso(expiresAt) },
  ],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar, Inc.']]] }],
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/rdap+json' } });
const opts = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'https://rdap.org/domain/', cacheHours: 24, cache: new MemoryCache(), fetchImpl, now: () => NOW, ...extra,
});

describe('parseRdap', () => {
  it('extracts expiry, registrar and status', () => {
    const info = parseRdap('example.com', rdapDoc(NOW + 100 * DAY));
    expect(info).toMatchObject({ domain: 'example.com', expiresAt: NOW + 100 * DAY, registrar: 'Example Registrar, Inc.', status: ['client transfer prohibited'] });
  });
  it('handles missing data', () => {
    expect(parseRdap('x.com', {})).toEqual({ domain: 'x.com', expiresAt: null, status: [] });
    expect(parseRdap('x.com', { events: [{ eventAction: 'expiration', eventDate: 'garbage' }] }).expiresAt).toBeNull();
  });
  it('matches the expiration action case-insensitively', () => {
    expect(parseRdap('x.com', { events: [{ eventAction: 'Expiration', eventDate: '2030-01-01T00:00:00Z' }] }).expiresAt).toBe(Date.UTC(2030, 0, 1));
  });
});

describe('evaluateDomain', () => {
  const t = domainTarget('example.com');
  const info = (days: number) => ({ domain: 'example.com', expiresAt: NOW + days * DAY + 1000, status: [] });
  it.each([[365, 'up'], [31, 'up'], [30, 'degraded'], [8, 'degraded'], [7, 'down'], [1, 'down']] as const)('%s days left is %s', (days, status) => {
    expect(evaluateDomain(t, info(days), NOW).status).toBe(status);
  });
  it('is down once expired', () => {
    const r = evaluateDomain(t, { domain: 'e', expiresAt: NOW - 3 * DAY, status: [] }, NOW);
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/expired 3 day/);
  });
  it('is degraded without an expiration date', () => {
    expect(evaluateDomain(t, { domain: 'e', expiresAt: null, status: [] }, NOW).status).toBe('degraded');
  });
});

describe('lookupDomain caching', () => {
  it('queries rdap.org and caches the answer', async () => {
    const fetchImpl = vi.fn(async () => json(rdapDoc(NOW + 200 * DAY)));
    const o = opts(fetchImpl as unknown as typeof fetch);
    const first = await lookupDomain('example.com', o);
    const second = await lookupDomain('example.com', o);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://rdap.org/domain/example.com');
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('refreshes after the cache expires', async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => json(rdapDoc(NOW + 200 * DAY)));
    const o = { ...opts(fetchImpl as unknown as typeof fetch), now: () => now };
    await lookupDomain('example.com', o);
    now += 25 * 3_600_000;
    const again = await lookupDomain('example.com', o);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(again.cached).toBe(false);
  });

  it('serves stale data when the registry is down', async () => {
    let now = NOW;
    let fail = false;
    const fetchImpl = vi.fn(async () => { if (fail) throw new Error('boom'); return json(rdapDoc(NOW + 200 * DAY)); });
    const o = { ...opts(fetchImpl as unknown as typeof fetch), now: () => now };
    await lookupDomain('example.com', o);
    now += 48 * 3_600_000;
    fail = true;
    const r = await lookupDomain('example.com', o);
    expect(r).toMatchObject({ cached: true, stale: true });
  });

  it('keeps separate entries per domain', async () => {
    const fetchImpl = vi.fn(async () => json(rdapDoc(NOW + 200 * DAY)));
    const o = opts(fetchImpl as unknown as typeof fetch);
    await lookupDomain('a.com', o);
    await lookupDomain('b.com', o);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on HTTP errors without a cache', async () => {
    const fetchImpl = vi.fn(async () => json({}, 404));
    await expect(lookupDomain('nope.com', opts(fetchImpl as unknown as typeof fetch))).rejects.toThrow(/HTTP 404/);
  });

  it('does not cache when cacheHours is 0', async () => {
    const fetchImpl = vi.fn(async () => json(rdapDoc(NOW + 200 * DAY)));
    const o = opts(fetchImpl as unknown as typeof fetch, { cacheHours: 0 });
    await lookupDomain('example.com', o);
    await lookupDomain('example.com', o);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('checkDomain', () => {
  it('reports the days left with registrar details', async () => {
    const fetchImpl = vi.fn(async () => json(rdapDoc(NOW + 20 * DAY + 5000)));
    const r = await checkDomain(domainTarget('example.com'), opts(fetchImpl as unknown as typeof fetch));
    expect(r.status).toBe('degraded');
    expect(r.details).toMatchObject({ daysLeft: 20, registrar: 'Example Registrar, Inc.', cached: false });
  });

  it('is degraded, not down, when RDAP is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const r = await checkDomain(domainTarget('example.com'), opts(fetchImpl as unknown as typeof fetch));
    expect(r.status).toBe('degraded');
    expect(r.message).toMatch(/RDAP lookup failed: network down/);
  });
});
