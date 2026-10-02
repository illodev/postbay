import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError } from '../api';
import { t, tMaybe } from '../i18n';
import { NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import { Icon, type IconName } from './icons';
import '../styles/ui.css';
import { HAS_LOGO, NetLogo } from './netlogos';

/** What to tell the person about an error: the translated text for a known API code, else the server's message. */
export const errorMessage = (e: unknown): string => {
  if (e instanceof ApiError) return tMaybe(`errors.${e.code}`, e.message);
  if (e instanceof TypeError) return t('errors.network');
  if (e instanceof Error) return e.message;
  return t('common.somethingWrong');
};

// ───────────────────────────── toasts ─────────────────────────────

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, kind }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      <ConfirmProvider>{children}</ConfirmProvider>
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────────────────────── small pieces ─────────────────────────────

export function Chip({ state, label }: { state: string; label?: string }) {
  return <span className={`chip chip-${state}`}>{label ?? STATE_LABEL[state] ?? state}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return <div className="muted center pad">{label ?? t('common.loading')}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="notice notice-bad" role="alert">{errorMessage(error)}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

/** Modal built on <dialog>: focus trap, Escape to close and backdrop come from the browser. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Closing the <dialog> on unmount fires its "close" event a moment later. That is not the person closing it, and
  // must not call onClose: under StrictMode the effect runs, cleans up and runs again, and the stray event used to
  // unmount the dialog right after it opened.
  const closingOnUnmount = useRef(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) {
        closingOnUnmount.current = true;
        d.close();
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      onClose={() => {
        if (closingOnUnmount.current) {
          closingOnUnmount.current = false;
          return;
        }
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast(t('common.copied'));
        } catch {
          toast(t('common.copyFailed'), 'error');
        }
      }}
    >
      {label ?? t('common.copy')}
    </button>
  );
}

// ───────────────────────────── confirming ─────────────────────────────

export interface ConfirmOptions {
  title: string;
  /** What will happen, in a sentence or two. */
  text?: ReactNode;
  /** The words on the button that goes ahead: say the action ("Borrar el webhook"), not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Something that cannot be taken back: the button is red, and the focus starts on Cancel. */
  danger?: boolean;
}

/**
 * Asks before doing something, in the app's own dialog instead of the browser's. A controlled component, for a page that
 * wants to hold the question in its state; most callers want `useConfirm()` instead.
 */
