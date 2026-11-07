import tls from 'node:tls';
import type { CheckResult, TlsTarget } from '../types.js';
import { daysBetween, nameMatches } from '../util.js';

export interface CertInfo {
  validTo: number;
  validFrom: number;
  issuer: string;
  subject: string;
  san: string[];
  authorized: boolean;
  authorizationError?: string;
}

function flatten(obj: Record<string, string | string[]> | undefined): string {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ');
}

export function fetchCertificate(target: Pick<TlsTarget, 'host' | 'port' | 'servername' | 'timeout'>): Promise<CertInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.servername ?? (/^[\d.]+$|:/.test(target.host) ? undefined : target.host),
      rejectUnauthorized: false,
    });
    socket.setTimeout(target.timeout, () => {
      socket.destroy();
      reject(new Error(`Timed out after ${target.timeout}ms`));
    });
    socket.on('error', (e) => reject(e));
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const info: CertInfo = {
        validTo: Date.parse(cert.valid_to),
        validFrom: Date.parse(cert.valid_from),
        issuer: flatten(cert.issuer as unknown as Record<string, string | string[]>),
        subject: flatten(cert.subject as unknown as Record<string, string | string[]>),
        san: (cert.subjectaltname ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.startsWith('DNS:'))
          .map((s) => s.slice(4)),
        authorized: socket.authorized,
      };
      if (socket.authorizationError) info.authorizationError = String(socket.authorizationError);
      socket.end();
      resolve(info);
    });
  });
}

/** Turn certificate facts into a status. Pure, so it is easy to test. */
export function evaluateCertificate(target: TlsTarget, cert: CertInfo, now: number): CheckResult {
  const daysLeft = daysBetween(now, cert.validTo);
  const details = {
    daysLeft,
    validTo: new Date(cert.validTo).toISOString(),
    issuer: cert.issuer,
    subject: cert.subject,
    san: cert.san,
  };
  const fail = (message: string): CheckResult => ({ status: 'down', latencyMs: 0, message, details });

  if (cert.validFrom > now) return fail('Certificate is not valid yet');
  if (cert.validTo <= now) return fail(`Certificate expired ${Math.abs(daysLeft)} day(s) ago`);
  if (target.verifyChain && !cert.authorized) return fail(`Certificate is not trusted: ${cert.authorizationError ?? 'unknown error'}`);
  if (target.issuer && !cert.issuer.toLowerCase().includes(target.issuer.toLowerCase())) {
    return fail(`Unexpected issuer "${cert.issuer}" (expected to contain "${target.issuer}")`);
  }
  const missing = target.san.filter((name) => !cert.san.some((p) => nameMatches(p, name)));
  if (missing.length > 0) return fail(`Certificate does not cover: ${missing.join(', ')}`);
  if (daysLeft <= target.criticalDays) return fail(`Certificate expires in ${daysLeft} day(s)`);
  if (daysLeft <= target.warnDays) {
    return { status: 'degraded', latencyMs: 0, message: `Certificate expires in ${daysLeft} day(s)`, details };
  }
  return { status: 'up', latencyMs: 0, message: `Certificate valid for ${daysLeft} more day(s)`, details };
}

export async function checkTls(target: TlsTarget, now: () => number = Date.now): Promise<CheckResult> {
  const started = performance.now();
  try {
    const cert = await fetchCertificate(target);
    const result = evaluateCertificate(target, cert, now());
    result.latencyMs = Math.round(performance.now() - started);
    return result;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      message: `TLS connection failed: ${err.code ? `${err.code}: ` : ''}${err.message}`,
    };
  }
}
