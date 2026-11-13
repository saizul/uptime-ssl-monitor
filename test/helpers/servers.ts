import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { generateSelfSignedCert, type CertOptions } from './cert.js';
import type { HttpTarget, TcpTarget, TargetBase, TlsTarget, DomainTarget, DnsTarget } from '../../src/types.js';

export interface TestServer {
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(handler?: http.RequestListener): Promise<TestServer & { requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> }> {
  const requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (handler) return handler(req, res);
      routes(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function routes(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  if (url === '/ok') { res.end('Welcome to the test page. Everything is fine.'); return; }
  if (url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
  if (url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
  if (url === '/error') { res.writeHead(500); res.end('Internal Server Error: boom'); return; }
  if (url === '/missing') { res.writeHead(404); res.end('nope'); return; }
  if (url === '/slow') { setTimeout(() => res.end('slow but fine'), 250); return; }
  if (url === '/hang') { return; }
  res.end(`default ${req.method} ${url}`);
}

export async function startTlsServer(cert?: CertOptions): Promise<TestServer> {
  const { key, cert: pem } = generateSelfSignedCert(cert);
  const server = tls.createServer({ key, cert: pem }, (socket) => { socket.on('error', () => {}); socket.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

export async function startTcpServer(): Promise<TestServer> {
  const server = net.createServer((s) => { s.on('error', () => {}); s.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

/** A port that nothing listens on. */
export async function closedPort(): Promise<number> {
  const s = await startTcpServer();
  await s.close();
  return s.port;
}

export const baseTarget = (name = 't'): TargetBase => ({
  name, interval: 60_000, timeout: 2000, retries: 0, retryInterval: 1000, recovery: 1, alerts: [], hidden: false,
});

export const httpTarget = (port: number, path: string, extra: Partial<HttpTarget> = {}): HttpTarget => ({
  ...baseTarget('http'), type: 'http', url: `http://127.0.0.1:${port}${path}`, method: 'GET', headers: {},
  expectedStatus: ['2xx'], maxRedirects: 5, insecure: false, ...extra,
});

export const tcpTarget = (port: number, extra: Partial<TcpTarget> = {}): TcpTarget => ({
  ...baseTarget('tcp'), type: 'tcp', host: '127.0.0.1', port, ...extra,
});

export const tlsTarget = (port: number, extra: Partial<TlsTarget> = {}): TlsTarget => ({
  ...baseTarget('tls'), type: 'tls', host: '127.0.0.1', port, warnDays: 21, criticalDays: 7, san: [], verifyChain: false, ...extra,
});

export const domainTarget = (domain: string, extra: Partial<DomainTarget> = {}): DomainTarget => ({
  ...baseTarget('domain'), type: 'domain', domain, warnDays: 30, criticalDays: 7, ...extra,
});

export const dnsTarget = (host: string, extra: Partial<DnsTarget> = {}): DnsTarget => ({
  ...baseTarget('dns'), type: 'dns', host, recordType: 'A', expected: [], match: 'includes', resolvers: [], ...extra,
});
