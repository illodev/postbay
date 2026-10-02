import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Account, type AccountReport, type CheckResult } from '../api';
import { NETWORK_LABEL } from '../lib/format';
import { Dialog, ErrorBox, Spinner } from './ui';

const LABEL: Record<CheckResult['status'], string> = { pass: 'OK', warn: 'Look at this', fail: 'Fix this', skip: 'Skipped' };
const CHIP: Record<CheckResult['status'], string> = { pass: 'chip-approved', warn: 'chip-on_hold', fail: 'chip-failed', skip: '' };

/** One line per check: what was looked at, what was found, and what to do about it. */
export function ResultList({ results }: { results: CheckResult[] }) {
  return (
    <ul className="checks" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {results.map((r) => (
        <li key={r.id} data-status={r.status} style={{ padding: '.55rem 0', borderTop: '1px solid var(--border)' }}>
          <div className="row" style={{ gap: '.5rem', alignItems: 'baseline' }}>
            <span className={`chip ${CHIP[r.status]}`}>{LABEL[r.status]}</span>
            <strong>{r.title}</strong>
          </div>
          <div className="small" style={{ marginTop: 2 }}>{r.detail}</div>
          {r.hint && r.status !== 'pass' && <div className="small muted" style={{ marginTop: 2 }}>→ {r.hint}</div>}
          {r.hint && r.status === 'pass' && <div className="small muted" style={{ marginTop: 2 }}>{r.hint}</div>}
        </li>
      ))}
    </ul>
  );
}

function summary(results: CheckResult[]): string {
  const n = (s: CheckResult['status']) => results.filter((r) => r.status === s).length;
  const parts = [`${n('pass')} OK`, n('warn') ? `${n('warn')} to look at` : '', n('fail') ? `${n('fail')} to fix` : '', n('skip') ? `${n('skip')} skipped` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** What would stop a network from working on this server: addresses, keys, ffmpeg, the LinkedIn version. */
export function ServerCheckDialog({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const { data, error } = useQuery({ queryKey: ['server-check', brandId], staleTime: 0, gcTime: 0, queryFn: () => api.get<CheckResult[]>(`/api/brands/${brandId}/server-check`) });
  return (
    <Dialog title="Is this server ready?" onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner label="Checking…" />}
      {data && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>{summary(data)}</p>
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
    <Dialog title={`Check ${NETWORK_LABEL[account.network] ?? account.network} · ${account.display_name}`} onClose={onClose} wide>
      {error && <ErrorBox error={error} />}
      {isFetching && <Spinner label="Asking the network…" />}
      {data && !isFetching && (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>{summary(data.results)}</p>
          <ResultList results={data.results} />
          <p className="muted small" style={{ margin: 0 }}>These checks only read. To make one real test post on the account, run the command line check with <code>--publish</code> (docs/phase-5.md).</p>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: '.75rem' }}>
        <button className="btn" onClick={() => setRun((n) => n + 1)} disabled={isFetching}>Check again</button>
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
