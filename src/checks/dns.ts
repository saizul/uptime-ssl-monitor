import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import type { CheckResult, DnsRecordType, DnsTarget } from '../types.js';

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];

/** The subset of `dns.promises.Resolver` the check needs, so tests can inject answers. */
export interface DnsResolverLike {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(host: string): Promise<string[][]>;
  resolveNs(host: string): Promise<string[]>;
  cancel?(): void;
}

export interface DnsCheckOptions {
  /** Use this resolver instead of creating one from the target settings. */
  resolver?: DnsResolverLike;
}

/** One answer record, reduced to what the comparison needs. */
interface DnsAnswer {
  value: string;
  priority?: number;
}

/** Lowercase a DNS name and drop the trailing root dot. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** Canonical text form of an IPv6 address ("2001:DB8:0::1" -> "2001:db8::1"). */
export function normalizeIPv6(address: string): string {
  return new URL(`http://[${address.trim()}]/`).hostname.slice(1, -1);
}

/** Normalize an `expected` entry of the given record type. Throws on values that can never match. */
export function normalizeExpected(type: DnsRecordType, value: string): string {
  switch (type) {
    case 'A':
      if (!net.isIPv4(value.trim())) throw new Error(`"${value}" is not an IPv4 address`);
      return value.trim();
    case 'AAAA':
      if (!net.isIPv6(value.trim())) throw new Error(`"${value}" is not an IPv6 address`);
      return normalizeIPv6(value);
    case 'MX': {
      const m = /^\s*(?:(\d{1,5})\s+)?(\S+)\s*$/.exec(value);
      if (!m) throw new Error(`"${value}" must be "host" or "priority host"`);
      return m[1] !== undefined ? `${Number(m[1])} ${normalizeName(m[2] as string)}` : normalizeName(m[2] as string);
    }
    case 'CNAME':
    case 'NS':
      return normalizeName(value);
    case 'TXT':
      return value;
  }
}

/** Validate a resolver address: "1.1.1.1", "1.1.1.1:53", "2606:4700::1111" or "[2606:4700::1111]:53". */
export function isValidResolver(server: string): boolean {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(server);
  const v4 = /^([\d.]+)(?::(\d{1,5}))?$/.exec(server);
  let host: string;
  let port: string | undefined;
  if (bracketed) [, host = '', port] = bracketed;
  else if (v4) [, host = '', port] = v4;
  else if (net.isIPv6(server)) return true;
  else return false;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  return bracketed ? net.isIPv6(host) : net.isIPv4(host);
}

function createResolver(target: DnsTarget): DnsResolverLike {
  const resolver = new dnsPromises.Resolver({ timeout: target.timeout, tries: 1 });
  if (target.resolvers.length > 0) resolver.setServers(target.resolvers);
  return resolver;
}

async function query(resolver: DnsResolverLike, type: DnsRecordType, host: string): Promise<DnsAnswer[]> {
  switch (type) {
    case 'A':
      return (await resolver.resolve4(host)).map((value) => ({ value }));
    case 'AAAA':
      return (await resolver.resolve6(host)).map((value) => ({ value: normalizeIPv6(value) }));
    case 'CNAME':
      return (await resolver.resolveCname(host)).map((value) => ({ value: normalizeName(value) }));
    case 'NS':
      return (await resolver.resolveNs(host)).map((value) => ({ value: normalizeName(value) }));
    case 'MX':
      return (await resolver.resolveMx(host)).map((r) => ({ value: normalizeName(r.exchange), priority: r.priority }));
    case 'TXT':
      // Long TXT records arrive as several character strings; they form one value.
      return (await resolver.resolveTxt(host)).map((chunks) => ({ value: chunks.join('') }));
  }
}

function matches(expected: string, answer: DnsAnswer): boolean {
  if (answer.priority !== undefined) {
    const space = expected.indexOf(' ');
    if (space !== -1) return Number(expected.slice(0, space)) === answer.priority && expected.slice(space + 1) === answer.value;
  }
  return expected === answer.value;
}

const show = (a: DnsAnswer): string => (a.priority !== undefined ? `${a.priority} ${a.value}` : a.value);

/** Compare the answer with the target expectations. Returns a failure message, or undefined when it matches. */
export function compareAnswers(target: DnsTarget, answers: DnsAnswer[]): string | undefined {
  if (answers.length === 0) return `No ${target.recordType} records for ${target.host}`;
  if (target.expected.length === 0) return undefined;
  const got = answers.map(show).join(', ');
  const missing = target.expected.filter((e) => !answers.some((a) => matches(e, a)));
  if (missing.length > 0) return `Missing ${target.recordType} value(s) ${missing.join(', ')} for ${target.host}; got ${got}`;
  if (target.match === 'exact') {
    const extra = answers.filter((a) => !target.expected.some((e) => matches(e, a)));
    if (extra.length > 0) return `Unexpected ${target.recordType} value(s) ${extra.map(show).join(', ')} for ${target.host}`;
  }
  return undefined;
}

/** Resolve a DNS record and check it against the expected values. Never throws. */
export async function checkDns(target: DnsTarget, opts: DnsCheckOptions = {}): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const details: Record<string, unknown> = { host: target.host, recordType: target.recordType };
  if (target.resolvers.length > 0) details['resolvers'] = target.resolvers;

  let resolver: DnsResolverLike;
  try {
    resolver = opts.resolver ?? createResolver(target);
  } catch (e) {
    return { status: 'down', latencyMs: 0, message: `Invalid resolver: ${(e as Error).message}`, details };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      resolver.cancel?.();
      reject(Object.assign(new Error(`Timed out after ${target.timeout}ms`), { code: 'ETIMEOUT' }));
    }, target.timeout);
  });

  let answers: DnsAnswer[];
  try {
    answers = await Promise.race([query(resolver, target.recordType, target.host), timeout]);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const ms = elapsed();
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return { status: 'down', latencyMs: ms, message: `No ${target.recordType} records for ${target.host} (${err.code})`, details };
    }
    return { status: 'down', latencyMs: ms, message: `${err.code ?? 'ERROR'}: ${err.message}`, details };
  } finally {
    clearTimeout(timer);
  }

  const ms = elapsed();
  details['values'] = answers.map(show);
  const failure = compareAnswers(target, answers);
  if (failure !== undefined) return { status: 'down', latencyMs: ms, message: failure, details };
  if (target.maxResponseTime !== undefined && ms > target.maxResponseTime) {
    return { status: 'degraded', latencyMs: ms, message: `Slow DNS answer: ${ms}ms (limit ${target.maxResponseTime}ms)`, details };
  }
  return { status: 'up', latencyMs: ms, message: `${target.recordType} ${target.host}: ${answers.map(show).join(', ')}`, details };
}
