import { describe, expect, it } from 'vitest';
import { ConfigError, interpolateEnv, parseConfig } from '../src/config.js';

const MIN = `
targets:
  - name: Site
    type: http
    url: https://example.com
`;

describe('parseConfig defaults', () => {
  it('fills in defaults', () => {
    const c = parseConfig(MIN);
    const t = c.targets[0]!;
    expect(c.database).toBe('./monitor.db');
    expect(c.retentionDays).toBe(30);
    expect(c.jitter).toBe(0.1);
    expect(c.rdap.baseUrl).toBe('https://rdap.org/domain/');
    expect(c.flap).toEqual({ windowMs: 600_000, threshold: 4 });
    expect(t).toMatchObject({ type: 'http', method: 'GET', interval: 60_000, timeout: 10_000, retries: 2, recovery: 2, expectedStatus: ['2xx'], maxRedirects: 5, insecure: false });
  });

  it('applies shared defaults and per-target overrides', () => {
    const c = parseConfig(`
defaults: { interval: 2m, retries: 1, timeout: 5s }
targets:
  - { name: A, type: tcp, host: db, port: 5432 }
  - { name: B, type: tcp, host: cache, port: 6379, interval: 30s, retries: 4 }
`);
    expect(c.targets[0]).toMatchObject({ interval: 120_000, retries: 1, timeout: 5000 });
    expect(c.targets[1]).toMatchObject({ interval: 30_000, retries: 4, timeout: 5000 });
  });
});

describe('parseConfig target types', () => {
  it('parses a full http target', () => {
    const c = parseConfig(`
targets:
  - name: API
    type: http
    url: https://api.example.com/health
    method: post
    headers: { Authorization: Bearer abc }
    expectedStatus: [200, 204]
    keyword: ok
    keywordAbsent: error
    maxResponseTime: 800ms
`);
    expect(c.targets[0]).toMatchObject({ method: 'POST', expectedStatus: [200, 204], keyword: 'ok', keywordAbsent: 'error', maxResponseTime: 800, headers: { Authorization: 'Bearer abc' } });
  });

  it('parses tls and domain targets', () => {
    const c = parseConfig(`
targets:
  - { name: Cert, type: tls, host: example.com, san: [example.com, www.example.com], issuer: "Let's Encrypt", warnDays: 30, criticalDays: 10 }
  - { name: Domain, type: domain, domain: Example.COM }
`);
    expect(c.targets[0]).toMatchObject({ port: 443, san: ['example.com', 'www.example.com'], issuer: "Let's Encrypt", warnDays: 30, criticalDays: 10, verifyChain: true });
    expect(c.targets[1]).toMatchObject({ domain: 'example.com', warnDays: 30, criticalDays: 7, interval: 6 * 3_600_000 });
  });

  it('accepts a single san string', () => {
    const c = parseConfig(`targets:\n  - { name: C, type: tls, host: h, san: h.example.com }`);
    expect(c.targets[0]).toMatchObject({ san: ['h.example.com'] });
  });
});

describe('http basicAuth', () => {
  const doc = (auth: string): string => `
targets:
  - name: Admin
    type: http
    url: https://example.com/admin
${auth}`;

  it('parses credentials and expands environment variables', () => {
    const c = parseConfig(doc('    basicAuth:\n      username: bot\n      password: ${PW}'), { PW: 'hunter2' });
    expect(c.targets[0]).toMatchObject({ basicAuth: { username: 'bot', password: 'hunter2' } });
  });

  it('is optional', () => {
    expect(parseConfig(doc('')).targets[0]).not.toHaveProperty('basicAuth');
  });

  it('rejects malformed basicAuth', () => {
    expect(() => parseConfig(doc('    basicAuth: nope'))).toThrow(/basicAuth/);
    expect(() => parseConfig(doc('    basicAuth:\n      username: bot'))).toThrow(/password/);
    expect(() => parseConfig(doc('    basicAuth:\n      username: "a:b"\n      password: x'))).toThrow(/":"/);
  });
});

