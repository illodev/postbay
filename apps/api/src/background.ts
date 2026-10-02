import type { Ctx } from './context.js';
import { sendPendingPush } from './services/push.js';
import { sendPendingSlack } from './services/slack.js';
import { describeNotification, notifyRoles, recipientLocale } from './services/notify.js';

/** Whether a person wants this kind by email: all of them unless they turned some off (see services/push.ts for the preferences). */
const emailWanted = (prefs: { emailOff?: string[] } | null, kind: string) => !(prefs?.emailOff ?? []).includes(kind);

/** Emails the notifications that have not been sent yet, each in its reader's language. Without SMTP they end up in the server log. */
export async function sendPendingEmails(ctx: Ctx, limit = 50): Promise<number> {
  return ctx.db.tx(async (db) => {
    const rows = await db.query(
      `select n.id, n.kind, n.payload, u.email, u.notify_prefs, b.name as brand, b.locale as brand_locale, p.title as piece_title
       from notification n join app_user u on u.id = n.user_id join brand b on b.id = n.brand_id
       left join piece p on p.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.emailed_at is null order by n.created_at limit $1 for update of n skip locked`,
      [limit],
    );
    let sent = 0;
    for (const n of rows) {
      // Someone who turned this kind off is not emailed it; the notification is still in the bell.
      if (!emailWanted(n.notify_prefs, n.kind)) {
        await db.query('update notification set emailed_at = now() where id = $1', [n.id]);
        continue;
      }
      // In the person's language: their own choice, or the brand's.
      const d = describeNotification(recipientLocale(n.notify_prefs, n.brand_locale), ctx.config.APP_URL, n.kind, n.payload, n.brand, n.piece_title);
      try {
        await ctx.mailer.send(n.email, d.title, `${d.subject}${d.body ? `\n\n${d.body}` : ''}\n\n${d.url}\n`);
        await db.query('update notification set emailed_at = now() where id = $1', [n.id]);
        sent++;
      } catch (err) {
        ctx.log.error({ err: String(err), notificationId: n.id }, 'could not send notification email');
      }
    }
    return sent;
  });
}

/**
 * Assisted publishing: when a scheduled publication reaches its time, tell the approvers it is due.
 * Paused brands are skipped, and a publication is only announced once per date it is set to.
 */
export async function notifyDuePublications(ctx: Ctx): Promise<number> {
  return ctx.db.tx(async (db) => {
    const due = await db.query(
      `update publication pub set due_notified_at = now()
       from variant v join piece p on p.id = v.piece_id join brand b on b.id = p.brand_id
       where v.id = pub.variant_id and pub.manual and pub.status = 'scheduled' and pub.scheduled_at <= now()
         and pub.due_notified_at is null and not b.paused
       returning pub.id, p.brand_id, p.id as piece_id`,
    );
    for (const d of due) {
      await notifyRoles(db, d.brand_id, ['approver', 'admin'], 'publication.due', { publicationId: d.id, pieceId: d.piece_id }, null);
    }
    return due.length;
  });
}

export function startBackground(ctx: Ctx, everyMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await notifyDuePublications(ctx);
      await sendPendingEmails(ctx);
      await sendPendingSlack(ctx);
      await sendPendingPush(ctx);
    } catch (err) {
      ctx.log.error({ err: String(err) }, 'background tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
