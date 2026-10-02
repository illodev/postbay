import { createContext, Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The header of a page: breadcrumbs on the left, the page's main actions on the right. It sits at the top of the
 * page itself — there is no global top bar (it cost a full-height page like the review a scroll for nothing).
 */

/** Kept for pages written against the earlier portal version; nothing reads it any more. */
export const PageBarSlots = createContext<{ crumbs: HTMLElement | null; actions: HTMLElement | null }>({ crumbs: null, actions: null });

export interface Crumb {
  label: string;
  to?: string;
}

export function PageBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <div className="page-top">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sep" aria-hidden="true">/</span>}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to}>{c.label}</Link>
            ) : (
              <span className="here" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      {actions && <div className="page-top-actions">{actions}</div>}
    </div>
  );
}
