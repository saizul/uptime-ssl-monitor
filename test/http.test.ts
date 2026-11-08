import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHttp } from '../src/checks/http.js';
import { closedPort, httpTarget, startHttpServer } from './helpers/servers.js';

let server: Awaited<ReturnType<typeof startHttpServer>>;
beforeAll(async () => { server = await startHttpServer(); });
afterAll(async () => { await server.close(); });

describe('checkHttp', () => {
  it('reports up for a healthy page', async () => {
    const r = await checkHttp(httpTarget(server.port, '/ok'));
    expect(r.status).toBe('up');
    expect(r.details).toMatchObject({ statusCode: 200, redirects: 0 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports down for an unexpected status', async () => {
    const r = await checkHttp(httpTarget(server.port, '/error'));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Unexpected status 500/);
  });

  it('accepts a configured non-2xx status', async () => {
    const r = await checkHttp(httpTarget(server.port, '/missing', { expectedStatus: [404] }));
    expect(r.status).toBe('up');
  });

  it('follows redirects', async () => {
    const r = await checkHttp(httpTarget(server.port, '/redirect'));
    expect(r.status).toBe('up');
    expect(r.details).toMatchObject({ redirects: 1, statusCode: 200 });
  });

  it('stops at the redirect limit', async () => {
    const r = await checkHttp(httpTarget(server.port, '/loop', { maxRedirects: 3 }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Unexpected status 302/);
  });

  it('can treat a redirect as the expected result', async () => {
    const r = await checkHttp(httpTarget(server.port, '/redirect', { maxRedirects: 0, expectedStatus: [302] }));
    expect(r.status).toBe('up');
  });

  it('finds a required keyword', async () => {
    expect((await checkHttp(httpTarget(server.port, '/ok', { keyword: 'Everything is fine' }))).status).toBe('up');
  });

  it('fails when a required keyword is missing', async () => {
    const r = await checkHttp(httpTarget(server.port, '/ok', { keyword: 'Maintenance' }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Keyword "Maintenance" not found/);
  });

  it('fails when a forbidden keyword is present', async () => {
    const r = await checkHttp(httpTarget(server.port, '/ok', { keywordAbsent: 'Welcome' }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Forbidden keyword/);
  });

  it('passes when a forbidden keyword is absent', async () => {
    expect((await checkHttp(httpTarget(server.port, '/ok', { keywordAbsent: 'Exception' }))).status).toBe('up');
  });

  it('reports degraded for a slow response', async () => {
    const r = await checkHttp(httpTarget(server.port, '/slow', { maxResponseTime: 50 }));
    expect(r.status).toBe('degraded');
    expect(r.message).toMatch(/Slow response/);
  });

  it('stays up when the response is fast enough', async () => {
    expect((await checkHttp(httpTarget(server.port, '/ok', { maxResponseTime: 5000 }))).status).toBe('up');
  });

  it('times out on a hanging server', async () => {
    const r = await checkHttp(httpTarget(server.port, '/hang', { timeout: 200 }));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/Timed out after 200ms/);
  });

  it('reports connection refused', async () => {
    const r = await checkHttp(httpTarget(await closedPort(), '/'));
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/ECONNREFUSED/);
  });

  it('sends the configured method, headers and body', async () => {
    await checkHttp(httpTarget(server.port, '/echo', { method: 'POST', headers: { 'x-token': 'abc' }, body: '{"ping":true}' }));
    const req = server.requests.find((r) => r.url === '/echo');
    expect(req).toMatchObject({ method: 'POST', body: '{"ping":true}' });
    expect(req?.headers['x-token']).toBe('abc');
    expect(req?.headers['user-agent']).toMatch(/uptime-ssl-monitor/);
  });

  describe('basicAuth', () => {
    const creds = { username: 'monitor', password: 's3cret' };
    const expected = `Basic ${Buffer.from('monitor:s3cret').toString('base64')}`;

    it('sends an Authorization header', async () => {
      const r = await checkHttp(httpTarget(server.port, '/ok', { basicAuth: creds }));
      expect(r.status).toBe('up');
      expect(server.requests.at(-1)?.headers['authorization']).toBe(expected);
    });

    it('does not override an explicit Authorization header', async () => {
      await checkHttp(httpTarget(server.port, '/ok', { basicAuth: creds, headers: { Authorization: 'Bearer abc' } }));
      expect(server.requests.at(-1)?.headers['authorization']).toBe('Bearer abc');
    });

    it('keeps credentials on same-origin redirects', async () => {
      await checkHttp(httpTarget(server.port, '/redirect', { basicAuth: creds }));
      expect(server.requests.at(-1)?.url).toBe('/ok');
      expect(server.requests.at(-1)?.headers['authorization']).toBe(expected);
    });

    it('drops credentials when redirected to another origin', async () => {
      const target = await startHttpServer();
      const origin = await startHttpServer((_req, res) => {
        res.writeHead(302, { location: `http://localhost:${target.port}/ok` });
        res.end();
      });
      try {
        const r = await checkHttp(httpTarget(origin.port, '/', { basicAuth: creds }));
        expect(r.status).toBe('up');
        expect(origin.requests.at(-1)?.headers['authorization']).toBe(expected);
        expect(target.requests.at(-1)?.headers['authorization']).toBeUndefined();
      } finally {
        await origin.close();
        await target.close();
      }
    });
  });
});
