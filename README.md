# uptime-ssl-monitor

A small self-hosted monitor for websites, TCP services, TLS certificates and domain registrations. Run it as a one-shot check in CI, or as a daemon that stores history in SQLite, sends alerts and publishes a static status page.

- HTTP(S) checks: expected status, keyword present or absent, maximum response time (slow = degraded)
- TCP port checks
- TLS certificate checks: days left with warn and critical thresholds, issuer, SAN match (wildcards supported)
- Domain expiry through [RDAP](https://rdap.org) with caching and stale fallback
- Per-target intervals with jitter, retries before alerting, recovery thresholds and flap protection
- Alerts: Telegram, Slack webhook, HMAC signed webhook, email (SMTP)
- SQLite history with retention, daily rollups, and a responsive dark/light status page with 90-day uptime bars
- Node 20+, TypeScript, tiny dependency list (`yaml`, `better-sqlite3`; `nodemailer` is optional)

## Install

```bash
npm install -g uptime-ssl-monitor     # provides the "monitor" command
# or from a clone
npm install && npm run build && node dist/bin.js --help
```

Docker:

```bash
docker build -t uptime-ssl-monitor .
docker run -d --name monitor -v $PWD/monitor.yaml:/config/monitor.yaml:ro -v monitor-data:/data \
  -e TELEGRAM_BOT_TOKEN=... uptime-ssl-monitor
```

Point `database` and `statusPage.outDir` at `/data/...` in the container.

## Example configuration

```yaml
database: ./data/monitor.db
retentionDays: 30

defaults:
  interval: 60s
  timeout: 10s
  retries: 2

statusPage:
  title: Example status
  outDir: ./public

alerts:
  - name: ops-telegram
    type: telegram
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}

targets:
  - name: Website
    type: http
    url: https://example.com/
    expectedStatus: [200]
    keyword: "Example Domain"
    maxResponseTime: 1500ms

  - name: Database
    type: tcp
    host: db.internal.example.com
    port: 5432

  - name: Website certificate
    type: tls
    host: example.com
    san: [example.com, www.example.com]
    warnDays: 21
    criticalDays: 7

  - name: example.com registration
    type: domain
    domain: example.com
```

A fully commented file is in [`examples/monitor.example.yaml`](examples/monitor.example.yaml). Values like `${VAR}` and `${VAR:-default}` are read from the environment, so secrets never need to live in the file.

## Commands

```bash
monitor check       -c monitor.yaml [--only name] [--json] [--fail-on down|degraded] [--alerts] [--record]
monitor run         -c monitor.yaml
monitor status-page -c monitor.yaml --out ./public
monitor validate    -c monitor.yaml
```

### `monitor check`

Runs every target once and prints the result. Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Everything is at a healthier level than `--fail-on` (default `down`, so degraded passes) |
| 1 | At least one target is at or beyond `--fail-on` |
| 2 | Usage or configuration error |

`--record` stores the results in the database; `--alerts` sends alerts (and implies recording so state is kept). CI example:

```yaml
- run: npx -p uptime-ssl-monitor monitor check -c monitor.yaml --fail-on degraded
```

(Use `npx -p uptime-ssl-monitor monitor check ...` if your npm version needs the binary name.)

### `monitor run`

The daemon. It restores state from SQLite, schedules every target on its own timer, writes results, sends alerts, prunes old data and, when `statusPage.outDir` is set, regenerates the status page every `refreshMinutes`. SIGINT and SIGTERM stop it gracefully.

### `monitor status-page`

Builds `index.html` (self-contained, no external requests) and `status.json` from the stored history. Serve the folder with any static host.

## How alerting works

Each result is `up`, `degraded` or `down`. The confirmed status changes only when the evidence is consistent:

- A worse status is confirmed after `retries + 1` consecutive bad checks. While a failure is unconfirmed, the target is re-checked every `retryInterval`.
- A better status needs `recovery` consecutive good checks.
- Flap protection: when a target changes confirmed status `flap.threshold` times within `flap.window`, one "flapping" alert is sent and individual down/recovered alerts are muted until the target has been stable for a full window ("stable again" is then sent).
- The first successful check after start-up is silent. State survives restarts.

Degraded means: slower than `maxResponseTime`, a certificate or domain inside its warning window, or an RDAP registry that could not be reached (a registry outage is never reported as your domain being down).

### Channels

| Type | Required settings |
| --- | --- |
| `telegram` | `botToken`, `chatId` |
| `slack` | `webhookUrl` (incoming webhook) |
| `webhook` | `url`, optional `secret`, `headers` |
| `email` | `from`, `to`, `smtp` (`host`, `port`, `secure`, `user`, `pass`); requires `npm install nodemailer` |

A target's `alerts: [name, ...]` limits which channels it uses; without it all channels are used.

Signed webhooks send JSON with `x-monitor-timestamp` and `x-monitor-signature: sha256=<hex>` where the signature is HMAC-SHA256 of `"<timestamp>.<raw body>"`. Verify it on the receiving side:

```ts
import { verifySignature } from 'uptime-ssl-monitor';
verifySignature(secret, req.headers['x-monitor-timestamp'], rawBody, req.headers['x-monitor-signature']);
```

Payload: `{ event, target, type, from, to, message, timestamp, details }` with `event` one of `down`, `degraded`, `recovered`, `flapping`, `flap-ended`.

Email goes through a small `EmailTransport` interface (`sendMail`), so you can plug in any mailer in code instead of nodemailer.

## Data and retention

Raw results are kept for `retentionDays` (default 30). Daily rollups (checks, up, degraded, down, average latency) are kept for 400 days, so the 90-day bars stay accurate even with short raw retention. Uptime counts degraded as available. A day is shown red when at least 1% of its checks failed, amber when anything failed or degraded, green otherwise. RDAP answers are cached in the same database for `rdap.cacheHours`.

## Development

```bash
npm install
npm run lint
npm test          # 200+ tests: local HTTP/TLS/TCP servers, generated self-signed certificates, mocked RDAP
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed, by [Saizul Amin](https://saizul.com).
