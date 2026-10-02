import type { Ctx } from './context.js';
import { notifyRoles } from './services/notify.js';

const SUBJECTS: Record<string, string> = {
  'version.uploaded': 'A new version is ready for review',
  'comment.created': 'New comment on a piece',
  'version.changes_requested': 'Changes were requested on a version',
  'version.approved': 'A version was approved',
  'publication.due': 'A publication is due: it needs to go out now',
  'publication.reapproval': 'A change to a scheduled publication needs your confirmation',
  'publication.on_hold': 'Scheduled publications were put on hold by a new version',
  'publication.published': 'A post went out',
  'publication.failed': 'A post could not be published',
  'publication.private': 'A video was uploaded but is private: a person has to make it public',
  'account.reconnect': 'An account needs to be reconnected',
  'account.expiring': 'An account connection is about to expire',
  'webhook.failing': 'A webhook is failing: events are not reaching its receiver',
  'agent.needs_person': 'The agent has handed a piece back to a person',
  'agent.failed': 'An agent run failed',
};

/** Emails the notifications that have not been sent yet. Without SMTP they end up in the server log. */
export async function sendPendingEmails(ctx: Ctx, limit = 50): Promise<number> {
  return ctx.db.tx(async (db) => {
    const rows = await db.query(
      `select n.id, n.kind, n.payload, u.email, b.name as brand, p.title as piece_title
       from notification n join app_user u on u.id = n.user_id join brand b on b.id = n.brand_id
       left join piece p on p.id = nullif(n.payload->>'pieceId', '')::uuid
       where n.emailed_at is null order by n.created_at limit $1 for update of n skip locked`,
      [limit],
    );
    let sent = 0;
    for (const n of rows) {
      const link = n.payload.pieceId ? `${ctx.config.APP_URL}/pieces/${n.payload.pieceId}` : ctx.config.APP_URL;
      try {
        await ctx.mailer.send(
          n.email,
          `[${n.brand}] ${SUBJECTS[n.kind] ?? n.kind}`,
          `${SUBJECTS[n.kind] ?? n.kind}${n.piece_title ? `\n\nPiece: ${n.piece_title}` : ''}\n\n${link}\n`,
        );
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
