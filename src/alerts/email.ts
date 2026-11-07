import { alertText, alertTitle, type AlertChannel } from './types.js';

/** The only part of nodemailer's API that we use. Plug in anything with this shape. */
export interface EmailTransport {
  sendMail(message: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpSettings {
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}

export interface EmailConfig {
  name: string;
  from: string;
  to: string[] | string;
  smtp: SmtpSettings;
}

/** Create a transport using nodemailer, which is an optional dependency. */
export async function nodemailerTransport(smtp: SmtpSettings): Promise<EmailTransport> {
  let mod: { createTransport: (options: unknown) => EmailTransport };
  try {
    const specifier = 'nodemailer';
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new Error('Email alerts need the optional "nodemailer" package: npm install nodemailer');
  }
  return mod.createTransport({
    host: smtp.host,
    port: smtp.port ?? (smtp.secure ? 465 : 587),
    secure: smtp.secure ?? false,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? '' } } : {}),
  });
}

export function createEmailChannel(cfg: EmailConfig, transport?: EmailTransport): AlertChannel {
  let pending: Promise<EmailTransport> | undefined;
  const getTransport = (): Promise<EmailTransport> => {
    if (transport) return Promise.resolve(transport);
    pending ??= nodemailerTransport(cfg.smtp);
    return pending;
  };
  return {
    name: cfg.name,
    async send(event) {
      const t = await getTransport();
      await t.sendMail({
        from: cfg.from,
        to: Array.isArray(cfg.to) ? cfg.to : [cfg.to],
        subject: alertTitle(event),
        text: alertText(event),
      });
    },
  };
}
