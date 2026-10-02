import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type Anchor, type CommentThread, type SubtitleCue, type SubtitleTrack } from '../api';
import { t } from '../i18n';
import { playhead } from '../lib/playhead';
import { ErrorBox } from './ui';
import { timecode } from './viewer';

/** The line on screen at a moment: the last that has started and not ended, as the server's cueAt does. */
function currentCue(cues: SubtitleCue[], t: number): number {
  let found = -1;
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) found = c.index;
  }
  return found;
}

/**
 * The subtitle lines beside the video: the line being said is marked as it plays, a click goes to it, and each can be commented on
 * by itself. A comment on a line carries the line's words, so whoever reads it (a person, or an agent) sees what was meant.
 */
export function SubtitlePanel({ versionId, threads, canAnnotate, firstVideoPosition, onDraft, onSeek, onFocus }: {
  versionId: string;
  threads: CommentThread[];
  canAnnotate: boolean;
  firstVideoPosition: number;
  onDraft: (a: Anchor) => void;
  onSeek: (t: number, position: number) => void;
  onFocus: (id: string) => void;
}) {
  const { data, error } = useQuery({ queryKey: ['subtitles', versionId], queryFn: () => api.get<{ tracks: SubtitleTrack[] }>(`/api/versions/${versionId}/subtitles`) });
  const [which, setWhich] = useState(0);
  const tracks = data?.tracks ?? [];
  const track = tracks[Math.min(which, Math.max(tracks.length - 1, 0))];
  const cues = useMemo(() => track?.cues ?? [], [track]);
  const now = useSyncExternalStore(playhead.subscribe, () => currentCue(cues, playhead.t));
  const list = useRef<HTMLDivElement>(null);

  // Keep the line being said in view inside the list, without moving the page.
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>(`[data-cue="${now}"]`);
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop - box.clientHeight / 3;
  }, [now]);

  const byCue = useMemo(() => {
    const m = new Map<number, CommentThread[]>();
    for (const c of threads) {
      const a = c.anchor;
      if (a?.type === 'time' && a.cue !== undefined && (a.track ?? 0) === track?.position) m.set(a.cue, [...(m.get(a.cue) ?? []), c]);
    }
    return m;
  }, [threads, track?.position]);

  if (error) return <ErrorBox error={error} />;
  if (!track) return null;
  return (
    <section className="rv-subs" aria-label={t('review.subs.title')}>
      <header className="rv-subs-head">
        <h2>{t('review.subs.title')}</h2>
        <span className="rv-meta-n">{t('review.subs.lines', { count: cues.length })}</span>
        <span className="grow" />
        {tracks.length > 1 && (
          <select
            className="rv-select"
            aria-label={t('review.subs.file')}
            value={track.position}
            onChange={(e) => setWhich(tracks.findIndex((x) => x.position === Number(e.target.value)))}
          >
            {tracks.map((x) => <option key={x.assetId} value={x.position}>{x.name}</option>)}
          </select>
        )}
      </header>
      {track.problem && <div className="notice notice-warn">{t('review.subs.problem', { name: track.name, problem: track.problem })}</div>}
      {track.skipped > 0 && <p className="muted small">{t('review.subs.skipped', { count: track.skipped })}</p>}
      {track.truncated && <p className="muted small">{t('review.subs.truncated')}</p>}
      {cues.length > 0 && (
        <div ref={list} className="cue-list rv-cues" role="list">
          {cues.map((c) => {
            const threadsHere = byCue.get(c.index) ?? [];
            const open = threadsHere.filter((x) => x.status === 'open').length;
            return (
              <div key={c.index} role="listitem" data-cue={c.index} className={`cue ${now === c.index ? 'now' : ''}`}>
                <button type="button" className="cue-time" onClick={() => onSeek(c.start, firstVideoPosition)} title={t('review.subs.goTo')}>{timecode(c.start)}</button>
                <span className="cue-text">{c.text || <span className="muted">{t('review.subs.noWords')}</span>}</span>
                {threadsHere.length > 0 && (
                  <button
                    type="button"
                    className={`rv-cue-count ${open ? 'open' : ''}`}
                    onClick={() => onFocus(threadsHere[0]!.id)}
                    title={t('review.subs.commentsOnLine', { count: threadsHere.length })}
                    aria-label={t('review.subs.commentsOnLine', { count: threadsHere.length })}
                  >
                    {threadsHere.length}
                  </button>
                )}
                {canAnnotate && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-small rv-cue-add"
                    aria-label={t('review.subs.commentLine', { n: c.index + 1 })}
                    onClick={() => onDraft({ type: 'time', t: c.start, t_end: c.end, track: track.position, cue: c.index, cue_text: c.text })}
                  >
                    {t('review.subs.comment')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
