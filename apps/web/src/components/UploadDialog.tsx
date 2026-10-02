import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Avatar, displayName } from './Avatar';
import { Icon, type IconName } from './icons';
import { api, ApiError, type Anchor, type CommentThread } from '../api';
import { t, tMaybe, type Key } from '../i18n';
import { fmtBytes } from '../lib/format';
import { createVersion, guessKind, guessMime, type AssetKind, type PendingFile, type Progress } from '../lib/upload';
import { Dialog, ErrorBox, errorMessage, Select, Tip, Tipped, useToast } from './ui';
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
  versions?: { id: string; number: number; by_agent?: boolean }[];
}

const KIND_ICON: Record<AssetKind, IconName> = { video: 'film', image: 'image', pdf: 'file', cover: 'image', subtitles: 'captions' };

/** A look at the file before it goes: the picture, the video's first frame, or the kind of file it is. */
function FilePreview({ file, kind }: { file: File; kind: AssetKind }) {
  const [url, setUrl] = useState<string | null>(null);
  const visual = (kind === 'image' || kind === 'cover' || kind === 'video') && /^(image|video)\//.test(file.type);
  useEffect(() => {
    if (!visual) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file, visual]);
  return (
    <span className={`pc-file-thumb is-${kind}`} aria-hidden="true">
      {url && file.type.startsWith('image/') && <img src={url} alt="" />}
      {url && file.type.startsWith('video/') && <video src={`${url}#t=0.1`} muted preload="metadata" playsInline />}
      {!url && <Icon name={KIND_ICON[kind]} />}
      {kind === 'video' && url && <span className="pc-file-thumb-badge"><Icon name="play" /></span>}
    </span>
  );
}

/** Where a comment points, as the review marks say it: 0:12, 0:12–0:15, or a page. */
function markOf(a: Anchor | null): string | null {
  if (!a) return null;
  const tc = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  if (a.type === 'time') return a.t_end !== undefined && a.t_end > a.t ? `${tc(a.t)}–${tc(a.t_end)}` : tc(a.t);
  return t('piece.upload.pageMark', { n: a.page });
}

const shortName = (name: string | null | undefined) => (name ? displayName(name.includes('@') ? null : name, name.includes('@') ? name : null) : t('piece.unknownAuthor'));

