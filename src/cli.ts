import { parseArgs } from 'node:util';
import { createChannels } from './alerts/index.js';
import { ConfigError, loadConfig } from './config.js';
import { MonitorService } from './monitor.js';
import { buildReport, formatReport } from './report.js';
import { Scheduler } from './scheduler.js';
import { writeStatusPage } from './statuspage.js';
import { Store } from './store.js';
import { SEVERITY, type Config, type Status, type Target } from './types.js';
import { formatDuration, parseDuration } from './util.js';

const VERSION = '1.0.0';

const HELP = `uptime-ssl-monitor ${VERSION}

Usage:
  monitor check        [-c config.yaml] [--only name[,name]] [--json] [--fail-on down|degraded] [--alerts] [--record]
  monitor run          [-c config.yaml]
  monitor report       [-c config.yaml] [--since 7d] [--only name[,name]] [--json]
  monitor status-page  [-c config.yaml] --out <dir>
  monitor validate     [-c config.yaml]

Options:
  -c, --config <file>  Configuration file (default: monitor.yaml)
  -o, --out <dir>      Output directory for the status page
      --only <name>    Check only the named target(s); repeatable or comma separated, case-insensitive
      --json           Print machine readable JSON (check): an array with name, type, status, message, latencyMs, details, ok, checkedAt
      --fail-on <lvl>  Exit 1 when a target is at this level or worse (default: down)
      --since <dur>    Window for "report", e.g. 24h, 7d, 2w (default: 7d)
      --alerts         Send alerts during a one-shot check
      --record         Store one-shot results in the database
  -h, --help           Show this help
  -v, --version        Show the version

"report" summarises the stored history: uptime, incidents (runs of failed checks), downtime and latency per target.

Exit codes for "check": 0 = healthy, 1 = a target is at or beyond --fail-on, 2 = usage or configuration error.
`;

const out = (s: string): void => void process.stdout.write(s + '\n');
const err = (s: string): void => void process.stderr.write(s + '\n');

function stamp(): string {
  return new Date().toISOString();
}

/**
 * Resolve `--only` values to targets. Each value may hold several comma separated names.
 * Names match exactly first, then case-insensitively. Config order is kept and duplicates dropped.
 */
export function selectTargets(all: Target[], only: string[]): { targets: Target[]; unknown: string[] } {
  const wanted = only.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
  if (wanted.length === 0) return { targets: all, unknown: [] };
  const chosen = new Set<Target>();
  const unknown: string[] = [];
  for (const name of wanted) {
    const hit = all.find((t) => t.name === name) ?? all.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit) chosen.add(hit);
    else unknown.push(name);
  }
  return { targets: all.filter((t) => chosen.has(t)), unknown };
}

async function cmdCheck(config: Config, values: Record<string, unknown>): Promise<number> {
  const failOn = (values['fail-on'] as string | undefined) ?? 'down';
  if (failOn !== 'down' && failOn !== 'degraded') {
    err('--fail-on must be "down" or "degraded"');
    return 2;
  }
  const selection = selectTargets(config.targets, (values['only'] as string[] | undefined) ?? []);
  if (selection.unknown.length > 0) {
    err(`Unknown target(s): ${selection.unknown.join(', ')}. Available: ${config.targets.map((t) => t.name).join(', ')}`);
    return 2;
  }
  const targets = selection.targets;

  const record = values['record'] === true || values['alerts'] === true;
  const store = record ? new Store(config.database) : undefined;
  const channels = values['alerts'] === true ? createChannels(config.channels) : [];
  const service = new MonitorService({ config, ...(store ? { store } : {}), channels, log: (l, m) => l !== 'info' && err(`${l}: ${m}`) });
  const outcomes = await service.checkAll(targets);
  store?.close();

  const worst = outcomes.reduce((max, o) => Math.max(max, SEVERITY[o.result.status]), 0);
  if (values['json'] === true) {
    const checkedAt = stamp();
    out(
      JSON.stringify(
        outcomes.map((o) => ({
          name: o.target.name,
          type: o.target.type,
          ...o.result,
          // true when this target alone would not trip --fail-on
          ok: SEVERITY[o.result.status] < SEVERITY[failOn],
          checkedAt,
        })),
        null,
        2,
      ),
    );
  } else {
    const width = Math.max(...outcomes.map((o) => o.target.name.length), 4);
    for (const o of outcomes) {
      const tag = { up: ' UP ', degraded: 'WARN', down: 'DOWN' }[o.result.status as Status];
      out(`[${tag}] ${o.target.name.padEnd(width)}  ${o.result.message}`);
    }
    const bad = outcomes.filter((o) => o.result.status !== 'up').length;
    out(`\n${outcomes.length - bad}/${outcomes.length} healthy`);
  }
  return worst >= SEVERITY[failOn] ? 1 : 0;
}

