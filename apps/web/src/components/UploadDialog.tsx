import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, type CommentThread } from '../api';
import { t, tMaybe, type Key } from '../i18n';
import { fmtBytes } from '../lib/format';
import { createVersion, guessKind, guessMime, type AssetKind, type PendingFile, type Progress } from '../lib/upload';
import { Dialog, ErrorBox, errorMessage, useToast } from './ui';
import '../styles/piece.css';

type Shape = 'document' | 'carousel' | 'default';

const ACCEPT: Record<Shape, string> = {
  document: 'application/pdf',
  carousel: 'image/*,video/*',
  default: 'image/*,video/*,.vtt,.srt',
};

const ROLES: AssetKind[] = ['video', 'image', 'pdf', 'cover', 'subtitles'];

// What the API accepts for each role and each format (apps/api/src/services/versions.ts). Checked here too, so a wrong file is
// pointed out before anything is sent instead of after the whole upload.
const MIME_OK: Record<AssetKind, RegExp> = {
  video: /^video\/(mp4|quicktime|webm|x-matroska)$/,
  image: /^image\/(jpeg|png|webp|gif)$/,
  pdf: /^application\/pdf$/,
  subtitles: /^(text\/vtt|text\/plain|application\/x-subrip)$/,
  cover: /^image\/(jpeg|png|webp)$/,
};
const MAX_BYTES = 4 * 1024 ** 3;
const MAX_FILES = 30;

const roleLabel = (k: AssetKind) => t(`piece.upload.role.${k}` as Key);

function fileProblem(f: PendingFile): string | null {
  if (f.file.size === 0) return t('piece.upload.problem.empty');
  if (f.file.size > MAX_BYTES) return t('piece.upload.problem.tooBig', { max: fmtBytes(MAX_BYTES) });
  if (!MIME_OK[f.kind].test(guessMime(f.file))) return t('piece.upload.problem.type', { role: roleLabel(f.kind) });
  return null;
}

/** Why this set of files cannot make a version of this format, or null when it can. */
function compositionProblem(shape: Shape, files: PendingFile[]): string | null {
  if (files.length === 0) return null;
  if (files.length > MAX_FILES) return t('piece.upload.rule.tooMany', { max: MAX_FILES });
  const count = (k: AssetKind) => files.filter((f) => f.kind === k).length;
  const primary = count('video') + count('image');
  if (count('cover') > 1) return t('piece.upload.rule.oneCover');
  if (count('subtitles') > 10) return t('piece.upload.rule.tooManySubtitles');
  if (count('subtitles') > 0 && count('video') === 0) return t('piece.upload.rule.subtitlesNeedVideo');
  if (shape === 'document') {
    if (count('pdf') !== 1 || primary > 0) return t('piece.upload.rule.document');
  } else if (shape === 'carousel') {
    if (count('pdf') > 0) return t('piece.upload.rule.carouselNoPdf');
    if (primary < 2 || primary > 20) return t('piece.upload.rule.carouselCount', { count: primary });
  } else {
    if (count('pdf') > 0) return t('piece.upload.rule.noPdf');
    if (primary !== 1) return primary > 1 && count('image') > 0 && count('video') > 0 ? t('piece.upload.rule.singleCover') : t('piece.upload.rule.single');
  }
  if (count('cover') > 0 && count('video') === 0) return t('piece.upload.rule.coverNeedsVideo');
  return null;
}

type Phase = 'waiting' | 'checking' | 'checked' | 'uploading' | 'done';

/** Where one file is, from the single progress the upload reports: all files are checked first, then sent one after another. */
function phaseOf(i: number, p: Progress | null): { phase: Phase; fraction: number } | null {
  if (!p) return null;
  if (p.step === 'hashing') return i < p.file ? { phase: 'checked', fraction: 1 } : i === p.file ? { phase: 'checking', fraction: p.fraction } : { phase: 'waiting', fraction: 0 };
  if (p.step === 'uploading') return i < p.file ? { phase: 'done', fraction: 1 } : i === p.file ? { phase: 'uploading', fraction: p.fraction } : { phase: 'checked', fraction: 0 };
  return { phase: 'done', fraction: 1 };
}

