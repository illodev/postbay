import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/**
 * Without SMTP_URL, emails are written to the server log, which is enough for development. Never their text in production:
 * a sign-in link in a log signs in whoever reads the log (loadConfig refuses email-link sign-in in production without SMTP,
 * so this is for whatever else is mailed).
 */
export function createMailer(config: Config, log: { info: (o: object, m?: string) => void; warn?: (o: object, m?: string) => void }): Mailer {
  if (!config.SMTP_URL) {
    return {
      async send(to, subject, text) {
        if (config.isProd) (log.warn ?? log.info)({ to, subject }, 'email not sent: SMTP_URL is not set (its text is not logged in production)');
        else log.info({ to, subject, text }, 'email (SMTP not configured)');
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
