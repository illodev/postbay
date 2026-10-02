import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api, type Prize, type PrizeDelivery, type PublicationPrize, type PublicationRow } from '../api';
import { t, tMaybe } from '../i18n';
import { fmtDateTime, NETWORK_LABEL } from '../lib/format';
import { Chip, CopyButton, Dialog, ErrorBox, Field, Select, Spinner, Switch, useToast } from './ui';
import '../styles/settings.css';

/**
 * What the message looks like for a person, with made-up values, so nobody has to guess how {{link}} comes out.
 * The message keys hold {{double braces}} on purpose: they are read with t() and no variables, so nothing in them is filled.
 */
export function previewMessage(template: string, prize: string, hours: number) {
  return template
    .replace(/\{\{\s*name\s*\}\}/g, t('prizes.preview.name'))
    .replace(/\{\{\s*prize\s*\}\}/g, prize || t('prizes.preview.prize'))
    .replace(/\{\{\s*hours\s*\}\}/g, String(hours))
    .replace(/\{\{\s*link\s*\}\}/g, 'https://…/prize/…');
}

const DELIVERY_CHIP: Record<PrizeDelivery['status'], string> = { sent: 'approved', pending: 'scheduled', skipped: 'draft', failed: 'failed' };

function RuleForm({ pub, info, prizes, onClose }: { pub: PublicationRow; info: PublicationPrize; prizes: Prize[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rule = info.rule;
  const usable = prizes.filter((p) => p.usable && (!p.archived || p.id === rule?.prize?.id));
  const [prizeId, setPrizeId] = useState(rule?.prize?.id ?? usable[0]?.id ?? '');
  const [keyword, setKeyword] = useState(rule?.keyword ?? '');
  const [message, setMessage] = useState(rule?.message ?? t('prizes.rule.defaultMessage'));
  const [hours, setHours] = useState(rule?.link_hours ?? 72);
  const [days, setDays] = useState(30);
  const [confirmed, setConfirmed] = useState(rule?.notice_confirmed ?? false);
  const [active, setActive] = useState(rule?.active ?? true);
  const priv = info.mode === 'private_reply';
  const cannotSend = priv && info.can_message === false;
  const prizeName = usable.find((p) => p.id === prizeId)?.name ?? '';
  const network = NETWORK_LABEL[pub.network] ?? pub.network;

  const save = useMutation({
    mutationFn: () => api.put(`/api/publications/${pub.id}/prize`, { prizeId, keyword, message, linkHours: hours, publicDays: days, noticeConfirmed: confirmed, active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prize', pub.id] });
      qc.invalidateQueries({ queryKey: ['prize-deliveries', pub.id] });
      qc.invalidateQueries({ queryKey: ['prizes'] });
      toast(active ? t('prizes.rule.savedOn') : t('prizes.rule.savedOff'));
    },
  });

  const settingsLink = <Link to="/settings?tab=prizes" onClick={onClose}>{t('prizes.rule.settingsLink')}</Link>;

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      {!info.prizes_enabled && (
        <div className="notice notice-warn" style={{ margin: 0 }}>{t('prizes.rule.off')} {settingsLink}.</div>
      )}
      {cannotSend && (
        <div className="notice notice-warn" data-testid="needs-reconnect" style={{ margin: 0 }}>{t('prizes.rule.needsReconnect')}</div>
      )}
      <div className="notice notice-info" style={{ margin: 0 }}>
        {priv ? t('prizes.rule.howPrivate', { network }) : t('prizes.rule.howPublic', { network })}
      </div>
      {usable.length === 0 ? (
        <div className="notice notice-warn" style={{ margin: 0 }}>{t('prizes.rule.noPrize')} {settingsLink}.</div>
      ) : (
        <Field label={t('prizes.rule.prize')}>
          <Select
            label={t('prizes.rule.prize')}
            value={prizeId || undefined}
            onChange={setPrizeId}
            options={usable.map((p) => ({ value: p.id, label: `${p.name} (${p.kind === 'file' ? t('prizes.kind.file') : t('prizes.kind.link')})` }))}
          />
        </Field>
      )}
      {priv && (
        <Field label={t('prizes.rule.keyword')} hint={t('prizes.rule.keywordHint')}>
          <input type="text" required maxLength={60} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('prizes.rule.keywordPlaceholder')} />
        </Field>
      )}
      {!priv && (
        <Field label={t('prizes.rule.note')} hint={t('prizes.rule.noteHint')}>
          <input type="text" required maxLength={60} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={t('prizes.rule.notePlaceholder')} />
        </Field>
      )}
      {priv && (
        <>
          <Field label={t('prizes.rule.message')} hint={t('prizes.rule.messageHint')}>
            <textarea required maxLength={700} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="preview-text set-message-preview" aria-label={t('prizes.rule.previewAria')}>
            <span className="muted small">{t('prizes.rule.previewTitle', { name: t('prizes.preview.name') })}</span>
            <div>{previewMessage(message, prizeName, hours)}</div>
            <div className="muted small">{info.auto_notice}</div>
          </div>
          <Field label={t('prizes.rule.hours')}>
            <input className="set-num-input" type="number" min={1} max={720} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </Field>
        </>
      )}
      {!priv && (
        <Field label={t('prizes.rule.days')}>
          <input className="set-num-input" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>
          {t('prizes.rule.confirm')}
          <span className="muted small" style={{ display: 'block' }}>{t('prizes.rule.confirmHint', { notice: info.auto_notice })}</span>
        </span>
      </label>
      <Switch label={t('prizes.rule.running')} hint={t('prizes.rule.runningHint')} checked={active} onChange={setActive} />
      {save.error && <ErrorBox error={save.error} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>
        <button className="btn btn-primary" disabled={save.isPending || !prizeId}>{t('common.save')}</button>
      </div>
    </form>
  );
}

function Deliveries({ pubId, zone }: { pubId: string; zone: string }) {
  const { data } = useQuery({ queryKey: ['prize-deliveries', pubId], queryFn: () => api.get<PrizeDelivery[]>(`/api/publications/${pubId}/prize/deliveries`), refetchInterval: 30_000 });
  if (!data) return null;
  if (data.length === 0) return <p className="muted small" style={{ margin: 0 }}>{t('prizes.people.none')}</p>;
  return (
    <div className="stack" style={{ gap: '.4rem' }}>
      <h3>{t('prizes.people.title')}</h3>
      <div className="table-wrap">
        <table className="set-table">
          <thead><tr><th>{t('prizes.people.person')}</th><th>{t('prizes.people.commented')}</th><th>{t('prizes.people.result')}</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td><strong style={{ fontWeight: 500 }}>{d.person}</strong></td>
                <td className="mono" data-label={t('prizes.people.commented')}>{fmtDateTime(d.comment_at, zone)}</td>
                <td data-label={t('prizes.people.result')}>
                  <div>
                    <Chip state={DELIVERY_CHIP[d.status]} label={t(`prizes.delivery.${d.status}`)} />
                    {d.status === 'sent' && <div className="muted small">{t('prizes.people.downloads', { count: d.downloads })}</div>}
                    {d.reason && <div className="muted small">{tMaybe(`prizes.reason.${d.reason}`, d.reason)}</div>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: 0 }}>{t('prizes.people.retention')}</p>
    </div>
  );
}

/** The prize a post carries: who gets what for which comment, and how it is going. */
export function PrizeDialog({ pub, brandId, zone, onClose }: { pub: PublicationRow; brandId: string; zone: string; onClose: () => void }) {
  const { data: info, error } = useQuery({ queryKey: ['prize', pub.id], queryFn: () => api.get<PublicationPrize>(`/api/publications/${pub.id}/prize`) });
  const { data: prizes } = useQuery({ queryKey: ['prizes', brandId], queryFn: () => api.get<Prize[]>(`/api/brands/${brandId}/prizes`) });
  const rule = info?.rule;
  return (
    <Dialog title={t('prizes.dialog.title', { network: NETWORK_LABEL[pub.network] ?? pub.network })} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {(!info || !prizes) && !error && <Spinner />}
      {info && prizes && (
        <div className="stack">
          {rule && (
            <div className="row" style={{ gap: '.6rem' }}>
              <Chip state={rule.active ? 'approved' : 'draft'} label={rule.active ? t('prizes.dialog.running') : t('prizes.dialog.off')} />
              <span className="muted small mono">
                {t('prizes.dialog.counts', { sent: rule.deliveries.sent, pending: rule.deliveries.pending, skipped: rule.deliveries.skipped, failed: rule.deliveries.failed })}
              </span>
            </div>
          )}
          {rule && info.mode === 'public_link' && rule.public_url && (
            <div className="card stack" style={{ gap: '.4rem' }}>
              <div className="row-between"><strong>{t('prizes.dialog.publicLink')}</strong><CopyButton text={rule.public_url} label={t('prizes.dialog.copyLink')} /></div>
              <code className="mono small" style={{ overflowWrap: 'anywhere' }}>{rule.public_url}</code>
              {rule.public_expires_at && <span className="muted small">{t('prizes.dialog.openUntil', { date: fmtDateTime(rule.public_expires_at, zone) })}</span>}
            </div>
          )}
          <RuleForm key={rule?.id ?? 'new'} pub={pub} info={info} prizes={prizes} onClose={onClose} />
          {rule && info.mode === 'private_reply' && <Deliveries pubId={pub.id} zone={zone} />}
        </div>
      )}
    </Dialog>
  );
}