/**
 * A new version for a variant: choose the variant (when the piece has several), drop or choose the files, say what changed and
 * which comments it fixes. Each file shows its own preview, progress and, if it fails, its own error.
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
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  // How far the whole upload is: bytes sent of the files already gone, plus the share of the one going now.
  const overall = progress
    ? progress.step === 'closing'
      ? 1
      : progress.step === 'hashing'
        ? 0
        : (files.slice(0, progress.file).reduce((n, f) => n + f.file.size, 0) + (files[progress.file]?.file.size ?? 0) * progress.fraction) / Math.max(1, totalBytes)
    : 0;

  const status = progress
    ? progress.step === 'hashing'
      ? t('piece.upload.status.checking', { n: progress.file + 1, total: files.length })
      : progress.step === 'uploading'
        ? t('piece.upload.status.uploading', { n: progress.file + 1, total: files.length, pct: pct(progress.fraction) })
        : t('piece.upload.status.closing')
    : null;

  const variantName = (v: UploadVariant) => `${tMaybe(`piece.formatName.${v.format}`, v.format)} · ${v.style || tMaybe(`piece.formatHint.${v.format}`, v.format)}`;
  const filesDone = ready;
  const nFiles = picking ? 2 : 1;

  return (
    <Dialog title={t('piece.upload.title')} onClose={() => !busy && onClose()} wide>
      <p className="pc-up-sub">
        <span className="pc-ftag">{tMaybe(`piece.formatName.${chosen.format}`, chosen.format)}</span>
        <span className="pc-up-sub-style">{chosen.style || tMaybe(`piece.formatHint.${chosen.format}`, chosen.format)}</span>
        {nextNumber !== null && <span className="pc-up-next">{t('piece.upload.willBe', { n: nextNumber })}</span>}
      </p>
      <ol className="pc-steps">
        {picking && (
          <li className="pc-step is-done">
            <span className="pc-step-n" aria-hidden="true"><Icon name="check" /></span>
            <div className="pc-step-body">
              <h3 id="pc-up-variant-h">{t('piece.upload.step.variant')}</h3>
              <div className="pc-up-variants" role="radiogroup" aria-labelledby="pc-up-variant-h">
                {variants!.map((v) => {
                  const lv = v.versions?.at(-1);
                  const on = v.id === chosen.id;
                  return (
                    <label key={v.id} className="pc-up-variant" data-on={on || undefined} data-disabled={busy || undefined}>
                      <input
                        type="radio"
                        className="sr-only"
                        name="pc-up-variant"
                        checked={on}
                        disabled={busy}
                        onChange={() => {
                          setChosenId(v.id);
                          setResolves(new Set());
                          setFileErrors({});
                        }}
                      />
                      <span className="pc-up-variant-thumb" aria-hidden="true">
                        {lv ? <img src={`/api/versions/${lv.id}/thumb?w=240`} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Icon name="plus" />}
                      </span>
                      <span className="pc-up-variant-text">
                        <span className="pc-up-variant-name">{variantName(v)}</span>
                        <span className="pc-up-variant-meta">{lv ? t('piece.upload.variantNow', { n: lv.number, next: lv.number + 1 }) : t('piece.upload.variantFirst')}</span>
                      </span>
                      {on && <Icon name="check" className="pc-up-variant-check" />}
                    </label>
                  );
                })}
              </div>
            </div>
          </li>
        )}

        <li className={`pc-step ${filesDone ? 'is-done' : ''}`}>
          <span className="pc-step-n" aria-hidden="true">{filesDone ? <Icon name="check" /> : nFiles}</span>
          <div className="pc-step-body">
            <h3>{t('piece.upload.step.files')}</h3>
            <div
              className={`pc-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''} ${files.length ? 'is-compact' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={onDrop}
            >
              <span className="pc-drop-icon" aria-hidden="true"><Icon name="upload" /></span>
              <span className="pc-drop-copy">
                <span className="pc-drop-text">
                  {files.length ? t('piece.upload.dropMore') : shape === 'document' ? t('piece.upload.dropOne') : t('piece.upload.drop')}
                </span>
                <span className="pc-drop-hint">{t(`piece.upload.hint.${shape}` as Key)}</span>
              </span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()}>
                {shape === 'document' ? (files.length ? t('piece.upload.chooseOther') : t('piece.upload.chooseOne')) : t('piece.upload.choose')}
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
                    <li key={`${f.file.name}-${f.file.size}-${i}`} className={`pc-file ${err ? 'has-error' : ''} ${ph ? `is-${ph.phase}` : ''}`}>
                      {shape === 'carousel' && <span className="pc-file-pos" aria-hidden="true">{i + 1}</span>}
                      <FilePreview file={f.file} kind={f.kind} />
                      <span className="pc-file-main">
                        <Tipped label={f.file.name}><span className="pc-file-name">{f.file.name}</span></Tipped>
                        <span className="pc-file-meta">
                          <span className="mono">{fmtBytes(f.file.size)}</span>
                          {ph && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className={`pc-file-phase is-${ph.phase}`}>
                                {t(`piece.upload.phase.${ph.phase}` as Key, { pct: pct(ph.fraction) })}
                                {ph.phase === 'uploading' && progress?.note && <> · {progress.note}</>}
                              </span>
                            </>
                          )}
                        </span>
                        {ph && (
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
                        )}
                        {err && !ph && <span className="pc-file-err" role="alert">{err}</span>}
                      </span>
                      <Select
                        className="pc-file-role"
                        label={t('piece.upload.roleOf', { name: f.file.name })}
                        value={f.kind}
                        disabled={busy}
                        onChange={(kind) => changeFiles((xs) => xs.map((x, j) => (j === i ? { ...x, kind } : x)))}
                        options={ROLES.map((k) => ({ value: k, label: roleLabel(k), icon: <Icon name={KIND_ICON[k]} /> }))}
                      />
                      <span className="pc-file-tools">
                        {shape !== 'document' && files.length > 1 && (
                          <>
                            <Tip label={t('piece.upload.moveUpShort')}><button type="button" className="pc-tool" aria-label={t('piece.upload.moveUp', { name: f.file.name })} disabled={busy || i === 0} onClick={() => move(i, -1)}><Icon name="arrowUp" /></button></Tip>
                            <Tip label={t('piece.upload.moveDownShort')}><button type="button" className="pc-tool" aria-label={t('piece.upload.moveDown', { name: f.file.name })} disabled={busy || i === files.length - 1} onClick={() => move(i, 1)}><Icon name="arrowDown" /></button></Tip>
                          </>
                        )}
                        <Tip label={t('piece.upload.removeShort')}><button type="button" className="pc-tool is-remove" aria-label={t('piece.upload.remove', { name: f.file.name })} disabled={busy} onClick={() => changeFiles((xs) => xs.filter((_, j) => j !== i))}><Icon name="x" /></button></Tip>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {rule && <p className="pc-rule" role="status"><Icon name="alert" />{rule}</p>}
          </div>
        </li>

        <li className="pc-step">
          <span className="pc-step-n" aria-hidden="true">{nFiles + 1}</span>
          <div className="pc-step-body">
            <h3><label htmlFor="pc-up-notes">{t('piece.upload.step.notes')}</label></h3>
            <textarea id="pc-up-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} placeholder={t('piece.upload.notesPlaceholder')} />
            {open && open.length > 0 && (
              <fieldset className="pc-fixes">
                <legend>{t('piece.upload.fixes', { count: open.length })}</legend>
                <ul className="pc-fix-list">
                  {open.map((c) => {
                    const mark = markOf(c.anchor);
                    return (
                      <li key={c.id}>
                        <label className="pc-fix" data-on={resolves.has(c.id) || undefined}>
                          <input type="checkbox" checked={resolves.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} />
                          <Avatar name={shortName(c.author)} size={20} />
                          <span className="pc-fix-text">
                            {mark && <span className="tc">{mark}</span>}
                            <span className="pc-fix-body">{c.body}</span>
                          </span>
                          <span className="pc-fix-from">{t('piece.upload.fixFrom', { n: c.version_number, who: shortName(c.author) })}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            )}
          </div>
        </li>
      </ol>

      {send.error && (hasFileError ? <div className="notice notice-bad" role="alert">{t('piece.upload.failedFile')}</div> : <ErrorBox error={send.error} />)}
      <div className="pc-up-foot">
        <div className="pc-up-status" role="status">
          {status ? (
            <>
              <span className="pc-up-status-text">{status}</span>
              <span className="pc-bar is-uploading pc-up-overall" aria-hidden="true"><i style={{ width: `${pct(overall)}%` }} /></span>
            </>
          ) : files.length > 0 ? (
            <span className="pc-up-status-text">{t('piece.upload.summary', { count: files.length, size: fmtBytes(totalBytes) })}</span>
          ) : null}
        </div>
        <div className="pc-up-buttons">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => send.mutate()}>
            <Icon name="upload" />
            {busy ? t('piece.upload.sending') : t('piece.upload.submit')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