describe('parseConfig alert channels', () => {
  it('parses all channel types', () => {
    const c = parseConfig(`
alerts:
  - { name: tg, type: telegram, botToken: "123:abc", chatId: "-100" }
  - { name: sl, type: slack, webhookUrl: https://hooks.slack.test/x }
  - { name: wh, type: webhook, url: https://example.com/hook, secret: s3 }
  - { name: mail, type: email, from: a@x.com, to: [b@x.com], smtp: { host: smtp.x.com } }
${MIN}`);
    expect(c.channels.map((x) => x.type)).toEqual(['telegram', 'slack', 'webhook', 'email']);
  });

  it('auto-names channels and validates references', () => {
    const c = parseConfig(`alerts:\n  - { type: slack, webhookUrl: https://h.test/x }\n${MIN}`);
    expect(c.channels[0]!.name).toBe('slack-1');
    expect(() => parseConfig(`${MIN.replace('url:', 'alerts: [nope]\n    url:')}`)).toThrow(/unknown alert channel/);
  });
});

describe('parseConfig errors', () => {
  const bad = (yaml: string, pattern: RegExp): void => {
    expect(() => parseConfig(yaml)).toThrow(ConfigError);
    expect(() => parseConfig(yaml)).toThrow(pattern);
  };
  it('rejects malformed documents', () => {
    bad('- a', /mapping/);
    bad('foo: bar', /targets/);
    bad('targets: []', /non-empty/);
    bad('targets: [', /Invalid YAML/);
  });
  it('rejects bad targets', () => {
    bad('targets:\n  - { type: http, url: https://a.com }', /"name" is required/);
    bad('targets:\n  - { name: a, type: ftp }', /"type"/);
    bad('targets:\n  - { name: a, type: http, url: "not a url" }', /valid URL/);
    bad('targets:\n  - { name: a, type: http, url: ftp://x.com }', /http or https/);
    bad('targets:\n  - { name: a, type: tcp, host: h }', /"port" is required/);
    bad('targets:\n  - { name: a, type: tcp, host: h, port: 99999 }', /"port"/);
    bad('targets:\n  - { name: a, type: tcp, host: h, port: 1, interval: 100ms }', /at least 1s/);
    bad('targets:\n  - { name: a, type: http, url: https://a.com, interval: soon }', /Invalid/);
    bad('targets:\n  - { name: a, type: http, url: https://a.com, expectedStatus: [99] }', /expectedStatus/);
    bad('targets:\n  - { name: a, type: tls, host: h, warnDays: 5, criticalDays: 10 }', /criticalDays/);
    bad('targets:\n  - { name: a, type: tcp, host: h, port: 1 }\n  - { name: a, type: tcp, host: h, port: 2 }', /Duplicate target/);
  });
  it('rejects bad channels', () => {
    bad(`alerts:\n  - { type: sms }\n${MIN}`, /"type"/);
    bad(`alerts:\n  - { type: telegram, botToken: x }\n${MIN}`, /chatId/);
    bad(`alerts:\n  - { type: email, from: a@x.com, smtp: { host: h } }\n${MIN}`, /"to"/);
    bad(`alerts:\n  - { name: a, type: slack, webhookUrl: u }\n  - { name: a, type: slack, webhookUrl: u }\n${MIN}`, /Duplicate alert/);
  });
  it('validates jitter', () => {
    expect(parseConfig(`jitter: 20%\n${MIN}`).jitter).toBeCloseTo(0.2);
    bad(`jitter: 3\n${MIN}`, /jitter/);
  });
});

describe('environment interpolation', () => {
  it('substitutes variables and defaults', () => {
    expect(interpolateEnv({ a: 'x-${FOO}-y', b: ['${BAR:-dflt}'] }, { FOO: '1' })).toEqual({ a: 'x-1-y', b: ['dflt'] });
  });
  it('fails on a missing variable', () => {
    expect(() => interpolateEnv('${MISSING}', {})).toThrow(/MISSING/);
  });
  it('is applied while parsing the config', () => {
    const c = parseConfig(`alerts:\n  - { type: slack, webhookUrl: "\${HOOK}" }\n${MIN}`, { HOOK: 'https://hooks.test/abc' });
    expect(c.channels[0]).toMatchObject({ webhookUrl: 'https://hooks.test/abc' });
  });
});

