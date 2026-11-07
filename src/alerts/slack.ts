import { alertText, postJson, type AlertChannel, type FetchDeps } from './types.js';

export interface SlackConfig {
  name: string;
  webhookUrl: string;
}

const COLORS = { down: '#d32f2f', degraded: '#f9a825', recovered: '#2e7d32', flapping: '#8e24aa', 'flap-ended': '#1976d2' } as const;

export function createSlackChannel(cfg: SlackConfig, deps: FetchDeps = {}): AlertChannel {
  return {
    name: cfg.name,
    async send(event) {
      const text = alertText(event);
      const body = JSON.stringify({ text: text.split('\n')[0], attachments: [{ color: COLORS[event.kind], text }] });
      await postJson(deps.fetchImpl ?? fetch, cfg.webhookUrl, body, {}, 'Slack webhook');
    },
  };
}
