import { useCallback, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

/**
 * Dependency-free path router.
 *
 * The API serves the SPA for every non-`/api` path and the hosting docs cover
 * the equivalent rewrite for Vercel, so real URLs (including the emailed
 * `/invite/:token` link) are safe to link to and refresh.
 */

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function useLocation(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  );
}

export interface NavigateOptions {
  replace?: boolean;
  /** Keep the scroll position (used for query-only changes). */
  keepScroll?: boolean;
}

export function navigate(to: string, options: NavigateOptions = {}): void {
  const target = to.startsWith('/') ? to : `/${to}`;
  if (target === window.location.pathname && !options.replace) return;
  if (options.replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  if (!options.keepScroll) window.scrollTo({ top: 0 });
  emit();
}

export function reloadCurrentRoute(): void {
  emit();
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  children: ReactNode;
}

/** Anchor that routes client-side, degrading to a normal link without JS. */
export function Link({ to, replace = false, onClick, children, ...rest }: LinkProps): JSX.Element {
  const handle = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(to, { replace });
    },
    [onClick, to, replace],
  );

  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

/** Split a pathname into non-empty segments. */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}
