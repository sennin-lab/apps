import { useEffect, useState } from 'react';

// /next 配下の URL を画面に変換する簡単なルーター
const BASE = '/next';

export type Route =
  | { name: 'home' }
  | { name: 'store' }
  | { name: 'studio' }
  | { name: 'admin' }
  | { name: 'run'; appId: string }
  | { name: 'notFound' };

export function parseRoute(pathname: string): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'store' && parts.length === 1) return { name: 'store' };
  if (parts[0] === 'studio' && parts.length === 1) return { name: 'studio' };
  if (parts[0] === 'admin' && parts.length === 1) return { name: 'admin' };
  if (parts[0] === 'run' && parts[1]) return { name: 'run', appId: decodeURIComponent(parts[1]) };
  return { name: 'notFound' };
}

export function navigate(path: string): void {
  window.history.pushState({}, '', `${BASE}${path}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return route;
}
