import { describe, expect, it, vi } from 'vitest';
import { createChannels, createEmailChannel, createSlackChannel, createTelegramChannel, createWebhookChannel, dispatchAlert, signPayload, verifySignature } from '../src/alerts/index.js';
import { alertText, alertTitle } from '../src/alerts/types.js';
import type { AlertEvent } from '../src/types.js';
import { startHttpServer } from './helpers/servers.js';

const event: AlertEvent = {
  kind: 'down', target: 'Homepage', targetType: 'http', from: 'up', to: 'down',
  message: 'Unexpected status 500', timestamp: Date.UTC(2026, 0, 1, 12, 0, 0), details: { statusCode: 500 },
};

function fakeFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('ok', { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('alert text', () => {
  it('builds a title and body', () => {
    expect(alertTitle(event)).toBe('[DOWN] Homepage');
    const text = alertText(event);
    expect(text).toContain('Unexpected status 500');
    expect(text).toContain('Status: up -> down');
    expect(text).toContain('2026-01-01T12:00:00.000Z');
  });
  it.each([['recovered', 'RECOVERED'], ['degraded', 'DEGRADED'], ['flapping', 'FLAPPING'], ['flap-ended', 'STABLE AGAIN']] as const)('labels %s', (kind, label) => {
    expect(alertTitle({ ...event, kind })).toBe(`[${label}] Homepage`);
  });
  it('omits the transition line for flapping events', () => {
    expect(alertText({ ...event, kind: 'flapping' })).not.toContain('Status:');
  });
});

describe('telegram', () => {
  it('posts to the Bot API sendMessage endpoint', async () => {
    const f = fakeFetch();
    await createTelegramChannel({ name: 'tg', botToken: '123:SECRET', chatId: '-100' }, { fetchImpl: f.impl }).send(event);
    expect(f.calls[0]!.url).toBe('https://api.telegram.org/bot123:SECRET/sendMessage');
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body).toMatchObject({ chat_id: '-100', disable_web_page_preview: true });
    expect(body.text).toContain('[DOWN] Homepage');
  });
  it('does not leak the token in errors', async () => {
    const f = fakeFetch(401);
    const err = await createTelegramChannel({ name: 'tg', botToken: '123:SECRET', chatId: 1 }, { fetchImpl: f.impl }).send(event).catch((e: Error) => e);
    expect((err as Error).message).toBe('Telegram sendMessage failed with HTTP 401');
    expect((err as Error).message).not.toContain('SECRET');
  });
  it('supports a custom API base', async () => {
    const f = fakeFetch();
    await createTelegramChannel({ name: 'tg', botToken: 't', chatId: 1, apiBase: 'http://localhost:9/' }, { fetchImpl: f.impl }).send(event);
    expect(f.calls[0]!.url).toBe('http://localhost:9/bott/sendMessage');
  });
});

describe('slack', () => {
  it('posts a colored attachment', async () => {
    const f = fakeFetch();
    await createSlackChannel({ name: 'sl', webhookUrl: 'https://hooks.slack.test/T/B/x' }, { fetchImpl: f.impl }).send(event);
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(f.calls[0]!.url).toBe('https://hooks.slack.test/T/B/x');
    expect(body.text).toBe('[DOWN] Homepage');
    expect(body.attachments[0].color).toBe('#d32f2f');
  });
  it('throws on HTTP errors', async () => {
    await expect(createSlackChannel({ name: 'sl', webhookUrl: 'https://h.test/x' }, { fetchImpl: fakeFetch(500).impl }).send(event)).rejects.toThrow(/HTTP 500/);
  });
});

describe('signed webhook', () => {
  it('signs and verifies payloads', () => {
    const sig = signPayload('secret', '1700000000000', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature('secret', '1700000000000', '{"a":1}', sig, { now: 1700000000000 })).toBe(true);
  });
  it('rejects tampering, wrong secrets and replays', () => {
    const sig = signPayload('secret', '1700000000000', '{"a":1}');
    const now = 1700000000000;
    expect(verifySignature('secret', '1700000000000', '{"a":2}', sig, { now })).toBe(false);
    expect(verifySignature('other', '1700000000000', '{"a":1}', sig, { now })).toBe(false);
    expect(verifySignature('secret', '1700000000000', '{"a":1}', sig, { now: now + 10 * 60_000 })).toBe(false);
    expect(verifySignature('secret', '1700000000000', '{"a":1}', 'sha256=short', { now })).toBe(false);
    expect(verifySignature('secret', 'abc', '{"a":1}', sig, { now })).toBe(false);
  });

  it('delivers a verifiable request to a real HTTP endpoint', async () => {
    const server = await startHttpServer((_req, res) => { res.end('ok'); });
    try {
      await createWebhookChannel({ name: 'wh', url: `http://127.0.0.1:${server.port}/hook`, secret: 'topsecret', headers: { 'x-env': 'test' } }).send(event);
      const req = server.requests[0]!;
      expect(req.method).toBe('POST');
      expect(req.headers['x-env']).toBe('test');
      const ts = req.headers['x-monitor-timestamp'] as string;
      expect(verifySignature('topsecret', ts, req.body, req.headers['x-monitor-signature'] as string)).toBe(true);
      expect(JSON.parse(req.body)).toMatchObject({ event: 'down', target: 'Homepage', type: 'http', from: 'up', to: 'down', timestamp: '2026-01-01T12:00:00.000Z', details: { statusCode: 500 } });
    } finally {
      await server.close();
    }
  });

  it('sends no signature header without a secret', async () => {
    const f = fakeFetch();
    await createWebhookChannel({ name: 'wh', url: 'https://h.test/x' }, { fetchImpl: f.impl }).send(event);
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-monitor-signature']).toBeUndefined();
    expect(headers['x-monitor-timestamp']).toBeDefined();
  });
});

describe('email', () => {
  it('sends through a pluggable transport', async () => {
    const sendMail = vi.fn(async () => ({}));
    await createEmailChannel({ name: 'm', from: 'monitor@x.com', to: ['a@x.com', 'b@x.com'], smtp: { host: 'smtp.x.com' } }, { sendMail }).send(event);
    expect(sendMail).toHaveBeenCalledWith({ from: 'monitor@x.com', to: ['a@x.com', 'b@x.com'], subject: '[DOWN] Homepage', text: alertText(event) });
  });
  it('wraps a single recipient in a list', async () => {
    const sendMail = vi.fn(async (_m: unknown) => ({}));
    await createEmailChannel({ name: 'm', from: 'f@x.com', to: 'a@x.com', smtp: { host: 'h' } }, { sendMail }).send(event);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ to: ['a@x.com'] });
  });
  it('propagates transport errors', async () => {
    const sendMail = vi.fn(async () => { throw new Error('SMTP 550'); });
    await expect(createEmailChannel({ name: 'm', from: 'f', to: 'a', smtp: { host: 'h' } }, { sendMail }).send(event)).rejects.toThrow('SMTP 550');
  });
});

