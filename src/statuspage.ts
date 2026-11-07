import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { ConfirmedStatus, Config, Target } from './types.js';
import { escapeHtml } from './util.js';

const DAY_MS = 86_400_000;

export type DayStatus = 'up' | 'degraded' | 'down' | 'none';

export interface DayCell {
  day: string;
  status: DayStatus;
  /** Uptime percentage (degraded counts as available) or null without data. */
  uptime: number | null;
  checks: number;
}

export interface TargetView {
  name: string;
  type: Target['type'];
  status: ConfirmedStatus;
  message: string;
  latencyMs: number | null;
  lastCheck: number | null;
  uptime90: number | null;
  days: DayCell[];
}

export interface StatusModel {
  title: string;
  description: string;
  generatedAt: number;
  overall: 'operational' | 'degraded' | 'outage' | 'unknown';
  targets: TargetView[];
}

/** Classify one day from its counters. */
export function classifyDay(total: number, up: number, degraded: number, down: number): DayStatus {
  if (total === 0) return 'none';
  if (down > 0 && down / total >= 0.01) return 'down';
  if (down > 0 || degraded > 0) return 'degraded';
  return up === total ? 'up' : 'none';
}

export function buildStatusModel(config: Config, store: Store, now: number, days = 90): StatusModel {
  const views: TargetView[] = [];
  for (const t of config.targets) {
    if (t.hidden) continue;
    const rows = new Map(store.dailyUptime(t.name, days, now).map((r) => [r.day, r]));
    const cells: DayCell[] = [];
    let total = 0;
    let available = 0;
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
      const r = rows.get(day);
      if (!r) {
        cells.push({ day, status: 'none', uptime: null, checks: 0 });
        continue;
      }
      total += r.total;
      available += r.up + r.degraded;
      cells.push({
        day,
        status: classifyDay(r.total, r.up, r.degraded, r.down),
        uptime: Math.round(((r.up + r.degraded) / r.total) * 10000) / 100,
        checks: r.total,
      });
    }
    const latest = store.latestResult(t.name);
    views.push({
      name: t.name,
      type: t.type,
      status: store.confirmedStatus(t.name),
      message: latest?.message ?? 'No data yet',
      latencyMs: latest?.latencyMs ?? null,
      lastCheck: latest?.ts ?? null,
      uptime90: total > 0 ? Math.round((available / total) * 10000) / 100 : null,
      days: cells,
    });
  }
  const statuses = views.map((v) => v.status);
  const overall = statuses.includes('down')
    ? 'outage'
    : statuses.includes('degraded')
      ? 'degraded'
      : statuses.length > 0 && statuses.every((s) => s === 'unknown')
        ? 'unknown'
        : 'operational';
  return { title: config.statusPage.title, description: config.statusPage.description, generatedAt: now, overall, targets: views };
}

const OVERALL_TEXT: Record<StatusModel['overall'], string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'Some systems are down',
  unknown: 'Waiting for the first checks',
};

