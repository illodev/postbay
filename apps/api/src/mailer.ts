import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Without SMTP_URL, emails are written to the server log, which is enough for development. */
export function createMailer(config: Config, log: { info: (o: object, m?: string) => void }): Mailer {
  if (!config.SMTP_URL) {
    return {
      async send(to, subject, text) {
        log.info({ to, subject, text }, 'email (SMTP not configured)');
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
    },
  };
}
