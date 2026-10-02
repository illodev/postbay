import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, type Prize, type PrizeDelivery, type PublicationPrize, type PublicationRow } from '../api';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { CopyButton, Dialog, ErrorBox, Field, Spinner, useToast } from './ui';

const REASON_LABEL: Record<string, string> = {
  rule_off: 'The prize was switched off before it could be sent',
  too_old: 'The comment is older than the 7 days the network allows for a private reply',
  already_received: 'This person already received this prize',
};

const DEFAULT_MESSAGE = 'Hi {{name}}! Here is {{prize}}: {{link}}\n\nThe link works for {{hours}} hours.';

/** What the message looks like for a person, with made-up values, so nobody has to guess how {{link}} comes out. */
export function previewMessage(template: string, prize: string, hours: number) {
  return template
    .replace(/\{\{\s*name\s*\}\}/g, 'Alex')
    .replace(/\{\{\s*prize\s*\}\}/g, prize || 'the prize')
    .replace(/\{\{\s*hours\s*\}\}/g, String(hours))
    .replace(/\{\{\s*link\s*\}\}/g, 'https://…/prize/…');
}

function RuleForm({ pub, info, prizes, onClose }: { pub: PublicationRow; info: PublicationPrize; prizes: Prize[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rule = info.rule;
  const usable = prizes.filter((p) => p.usable && (!p.archived || p.id === rule?.prize?.id));
  const [prizeId, setPrizeId] = useState(rule?.prize?.id ?? usable[0]?.id ?? '');
  const [keyword, setKeyword] = useState(rule?.keyword ?? '');
  const [message, setMessage] = useState(rule?.message ?? DEFAULT_MESSAGE);
  const [hours, setHours] = useState(rule?.link_hours ?? 72);
  const [days, setDays] = useState(30);
  const [confirmed, setConfirmed] = useState(rule?.notice_confirmed ?? false);
  const [active, setActive] = useState(rule?.active ?? true);
  const priv = info.mode === 'private_reply';
  const cannotSend = priv && info.can_message === false;
  const prizeName = usable.find((p) => p.id === prizeId)?.name ?? '';

  const save = useMutation({
    mutationFn: () => api.put(`/api/publications/${pub.id}/prize`, { prizeId, keyword, message, linkHours: hours, publicDays: days, noticeConfirmed: confirmed, active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prize', pub.id] });
      qc.invalidateQueries({ queryKey: ['prize-deliveries', pub.id] });
      qc.invalidateQueries({ queryKey: ['prizes'] });
      toast(active ? 'Prize saved: it is running' : 'Prize saved, switched off');
    },
  });

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {!info.prizes_enabled && (
        <div className="notice notice-warn">Prizes are switched off for this brand. An admin switches them on in <Link to="/settings?tab=prizes" onClick={onClose}>Settings → Prizes</Link>.</div>
      )}
      {cannotSend && (
        <div className="notice notice-warn" data-testid="needs-reconnect">
          This account was connected without the permission to send private messages. An admin switches prizes on in Settings → Prizes and connects the account again; the sign-in then asks for it.
        </div>
      )}
      <div className="notice notice-info">
        {priv
          ? <>Anyone who comments the keyword on this {NETWORK_LABEL[pub.network] ?? pub.network} post gets the prize as a private message, by the app itself. Each person gets each prize once.</>
          : <>{NETWORK_LABEL[pub.network] ?? pub.network} posts cannot send private messages here. The prize gets a public page instead: pin a comment on the post that points people to the link below.</>}
      </div>
      {usable.length === 0 ? (
        <div className="notice notice-warn">There is no prize to give yet. Add one in <Link to="/settings?tab=prizes" onClick={onClose}>Settings → Prizes</Link>: a file or a link.</div>
      ) : (
        <Field label="Prize">
          <select value={prizeId} onChange={(e) => setPrizeId(e.target.value)} required>
            {usable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind === 'file' ? 'file' : 'link'})</option>)}
          </select>
        </Field>
      )}
      {priv && (
        <Field label="Keyword" hint="Comments that contain this word (any case, accents ignored, as a whole word) win the prize.">
          <input type="text" required maxLength={60} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="recipe" />
        </Field>
      )}
      {!priv && (
        <Field label="Note to yourself" hint="Not shown to anyone. People see the name of the prize on its page.">
          <input type="text" required maxLength={60} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="giveaway in the pinned comment" />
        </Field>
      )}
      {priv && (
        <>
          <Field label="Message" hint="Placeholders: {{name}}, {{prize}}, {{link}} (required), {{hours}}. The note below is added to every message.">
            <textarea required maxLength={700} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="preview-text" aria-label="How the message looks">
            <span className="muted small">What Alex receives</span>
            <div>{previewMessage(message, prizeName, hours)}</div>
            <div className="muted small" style={{ marginTop: '.4rem' }}>{info.auto_notice}</div>
          </div>
          <Field label="The link works for (hours)">
            <input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ maxWidth: 120 }} />
          </Field>
        </>
      )}
      {!priv && (
        <Field label="The public page stays open for (days)">
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 120 }} />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>
          The text of this post tells people that the reply is automatic and what is done with their data.
          <span className="muted small" style={{ display: 'block' }}>Required: a prize does not run without it. Every message also ends with “{info.auto_notice}”.</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>Running <span className="muted small">(untick to stop giving it out without losing the settings)</span></span>
      </label>
      {save.error && <ErrorBox error={save.error} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button className="btn btn-primary" disabled={save.isPending || !prizeId}>Save</button>
      </div>
    </form>
  );
}