const STATUS_TEXT: Record<ConfirmedStatus, string> = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5b6672;--border:#e1e5ea;--up:#2fa84f;--degraded:#e0a100;--down:#d93a3a;--none:#d5dae0;--accent:#2563eb}
:root[data-theme=dark]{--bg:#0e1116;--card:#171b22;--text:#e6e9ee;--muted:#98a2af;--border:#262c36;--up:#3ec45f;--degraded:#f0b429;--down:#f05252;--none:#2a313b;--accent:#6ea0ff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0e1116;--card:#171b22;--text:#e6e9ee;--muted:#98a2af;--border:#262c36;--up:#3ec45f;--degraded:#f0b429;--down:#f05252;--none:#2a313b;--accent:#6ea0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:20px}
h1{font-size:1.5rem;margin:0}.sub{color:var(--muted);margin:4px 0 0}
button{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.banner{border-radius:12px;padding:16px 20px;color:#fff;font-weight:600;margin-bottom:20px}
.banner.operational{background:var(--up)}.banner.degraded{background:var(--degraded);color:#1b1f24}.banner.outage{background:var(--down)}.banner.unknown{background:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.name{font-weight:600}.type{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;margin-left:8px}
.pill{font-size:.85rem;font-weight:600;padding:2px 10px;border-radius:999px;border:1px solid currentColor}
.pill.up{color:var(--up)}.pill.degraded{color:var(--degraded)}.pill.down{color:var(--down)}.pill.unknown{color:var(--muted)}
.bars{display:flex;gap:2px;height:32px;margin:12px 0 6px}
.bar{flex:1;min-width:2px;border-radius:2px;background:var(--none)}.bar.up{background:var(--up)}.bar.degraded{background:var(--degraded)}.bar.down{background:var(--down)}
.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:.8rem;gap:8px;flex-wrap:wrap}
.msg{color:var(--muted);font-size:.9rem;margin-top:4px;word-break:break-word}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:28px}
@media (max-width:520px){h1{font-size:1.25rem}.card{padding:14px}.bars{height:26px;gap:1px}}
`;

const THEME_JS = `(function(){var r=document.documentElement,k='monitor-theme',s=null;try{s=localStorage.getItem(k)}catch(e){}if(s)r.setAttribute('data-theme',s);document.getElementById('theme').addEventListener('click',function(){var d=r.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var n=d==='dark'?'light':'dark';r.setAttribute('data-theme',n);try{localStorage.setItem(k,n)}catch(e){}})})();`;

function renderTarget(t: TargetView): string {
  const bars = t.days
    .map((d) => {
      const title = d.uptime === null ? `${d.day}: no data` : `${d.day}: ${d.uptime}% uptime (${d.checks} checks)`;
      return `<span class="bar ${d.status}" title="${escapeHtml(title)}"></span>`;
    })
    .join('');
  const uptime = t.uptime90 === null ? 'n/a' : `${t.uptime90}%`;
  const latency = t.latencyMs === null ? '' : ` &middot; ${t.latencyMs}ms`;
  return `<section class="card">
<div class="row"><div><span class="name">${escapeHtml(t.name)}</span><span class="type">${escapeHtml(t.type)}</span></div><span class="pill ${t.status}">${STATUS_TEXT[t.status]}</span></div>
<div class="msg">${escapeHtml(t.message)}${latency}</div>
<div class="bars" role="img" aria-label="${escapeHtml(t.name)} uptime over the last ${t.days.length} days">${bars}</div>
<div class="meta"><span>${t.days.length} days ago</span><span>${uptime} uptime</span><span>Today</span></div>
</section>`;
}

/** Render a single self-contained HTML document. */
export function renderStatusPage(model: StatusModel): string {
  const generated = new Date(model.generatedAt).toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="300">
<title>${escapeHtml(model.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header><div><h1>${escapeHtml(model.title)}</h1>${model.description ? `<p class="sub">${escapeHtml(model.description)}</p>` : ''}</div><button id="theme" type="button" aria-label="Toggle theme">Theme</button></header>
<div class="banner ${model.overall}" role="status">${OVERALL_TEXT[model.overall]}</div>
${model.targets.map(renderTarget).join('\n')}
<footer>Updated <time datetime="${generated}">${generated.replace('T', ' ').slice(0, 19)} UTC</time></footer>
</main>
<script>${THEME_JS}</script>
</body>
</html>
`;
}

/** Write index.html and status.json into `outDir` (atomically replaced). */
export function writeStatusPage(config: Config, store: Store, outDir: string, now = Date.now()): StatusModel {
  const model = buildStatusModel(config, store, now);
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, content: string): void => {
    const tmp = join(outDir, `.${name}.tmp`);
    writeFileSync(tmp, content);
    renameSync(tmp, join(outDir, name));
  };
  write('index.html', renderStatusPage(model));
  write('status.json', JSON.stringify(model, null, 2));
  return model;
}
