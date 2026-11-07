import { alertText, postJson, type AlertChannel, type FetchDeps } from './types.js';

export interface TelegramConfig {
  name: string;
  botToken: string;
  chatId: string | number;
  /** Override for tests or a self-hosted Bot API server. */
  apiBase?: string;
}

export function createTelegramChannel(cfg: TelegramConfig, deps: FetchDeps = {}): AlertChannel {
  return {
    name: cfg.name,
    async send(event) {
      const base = (cfg.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
      const body = JSON.stringify({ chat_id: cfg.chatId, text: alertText(event), disable_web_page_preview: true });
      // The URL contains the bot token, so it is never put into an error message.
      await postJson(deps.fetchImpl ?? fetch, `${base}/bot${cfg.botToken}/sendMessage`, body, {}, 'Telegram sendMessage');
    },
  };
}
