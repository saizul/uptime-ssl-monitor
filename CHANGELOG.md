# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Maintenance windows: a top-level `maintenance` list (`start`, `end`, optional `targets`) suppresses alerts for matching targets while a window is active. Checks, history and the status page keep running.
- HTTP targets accept `basicAuth` (`username`, `password`). Credentials are never forwarded to a different origin on redirect.
- `monitor check --json` entries now include `ok` (agrees with `--fail-on`) and `checkedAt`.
- `--only` accepts comma separated names and matches case-insensitively when there is no exact match; the unknown-name error lists the available targets.

## [1.0.0] - 2026-11-07

### Added
- Checks: HTTP(S) (status, keyword present/absent, response time, redirects), TCP port,
  TLS certificate (days left, issuer, SAN match, chain trust) and domain expiry through RDAP with caching.
- Scheduler with per-target intervals, jitter, staggered start and quicker re-checks while a failure is unconfirmed.
- State machine (up, degraded, down) with retries, recovery threshold and flap protection.
- Alert channels: Telegram, Slack webhook, HMAC signed generic webhook and SMTP email
  (optional nodemailer or a custom transport).
- SQLite persistence with retention and daily rollups.
- Static, responsive status page with dark and light themes and 90-day uptime bars.
- CLI: `monitor check` (CI-friendly exit codes), `monitor run`, `monitor status-page`, `monitor validate`.
- Dockerfile and example configuration.
