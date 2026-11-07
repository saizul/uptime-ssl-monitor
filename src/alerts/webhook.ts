import { createHmac, timingSafeEqual } from 'node:crypto';
import { postJson, type AlertChannel, type FetchDeps } from './types.js';

export interface WebhookConfig {
  name: string;
  url: string;
  /** Shared secret used to sign the payload with HMAC-SHA256. */
  secret?: string;
  headers?: Record<string, string>;
}

/** Signature over `${timestamp}.${body}`, hex encoded and prefixed with "sha256=". */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Receiver side helper: constant-time signature check with a replay window. */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  opts: { toleranceMs?: number; now?: number } = {},
): boolean {
  const age = Math.abs((opts.now ?? Date.now()) - Number(timestamp));
  if (!Number.isFinite(age) || age > (opts.toleranceMs ?? 5 * 60_000)) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function createWebhookChannel(cfg: WebhookConfig, deps: FetchDeps = {}): AlertChannel {
  return {
    name: cfg.name,
    async send(event) {
      const body = JSON.stringify({
        event: event.kind,
        target: event.target,
        type: event.targetType,
        from: event.from,
        to: event.to,
        message: event.message,
        timestamp: new Date(event.timestamp).toISOString(),
        details: event.details ?? {},
      });
      const timestamp = String(Date.now());
      const headers: Record<string, string> = { ...(cfg.headers ?? {}), 'x-monitor-timestamp': timestamp };
      if (cfg.secret) headers['x-monitor-signature'] = signPayload(cfg.secret, timestamp, body);
      await postJson(deps.fetchImpl ?? fetch, cfg.url, body, headers, 'Webhook');
    },
  };
}
