# Contributing

Thanks for your interest in uptime-ssl-monitor.

## Setup

```bash
npm install     # needs Node 20+; better-sqlite3 uses a prebuilt binary or builds from source
npm run lint
npm run typecheck
npm test
npm run build
```

## Guidelines

- Tests use vitest and run against local servers: an HTTP server, a TLS server with a
  self-signed certificate created in `test/helpers/cert.ts`, a small UDP DNS server in
  `test/helpers/dns.ts`, and a mocked RDAP endpoint.
  Do not add tests that need the internet.
- New check types belong in `src/checks/`, are wired up in `src/checks/index.ts`, validated
  in `src/config.ts` and covered by tests with a pure `evaluate*` function where possible.
- New alert channels implement `AlertChannel` (`src/alerts/types.ts`) and take an injectable
  `fetch` or transport so they can be tested without network access.
- Keep runtime dependencies minimal. Optional features should load their dependency lazily.
- Never log secrets such as bot tokens, webhook URLs or SMTP passwords.
- Keep pull requests focused and describe the behavior change.

## Reporting bugs

Open an issue with the (redacted) configuration, the command you ran and the output.
