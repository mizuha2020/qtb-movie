import type { NavigateFunction, NavigateOptions, To } from 'react-router';

/**
 * Navigator dùng chung cho các handler trong App (vốn nằm ngoài <Routes>).
 * RouteSync sẽ đăng ký navigate thật khi mount; trước đó rớt về pushState cùng URL
 * để không vỡ logic back-button cũ.
 */
let appNav: NavigateFunction | null = null;

export function setAppNavigator(nav: NavigateFunction | null) {
  appNav = nav;
}

/** Param test/debug giữ nguyên khi đi giữa các trang (kẻo mất tv=1/tvdebug). */
const STICKY_PARAMS = ['tv', 'tvdebug'];
function withStickyParams(to: string): string {
  try {
    if (typeof window === 'undefined') return to;
    const cur = new URLSearchParams(window.location.search);
    const keep: Array<[string, string]> = [];
    for (const k of STICKY_PARAMS) {
      const v = cur.get(k);
      if (v !== null) keep.push([k, v]);
    }
    if (!keep.length) return to;
    const q = to.indexOf('?');
    if (q >= 0) {
      const existing = new URLSearchParams(to.slice(q + 1));
      for (const [k, v] of keep) {
        if (existing.get(k) === null) existing.set(k, v);
      }
      const s = existing.toString();
      return to.slice(0, q) + (s ? `?${s}` : '');
    }
    return `${to}?${keep.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  } catch {
    return to;
  }
}

export function appNavigate(to: To, opts?: NavigateOptions) {
  const finalTo = typeof to === 'string' ? withStickyParams(to) : to;
  if (appNav) {
    appNav(finalTo, opts);
    return;
  }
  if (typeof window !== 'undefined' && typeof finalTo === 'string') {
    window.history.pushState({}, '', finalTo);
  }
}
