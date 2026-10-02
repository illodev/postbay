import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, type CommentThread } from '../api';
import { fmtBytes } from '../lib/format';
import { createVersion, guessKind, type AssetKind, type PendingFile, type Progress } from '../lib/upload';
import { Dialog, ErrorBox, Field, useToast } from './ui';

const HINT: Record<string, string> = {
  document: 'One PDF.',
  carousel: 'Between 2 and 20 images or videos, in the order they should appear. A video can also have a cover and subtitles.',
  default: 'One video or one image. A video can also have a cover image and subtitle files (.vtt or .srt).',
};

const ACCEPT: Record<string, string> = {
  document: 'application/pdf',
  carousel: 'image/*,video/*',
  default: 'image/*,video/*,.vtt,.srt',
};

export function UploadDialog({ variant, latestVersionId, onClose }: {
  variant: { id: string; format: string; style: string };
  latestVersionId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notes, setNotes] = useState('');
  const [resolves, setResolves] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Progress | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const key = variant.format === 'document' || variant.format === 'carousel' ? variant.format : 'default';

  const { data: open } = useQuery({
    queryKey: ['open-comments', latestVersionId],
    enabled: !!latestVersionId,
    queryFn: () => api.get<CommentThread[]>(`/api/versions/${latestVersionId}/comments?status=open&carried=true`),
  });

  const send = useMutation({
    mutationFn: () => createVersion(variant.id, files, notes, [...resolves], setProgress),
    onSuccess: () => {
      for (const k of ['piece', 'pieces', 'version']) qc.invalidateQueries({ queryKey: [k] });
      toast('Version uploaded and sent to review');
      onClose();
    },
    onSettled: () => setProgress(null),
  });

  const add = (list: FileList | null) => {
    if (!list) return;
    // A FileList is live: copy it before resetting the input, or React reads it empty when it applies the update.
    const picked = [...list].map((file) => ({ file, kind: guessKind(file) }));
    setFiles((f) => [...f, ...picked]);
    if (input.current) input.current.value = '';
  };
  const move = (i: number, d: -1 | 1) =>
    setFiles((f) => {
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

  const label = progress
    ? progress.step === 'hashing'
      ? `Checking file ${progress.file + 1} of ${files.length}…`
      : progress.step === 'uploading'
        ? `Uploading file ${progress.file + 1} of ${files.length}… ${Math.round(progress.fraction * 100)}%${progress.note ? ` · ${progress.note}` : ''}`
        : 'Creating the version…'
    : null;

  return (
    <Dialog title={`New version · ${variant.format}${variant.style ? ` · ${variant.style}` : ''}`} onClose={() => !send.isPending && onClose()} wide>
      <div className="stack">
        <p className="muted">{HINT[key]}</p>
        <div>
          <input ref={input} type="file" multiple={key !== 'document'} accept={ACCEPT[key]} onChange={(e) => add(e.target.files)} aria-label="Choose files" disabled={send.isPending} />
        </div>
        {files.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>File</th><th>Role</th><th /></tr></thead>
              <tbody>
                {files.map((f, i) => (
                  <tr key={`${f.file.name}-${i}`}>
                    <td>{i + 1}</td>
                    <td>{f.file.name} <span className="muted small">{fmtBytes(f.file.size)}</span></td>
                    <td>
                      <select aria-label={`Role of ${f.file.name}`} value={f.kind} disabled={send.isPending}
                        onChange={(e) => setFiles((xs) => xs.map((x, j) => (j === i ? { ...x, kind: e.target.value as AssetKind } : x)))}>
                        <option value="video">Video</option>
                        <option value="image">Image</option>
                        <option value="pdf">PDF</option>
                        <option value="cover">Cover</option>
                        <option value="subtitles">Subtitles</option>
                      </select>
                    </td>
                    <td className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn btn-small" aria-label="Move up" disabled={send.isPending || i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button className="btn btn-small" aria-label="Move down" disabled={send.isPending || i === files.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button className="btn btn-small" aria-label={`Remove ${f.file.name}`} disabled={send.isPending} onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Field label="What changed" hint="Shown to the reviewers next to the version.">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={send.isPending} />
        </Field>
        {open && open.length > 0 && (
          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8 }}>
            <legend className="field-label">Comments this version fixes</legend>
            <div className="stack">
              {open.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={resolves.has(c.id)} onChange={() => toggle(c.id)} disabled={send.isPending} />
                  <span>{c.body} <span className="muted small">(v{c.version_number}, {c.author})</span></span>
                </label>
              ))}
            </div>
            <p className="muted small" style={{ marginTop: '.5rem' }}>Comments you do not tick stay open and still block approval.</p>
          </fieldset>
        )}
        {send.error && <ErrorBox error={send.error} />}
        {label && <div className="notice notice-info" role="status">{label}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={send.isPending}>Cancel</button>
          <button className="btn btn-primary" disabled={send.isPending || files.length === 0} onClick={() => send.mutate()}>Upload and send to review</button>
        </div>
      </div>
    </Dialog>
  );
}