describe('maintenance windows', () => {
  const withMaintenance = (block: string): string => `${MIN}\nmaintenance:\n${block}`;

  it('defaults to none', () => {
    expect(parseConfig(MIN).maintenance).toEqual([]);
  });

  it('parses windows with a zone and target list', () => {
    const c = parseConfig(withMaintenance(`  - { name: Upgrade, start: "2026-12-06T22:00:00Z", end: "2026-12-07T06:00:00+06:00", targets: [Site] }`));
    expect(c.maintenance).toEqual([
      { name: 'Upgrade', targets: ['Site'], start: Date.parse('2026-12-06T22:00:00Z'), end: Date.parse('2026-12-07T06:00:00+06:00') },
    ]);
  });

  it('names unnamed windows and applies to all targets', () => {
    const c = parseConfig(withMaintenance(`  - { start: "2026-12-06T22:00:00Z", end: "2026-12-06T23:00:00Z" }`));
    expect(c.maintenance[0]).toMatchObject({ name: 'maintenance-1', targets: [] });
  });

  it('requires a time zone', () => {
    expect(() => parseConfig(withMaintenance(`  - { start: "2026-12-06T22:00:00", end: "2026-12-06T23:00:00Z" }`))).toThrow(/time zone/);
  });

  it('rejects an end before the start', () => {
    expect(() => parseConfig(withMaintenance(`  - { start: "2026-12-06T23:00:00Z", end: "2026-12-06T22:00:00Z" }`))).toThrow(/after "start"/);
  });

  it('rejects unknown targets', () => {
    expect(() => parseConfig(withMaintenance(`  - { start: "2026-12-06T22:00:00Z", end: "2026-12-06T23:00:00Z", targets: [Nope] }`))).toThrow(/unknown target "Nope"/);
  });

  it('rejects a non-list value', () => {
    expect(() => parseConfig(`${MIN}\nmaintenance: soon`)).toThrow(/must be a list/);
  });
});

describe('dns targets', () => {
  it('parses a dns target with defaults', () => {
    const c = parseConfig(`targets:\n  - { name: Web DNS, type: dns, host: WWW.Example.com. }`);
    expect(c.targets[0]).toMatchObject({ type: 'dns', host: 'www.example.com', recordType: 'A', expected: [], match: 'includes', resolvers: [], interval: 60_000 });
  });

  it('normalizes expected values and resolvers', () => {
    const c = parseConfig(`
targets:
  - name: Mail
    type: dns
    host: example.com
    recordType: mx
    expected: ["10 MX1.Example.com.", mx2.example.com]
    match: exact
    resolver: [1.1.1.1, "[2606:4700::1111]:53"]
    maxResponseTime: 500ms
  - { name: V6, type: dns, host: example.com, recordType: AAAA, expected: "2001:DB8::0:1", resolver: 9.9.9.9 }
`);
    expect(c.targets[0]).toMatchObject({ recordType: 'MX', expected: ['10 mx1.example.com', 'mx2.example.com'], match: 'exact', resolvers: ['1.1.1.1', '[2606:4700::1111]:53'], maxResponseTime: 500 });
    expect(c.targets[1]).toMatchObject({ recordType: 'AAAA', expected: ['2001:db8::1'], resolvers: ['9.9.9.9'] });
  });

  it('keeps TXT values verbatim', () => {
    const c = parseConfig(`targets:\n  - { name: SPF, type: dns, host: example.com, recordType: TXT, expected: "v=spf1 include:_spf.Example.net ~all" }`);
    expect(c.targets[0]).toMatchObject({ expected: ['v=spf1 include:_spf.Example.net ~all'] });
  });

  it('rejects invalid dns settings', () => {
    const bad = (target: string, pattern: RegExp): void => {
      expect(() => parseConfig(`targets:\n  - { name: d, type: dns, ${target} }`)).toThrow(pattern);
    };
    bad('recordType: A', /"host" is required/);
    bad('host: "a b"', /"host" must be a DNS name/);
    bad('host: example.com, recordType: SRV', /"recordType" must be one of A, AAAA, CNAME, MX, TXT, NS/);
    bad('host: example.com, expected: ["::1"]', /"expected" "::1" is not an IPv4 address/);
    bad('host: example.com, recordType: AAAA, expected: [1.2.3.4]', /not an IPv6 address/);
    bad('host: example.com, match: all, expected: [1.2.3.4]', /"match" must be/);
    bad('host: example.com, match: exact', /needs at least one "expected"/);
    bad('host: example.com, resolver: dns.google', /"resolver" entry "dns.google"/);
  });
});