const pct = (f: number) => Math.round(Math.min(1, Math.max(0, f)) * 100);

/**
 * Which file a failed upload was on, or -1 when it was not one file's fault. The API names the file when it refuses one; otherwise
 * the last progress says where it was: checking a file, sending one, or, with every file checked, asking for the addresses (the
 * API's own error) or starting to send the first file.
 */
function failedFile(e: unknown, msg: string, p: Progress | null, names: string[]): number {
  const named = names.findIndex((name) => msg.startsWith(`${name}:`));
  if (named >= 0 || !p || p.step === 'closing') return named;
  if (p.step === 'uploading') return p.file;
  if (p.fraction < 1) return p.file;
  if (p.file < names.length - 1) return p.file + 1;
  return e instanceof ApiError || e instanceof TypeError ? -1 : 0;
}

export interface UploadVariant {
  id: string;
  format: string;
  style: string;
  versions?: { id: string; number: number }[];
}

/**
 * A new version for a variant: choose the variant (when the piece has several), drop or choose the files, say what changed and
 * which comments it fixes. Each file shows its own progress and, if it fails, its own error.
 */
export function UploadDialog({ variant, variants, latestVersionId, onClose }: {
  variant: UploadVariant;
  /** The piece's variants, to let the person pick another one. */
  variants?: UploadVariant[];
  /** The latest version of `variant`, when `variant` does not list its versions. */
  latestVersionId?: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [chosenId, setChosenId] = useState(variant.id);
  const chosen = variants?.find((v) => v.id === chosenId) ?? variant;
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notes, setNotes] = useState('');
  const [resolves, setResolves] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [fileErrors, setFileErrors] = useState<Record<number, string>>({});
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const last = useRef<Progress | null>(null);
  const shape: Shape = chosen.format === 'document' || chosen.format === 'carousel' ? chosen.format : 'default';
  const latestId = chosen.versions ? (chosen.versions.at(-1)?.id ?? null) : chosen.id === variant.id ? (latestVersionId ?? null) : null;
  const nextNumber = chosen.versions ? (chosen.versions.at(-1)?.number ?? 0) + 1 : null;
  const picking = !!variants && variants.length > 1;

  // A file dropped beside the drop area would make the browser open it and leave the app, upload and all.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const { data: open } = useQuery({
    queryKey: ['open-comments', latestId],
    enabled: !!latestId,
    queryFn: () => api.get<CommentThread[]>(`/api/versions/${latestId}/comments?status=open&carried=true`),
  });

  const send = useMutation({
    mutationFn: () => {
      last.current = null;
      setFileErrors({});
      return createVersion(chosen.id, files, notes, [...resolves], (p) => {
        last.current = p;
        setProgress(p);
      });
    },
    onSuccess: () => {
      for (const k of ['piece', 'pieces', 'version']) qc.invalidateQueries({ queryKey: [k] });
      toast(t('piece.upload.done'));
      onClose();
    },
    onError: (e) => {
      const msg = errorMessage(e);
      const i = failedFile(e, msg, last.current, files.map((f) => f.file.name));
      if (i >= 0) setFileErrors({ [i]: msg });
    },
    onSettled: () => setProgress(null),
  });
  const busy = send.isPending;

  const changeFiles = (next: (f: PendingFile[]) => PendingFile[]) => {
    setFileErrors({});
    setFiles(next);
  };
  const add = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    // A FileList is live: copy it before resetting the input, or React reads it empty when it applies the update.
    const picked = [...list].map((file) => ({ file, kind: guessKind(file) }));
    changeFiles((current) => {
      // A document takes one PDF: choosing another replaces it.
      if (shape === 'document') return picked.slice(-1);
      const all = [...current, ...picked];
      // Beside a video, the first image is most likely its cover.
      if (shape === 'default' && all.some((f) => f.kind === 'video') && !all.some((f) => f.kind === 'cover')) {
        const img = all.findIndex((f) => f.kind === 'image');
        if (img >= 0) all[img] = { ...all[img]!, kind: 'cover' };
      }
      return all;
    });
    if (input.current) input.current.value = '';
  };
  const move = (i: number, d: -1 | 1) =>
    changeFiles((f) => {
      const next = [...f];
      const j = i + d;
      if (j < 0 || j >= next.length) return f;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const toggle = (id: string) =>
    setResolves((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!busy) add(e.dataTransfer.files);
  };

  const problems = files.map(fileProblem);
  const rule = compositionProblem(shape, files);
  const ready = files.length > 0 && !rule && problems.every((p) => p === null);
  const hasFileError = Object.keys(fileErrors).length > 0;

  const status = progress
    ? progress.step === 'hashing'
      ? t('piece.upload.status.checking', { n: progress.file + 1, total: files.length })
      : progress.step === 'uploading'
        ? t('piece.upload.status.uploading', { n: progress.file + 1, total: files.length, pct: pct(progress.fraction) })
        : t('piece.upload.status.closing')
    : null;

  const variantName = (v: UploadVariant) => `${tMaybe(`piece.formatName.${v.format}`, v.format)}${v.style ? ` · ${v.style}` : ''}`;
  let step = 0;

  return (
    <Dialog title={t('piece.upload.title')} onClose={() => !busy && onClose()} wide>
      <p className="pc-up-sub">
        <span className="tag">{tMaybe(`piece.formatName.${chosen.format}`, chosen.format)}</span>
        {chosen.style && <span>{chosen.style}</span>}
        {nextNumber !== null && <span className="muted">{t('piece.upload.willBe', { n: nextNumber })}</span>}
      </p>
      <ol className="pc-steps">
        {picking && (
          <li className="pc-step">
            <span className="pc-step-n" aria-hidden="true">{++step}</span>
            <div className="pc-step-body">
              <h3><label htmlFor="pc-up-variant">{t('piece.upload.step.variant')}</label></h3>
              <select
                id="pc-up-variant"
                value={chosen.id}
                disabled={busy}
                onChange={(e) => {
                  setChosenId(e.target.value);
                  setResolves(new Set());
                  setFileErrors({});
                }}
              >
                {variants!.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.versions?.length ? t('piece.upload.variantOption', { name: variantName(v), n: v.versions.at(-1)!.number }) : variantName(v)}
                  </option>
                ))}
              </select>
            </div>
          </li>
        )}

        <li className="pc-step">
          <span className="pc-step-n" aria-hidden="true">{++step}</span>
          <div className="pc-step-body">
            <h3>{t('piece.upload.step.files')}</h3>
            <p className="muted small pc-step-hint">{t(`piece.upload.hint.${shape}` as Key)}</p>
            <div
              className={`pc-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <svg className="pc-drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 15V4M7 9l5-5 5 5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
              <span>{shape === 'document' ? t('piece.upload.dropOne') : t('piece.upload.drop')}</span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
                {shape === 'document' ? t('piece.upload.chooseOne') : t('piece.upload.choose')}
              </button>
              <input
                ref={input}
                className="sr-only"
                tabIndex={-1}
                type="file"
                multiple={shape !== 'document'}
                accept={ACCEPT[shape]}
                onChange={(e) => add(e.target.files)}
                aria-label={t('piece.upload.choose')}
                disabled={busy}
              />
            </div>

            {files.length > 0 && (
              <ul className="pc-files" aria-label={t('piece.upload.filesLabel', { count: files.length })}>
                {files.map((f, i) => {
                  const ph = phaseOf(i, progress);
                  const err = fileErrors[i] ?? problems[i];
                  return (
                    <li key={`${f.file.name}-${f.file.size}-${i}`} className={`pc-file ${err ? 'has-error' : ''}`}>
                      <span className="pc-file-n mono" aria-hidden="true">{i + 1}</span>
                      <span className="pc-file-name" title={f.file.name}>
                        {f.file.name}
                        <span className="mono muted">{fmtBytes(f.file.size)}</span>
                      </span>
                      <select
                        className="pc-file-role"
                        aria-label={t('piece.upload.roleOf', { name: f.file.name })}
                        value={f.kind}
                        disabled={busy}
                        onChange={(e) => changeFiles((xs) => xs.map((x, j) => (j === i ? { ...x, kind: e.target.value as AssetKind } : x)))}
                      >
                        {ROLES.map((k) => <option key={k} value={k}>{roleLabel(k)}</option>)}
                      </select>
                      <span className="pc-file-tools">
                        {shape !== 'document' && (
                          <>
                            <button type="button" className="icon-btn" aria-label={t('piece.upload.moveUp', { name: f.file.name })} title={t('piece.upload.moveUpShort')} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
                            <button type="button" className="icon-btn" aria-label={t('piece.upload.moveDown', { name: f.file.name })} title={t('piece.upload.moveDownShort')} disabled={busy || i === files.length - 1} onClick={() => move(i, 1)}>↓</button>
                          </>
                        )}
                        <button type="button" className="icon-btn" aria-label={t('piece.upload.remove', { name: f.file.name })} title={t('piece.upload.removeShort')} disabled={busy} onClick={() => changeFiles((xs) => xs.filter((_, j) => j !== i))}>×</button>
                      </span>
                      {ph && (
                        <span className="pc-file-prog">
                          <span
                            className={`pc-bar is-${ph.phase}`}
                            role="progressbar"
                            aria-label={t('piece.upload.progressOf', { name: f.file.name })}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct(ph.fraction)}
                          >
                            <i style={{ width: `${pct(ph.fraction)}%` }} />
                          </span>
                          <span className="pc-file-phase">
                            {t(`piece.upload.phase.${ph.phase}` as Key, { pct: pct(ph.fraction) })}
                            {ph.phase === 'uploading' && progress?.note && <> · {progress.note}</>}
                          </span>
                        </span>
                      )}
                      {err && !ph && <span className="pc-file-err" role="alert">{err}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
            {rule && <p className="pc-rule" role="status">{rule}</p>}
          </div>
        </li>

        <li className="pc-step">
          <span className="pc-step-n" aria-hidden="true">{++step}</span>
          <div className="pc-step-body">
            <h3><label htmlFor="pc-up-notes">{t('piece.upload.step.notes')}</label></h3>
            <p className="muted small pc-step-hint">{t('piece.upload.notesHint')}</p>
            <textarea id="pc-up-notes" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} placeholder={t('piece.upload.notesPlaceholder')} />
            {open && open.length > 0 && (
              <fieldset className="pc-fixes">
                <legend>{t('piece.upload.fixes', { count: open.length })}</legend>
                <div className="stack" style={{ gap: '.5rem' }}>
                  {open.map((c) => (
                    <label key={c.id} className="check">
                      <input type="checkbox" checked={resolves.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} />
                      <span>
                        {c.body}{' '}
                        <span className="muted small">{t('piece.upload.fixFrom', { n: c.version_number, who: c.author ?? t('piece.unknownAuthor') })}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="muted small pc-fixes-note">{t('piece.upload.fixesNote')}</p>
              </fieldset>
            )}
          </div>
        </li>
      </ol>

      {send.error && (hasFileError ? <div className="notice notice-bad" role="alert">{t('piece.upload.failedFile')}</div> : <ErrorBox error={send.error} />)}
      <div className="pc-up-foot">
        <span className="pc-up-status" role="status">{status ?? (files.length > 0 ? t('piece.upload.summary', { count: files.length, size: fmtBytes(files.reduce((n, f) => n + f.file.size, 0)) }) : '')}</span>
        <div className="row">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => send.mutate()}>
            {busy ? t('piece.upload.sending') : t('piece.upload.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
