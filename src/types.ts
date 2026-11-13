export type Status = 'up' | 'degraded' | 'down';
export type ConfirmedStatus = Status | 'unknown';

export const SEVERITY: Record<ConfirmedStatus, number> = {
  unknown: -1,
  up: 0,
  degraded: 1,
  down: 2,
};

export interface CheckResult {
  status: Status;
  /** Time the check took in milliseconds. */
  latencyMs: number;
  message: string;
  /** Check specific data (status code, days left, issuer ...). */
  details?: Record<string, unknown>;
}

export interface TargetBase {
  name: string;
  /** Milliseconds between checks. */
  interval: number;
  /** Milliseconds before a check is aborted. */
  timeout: number;
  /** Failed checks re-tried before an alert is raised. */
  retries: number;
  /** Seconds between re-checks while a failure is unconfirmed (ms). */
  retryInterval: number;
  /** Consecutive good checks needed to recover. */
  recovery: number;
  /** Alert channel names. Empty means all channels. */
  alerts: string[];
  /** Hide from the status page. */
  hidden: boolean;
}

export interface HttpTarget extends TargetBase {
  type: 'http';
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** HTTP Basic credentials. Sent only to the original origin, never to redirect targets on another origin. */
  basicAuth?: { username: string; password: string };
  /** Numbers (200) or classes ("2xx"). */
  expectedStatus: Array<number | string>;
  keyword?: string;
  keywordAbsent?: string;
  /** Slower responses are reported as degraded (ms). */
  maxResponseTime?: number;
  maxRedirects: number;
  /** Skip TLS verification of the target. */
  insecure: boolean;
}

export interface TcpTarget extends TargetBase {
  type: 'tcp';
  host: string;
  port: number;
  maxResponseTime?: number;
}

export interface TlsTarget extends TargetBase {
  type: 'tls';
  host: string;
  port: number;
  servername?: string;
  /** Degraded when fewer days remain. */
  warnDays: number;
  /** Down when fewer days remain. */
  criticalDays: number;
  /** Substring that must appear in the issuer. */
  issuer?: string;
  /** Names that must be covered by the certificate SANs. */
  san: string[];
  /** Fail when the chain is not trusted by this machine. */
  verifyChain: boolean;
}

export interface DomainTarget extends TargetBase {
  type: 'domain';
  domain: string;
  warnDays: number;
  criticalDays: number;
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';

export interface DnsTarget extends TargetBase {
  type: 'dns';
  /** Name to resolve. */
  host: string;
  recordType: DnsRecordType;
  /** Values that must be returned (normalized). Empty means any answer is fine. */
  expected: string[];
  /** "includes": every expected value is present. "exact": the answer is exactly the expected set. */
  match: 'includes' | 'exact';
  /** DNS servers ("1.1.1.1", "1.1.1.1:5353", "[2606:4700::1111]:53"). Empty means the system resolver configuration. */
  resolvers: string[];
  /** Slower answers are reported as degraded (ms). */
  maxResponseTime?: number;
}

export type Target = HttpTarget | TcpTarget | TlsTarget | DomainTarget | DnsTarget;

export interface AlertChannelConfig {
  name: string;
  type: 'telegram' | 'slack' | 'webhook' | 'email';
  [key: string]: unknown;
}

export interface MaintenanceWindow {
  name: string;
  /** Target names the window applies to. Empty means all targets. */
  targets: string[];
  /** Start of the window (ms since epoch, inclusive). */
  start: number;
  /** End of the window (ms since epoch, exclusive). */
  end: number;
}

export interface Config {
  database: string;
  /** Days of raw check results to keep. */
  retentionDays: number;
  rdap: { baseUrl: string; cacheHours: number };
  /** Jitter as a fraction of the interval (0.1) applied to each schedule. */
  jitter: number;
  flap: { windowMs: number; threshold: number };
  /** Alerts for matching targets are suppressed while a window is active. */
  maintenance: MaintenanceWindow[];
  statusPage: { title: string; description: string; outDir?: string; refreshMinutes: number };
  channels: AlertChannelConfig[];
  targets: Target[];
}

export type AlertKind = 'down' | 'degraded' | 'recovered' | 'flapping' | 'flap-ended';

export interface AlertEvent {
  kind: AlertKind;
  target: string;
  targetType: Target['type'];
  from: ConfirmedStatus;
  to: ConfirmedStatus;
  message: string;
  timestamp: number;
  details?: Record<string, unknown>;
}
