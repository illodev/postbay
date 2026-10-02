import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type Anchor, type CommentThread, type SubtitleCue, type SubtitleTrack } from '../api';
import { fmtTime } from '../lib/format';
import { playhead } from '../lib/playhead';
import { ErrorBox } from './ui';

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
    <section className="card stack" aria-label="Subtitles" style={{ gap: '.5rem' }}>
      <div className="row-between">
        <h3>Subtitles</h3>
        {tracks.length > 1 && (
          <select aria-label="Subtitle file" value={track.position} onChange={(e) => setWhich(tracks.findIndex((t) => t.position === Number(e.target.value)))} style={{ width: 'auto' }}>
            {tracks.map((t) => <option key={t.assetId} value={t.position}>{t.name}</option>)}
          </select>
        )}
      </div>
      {track.problem && <div className="notice notice-warn">{track.name}: {track.problem}.</div>}
      {track.skipped > 0 && <p className="muted small" style={{ margin: 0 }}>{track.skipped} block{track.skipped === 1 ? '' : 's'} of the file could not be read and are not shown.</p>}
      {track.truncated && <p className="muted small" style={{ margin: 0 }}>Only the first lines of this long file are shown.</p>}
      {cues.length > 0 && (
        <div ref={list} className="cue-list" role="list">
          {cues.map((c) => {
            const threadsHere = byCue.get(c.index) ?? [];
            const open = threadsHere.filter((t) => t.status === 'open').length;
            return (
              <div key={c.index} role="listitem" data-cue={c.index} className={`cue ${now === c.index ? 'now' : ''}`}>
                <button className="cue-time" onClick={() => onSeek(c.start, firstVideoPosition)} title="Go to this line">{fmtTime(c.start)}</button>
                <span className="cue-text">{c.text || <span className="muted">(no words)</span>}</span>
                {threadsHere.length > 0 && (
                  <button className={`chip ${open ? 'chip-changes_requested' : 'chip-approved'}`} onClick={() => onFocus(threadsHere[0]!.id)} title={`${threadsHere.length} comment${threadsHere.length === 1 ? '' : 's'} on this line`}>
                    {threadsHere.length}
                  </button>
                )}
                {canAnnotate && (
                  <button className="btn btn-small" aria-label={`Comment on line ${c.index + 1}`} onClick={() => onDraft({ type: 'time', t: c.start, t_end: c.end, track: track.position, cue: c.index, cue_text: c.text })}>
                    Comment
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
