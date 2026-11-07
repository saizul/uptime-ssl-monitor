import type { AlertChannelConfig, AlertEvent } from '../types.js';
import { createEmailChannel, type EmailConfig, type EmailTransport } from './email.js';
import { createSlackChannel, type SlackConfig } from './slack.js';
import { createTelegramChannel, type TelegramConfig } from './telegram.js';
import type { AlertChannel } from './types.js';
import { createWebhookChannel, type WebhookConfig } from './webhook.js';

export * from './types.js';
export { createEmailChannel, nodemailerTransport, type EmailTransport } from './email.js';
export { createSlackChannel } from './slack.js';
export { createTelegramChannel } from './telegram.js';
export { createWebhookChannel, signPayload, verifySignature } from './webhook.js';

export interface ChannelDeps {
  fetchImpl?: typeof fetch;
  emailTransport?: EmailTransport;
}

export function createChannels(configs: AlertChannelConfig[], deps: ChannelDeps = {}): AlertChannel[] {
  const fetchDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  return configs.map((c) => {
    switch (c.type) {
      case 'telegram':
        return createTelegramChannel(c as unknown as TelegramConfig, fetchDeps);
      case 'slack':
        return createSlackChannel(c as unknown as SlackConfig, fetchDeps);
      case 'webhook':
        return createWebhookChannel(c as unknown as WebhookConfig, fetchDeps);
      case 'email':
        return createEmailChannel(c as unknown as EmailConfig, deps.emailTransport);
    }
  });
}

/** Send an event to the selected channels (all when `names` is empty). Failures are reported, never thrown. */
export async function dispatchAlert(
  channels: AlertChannel[],
  names: string[],
  event: AlertEvent,
  onError: (channel: string, error: Error) => void = () => {},
): Promise<{ sent: string[]; failed: string[] }> {
  const selected = names.length === 0 ? channels : channels.filter((c) => names.includes(c.name));
  const sent: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    selected.map(async (c) => {
      try {
        await c.send(event);
        sent.push(c.name);
      } catch (e) {
        failed.push(c.name);
        onError(c.name, e as Error);
      }
    }),
  );
  return { sent, failed };
}
