import type { NavTab } from './types';

/**
 * Bản đồ tab <-> đường dẫn web (deep-link chia sẻ được).
 * CTA: thêm tab mới thì thêm 1 dòng ở đây, mọi chỗ khác tự ăn theo.
 */
export const TAB_PATHS: Record<NavTab, string> = {
  home: '/',
  series: '/series',
  single: '/movies',
  cinema: '/theater',
  anime: '/anime',
  'tv-shows': '/tv-shows',
  filter: '/browse',
  'my-list': '/my-list',
  history: '/history',
  offline: '/downloads',
  'tv-live': '/live-tv',
  youtube: '/youtube',
};

const PATH_TABS: Record<string, NavTab> = Object.fromEntries(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as NavTab]),
);

export interface FilterQuery {
  keyword: string;
  genre: string;
  country: string;
}

export const EMPTY_FILTER: FilterQuery = { keyword: '', genre: '', country: '' };

export type ParsedRoute =
  | { kind: 'tab'; tab: NavTab; filter: FilterQuery }
  | { kind: 'detail'; slug: string }
  | { kind: 'player'; slug: string; episodeSlug?: string; serverName?: string }
  | { kind: 'unknown' };

function readFilterQuery(search: string): FilterQuery {
  try {
    const sp = new URLSearchParams(search);
    return {
      keyword: (sp.get('q') || '').trim(),
      genre: (sp.get('genre') || '').trim(),
      country: (sp.get('country') || '').trim(),
    };
  } catch {
    return { ...EMPTY_FILTER };
  }
}

function writeFilterQuery(f: FilterQuery): string {
  const sp = new URLSearchParams();
  if (f.keyword) sp.set('q', f.keyword);
  if (f.genre) sp.set('genre', f.genre);
  if (f.country) sp.set('country', f.country);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const cleanPath = (p: string) =>
  p.length > 1 ? p.replace(/\/+$/, '') : p;

/** Parse URL hiện tại thành route nội bộ (không throw). */
export function parseLocation(pathname: string, search: string): ParsedRoute {
  const path = cleanPath(pathname || '/');
  if (PATH_TABS[path]) {
    const tab = PATH_TABS[path];
    return {
      kind: 'tab',
      tab,
      filter: tab === 'filter' ? readFilterQuery(search) : { ...EMPTY_FILTER },
    };
  }
  const segs = path.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segs[0] === 'movie' && segs[1]) {
    return { kind: 'detail', slug: segs[1] };
  }
  if (segs[0] === 'watch' && segs[1]) {
    return {
      kind: 'player',
      slug: segs[1],
      episodeSlug: segs[2] || undefined,
      serverName: segs[3] || undefined,
    };
  }
  return { kind: 'unknown' };
}

/** URL của tab (filter kèm query nếu có). */
export function buildTabUrl(tab: NavTab, filter?: FilterQuery): string {
  const base = TAB_PATHS[tab] ?? '/';
  if (tab === 'filter' && filter) return `${base}${writeFilterQuery(filter)}`;
  return base;
}

/** URL chi tiết phim: /movie/:slug (slug giữ nguyên từ phimapi) */
export function buildPhimUrl(slug: string): string {
  return `/movie/${encodeURIComponent(slug)}`;
}

/** URL xem phim: /watch/:slug/:tap?/:server? */
export function buildXemUrl(slug: string, episodeSlug?: string, serverName?: string): string {
  let url = `/watch/${encodeURIComponent(slug)}`;
  if (episodeSlug) url += `/${encodeURIComponent(episodeSlug)}`;
  if (episodeSlug && serverName) url += `/${encodeURIComponent(serverName)}`;
  return url;
}

/** So sánh 2 route theo nghĩa (query không phân biệt thứ tự). */
export function routesEqual(a: ParsedRoute, b: ParsedRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'tab' && b.kind === 'tab') {
    return (
      a.tab === b.tab &&
      a.filter.keyword === b.filter.keyword &&
      a.filter.genre === b.filter.genre &&
      a.filter.country === b.filter.country
    );
  }
  if (a.kind === 'detail' && b.kind === 'detail') return a.slug === b.slug;
  if (a.kind === 'player' && b.kind === 'player') {
    return (
      a.slug === b.slug &&
      (a.episodeSlug || undefined) === (b.episodeSlug || undefined) &&
      (a.serverName || undefined) === (b.serverName || undefined)
    );
  }
  return true; // unknown === unknown
}

/** Chuẩn hóa route state thành URL đầy đủ (để điều hướng). */
export function routeToUrl(r: ParsedRoute): string {
  if (r.kind === 'tab') return buildTabUrl(r.tab, r.filter);
  if (r.kind === 'detail') return buildPhimUrl(r.slug);
  if (r.kind === 'player') return buildXemUrl(r.slug, r.episodeSlug, r.serverName);
  return '/';
}