export function ConfirmDialog({ title, text, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: ConfirmOptions & { busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closingOnUnmount = useRef(false);
  const titleId = useRef(`confirm-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) {
        closingOnUnmount.current = true;
        d.close();
      }
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog confirm ${danger ? 'confirm-danger' : ''}`}
      aria-labelledby={titleId}
      onClose={() => {
        if (closingOnUnmount.current) {
          closingOnUnmount.current = false;
          return;
        }
        onCancel();
      }}
      onClick={(e) => e.target === ref.current && onCancel()}
    >
      <form
        className="confirm-body"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {text && <div className="confirm-text">{text}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel} autoFocus={danger}>{cancelLabel ?? t('common.cancel')}</button>
          <button type="submit" className={`btn ${danger ? 'btn-confirm-danger' : 'btn-primary'}`} disabled={busy} autoFocus={!danger}>
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

type Ask = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<Ask | null>(null);

/** Holds the one question on screen; mounted by ToastProvider, so every page has it. */
function ConfirmProvider({ children }: { children: ReactNode }) {
  const [asked, setAsked] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const ask = useCallback<Ask>((o) => new Promise<boolean>((resolve) => setAsked({ ...o, resolve })), []);
  const answer = (ok: boolean) => {
    asked?.resolve(ok);
    setAsked(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {asked && <ConfirmDialog {...asked} onConfirm={() => answer(true)} onCancel={() => answer(false)} />}
    </ConfirmCtx.Provider>
  );
}

/**
 * `const confirm = useConfirm(); if (await confirm({ title, text, danger: true, confirmLabel })) remove.mutate(id);`
 * Outside the provider (a test harness, a page mounted on its own) it falls back to the browser's confirm.
 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmCtx);
  return ask ?? ((o) => Promise.resolve(window.confirm([o.title, typeof o.text === 'string' ? o.text : ''].filter(Boolean).join('\n\n'))));
}

// ───────────────────────────── networks and loading ─────────────────────────────

/** Two letters for a network. Not words: the same in every language, and the network's full name is said next to it or in its title. */
export const NET_MARK: Record<string, string> = {
  instagram: 'IG', facebook: 'FB', youtube: 'YT', tiktok: 'TT', linkedin: 'LI', x: 'X', threads: 'TH', pinterest: 'PI', bluesky: 'BS',
};
export const netMark = (network: string) => NET_MARK[network] ?? network.slice(0, 2).toUpperCase();

/**
 * A network's square mark: its logo, or its initials for a network without one. Decorative by default (the name is beside it); pass `labelled` where the mark stands alone, and
 * it says the network's name to a screen reader and in a tooltip.
 */
export function NetMark({ network, size = 'md', labelled, className = '' }: { network: string; size?: 'xs' | 'sm' | 'md' | 'lg'; labelled?: boolean; className?: string }) {
  const name = NETWORK_LABEL[network] ?? network;
  return (
    <span
      className={`net ${size === 'md' ? '' : `net-${size}`} ${className}`.trim()}
      data-network={network}
      {...(labelled ? { role: 'img', 'aria-label': name, title: name } : { 'aria-hidden': true })}
    >
      {HAS_LOGO.has(network) ? <NetLogo network={network} /> : netMark(network)}
    </span>
  );
}

/** A shimmering block where something is loading, in the shape of what will come. */
export function Skeleton({ width, height = 14, radius, className = '', style }: { width?: number | string; height?: number | string; radius?: number | string; className?: string; style?: CSSProperties }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

/** Several lines of text that are loading; the last one shorter, as text is. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <span className={`skeleton-text ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={i === lines - 1 && lines > 1 ? '62%' : '100%'} />)}
    </span>
  );
}

// ───────────────────────────── a row's "⋯" menu ─────────────────────────────

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Takes something away: red, and usually last. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * The "⋯" button of a row and the menu it opens: the row's less frequent actions, out of the way until asked for. Arrow keys
 * move, Enter picks, Escape or a click outside closes and gives the focus back to the button.
 */
export function MenuButton({ label, items, align = 'right', icon = 'more', className = '' }: { label: string; items: (MenuItem | false | null | undefined)[]; align?: 'left' | 'right'; icon?: IconName; className?: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = items.filter(Boolean) as MenuItem[];
  const close = useCallback((focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && close(false);
    document.addEventListener('mousedown', onDown);
    // The first item takes the focus, so the keyboard can go on from there.
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);
  const onKey = (e: KeyboardEvent) => {
    const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  };
  if (list.length === 0) return null;
  return (
    <div ref={wrap} className={`menu-wrap ${className}`.trim()} onKeyDown={open ? onKey : undefined}>
      <button
        ref={button}
        type="button"
        className="menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div className={`menu-pop menu-pop-${align}`} role="menu" aria-label={label}>
          {list.map((it, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`menu-item ${it.danger ? 'menu-item-danger' : ''}`}
              disabled={it.disabled}
              onClick={() => { close(false); it.onSelect(); }}
            >
              {it.icon && <Icon name={it.icon} />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An on/off setting, as Frame.io draws them: the label (and a hint, only where it is needed) on the left, the switch on
 * the right. For a real multi-select, a checkbox is still the thing.
 */
export function Switch({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A small set of choices side by side (grid · board · list, S · M · L); arrows move between them. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (value: T) => void }) {
  const move = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length]!;
    onChange(next.value);
    ((e.currentTarget.parentElement?.children[(i + step + options.length) % options.length]) as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} title={o.title} onClick={() => onChange(o.value)} onKeyDown={(e) => move(e, i)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