function Deliveries({ pubId, zone }: { pubId: string; zone: string }) {
  const { data } = useQuery({ queryKey: ['prize-deliveries', pubId], queryFn: () => api.get<PrizeDelivery[]>(`/api/publications/${pubId}/prize/deliveries`), refetchInterval: 30_000 });
  if (!data) return null;
  if (data.length === 0) return <p className="muted small">Nobody has won it yet.</p>;
  return (
    <div className="stack" style={{ gap: '.4rem' }}>
      <h3>People</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Person</th><th>Commented</th><th>Result</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>{d.person}</td>
                <td>{fmtDateTime(d.comment_at, zone)}</td>
                <td>
                  <span className={`chip ${d.status === 'sent' ? 'chip-approved' : d.status === 'pending' ? 'chip-scheduled' : d.status === 'failed' ? 'chip-failed' : ''}`}>
                    {{ sent: 'Sent', pending: 'Waiting', skipped: 'Skipped', failed: 'Failed' }[d.status]}
                  </span>
                  {d.status === 'sent' && <div className="muted small">{d.downloads} download{d.downloads === 1 ? '' : 's'}</div>}
                  {d.reason && <div className="muted small">{REASON_LABEL[d.reason] ?? d.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Only the name they show is kept, and it is deleted automatically when the retention period set in Settings → Prizes ends.</p>
    </div>
  );
}

/** The prize a post carries: who gets what for which comment, and how it is going. */
export function PrizeDialog({ pub, brandId, zone, onClose }: { pub: PublicationRow; brandId: string; zone: string; onClose: () => void }) {
  const { data: info, error } = useQuery({ queryKey: ['prize', pub.id], queryFn: () => api.get<PublicationPrize>(`/api/publications/${pub.id}/prize`) });
  const { data: prizes } = useQuery({ queryKey: ['prizes', brandId], queryFn: () => api.get<Prize[]>(`/api/brands/${brandId}/prizes`) });
  const rule = info?.rule;
  return (
    <Dialog title={`Prize · ${NETWORK_LABEL[pub.network] ?? pub.network}`} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {(!info || !prizes) && !error && <Spinner />}
      {info && prizes && (
        <div className="stack">
          {rule && (
            <div className="row" style={{ gap: '.4rem' }}>
              <span className={`chip ${rule.active ? 'chip-approved' : ''}`}>{rule.active ? 'Running' : 'Switched off'}</span>
              <span className="muted small">
                {rule.deliveries.sent} sent · {rule.deliveries.pending} waiting · {rule.deliveries.skipped} skipped · {rule.deliveries.failed} failed
              </span>
            </div>
          )}
          {rule && info.mode === 'public_link' && rule.public_url && (
            <div className="card stack" style={{ gap: '.4rem' }}>
              <div className="row-between"><strong>Public link</strong><CopyButton text={rule.public_url} label="Copy link" /></div>
              <code className="mono small" style={{ overflowWrap: 'anywhere' }}>{rule.public_url}</code>
              {rule.public_expires_at && <span className="muted small">Open until {fmtDateTime(rule.public_expires_at, zone)}. Anyone with the link can open it.</span>}
            </div>
          )}
          <RuleForm key={rule?.id ?? 'new'} pub={pub} info={info} prizes={prizes} onClose={onClose} />
          {rule && info.mode === 'private_reply' && <Deliveries pubId={pub.id} zone={zone} />}
        </div>
      )}
    </Dialog>
  );
}
