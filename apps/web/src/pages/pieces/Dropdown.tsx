import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A button and what it opens: a menu (arrows move between the items, Enter picks, Escape closes and gives the focus back)
 * or a small panel. Closes when the pointer goes down outside it.
 */
export function Dropdown({
  button,
  children,
  align = 'start',
  kind = 'menu',
  className,
  panelClassName,
  label,
}: {
  /** The trigger: gets the props to spread on a <button>. */
  button: (props: { 'aria-expanded': boolean; 'aria-haspopup': 'menu' | 'dialog'; onClick: () => void; ref: (el: HTMLButtonElement | null) => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  kind?: 'menu' | 'dialog';
  className?: string;
  panelClassName?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    // A menu starts on its checked item, or its first one; a panel on its first control.
    const items = itemsOf(panel.current);
    (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault(); // the page's Escape (clear the selection) must not run too
      e.stopPropagation();
      close(true);
      return;
    }
    if (kind !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = itemsOf(panel.current);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]!.focus();
  };

  return (
    <div ref={wrap} className={`pz-dd ${className ?? ''}`} onKeyDown={onKeyDown}>
      {button({
        'aria-expanded': open,
        'aria-haspopup': kind,
        onClick: () => setOpen((o) => !o),
        ref: (el) => {
          trigger.current = el;
        },
      })}
      {open && (
        <div
          ref={panel}
          className={`popover pz-pop pz-pop-${align} ${panelClassName ?? ''}`}
          role={kind}
          aria-label={label}
          onBlur={(e) => {
            // Tabbing out of it closes it.
            if (kind === 'menu' && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
        >
          {children(() => close(true))}
        </div>
      )}
    </div>
  );
}

function itemsOf(el: HTMLElement | null): HTMLElement[] {
  if (!el) return [];
  return [...el.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled), button:not(:disabled), input:not(:disabled)')].filter(
    (x, i, all) => all.indexOf(x) === i,
  );
}
