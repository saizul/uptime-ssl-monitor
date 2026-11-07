import http from 'node:http';
import https from 'node:https';
import type { CheckResult, HttpTarget } from '../types.js';
import { statusMatches } from '../util.js';

const MAX_BODY = 1024 * 1024;

interface Response {
  status: number;
  body: string;
  finalUrl: string;
  redirects: number;
}

function request(target: HttpTarget, url: URL, signal: AbortSignal, wantBody: boolean): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { 'user-agent': 'uptime-ssl-monitor/1.0', accept: '*/*', ...target.headers };
    if (target.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(target.body));
    }
    const req = lib.request(
      url,
      { method: target.method, headers, signal, ...(url.protocol === 'https:' ? { rejectUnauthorized: !target.insecure } : {}) },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        const chunks: Buffer[] = [];
        let size = 0;
        if (!wantBody || (status >= 300 && status < 400 && location)) {
          res.resume();
          res.on('end', () => resolve({ status, ...(location ? { location } : {}), body: '' }));
          res.on('error', reject);
          return;
        }
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (target.body !== undefined) req.write(target.body);
    req.end();
  });
}

async function fetchFollowing(target: HttpTarget, signal: AbortSignal): Promise<Response> {
  let url = new URL(target.url);
  const wantBody = target.keyword !== undefined || target.keywordAbsent !== undefined;
  for (let redirects = 0; ; redirects++) {
    const res = await request(target, url, signal, wantBody);
    if (res.location && res.status >= 300 && res.status < 400 && redirects < target.maxRedirects) {
      url = new URL(res.location, url);
      continue;
    }
    return { status: res.status, body: res.body, finalUrl: url.toString(), redirects };
  }
}

function errorMessage(e: unknown, timeout: number): string {
  const err = e as NodeJS.ErrnoException & { cause?: { code?: string } };
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return `Timed out after ${timeout}ms`;
  const code = err.code ?? err.cause?.code;
  return code ? `${code}: ${err.message}` : err.message;
}

export async function checkHttp(target: HttpTarget): Promise<CheckResult> {
  const started = performance.now();
  const signal = AbortSignal.timeout(target.timeout);
  try {
    const res = await fetchFollowing(target, signal);
    const latencyMs = Math.round(performance.now() - started);
    const details = { statusCode: res.status, url: res.finalUrl, redirects: res.redirects };
    if (!statusMatches(res.status, target.expectedStatus)) {
      return { status: 'down', latencyMs, message: `Unexpected status ${res.status} (expected ${target.expectedStatus.join(', ')})`, details };
    }
    if (target.keyword !== undefined && !res.body.includes(target.keyword)) {
      return { status: 'down', latencyMs, message: `Keyword "${target.keyword}" not found`, details };
    }
    if (target.keywordAbsent !== undefined && res.body.includes(target.keywordAbsent)) {
      return { status: 'down', latencyMs, message: `Forbidden keyword "${target.keywordAbsent}" found`, details };
    }
    if (target.maxResponseTime !== undefined && latencyMs > target.maxResponseTime) {
      return { status: 'degraded', latencyMs, message: `Slow response: ${latencyMs}ms (limit ${target.maxResponseTime}ms)`, details };
    }
    return { status: 'up', latencyMs, message: `HTTP ${res.status} in ${latencyMs}ms`, details };
  } catch (e) {
    return { status: 'down', latencyMs: Math.round(performance.now() - started), message: errorMessage(e, target.timeout) };
  }
}
