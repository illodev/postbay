import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import '../styles/menu.css';

export type MenuEntry =
  | { sep: true }
  | {
      sep?: false;
      label: string;
      icon?: IconName;
      /** Said on hover: what the item does, when the label alone may not. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** A link that opens elsewhere (a published post) instead of an action. */
      href?: string;
      onSelect?: () => void;
    };

/**
 * The "⋯" menu: the actions a row or a page has beyond its main one. It opens beside its button, above everything (it is drawn
 * at the end of the page, so no scrolling box clips it), and works from the keyboard: arrows move, Enter picks, Escape closes.
 */
export function MoreMenu({ items, label, className, children, align = 'end' }: {
  items: MenuEntry[];
  /** What the button is called for a screen reader and on hover. */
  label: string;
  className?: string;
  /** The button's own content; the "⋯" icon when not given. */
  children?: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const viaKeyboard = useRef(false);
  const shown = items.filter((i, n, all) => !i.sep || (n > 0 && n < all.length - 1 && !all[n - 1]!.sep));

  const close = (focus = false) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 240;
    const height = menu.current?.offsetHeight ?? 0;
    const up = r.bottom + 6 + height > window.innerHeight - 8 && r.top - 6 - height > 8;
    const left = align === 'end' ? Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) : Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setPos({ top: up ? r.top - 6 - height : r.bottom + 6, left, up });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    if (viaKeyboard.current) menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close();
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list.at(-1)?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className ?? 'mm-trigger'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') viaKeyboard.current = true;
        }}
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => (viaKeyboard.current = false), 0);
        }}
      >
        {children ?? <Icon name="more" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="mm-menu"
            role="menu"
            aria-label={label}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            data-up={pos?.up || undefined}
            onKeyDown={onMenuKey}
          >
            {shown.map((item, i) =>
              item.sep ? (
                <div key={`sep-${i}`} className="mm-sep" role="separator" />
              ) : item.href ? (
                <a key={item.label} role="menuitem" className="mm-item" href={item.href} target="_blank" rel="noreferrer" title={item.hint} onClick={() => close()}>
                  {item.icon && <Icon name={item.icon} />}
                  <span className="mm-label">{item.label}</span>
                  <Icon name="external" className="mm-ext" />
                </a>
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`mm-item ${item.danger ? 'is-danger' : ''}`}
                  aria-disabled={item.disabled || undefined}
                  title={item.hint}
                  onClick={() => {
                    if (item.disabled) return;
                    close();
                    item.onSelect?.();
                  }}
                >
                  {item.icon && <Icon name={item.icon} />}
                  <span className="mm-label">{item.label}</span>
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