async function cmdRun(config: Config): Promise<number> {
  const store = new Store(config.database);
  const log = (level: string, message: string): void => out(`${stamp()} ${level.padEnd(5)} ${message}`);
  const channels = createChannels(config.channels);
  const service = new MonitorService({ config, store, channels, log });

  const pruned = store.prune(Date.now(), config.retentionDays);
  log('info', `started: ${config.targets.length} target(s), ${channels.length} alert channel(s), pruned ${pruned.results} old result(s)`);

  const scheduler = new Scheduler(config.targets, {
    jitter: config.jitter,
    run: async (target) => {
      const o = await service.checkTarget(target);
      log(o.result.status === 'up' ? 'info' : 'warn', `${target.name}: ${o.result.status} (${o.result.message}) [${formatDuration(o.result.latencyMs)}]`);
      return { retrying: o.retrying };
    },
    onError: (t, e) => log('error', `${t.name}: ${e.message}`),
  });
  scheduler.start();

  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => store.prune(Date.now(), config.retentionDays), 6 * 3_600_000));
  const outDir = config.statusPage.outDir;
  if (outDir) {
    const publish = (): void => {
      try {
        writeStatusPage(config, store, outDir);
      } catch (e) {
        log('error', `status page: ${(e as Error).message}`);
      }
    };
    timers.push(setInterval(publish, config.statusPage.refreshMinutes * 60_000));
    setTimeout(publish, 15_000).unref();
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  log('info', 'shutting down');
  timers.forEach(clearInterval);
  await scheduler.stop();
  if (outDir) writeStatusPage(config, store, outDir);
  store.close();
  return 0;
}

function cmdReport(config: Config, values: Record<string, unknown>): number {
  let windowMs: number;
  try {
    windowMs = parseDuration((values['since'] as string | undefined) ?? '7d', '--since');
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (windowMs <= 0) {
    err('--since must be greater than zero');
    return 2;
  }
  const selection = selectTargets(config.targets, (values['only'] as string[] | undefined) ?? []);
  if (selection.unknown.length > 0) {
    err(`Unknown target(s): ${selection.unknown.join(', ')}. Available: ${config.targets.map((t) => t.name).join(', ')}`);
    return 2;
  }
  const now = Date.now();
  const store = new Store(config.database);
  const report = buildReport(
    selection.targets.map((t) => ({ name: t.name, type: t.type, results: store.resultsBetween(t.name, now - windowMs, now) })),
    now,
    windowMs,
    config.retentionDays,
  );
  store.close();
  out(values['json'] === true ? JSON.stringify(report, null, 2) : formatReport(report));
  return 0;
}

function cmdStatusPage(config: Config, outDir: string | undefined): number {
  const dir = outDir ?? config.statusPage.outDir;
  if (!dir) {
    err('status-page needs --out <dir> (or statusPage.outDir in the configuration)');
    return 2;
  }
  const store = new Store(config.database);
  const model = writeStatusPage(config, store, dir);
  store.close();
  out(`Wrote ${dir}/index.html and ${dir}/status.json (${model.targets.length} target(s), ${model.overall})`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c', default: 'monitor.yaml' },
        out: { type: 'string', short: 'o' },
        only: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        since: { type: 'string' },
        'fail-on': { type: 'string' },
        alerts: { type: 'boolean' },
        record: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    err((e as Error).message);
    err(HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    out(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    out(HELP);
    return command || values.help ? 0 : 2;
  }
  if (!['check', 'run', 'report', 'status-page', 'validate'].includes(command)) {
    err(`Unknown command: ${command}`);
    err(HELP);
    return 2;
  }

  let config: Config;
  try {
    config = loadConfig(values.config as string);
  } catch (e) {
    err(e instanceof ConfigError ? `Configuration error: ${e.message}` : (e as Error).message);
    return 2;
  }

  switch (command) {
    case 'validate':
      out(`OK: ${config.targets.length} target(s), ${config.channels.length} alert channel(s)`);
      return 0;
    case 'check':
      return cmdCheck(config, values);
    case 'run':
      return cmdRun(config);
    case 'report':
      return cmdReport(config, values);
    default:
      return cmdStatusPage(config, values.out);
  }
}
