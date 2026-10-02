import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

/**
 * The bar at the top of every page belongs to the layout (search, menu), but its breadcrumbs and actions belong to the
 * page. A page renders <PageBar>, and its contents are portalled into the layout's slots.
 */
export const PageBarSlots = createContext<{ crumbs: HTMLElement | null; actions: HTMLElement | null }>({ crumbs: null, actions: null });

export interface Crumb {
  label: string;
  to?: string;
}

export function PageBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  const slots = useContext(PageBarSlots);
  return (
    <>
      {slots.crumbs &&
        createPortal(
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="sep" aria-hidden="true">/</span>}
                {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : <span className="here" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>}
              </Fragment>
            ))}
          </nav>,
          slots.crumbs,
        )}
      {slots.actions && actions && createPortal(actions, slots.actions)}
    </>
  );
}
