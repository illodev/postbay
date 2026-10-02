import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Account, type AccountReport, type CheckResult } from '../api';
import { t } from '../i18n';
import { NETWORK_LABEL } from '../lib/format';
import { Chip, Dialog, ErrorBox, Spinner } from './ui';

const CHIP: Record<CheckResult['status'], string> = { pass: 'approved', warn: 'on_hold', fail: 'failed', skip: 'draft' };

/**
 * One line per check: what was looked at, what was found, and what to do about it. The checks' own titles and details
 * come from the server as it words them.
 */
export function ResultList({ results }: { results: CheckResult[] }) {
  return (
    <ul className="checks" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 0 }}>
      {results.map((r) => (
        <li key={r.id} data-status={r.status} style={{ padding: '.6rem 0', borderTop: '1px solid var(--border)' }}>
          <div className="row" style={{ gap: '.6rem', alignItems: 'baseline', flexWrap: 'nowrap' }}>
            <span style={{ flex: '0 0 7.5rem' }}><Chip state={CHIP[r.status]} label={t(`settings.check.${r.status}`)} /></span>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontWeight: 500 }}>{r.title}</strong>
              <div className="small" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{r.detail}</div>
              {r.hint && <div className="small muted" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{r.status !== 'pass' && '→ '}{r.hint}</div>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function summary(results: CheckResult[]): string {
  const n = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
  const parts = [
    t('settings.check.sumPass', { count: n('pass') }),
    n('warn') ? t('settings.check.sumWarn', { count: n('warn') }) : '',
    n('fail') ? t('settings.check.sumFail', { count: n('fail') }) : '',
    n('skip') ? t('settings.check.sumSkip', { count: n('skip') }) : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** What would stop a network from working on this server: addresses, keys, ffmpeg, the LinkedIn version. */
export function ServerCheckDialog({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['server-check', brandId], staleTime: 0, gcTime: 0, queryFn: () => api.get<CheckResult[]>(`/api/brands/${brandId}/server-check`) });
  return (
    <Dialog title={t('settings.check.serverTitle')} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner label={t('settings.check.checking')} />}
      {data && (
        <div className="stack">
          <p className="muted mono small" style={{ margin: 0 }}>{summary(data)}</p>
          <ResultList results={data} />
        </div>
      )}
    </Dialog>
  );
}

/** Asks the network a few harmless questions about one account (is it accepted, what was granted, can the numbers be read). It never posts. */
export function AccountCheckDialog({ brandId, account, onClose }: { brandId: string; account: Account; onClose: () => void }) {
  const [run, setRun] = useState(0);
  const { data, error, isFetching } = useQuery({
    queryKey: ['account-check', account.id, run], staleTime: 0, gcTime: 0,
    queryFn: () => api.post<AccountReport>(`/api/brands/${brandId}/accounts/${account.id}/check`),
  });
  return (
    <Dialog title={t('settings.check.accountTitle', { network: NETWORK_LABEL[account.network] ?? account.network, name: account.display_name })} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {isFetching && <Spinner label={t('settings.check.asking')} />}
      {data && !isFetching && (
        <div className="stack">
          <p className="muted mono small" style={{ margin: 0 }}>{summary(data.results)}</p>
          <ResultList results={data.results} />
          <p className="muted small" style={{ margin: 0 }}>{t('settings.check.readOnly')} <code>--publish</code> (docs/phase-5.md).</p>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => setRun((n) => n + 1)} disabled={isFetching}>{t('settings.check.again')}</button>
        <button className="btn btn-primary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Dialog>
  );
}