describe('dispatchAlert and createChannels', () => {
  it('builds channels from config', () => {
    const channels = createChannels([
      { name: 'a', type: 'slack', webhookUrl: 'u' },
      { name: 'b', type: 'telegram', botToken: 't', chatId: 1 },
      { name: 'c', type: 'webhook', url: 'u' },
      { name: 'd', type: 'email', from: 'f', to: ['t'], smtp: { host: 'h' } },
    ]);
    expect(channels.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sends to all channels by default and filters by name', async () => {
    const sent: string[] = [];
    const mk = (name: string) => ({ name, send: async () => { sent.push(name); } });
    const channels = [mk('a'), mk('b'), mk('c')];
    await dispatchAlert(channels, [], event);
    expect(sent.sort()).toEqual(['a', 'b', 'c']);
    sent.length = 0;
    await dispatchAlert(channels, ['b'], event);
    expect(sent).toEqual(['b']);
  });

  it('isolates channel failures', async () => {
    const errors: string[] = [];
    const ok = { name: 'ok', send: vi.fn(async () => {}) };
    const bad = { name: 'bad', send: async () => { throw new Error('nope'); } };
    const r = await dispatchAlert([bad, ok], [], event, (c, e) => errors.push(`${c}:${e.message}`));
    expect(r).toEqual({ sent: ['ok'], failed: ['bad'] });
    expect(errors).toEqual(['bad:nope']);
    expect(ok.send).toHaveBeenCalledOnce();
  });
});
