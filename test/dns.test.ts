import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkDns, isValidResolver, normalizeExpected, normalizeIPv6, type DnsResolverLike } from '../src/checks/dns.js';
import { runCheck } from '../src/checks/index.js';
import { startDnsServer } from './helpers/dns.js';
import { dnsTarget } from './helpers/servers.js';

const errno = (code: string): Error => Object.assign(new Error(`query failed ${code}`), { code });

/** A resolver that answers from a fixed table; unknown lookups fail with ENOTFOUND. */
function fakeResolver(answers: Partial<{ [K in keyof DnsResolverLike]: unknown }>): DnsResolverLike {
  const method = (key: keyof DnsResolverLike) => async (): Promise<never> => {
    const v = answers[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw errno('ENOTFOUND');
    return v as never;
  };
  return {
    resolve4: method('resolve4'),
    resolve6: method('resolve6'),
    resolveCname: method('resolveCname'),
    resolveMx: method('resolveMx'),
    resolveTxt: method('resolveTxt'),
    resolveNs: method('resolveNs'),
  };
}

describe('normalizeExpected', () => {
  it('canonicalizes names and addresses', () => {
    expect(normalizeExpected('CNAME', 'Edge.Example.NET.')).toBe('edge.example.net');
    expect(normalizeExpected('AAAA', '2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(normalizeExpected('MX', ' 10   MX1.example.com. ')).toBe('10 mx1.example.com');
    expect(normalizeExpected('MX', 'mx1.example.com')).toBe('mx1.example.com');
    expect(normalizeExpected('TXT', 'v=spf1 -all')).toBe('v=spf1 -all');
  });
  it('rejects values that can never match', () => {
    expect(() => normalizeExpected('A', '::1')).toThrow(/IPv4/);
    expect(() => normalizeExpected('AAAA', '1.2.3.4')).toThrow(/IPv6/);
    expect(() => normalizeExpected('MX', 'a b c')).toThrow(/priority host/);
  });
  it('normalizes IPv6 answers', () => {
    expect(normalizeIPv6('2606:4700:0000:0000:0000:0000:0000:1111')).toBe('2606:4700::1111');
  });
});

describe('isValidResolver', () => {
  it.each(['1.1.1.1', '1.1.1.1:53', '127.0.0.1:5353', '2606:4700::1111', '[2606:4700::1111]:53', '[::1]'])('accepts %s', (s) => {
    expect(isValidResolver(s)).toBe(true);
  });
  it.each(['dns.google', '1.1.1', '1.1.1.1:0', '1.1.1.1:70000', '[1.1.1.1]:53', 'https://1.1.1.1', ''])('rejects %s', (s) => {
    expect(isValidResolver(s)).toBe(false);
  });
});

describe('checkDns with an injected resolver', () => {
  it('is up with any answer when nothing is expected', async () => {
    const r = await checkDns(dnsTarget('example.com'), { resolver: fakeResolver({ resolve4: ['93.184.215.14'] }) });
    expect(r.status).toBe('up');
    expect(r.message).toBe('A example.com: 93.184.215.14');
    expect(r.details).toMatchObject({ host: 'example.com', recordType: 'A', values: ['93.184.215.14'] });
  });

  it('includes mode needs every expected value but allows extras', async () => {
    const resolver = fakeResolver({ resolve4: ['10.0.0.1', '10.0.0.2'] });
    expect((await checkDns(dnsTarget('a.test', { expected: ['10.0.0.2'] }), { resolver })).status).toBe('up');
    const r = await checkDns(dnsTarget('a.test', { expected: ['10.0.0.2', '10.0.0.3'] }), { resolver });
    expect(r.status).toBe('down');
    expect(r.message).toBe('Missing A value(s) 10.0.0.3 for a.test; got 10.0.0.1, 10.0.0.2');
  });

  it('exact mode rejects unexpected values', async () => {
    const resolver = fakeResolver({ resolve4: ['10.0.0.1', '10.0.0.9'] });
    const r = await checkDns(dnsTarget('a.test', { expected: ['10.0.0.1'], match: 'exact' }), { resolver });
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Unexpected A value\(s\) 10\.0\.0\.9/);
    const ok = await checkDns(dnsTarget('a.test', { expected: ['10.0.0.9', '10.0.0.1'], match: 'exact' }), { resolver });
    expect(ok.status).toBe('up');
  });

  it('compares AAAA answers in canonical form', async () => {
    const resolver = fakeResolver({ resolve6: ['2001:0db8:0000:0000:0000:0000:0000:0001'] });
    const r = await checkDns(dnsTarget('v6.test', { recordType: 'AAAA', expected: ['2001:db8::1'] }), { resolver });
    expect(r.status).toBe('up');
  });

  it('matches MX by host, or by priority and host', async () => {
    const resolver = fakeResolver({ resolveMx: [{ exchange: 'MX1.Example.com', priority: 10 }, { exchange: 'mx2.example.com', priority: 20 }] });
    const t = (expected: string[], match: 'includes' | 'exact' = 'includes') => dnsTarget('example.com', { recordType: 'MX', expected, match });
    expect((await checkDns(t(['mx1.example.com']), { resolver })).status).toBe('up');
    expect((await checkDns(t(['10 mx1.example.com', '20 mx2.example.com'], 'exact'), { resolver })).status).toBe('up');
    const wrongPriority = await checkDns(t(['20 mx1.example.com']), { resolver });
    expect(wrongPriority.status).toBe('down');
    expect(wrongPriority.message).toMatch(/got 10 mx1\.example\.com, 20 mx2\.example\.com/);
    expect((await checkDns(t(['mx1.example.com'], 'exact'), { resolver })).status).toBe('down');
  });

  it('joins TXT chunks and compares them exactly', async () => {
    const resolver = fakeResolver({ resolveTxt: [['v=spf1 include:_spf.example.net ', '~all'], ['google-site-verification=abc']] });
    const r = await checkDns(dnsTarget('example.com', { recordType: 'TXT', expected: ['v=spf1 include:_spf.example.net ~all'] }), { resolver });
    expect(r.status).toBe('up');
    const bad = await checkDns(dnsTarget('example.com', { recordType: 'TXT', expected: ['v=spf1 -all'] }), { resolver });
    expect(bad.status).toBe('down');
  });

  it('normalizes CNAME and NS answers', async () => {
    const resolver = fakeResolver({ resolveCname: ['Edge.CDN.example.net.'], resolveNs: ['NS1.example.com', 'ns2.example.com'] });
    expect((await checkDns(dnsTarget('www.example.com', { recordType: 'CNAME', expected: ['edge.cdn.example.net'] }), { resolver })).status).toBe('up');
    expect((await checkDns(dnsTarget('example.com', { recordType: 'NS', expected: ['ns1.example.com', 'ns2.example.com'], match: 'exact' }), { resolver })).status).toBe('up');
  });

  it('is down when the name has no records', async () => {
    const r = await checkDns(dnsTarget('gone.test'), { resolver: fakeResolver({ resolve4: errno('ENOTFOUND') }) });
    expect(r.status).toBe('down');
    expect(r.message).toBe('No A records for gone.test (ENOTFOUND)');
    const empty = await checkDns(dnsTarget('empty.test'), { resolver: fakeResolver({ resolve4: [] }) });
    expect(empty.status).toBe('down');
    expect(empty.message).toBe('No A records for empty.test');
  });

  it('reports resolver errors with their code', async () => {
    const r = await checkDns(dnsTarget('a.test'), { resolver: fakeResolver({ resolve4: errno('ESERVFAIL') }) });
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/^ESERVFAIL:/);
  });

  it('times out and cancels a resolver that never answers', async () => {
    const cancel = vi.fn();
    const resolver: DnsResolverLike = { ...fakeResolver({}), resolve4: () => new Promise<string[]>(() => {}), cancel };
    const r = await checkDns(dnsTarget('slow.test', { timeout: 50 }), { resolver });
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/ETIMEOUT: Timed out after 50ms/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('is degraded when the answer is slower than maxResponseTime', async () => {
    const r = await checkDns(dnsTarget('a.test', { maxResponseTime: -1 }), { resolver: fakeResolver({ resolve4: ['10.0.0.1'] }) });
    expect(r.status).toBe('degraded');
    expect(r.message).toMatch(/Slow DNS answer/);
  });

  it('is used by runCheck through the runner context', async () => {
    const r = await runCheck(dnsTarget('a.test', { expected: ['10.0.0.1'] }), {
      rdap: { baseUrl: 'http://rdap.invalid/', cacheHours: 1 },
      dnsResolver: fakeResolver({ resolve4: ['10.0.0.1'] }),
    });
    expect(r.status).toBe('up');
  });
});

describe('checkDns against a local DNS server', () => {
  let server: Awaited<ReturnType<typeof startDnsServer>>;
  beforeAll(async () => {
    server = await startDnsServer({
      'app.monitor.test': { A: ['192.0.2.10', '192.0.2.11'] },
      'monitor.test': { TXT: ['v=spf1 ' + 'include:a.example.net '.repeat(15) + '-all'] },
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('resolves A records through the configured resolver', async () => {
    const r = await checkDns(dnsTarget('app.monitor.test', { expected: ['192.0.2.11', '192.0.2.10'], match: 'exact', resolvers: [server.address] }));
    expect(r.status).toBe('up');
    expect(r.details).toMatchObject({ values: ['192.0.2.10', '192.0.2.11'], resolvers: [server.address] });
    expect(server.queries).toContain('A app.monitor.test');
  });

  it('reassembles long TXT records split into several strings', async () => {
    const value = 'v=spf1 ' + 'include:a.example.net '.repeat(15) + '-all';
    expect(value.length).toBeGreaterThan(255);
    const r = await checkDns(dnsTarget('monitor.test', { recordType: 'TXT', expected: [value], resolvers: [server.address] }));
    expect(r.status).toBe('up');
  });

  it('is down for a name the server does not know', async () => {
    const r = await checkDns(dnsTarget('missing.monitor.test', { resolvers: [server.address] }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/No A records for missing\.monitor\.test \(ENOTFOUND\)/);
  });
});
