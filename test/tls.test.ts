import { afterEach, describe, expect, it } from 'vitest';
import { createX509 } from './helpers/x509.js';
import { checkTls, evaluateCertificate, fetchCertificate, type CertInfo } from '../src/checks/tls.js';
import { closedPort, startTlsServer, tlsTarget, type TestServer } from './helpers/servers.js';

const DAY = 86_400_000;
const servers: TestServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(opts: Parameters<typeof startTlsServer>[0]): Promise<TestServer> {
  const s = await startTlsServer(opts);
  servers.push(s);
  return s;
}

describe('generated certificates', () => {
  it('are parsed by Node', () => {
    const { cert } = createX509({ commonName: 'unit.test', san: ['unit.test', '*.unit.test'] });
    expect(cert).toContain('BEGIN CERTIFICATE');
  });
});

describe('fetchCertificate', () => {
  it('reads dates, issuer and SANs from a live TLS server', async () => {
    const notAfter = new Date(Date.now() + 40 * DAY);
    const s = await serve({ commonName: 'leaf.test', issuerCommonName: 'Test Root CA', san: ['leaf.test', '*.leaf.test'], notAfter });
    const info = await fetchCertificate(tlsTarget(s.port));
    expect(info.issuer).toContain('Test Root CA');
    expect(info.subject).toContain('leaf.test');
    expect(info.san).toEqual(['leaf.test', '*.leaf.test']);
    expect(Math.abs(info.validTo - notAfter.getTime())).toBeLessThan(2000);
    expect(info.authorized).toBe(false);
  });

  it('rejects when nothing is listening', async () => {
    await expect(fetchCertificate(tlsTarget(await closedPort()))).rejects.toThrow();
  });
});

describe('checkTls against a live server', () => {
  it('is up for a certificate with plenty of time left', async () => {
    const s = await serve({ notAfter: new Date(Date.now() + 90 * DAY + 3600_000) });
    const r = await checkTls(tlsTarget(s.port));
    expect(r.status).toBe('up');
    expect(r.details?.['daysLeft']).toBe(90);
  });

  it('is degraded inside the warning window', async () => {
    const s = await serve({ notAfter: new Date(Date.now() + 15 * DAY + 3600_000) });
    const r = await checkTls(tlsTarget(s.port));
    expect(r.status).toBe('degraded');
    expect(r.message).toMatch(/expires in 15 day/);
  });

  it('is down inside the critical window', async () => {
    const s = await serve({ notAfter: new Date(Date.now() + 3 * DAY + 3600_000) });
    const r = await checkTls(tlsTarget(s.port));
    expect(r.status).toBe('down');
  });

  it('is down once expired', async () => {
    const s = await serve({ notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - 2 * DAY) });
    const r = await checkTls(tlsTarget(s.port));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/expired/);
  });

  it('is down when the chain is not trusted and verification is on', async () => {
    const s = await serve({});
    const r = await checkTls(tlsTarget(s.port, { verifyChain: true }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/not trusted/);
  });

  it('checks the issuer', async () => {
    const s = await serve({ issuerCommonName: 'Acme Issuing CA' });
    expect((await checkTls(tlsTarget(s.port, { issuer: 'acme' }))).status).toBe('up');
    const bad = await checkTls(tlsTarget(s.port, { issuer: "Let's Encrypt" }));
    expect(bad.status).toBe('down');
    expect(bad.message).toMatch(/Unexpected issuer/);
  });

  it('checks SAN coverage including wildcards', async () => {
    const s = await serve({ san: ['site.test', '*.site.test'] });
    expect((await checkTls(tlsTarget(s.port, { san: ['site.test', 'www.site.test'] }))).status).toBe('up');
    const bad = await checkTls(tlsTarget(s.port, { san: ['other.test'] }));
    expect(bad.status).toBe('down');
    expect(bad.message).toMatch(/does not cover: other.test/);
  });

  it('reports a connection failure as down', async () => {
    const r = await checkTls(tlsTarget(await closedPort()));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/TLS connection failed/);
  });

  it('uses the injected clock', async () => {
    const s = await serve({ notAfter: new Date(Date.now() + 90 * DAY) });
    const r = await checkTls(tlsTarget(s.port), () => Date.now() + 85 * DAY);
    expect(r.status).toBe('down');
  });
});

describe('evaluateCertificate', () => {
  const now = Date.UTC(2026, 0, 1);
  const cert = (daysLeft: number, extra: Partial<CertInfo> = {}): CertInfo => ({
    validFrom: now - 100 * DAY, validTo: now + daysLeft * DAY + 1000, issuer: 'CN=R3, O=Let\'s Encrypt', subject: 'CN=a.test', san: ['a.test'], authorized: true, ...extra,
  });
  const t = tlsTarget(443);

  it.each([[90, 'up'], [22, 'up'], [21, 'degraded'], [8, 'degraded'], [7, 'down'], [0, 'down']] as const)('%s days left is %s', (days, status) => {
    expect(evaluateCertificate(t, cert(days), now).status).toBe(status);
  });

  it('flags certificates that are not yet valid', () => {
    expect(evaluateCertificate(t, cert(30, { validFrom: now + DAY }), now).message).toMatch(/not valid yet/);
  });

  it('reports the authorization error', () => {
    const r = evaluateCertificate({ ...t, verifyChain: true }, cert(30, { authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }), now);
    expect(r.message).toMatch(/CERT_HAS_EXPIRED/);
  });

  it('matches wildcard SANs', () => {
    const r = evaluateCertificate({ ...t, san: ['x.a.test'] }, cert(30, { san: ['*.a.test'] }), now);
    expect(r.status).toBe('up');
  });
});
