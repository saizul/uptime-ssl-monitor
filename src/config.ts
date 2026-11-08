import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AlertChannelConfig, Config, DomainTarget, HttpTarget, TcpTarget, Target, TargetBase, TlsTarget } from './types.js';
import { parseDuration } from './util.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Replace ${VAR} and ${VAR:-default} in every string of the parsed config. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, name: string, fallback?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`Environment variable ${name} is not set`);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (isObj(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)])) as T;
  }
  return value;
}

function str(o: Obj, key: string, where: string, required = true): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new ConfigError(`${where}: "${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v === '') throw new ConfigError(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function int(o: Obj, key: string, where: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${where}: "${key}" must be an integer between ${min} and ${max}`);
  }
  return v;
}

function dur(o: Obj, key: string, where: string, def: number | undefined): number | undefined {
  const v = o[key];
  if (v === undefined) return def;
  try {
    return parseDuration(v, `${where}.${key}`);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
}

function strList(o: Obj, key: string, where: string): string[] {
  const v = o[key];
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x) => typeof x === 'string' && x !== '')) throw new ConfigError(`${where}: "${key}" must be a list of strings`);
  return list as string[];
}

function bool(o: Obj, key: string, where: string, def: boolean): boolean {
  const v = o[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new ConfigError(`${where}: "${key}" must be true or false`);
  return v;
}

function parseBase(t: Obj, d: Obj, where: string): TargetBase {
  const merged: Obj = { ...d, ...t };
  const interval = dur(merged, 'interval', where, 60_000) as number;
  if (interval < 1000) throw new ConfigError(`${where}: "interval" must be at least 1s`);
  return {
    name: str(t, 'name', where) as string,
    interval,
    timeout: dur(merged, 'timeout', where, 10_000) as number,
    retries: int(merged, 'retries', where, 2, 0, 20),
    retryInterval: dur(merged, 'retryInterval', where, 10_000) as number,
    recovery: int(merged, 'recovery', where, 2, 1, 20),
    alerts: strList(merged, 'alerts', where),
    hidden: bool(t, 'hidden', where, false),
  };
}

function parseExpectedStatus(v: unknown, where: string): Array<number | string> {
  if (v === undefined) return ['2xx'];
  const list = Array.isArray(v) ? v : [v];
  for (const e of list) {
    const ok = (typeof e === 'number' && Number.isInteger(e) && e >= 100 && e <= 599) || (typeof e === 'string' && /^[1-5]xx$/i.test(e));
    if (!ok) throw new ConfigError(`${where}: "expectedStatus" entries must be status codes or classes like "2xx"`);
  }
  return list as Array<number | string>;
}

function parseTarget(raw: unknown, defaults: Obj, index: number): Target {
  if (!isObj(raw)) throw new ConfigError(`targets[${index}] must be a mapping`);
  const where = `targets[${index}]${typeof raw['name'] === 'string' ? ` (${raw['name']})` : ''}`;
  const base = parseBase(raw, defaults, where);
  const type = raw['type'];
  const merged: Obj = { ...defaults, ...raw };
  switch (type) {
    case 'http': {
      const url = str(raw, 'url', where) as string;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigError(`${where}: "url" is not a valid URL`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError(`${where}: "url" must be http or https`);
      const headers = raw['headers'] === undefined ? {} : raw['headers'];
      if (!isObj(headers)) throw new ConfigError(`${where}: "headers" must be a mapping`);
      const target: HttpTarget = {
        ...base,
        type: 'http',
        url,
        method: (str(raw, 'method', where, false) ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
        expectedStatus: parseExpectedStatus(raw['expectedStatus'], where),
        maxRedirects: int(raw, 'maxRedirects', where, 5, 0, 20),
        insecure: bool(raw, 'insecure', where, false),
      };
      const auth = raw['basicAuth'];
      if (auth !== undefined) {
        if (!isObj(auth)) throw new ConfigError(`${where}: "basicAuth" must be a mapping with "username" and "password"`);
        const username = str(auth, 'username', `${where}.basicAuth`) as string;
        const password = str(auth, 'password', `${where}.basicAuth`) as string;
        if (username.includes(':')) throw new ConfigError(`${where}: basicAuth "username" must not contain ":"`);
        target.basicAuth = { username, password };
      }
      const body = str(raw, 'body', where, false);
      if (body !== undefined) target.body = body;
      const keyword = str(raw, 'keyword', where, false);
      if (keyword !== undefined) target.keyword = keyword;
      const absent = str(raw, 'keywordAbsent', where, false);
      if (absent !== undefined) target.keywordAbsent = absent;
      const max = dur(raw, 'maxResponseTime', where, undefined);
      if (max !== undefined) target.maxResponseTime = max;
      return target;
    }
    case 'tcp': {
      const target: TcpTarget = {
        ...base,
        type: 'tcp',
        host: str(raw, 'host', where) as string,
        port: int(raw, 'port', where, -1, 1, 65535),
      };
      if (target.port === -1) throw new ConfigError(`${where}: "port" is required`);
      const max = dur(raw, 'maxResponseTime', where, undefined);
      if (max !== undefined) target.maxResponseTime = max;
      return target;
    }
    case 'tls': {
      const host = str(raw, 'host', where) as string;
      const target: TlsTarget = {
        ...base,
        type: 'tls',
        host,
        port: int(raw, 'port', where, 443, 1, 65535),
        warnDays: int(merged, 'warnDays', where, 21, 0, 3650),
        criticalDays: int(merged, 'criticalDays', where, 7, 0, 3650),
        san: strList(raw, 'san', where),
        verifyChain: bool(raw, 'verifyChain', where, true),
      };
      if (target.criticalDays > target.warnDays) throw new ConfigError(`${where}: "criticalDays" must not exceed "warnDays"`);
      const servername = str(raw, 'servername', where, false);
      if (servername !== undefined) target.servername = servername;
      const issuer = str(raw, 'issuer', where, false);
      if (issuer !== undefined) target.issuer = issuer;
      return target;
    }
    case 'domain': {
      const target: DomainTarget = {
        ...base,
        type: 'domain',
        domain: (str(raw, 'domain', where) as string).toLowerCase(),
        warnDays: int(merged, 'warnDays', where, 30, 0, 3650),
        criticalDays: int(merged, 'criticalDays', where, 7, 0, 3650),
      };
      if (target.criticalDays > target.warnDays) throw new ConfigError(`${where}: "criticalDays" must not exceed "warnDays"`);
      // Domain registrations change rarely; a long default interval avoids hammering RDAP.
      if (raw['interval'] === undefined && defaults['interval'] === undefined) target.interval = 6 * 3_600_000;
      return target;
    }
    default:
      throw new ConfigError(`${where}: "type" must be one of http, tcp, tls, domain`);
  }
}

function parseChannel(raw: unknown, index: number): AlertChannelConfig {
  const where = `alerts[${index}]`;
  if (!isObj(raw)) throw new ConfigError(`${where} must be a mapping`);
  const type = raw['type'];
  if (type !== 'telegram' && type !== 'slack' && type !== 'webhook' && type !== 'email') {
    throw new ConfigError(`${where}: "type" must be one of telegram, slack, webhook, email`);
  }
  const name = str(raw, 'name', where, false) ?? `${type}-${index + 1}`;
  const need = (...keys: string[]): void => {
    for (const k of keys) str(raw, k, `${where} (${type})`);
  };
  if (type === 'telegram') need('botToken', 'chatId');
  if (type === 'slack') need('webhookUrl');
  if (type === 'webhook') need('url');
  if (type === 'email') {
    need('from');
    if (strList(raw, 'to', where).length === 0) throw new ConfigError(`${where} (email): "to" is required`);
    if (!isObj(raw['smtp'])) throw new ConfigError(`${where} (email): "smtp" settings are required`);
  }
  return { ...raw, name, type } as AlertChannelConfig;
}

/** Validate an already parsed YAML document and fill in defaults. */
export function normalizeConfig(doc: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  if (!isObj(doc)) throw new ConfigError('The configuration must be a YAML mapping');
  const root = interpolateEnv(doc, env) as Obj;
  const defaults = root['defaults'] === undefined ? {} : root['defaults'];
  if (!isObj(defaults)) throw new ConfigError('"defaults" must be a mapping');

  const targetsRaw = root['targets'];
  if (!Array.isArray(targetsRaw) || targetsRaw.length === 0) throw new ConfigError('"targets" must be a non-empty list');
  const targets = targetsRaw.map((t, i) => parseTarget(t, defaults, i));
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.name)) throw new ConfigError(`Duplicate target name: ${t.name}`);
    seen.add(t.name);
  }

  const channelsRaw = root['alerts'] === undefined ? [] : root['alerts'];
  if (!Array.isArray(channelsRaw)) throw new ConfigError('"alerts" must be a list');
  const channels = channelsRaw.map(parseChannel);
  const channelNames = new Set<string>();
  for (const c of channels) {
    if (channelNames.has(c.name)) throw new ConfigError(`Duplicate alert channel name: ${c.name}`);
    channelNames.add(c.name);
  }
  for (const t of targets) {
    for (const a of t.alerts) {
      if (!channelNames.has(a)) throw new ConfigError(`Target "${t.name}" references unknown alert channel "${a}"`);
    }
  }

  const rdap = isObj(root['rdap']) ? root['rdap'] : {};
  const flap = isObj(root['flap']) ? root['flap'] : {};
  const page = isObj(root['statusPage']) ? root['statusPage'] : {};
  const jitterRaw = root['jitter'];
  let jitter = 0.1;
  if (jitterRaw !== undefined) {
    const n = typeof jitterRaw === 'string' && jitterRaw.endsWith('%') ? Number(jitterRaw.slice(0, -1)) / 100 : Number(jitterRaw);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new ConfigError('"jitter" must be between 0 and 1 (or "0%" to "100%")');
    jitter = n;
  }

  const config: Config = {
    database: str(root, 'database', 'config', false) ?? './monitor.db',
    retentionDays: int(root, 'retentionDays', 'config', 30, 1, 3650),
    rdap: {
      baseUrl: (str(rdap, 'baseUrl', 'rdap', false) ?? 'https://rdap.org/domain/').replace(/\/?$/, '/'),
      cacheHours: int(rdap, 'cacheHours', 'rdap', 24, 0, 24 * 90),
    },
    jitter,
    flap: {
      windowMs: dur(flap, 'window', 'flap', 600_000) as number,
      threshold: int(flap, 'threshold', 'flap', 4, 2, 100),
    },
    statusPage: {
      title: str(page, 'title', 'statusPage', false) ?? 'Service status',
      description: str(page, 'description', 'statusPage', false) ?? '',
      refreshMinutes: int(page, 'refreshMinutes', 'statusPage', 5, 1, 1440),
    },
    channels,
    targets,
  };
  const outDir = str(page, 'outDir', 'statusPage', false);
  if (outDir !== undefined) config.statusPage.outDir = outDir;
  return config;
}

export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv = process.env): Config {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (e) {
    throw new ConfigError(`Invalid YAML: ${(e as Error).message}`);
  }
  return normalizeConfig(doc, env);
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  return parseConfig(text, env);
}
