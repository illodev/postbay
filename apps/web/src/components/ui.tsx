import * as RAlert from '@radix-ui/react-alert-dialog';
import * as RDialog from '@radix-ui/react-dialog';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RPopover from '@radix-ui/react-popover';
import * as RSelect from '@radix-ui/react-select';
import * as RTooltip from '@radix-ui/react-tooltip';
import { createContext, useCallback, useContext, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { ApiError } from '../api';
import { t, tMaybe } from '../i18n';
import { NETWORK_LABEL, STATE_LABEL } from '../lib/format';
import '../styles/ui.css';
import { Icon, type IconName } from './icons';
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
      <RTooltip.Provider delayDuration={450} skipDelayDuration={250}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </RTooltip.Provider>
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

/**
 * A modal, on Radix: focus trap, Escape and a click outside close it, the page behind does not scroll, and the menus,
 * selects and tooltips opened inside it show above it (a browser <dialog> kept them underneath).
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <RDialog.Root open onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="dialog-overlay" />
        <RDialog.Content className={wide ? 'dialog dialog-wide' : 'dialog'} aria-describedby={undefined}>
          <div className="dialog-body">
            <header className="dialog-head">
              <RDialog.Title asChild>
                <h2>{title}</h2>
              </RDialog.Title>
              <RDialog.Close className="icon-btn" aria-label={t('common.close')}>
                <Icon name="x" />
              </RDialog.Close>
            </header>
            {children}
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  return (
    <RAlert.Root open onOpenChange={(open) => !open && onCancel()}>
      <RAlert.Portal>
        <RAlert.Overlay className="dialog-overlay" />
        <RAlert.Content
          className={`dialog confirm ${danger ? 'confirm-danger' : ''}`}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (danger ? cancelRef : okRef).current?.focus();
          }}
        >
          <form
            className="confirm-body"
            onSubmit={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            <RAlert.Title asChild>
              <h2>{title}</h2>
            </RAlert.Title>
            {text && <div className="confirm-text">{text}</div>}
            <div className="confirm-actions">
              <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</button>
              <button ref={okRef} type="submit" className={`btn ${danger ? 'btn-confirm-danger' : 'btn-primary'}`} disabled={busy}>
                {confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </form>
        </RAlert.Content>
      </RAlert.Portal>
    </RAlert.Root>
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
  const move = (e: KeyboardEvent, i: number) => {
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

// ───────────────────────────── floating: popover, menu, select, tooltip (Radix) ─────────────────────────────
// Placed where they fit (flipping at the window's edge), closed by Escape and a click outside, keyboard-driven, and shown
// above dialogs. Styled here, not by Radix: .float is the shared surface.

type Side = 'top' | 'right' | 'bottom' | 'left';
type Align = 'start' | 'center' | 'end';

/** A panel anchored to its trigger. Controlled (`open`/`onOpenChange`) when the page closes it itself, e.g. after a choice. */
export function Popover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'start', width, label, className = '' }: {
  trigger: ReactElement; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; side?: Side; align?: Align; width?: number | string; label?: string; className?: string;
}) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content className={`float ${className}`.trim()} side={side} align={align} sideOffset={6} collisionPadding={8} style={{ width }} aria-label={label}>
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

/** A menu of actions: arrows, Enter, typeahead. Its children are MenuItem, MenuSeparator and MenuLabel. */
export function Menu({ trigger, children, side = 'bottom', align = 'end', width, open, onOpenChange }: {
  trigger: ReactElement; children: ReactNode; side?: Side; align?: Align; width?: number | string; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RMenu.Root open={open} onOpenChange={onOpenChange}>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content className="float menu" side={side} align={align} sideOffset={6} collisionPadding={8} style={{ width }}>
          {children}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

export function MenuItem({ icon, lead, children, onSelect, danger, disabled, hint, checked }: {
  icon?: IconName; /** something else in the icon's place: a brand mark, an avatar */ lead?: ReactNode; children: ReactNode; onSelect: () => void;
  danger?: boolean; disabled?: boolean; /** a shortcut or a short note, on the right */ hint?: ReactNode; /** the current choice: a check on the right */ checked?: boolean;
}) {
  return (
    <RMenu.Item className={`menu-item ${danger ? 'menu-item-danger' : ''}`.trim()} onSelect={onSelect} disabled={disabled} aria-current={checked || undefined}>
      {icon && <Icon name={icon} />}
      {lead}
      <span className="grow menu-text">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked && <span className="select-check"><Icon name="check" /></span>}
    </RMenu.Item>
  );
}

export const MenuSeparator = () => <RMenu.Separator className="menu-sep" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <RMenu.Label className="menu-label">{children}</RMenu.Label>;

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** shown before the label, in the list and in the closed select: a NetMark, an Avatar, an icon */
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * The app's own select: its list is styled, keyboard and typeahead work, and it opens above a dialog. A value may not be
 * the empty string (Radix keeps that for "nothing chosen", shown with the placeholder): use 'all', 'none'… instead.
 */
export function Select<T extends string>({ value, onChange, options, placeholder, label, disabled, id, className = '' }: {
  value: T | undefined; onChange: (value: T) => void; options: SelectOption<T>[]; placeholder?: string; label?: string; disabled?: boolean; id?: string; className?: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <RSelect.Trigger className={`select-trigger ${className}`.trim()} aria-label={label} id={id}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="select-chevron">
          <Icon name="chevronDown" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="float select-list" position="popper" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} disabled={o.disabled} className="menu-item">
                {o.icon}
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="select-check">
                  <Icon name="check" />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/** A tooltip: what a button does, and its shortcut. The trigger must take a ref (a button, a link). */
export function Tip({ label, shortcut, side = 'top', children }: { label: ReactNode; shortcut?: string; side?: Side; children: ReactElement }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={8}>
          {label}
          {shortcut && <span className="kbd">{shortcut}</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
