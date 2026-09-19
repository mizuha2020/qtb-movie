import { Movie, MovieDetailResponse, MovieListResponse, EpisodeServer, ApiSource } from '../types';
import { getFullApiUrl, safeFetchJson, isNativeApp } from './apiConfig';
import { systemApiService } from './systemApiService';
import { db, rtdb, sanitizeData } from './firebase';
import { ref, get, set, onValue } from 'firebase/database';
import { doc, getDoc, setDoc } from 'firebase/firestore';

async function saveCacheToFirebase(cacheKey: string, payload: any): Promise<void> {
  // 1. Save to RTDB (Primary Database)
  try {
    if (rtdb) {
      await set(ref(rtdb, `system_cache/${cacheKey}`), payload);
    }
  } catch (err) {
    console.warn(`[RTDB Save Cache Error on ${cacheKey}]:`, err);
  }

  // 2. Secondary backup to Firestore
  try {
    if (db) {
      await setDoc(doc(db, 'system_cache', cacheKey), sanitizeData(payload));
    }
  } catch (err) {
    console.warn(`[Firestore Save Cache Error on ${cacheKey}]:`, err);
  }
}

async function readCacheFromFirebase(cacheKey: string): Promise<any | null> {
  // 1. Try RTDB first (Primary Database)
  try {
    if (rtdb) {
      const snapshot = await get(ref(rtdb, `system_cache/${cacheKey}`));
      if (snapshot.exists()) {
        return snapshot.val();
      }
    }
  } catch (err) {
    console.warn(`[RTDB Read Cache Error on ${cacheKey}]:`, err);
  }

  // 2. Try Firestore fallback
  try {
    if (db) {
      const snap = await getDoc(doc(db, 'system_cache', cacheKey));
      if (snap.exists()) {
        return snap.data();
      }
    }
  } catch (err) {
    console.warn(`[Firestore Read Cache Error on ${cacheKey}]:`, err);
  }

  return null;
}

function isMovieSourceEnabled(id: ApiSource): boolean {
  try {
    const active = systemApiService.getActiveEndpointsForCategory('movie');
    if (!active || active.length === 0) return true;
    return active.some(e => e.id === id);
  } catch { return true; }
}

export interface SourceOption {
  id: ApiSource;
  name: string;
  shortName: string;
  badgeColor: string;
  description: string;
  hasM3u8: boolean;
  hasEmbed: boolean;
}

export const API_SOURCES: SourceOption[] = [
  {
    id: 'all',
    name: 'Tất cả nguồn (All-in-One)',
    shortName: 'Tổng hợp',
    badgeColor: 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white',
    description: 'Tự động tổng hợp và tìm kiếm từ KKPhim, OPhim và NguonC',
    hasM3u8: true,
    hasEmbed: true,
  },
  {
    id: 'kkphim',
    name: 'KKPhim (Vietsub & M3U8)',
    shortName: 'KKPhim',
    badgeColor: 'bg-emerald-900/80 text-emerald-300 border border-emerald-700/60',
    description: 'Kho phim chất lượng cao, luồng HLS .m3u8 mượt mà, đầy đủ TMDB/IMDb',
    hasM3u8: true,
    hasEmbed: true,
  },
  {
    id: 'ophim',
    name: 'OPhim (Vietsub VIP)',
    shortName: 'OPhim',
    badgeColor: 'bg-sky-900/80 text-sky-300 border border-sky-700/60',
    description: 'Kho phim bộ & phim lẻ cập nhật liên tục, server VIP Vietsub',
    hasM3u8: true,
    hasEmbed: true,
  },
  {
    id: 'nguonc',
    name: 'NguonC (Vietsub Fast)',
    shortName: 'NguonC',
    badgeColor: 'bg-amber-900/80 text-amber-300 border border-amber-700/60',
    description: 'Nguồn phim độc lập, streaming tốc độ cao, phong phú anime và TV shows',
    hasM3u8: false,
    hasEmbed: true,
  },
];

// Base fetchers using dynamic active base URLs
const getKKPhimUrl = (endpoint: string) => {
  const base = systemApiService.getActiveBaseUrl('movie', 'kkphim', 'https://phimapi.com');
  return `${base.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
};

const getOPhimUrl = (endpoint: string) => {
  const base = systemApiService.getActiveBaseUrl('movie', 'ophim', 'https://ophim1.com');
  return `${base.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
};

const getNguonCUrl = (endpoint: string) => {
  return `https://phim.nguonc.com/api/${endpoint.replace(/^\//, '')}`;
};

// Current active source preference stored in memory/localStorage
let activeApiSource: ApiSource = (typeof window !== 'undefined' && (localStorage.getItem('qtb_api_source') as ApiSource)) || 'all';

export function getActiveApiSource(): ApiSource {
  return activeApiSource;
}

export function setActiveApiSource(source: ApiSource) {
  activeApiSource = source;
  if (typeof window !== 'undefined') {
    localStorage.setItem('qtb_api_source', source);
    window.dispatchEvent(new CustomEvent('qtb_source_changed', { detail: source }));
  }
}

// Format image URL properly across all CDNs
export function getImageUrl(path?: string, source?: ApiSource | string): string {
  if (!path) {
    return 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80';
  }
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const cleanPath = path.replace(/^\//, '');

  if (source === 'nguonc' || cleanPath.startsWith('public/images/')) {
    return `https://phim.nguonc.com/${cleanPath}`;
  }

  if (source === 'kkphim' || cleanPath.startsWith('uploads/movies/202')) {
    return `https://phimimg.com/${cleanPath}`;
  }

  // Default to OPhim / KKPhim standard CDN
  if (cleanPath.startsWith('uploads/movies/')) {
    return `https://img.ophim.live/${cleanPath}`;
  }
  return `https://img.ophim.live/uploads/movies/${cleanPath}`;
}

// Ép ảnh TMDB về đúng cỡ hiển thị (original 4K vài MB -> w1280/w500 vài trăm KB)
export function sizedTmdbUrl(url: string | null | undefined, size: 'w300' | 'w500' | 'w780' | 'w1280' = 'w1280'): string | null {
  if (!url) return null;
  try {
    if (!url.includes('image.tmdb.org')) return url;
    return url.replace(/\/original(?=\/)|\/w\d+(?=\/)/, `/${size}`);
  } catch {
    return url;
  }
}

// --- High-quality hero image optimizer (wsrv.nl like chophim.app, but some CDNs blocked) ---
export function getOptimizedImageUrl(url: string, width = 1920, quality = 85): string {
  if (!url || url.includes('unsplash.com')) return url;
  if (url.includes('wsrv.nl')) return url;
  if (url.includes('phimimg.com') || url.includes('img.ophim') || url.includes('ophim.live')) return url;
  try {
    const encoded = encodeURIComponent(url);
    return `https://wsrv.nl/?url=${encoded}&w=${width}&q=${quality}&output=webp&n=-1`;
  } catch {
    return url;
  }
}

export function getHeroImageUrl(path?: string, source?: ApiSource | string): string {
  const raw = getImageUrl(path, source);
  if (raw.includes('image.tmdb.org')) return getOptimizedImageUrl(raw, 1920, 100);
  if (raw.includes('phimimg.com') || raw.includes('img.ophim')) return raw;
  return getOptimizedImageUrl(raw, 1920, 90);
}

export const TMDB_API_KEY = "555c9b55025bdc42ab41e4969667ffed";
export const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const tmdbBackdropCacheClient = new Map<string, string | null>();
const tmdbLogoCacheClient = new Map<string, string | null>();
const tmdbAssetsCacheClient = new Map<string, { backdropUrl: string | null; logoUrl: string | null }>();

export function clearTmdbAssetsCache() {
  tmdbAssetsCacheClient.clear();
  tmdbBackdropCacheClient.clear();
  tmdbLogoCacheClient.clear();
  if (typeof window !== 'undefined') {
    try {
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('tmdb_asset_')) {
          localStorage.removeItem(key);
        }
      });
    } catch {}
  }
}

export async function getTmdbAssets(tmdbId: string | number, tmdbType?: string): Promise<{ backdropUrl: string | null; logoUrl: string | null }> {
  const id = String(tmdbId || "").trim();
  if (!id || !/^\d+$/.test(id)) return { backdropUrl: null, logoUrl: null };

  const rawType = String(tmdbType || '').trim().toLowerCase();
  const normalizedType =
    rawType === 'tv' || rawType === 'series' || rawType === 'tvshows'
      ? 'tv'
      : rawType === 'movie' || rawType === 'single'
      ? 'movie'
      : undefined;

  const cacheKey = normalizedType ? `${id}:${normalizedType}` : id;

  // 1. Memory cache check
  if (tmdbAssetsCacheClient.has(cacheKey)) return tmdbAssetsCacheClient.get(cacheKey)!;

  // 1b. Persistent localStorage cache check (instant on APK & repeated visits)
  const localCacheKey = `tmdb_assets_${cacheKey}`;
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem(localCacheKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && (parsed.backdropUrl || parsed.logoUrl)) {
          tmdbAssetsCacheClient.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch {}
  }

  let backdropUrl: string | null = null;
  let logoUrl: string | null = null;

  const isNative = isNativeApp();

  // 2. Try backend endpoint only on Web where same-origin backend proxy is guaranteed to respond quickly.
  // Native APK should bypass external cloud proxy to prevent 6s hang if backend is slow/offline.
  if (!isNative) {
    try {
      const fullUrl = getFullApiUrl(`/api/tmdb/backdrop/${id}${normalizedType ? `?type=${normalizedType}` : ''}`);
      const data = await safeFetchJson<{ backdropUrl?: string; logoUrl?: string }>(fullUrl, {}, 2500);
      if (data) {
        backdropUrl = data.backdropUrl || null;
        logoUrl = data.logoUrl || null;
      }
    } catch {}
  }

  // 3. Fallback: Direct TMDB Image API - works everywhere (web + Android tablet APK)
  if (!backdropUrl || !logoUrl) {
    try {
      const imgLangs = 'vi,en,null';
      let bestData: any = null;
      let otherData: any = null;

      if (normalizedType) {
        const targetUrl = `${TMDB_BASE_URL}/${normalizedType}/${id}/images?include_image_language=${imgLangs}&api_key=${TMDB_API_KEY}`;
        bestData = await safeFetchJson<any>(targetUrl, {}, 3500).catch(() => null);
        // Nếu thiếu 1 trong 2, thử fetch type còn lại làm fallback
        if (!bestData || (!bestData.backdrops?.length && !bestData.logos?.length)) {
          const fallbackType = normalizedType === 'tv' ? 'movie' : 'tv';
          otherData = await safeFetchJson<any>(`${TMDB_BASE_URL}/${fallbackType}/${id}/images?include_image_language=${imgLangs}&api_key=${TMDB_API_KEY}`, {}, 3000).catch(() => null);
          if (bestData && otherData) {
            if (!bestData.backdrops?.length && !bestData.logos?.length) bestData = otherData;
          } else if (!bestData) bestData = otherData;
        }
      } else {
        // Type unknown: fetch both movie & tv in parallel to eliminate long waterfall delay
        const [movieData, tvData] = await Promise.all([
          safeFetchJson<any>(`${TMDB_BASE_URL}/movie/${id}/images?include_image_language=${imgLangs}&api_key=${TMDB_API_KEY}`, {}, 3000).catch(() => null),
          safeFetchJson<any>(`${TMDB_BASE_URL}/tv/${id}/images?include_image_language=${imgLangs}&api_key=${TMDB_API_KEY}`, {}, 3000).catch(() => null),
        ]);

        const scoreCandidate = (data: any) => {
          if (!data || (!data.backdrops?.length && !data.logos?.length)) return -1;
          const hasViLogo = Array.isArray(data.logos) && data.logos.some((l: any) => l.iso_639_1 === 'vi');
          const hasViBackdrop = Array.isArray(data.backdrops) && data.backdrops.some((b: any) => b.iso_639_1 === 'vi');
          const maxVote = Math.max(0, ...(data.backdrops || []).map((b: any) => Number(b.vote_average) || 0), ...(data.logos || []).map((l: any) => Number(l.vote_average) || 0));
          const total = (data.backdrops?.length || 0) + (data.logos?.length || 0);
          return (hasViLogo ? 1000 : 0) + (hasViBackdrop ? 500 : 0) + maxVote * 100 + total * 10;
        };
        const movieScore = scoreCandidate(movieData);
        const tvScore = scoreCandidate(tvData);
        if (movieScore >= 0 || tvScore >= 0) {
          if (tvScore > movieScore) {
            bestData = tvData;
            otherData = movieData;
          } else {
            bestData = movieData;
            otherData = tvData;
          }
        } else {
          bestData = movieData || tvData;
          otherData = bestData === movieData ? tvData : movieData;
        }
      }

      if (bestData) {
        if (!logoUrl && bestData.logos && Array.isArray(bestData.logos) && bestData.logos.length > 0) {
          const viLogo = bestData.logos.find((l: any) => l.iso_639_1 === 'vi');
          const enLogo = bestData.logos.find((l: any) => l.iso_639_1 === 'en');
          const bestLogo = viLogo || enLogo || bestData.logos[0];
          if (bestLogo?.file_path) {
            logoUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
          }
        }
        if (!backdropUrl && bestData.backdrops && Array.isArray(bestData.backdrops) && bestData.backdrops.length > 0) {
          const textless = bestData.backdrops.filter((b: any) => !b.iso_639_1 || b.iso_639_1 === 'xx');
          const candidates = textless.length > 0 ? textless : [...bestData.backdrops];
          candidates.sort((a: any, b: any) => (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0));
          const bestBackdrop = candidates[0];
          if (bestBackdrop?.file_path) {
            backdropUrl = `https://image.tmdb.org/t/p/original${bestBackdrop.file_path}`;
          }
        }
        if (otherData) {
          if (!logoUrl && otherData.logos?.length) {
            const viLogo = otherData.logos.find((l: any) => l.iso_639_1 === 'vi');
            const enLogo = otherData.logos.find((l: any) => l.iso_639_1 === 'en');
            const bestLogo = viLogo || enLogo || otherData.logos[0];
            if (bestLogo?.file_path) logoUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
          }
          if (!backdropUrl && otherData.backdrops?.length) {
            const textless = otherData.backdrops.filter((b: any) => !b.iso_639_1 || b.iso_639_1 === 'xx');
            const candidates = textless.length > 0 ? textless : [...otherData.backdrops];
            candidates.sort((a: any, b: any) => (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0));
            const bestBackdrop = candidates[0];
            if (bestBackdrop?.file_path) backdropUrl = `https://image.tmdb.org/t/p/original${bestBackdrop.file_path}`;
          }
        }
      }
    } catch {}
  }

  // Chuẩn hóa cỡ ngay tại nguồn: backdrop w1280, logo w500 (hiển thị max-h-32)
  backdropUrl = sizedTmdbUrl(backdropUrl, 'w1280');
  logoUrl = sizedTmdbUrl(logoUrl, 'w500');
  const result = { backdropUrl, logoUrl };
  tmdbBackdropCacheClient.set(cacheKey, backdropUrl);
  tmdbLogoCacheClient.set(cacheKey, logoUrl);
  tmdbAssetsCacheClient.set(cacheKey, result);

  if (typeof window !== 'undefined' && (backdropUrl || logoUrl)) {
    try {
      localStorage.setItem(localCacheKey, JSON.stringify(result));
    } catch {}
  }

  return result;
}

export async function getTmdbBackdropUrl(tmdbId: string | number, tmdbType?: string): Promise<string | null> {
  const assets = await getTmdbAssets(tmdbId, tmdbType);
  return assets.backdropUrl;
}

export async function getTmdbLogoUrl(tmdbId: string | number, tmdbType?: string): Promise<string | null> {
  const assets = await getTmdbAssets(tmdbId, tmdbType);
  return assets.logoUrl;
}

export interface TmdbTrendingItem {
  tmdbId: string;
  title: string;
  original_title: string;
  overview: string;
  release_date: string;
  vote_average: number;
  backdrop_path: string | null;
  poster_path: string | null;
  backdropUrl: string | null;
  posterUrl: string | null;
}

const tmdbTrendingCacheClient = new Map<string, { data: TmdbTrendingItem[]; time: number }>();

export async function getTmdbTrending(): Promise<TmdbTrendingItem[]> {
  const cache = tmdbTrendingCacheClient.get("trending");
  if (cache && Date.now() - cache.time < 10 * 60 * 1000) return cache.data;

  // 1. Try backend
  try {
    const fullUrl = getFullApiUrl("/api/tmdb/trending");
    const isLocalhostApk = typeof window !== 'undefined' && window.location.hostname === 'localhost' && !fullUrl.startsWith('http');
    if (!isLocalhostApk) {
      const data = await safeFetchJson<{ results?: any[] }>(fullUrl, {}, 3000);
      if (data?.results && Array.isArray(data.results) && data.results.length > 0) {
        const items: TmdbTrendingItem[] = data.results.map((r: any) => ({
          tmdbId: String(r.id || r.tmdbId || ''),
          title: r.title || r.name || '',
          original_title: r.original_title || r.original_name || '',
          overview: r.overview || '',
          release_date: r.release_date || r.first_air_date || '',
          vote_average: r.vote_average || 0,
          backdrop_path: r.backdrop_path || null,
          poster_path: r.poster_path || null,
          backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
          posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        }));
        tmdbTrendingCacheClient.set("trending", { data: items, time: Date.now() });
        return items;
      }
    }
  } catch {}

  // 2. Direct TMDB API fallback
  try {
    const directRes = await safeFetchJson<{ results?: any[] }>(
      `${TMDB_BASE_URL}/trending/movie/day?api_key=${TMDB_API_KEY}&language=vi-VN`,
      {},
      3500
    );
    if (directRes?.results && Array.isArray(directRes.results)) {
      const items: TmdbTrendingItem[] = directRes.results.map((r: any) => ({
        tmdbId: String(r.id || ''),
        title: r.title || r.name || '',
        original_title: r.original_title || r.original_name || '',
        overview: r.overview || '',
        release_date: r.release_date || r.first_air_date || '',
        vote_average: r.vote_average || 0,
        backdrop_path: r.backdrop_path || null,
        poster_path: r.poster_path || null,
        backdropUrl: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
        posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
      }));
      tmdbTrendingCacheClient.set("trending", { data: items, time: Date.now() });
      return items;
    }
  } catch {}

  return [];
}

export async function tmdbFetch<T = any>(tmdbPath: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  const cleanPath = tmdbPath.replace(/^\//, "");

  // 1. Try backend proxy if available
  try {
    const fullUrl = getFullApiUrl(`/api/tmdb/v3/${cleanPath}${qs ? `?${qs}` : ""}`);
    const isLocalhostApk = typeof window !== 'undefined' && window.location.hostname === 'localhost' && !fullUrl.startsWith('http');
    if (!isLocalhostApk) {
      const data = await safeFetchJson<T>(fullUrl, {}, 3500);
      if (data) return data;
    }
  } catch {}

  // 2. Fallback to direct TMDB API
  const directUrl = `${TMDB_BASE_URL}/${cleanPath}?api_key=${TMDB_API_KEY}${qs ? `&${qs}` : ""}`;
  const res = await fetch(directUrl);
  if (!res.ok) throw new Error(`TMDB ${tmdbPath} ${res.status}`);
  return res.json();
}

export const tmdbApi = {
  trending: (type: "movie" | "tv" | "all" = "movie", window: "day" | "week" = "day") => tmdbFetch(`trending/${type}/${window}`),
  moviePopular: (page = 1) => tmdbFetch("movie/popular", { page }),
  movieNowPlaying: (page = 1) => tmdbFetch("movie/now_playing", { page }),
  movieUpcoming: (page = 1) => tmdbFetch("movie/upcoming", { page }),
  movieTopRated: (page = 1) => tmdbFetch("movie/top_rated", { page }),
  tvPopular: (page = 1) => tmdbFetch("tv/popular", { page }),
  searchMovie: (query: string, page = 1) => tmdbFetch("search/movie", { query, page }),
  discoverMovie: (params: Record<string, any> = {}) => tmdbFetch("discover/movie", params),
};

let clientTmdbHeroCache: { data: Movie[]; time: number } | null = null;

// Curated seed hero items to ensure instant load even when offline or before any network responds
const SEED_HERO_POPULAR: Partial<Movie>[] = [
  {
    name: "Moana 2",
    origin_name: "Moana 2",
    slug: "hanh-trinh-cua-moana-2",
    poster_url: "https://image.tmdb.org/t/p/w500/yh64qw9mgXBvlaWDi7Q9tpUBAvH.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/yh64qw9mgXBvlaWDi7Q9tpUBAvH.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/tElnmtQ6yz1PjN1kePNl8yMSb59.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "1241982" },
    type: "single",
    status: "completed",
  },
  {
    name: "Wicked",
    origin_name: "Wicked",
    slug: "wicked",
    poster_url: "https://image.tmdb.org/t/p/w500/xDGbZ0JJ3mYaGKy4Nzd9Kph6M9L.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/xDGbZ0JJ3mYaGKy4Nzd9Kph6M9L.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/uKb22E5ww9bX9hZNJK6WV24Ko4k.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "402431" },
    type: "single",
    status: "completed",
  },
  {
    name: "Gladiator II",
    origin_name: "Gladiator II",
    slug: "vo-si-giac-dau-2",
    poster_url: "https://image.tmdb.org/t/p/w500/2cxhvwyEwRlysAmRH4iodkvo0z5.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/2cxhvwyEwRlysAmRH4iodkvo0z5.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/euYIwmwkmz95mnXvufEmbL69ovr.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "558449" },
    type: "single",
    status: "completed",
  },
  {
    name: "Deadpool & Wolverine",
    origin_name: "Deadpool & Wolverine",
    slug: "deadpool-va-wolverine",
    poster_url: "https://image.tmdb.org/t/p/w500/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/yDHYTfA3R0jFYba16jBB1jv8uaC.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "533535" },
    type: "single",
    status: "completed",
  },
  {
    name: "Mufasa: Vua Sư Tử",
    origin_name: "Mufasa: The Lion King",
    slug: "mufasa-vua-su-tu",
    poster_url: "https://image.tmdb.org/t/p/w500/jbOSUAWMGzGLUm1T92z2x2mgmmb.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/jbOSUAWMGzGLUm1T92z2x2mgmmb.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/oHPoF0Gzu8xwK4CtdAYDaWdcu54.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "762509" },
    type: "single",
    status: "completed",
  },
  {
    name: "Dune: Hành Tinh Cát - Phần 2",
    origin_name: "Dune: Part Two",
    slug: "du-hanh-tinh-cat-phan-hai",
    poster_url: "https://image.tmdb.org/t/p/w500/czembW0Rk1Ke7lCJGahbOhdCuhV.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/czembW0Rk1Ke7lCJGahbOhdCuhV.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/xOMo8BRK7PfcJv9JCnx7s5200bm.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "693134" },
    type: "single",
    status: "completed",
  },
  {
    name: "Venom: Kèo Cuối",
    origin_name: "Venom: The Last Dance",
    slug: "venom-keo-cuoi",
    poster_url: "https://image.tmdb.org/t/p/w500/aosm8NMQ3UyoBVpSxyimorCQykC.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/aosm8NMQ3UyoBVpSxyimorCQykC.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/3V4kLQg0kSqPLctI5ziYWMEAZYF.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "912649" },
    type: "single",
    status: "completed",
  },
  {
    name: "Hành Tinh Khỉ: Vương Quốc Mới",
    origin_name: "Kingdom of the Planet of the Apes",
    slug: "hanh-tinh-khi-vuong-quoc-moi",
    poster_url: "https://image.tmdb.org/t/p/w500/gKkl37BQuKTanygYQG1pyYgLVgf.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/gKkl37BQuKTanygYQG1pyYgLVgf.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/fqv8v6A9pnivveuunPPGXurDOko.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "653346" },
    type: "single",
    status: "completed",
  },
  {
    name: "Inside Out 2 (Những Mảnh Ghép Cảm Xúc 2)",
    origin_name: "Inside Out 2",
    slug: "nhung-manh-ghep-cam-xuc-2",
    poster_url: "https://image.tmdb.org/t/p/w500/vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/xg270vg9bkHN9vy4vlmvNDaq12p.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "1022789" },
    type: "single",
    status: "completed",
  },
  {
    name: "Kẻ Trộm Mặt Trăng 4",
    origin_name: "Despicable Me 4",
    slug: "ke-trom-mat-trang-4",
    poster_url: "https://image.tmdb.org/t/p/w500/wWba3TaojhK7NdycRhoQpsG0FaH.jpg",
    thumb_url: "https://image.tmdb.org/t/p/w500/wWba3TaojhK7NdycRhoQpsG0FaH.jpg",
    backdrop_url: "https://image.tmdb.org/t/p/original/lgkGysjeistip209Tu47Jikm5e6.jpg",
    year: 2024,
    quality: "FHD",
    lang: "Vietsub",
    source: "kkphim",
    sourceLabel: "KKPhim",
    tmdb: { id: "519182" },
    type: "single",
    status: "completed",
  },
];

// Cache helpers for Client-side with auto reset at 00:00 & 12:00 Vietnam Time (UTC+7)
export function isVietnamCacheValid(savedAt: number): boolean {
  if (!savedAt || typeof savedAt !== 'number') return false;
  const now = Date.now();
  const vnMs = now + 7 * 60 * 60 * 1000;
  const vnDate = new Date(vnMs);
  const year = vnDate.getUTCFullYear();
  const month = vnDate.getUTCMonth();
  const day = vnDate.getUTCDate();
  const hours = vnDate.getUTCHours();

  let lastBoundaryVnMs: number;
  if (hours >= 12) {
    // Boundary is today 12:00:00 ICT
    lastBoundaryVnMs = Date.UTC(year, month, day, 12, 0, 0, 0);
  } else {
    // Boundary is today 00:00:00 ICT
    lastBoundaryVnMs = Date.UTC(year, month, day, 0, 0, 0, 0);
  }
  const lastBoundaryUtc = lastBoundaryVnMs - 7 * 60 * 60 * 1000;

  return savedAt >= lastBoundaryUtc;
}

export function setClientHeroCache(_items: Movie[], _savedAt = Date.now()) {
  // Client-side cache disabled per request
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('qtb_hero_banner_cache_v5');
    } catch {}
  }
}

export function getClientHeroCache(): Movie[] | null {
  // Client-side cache disabled per request
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('qtb_hero_banner_cache_v5');
    } catch {}
  }
  return null;
}

export function setClientNetflixCache(_data: any, _savedAt = Date.now()) {
  // Client-side cache disabled per request
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('qtb_netflix_top10_cache_v5');
    } catch {}
  }
}

export function getClientNetflixCache(): any | null {
  // Client-side cache disabled per request
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('qtb_netflix_top10_cache_v5');
    } catch {}
  }
  return null;
}

function normHeroTitle(s: any): string {
  return String(s || '').toLowerCase().trim().replace(/[“”"'`’.:;\-–—!?()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripHeroDiacritics(s: string): string {
  try { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch { return s; }
}
// Chấm điểm khớp TMDB <-> phimapi, thà bỏ qua còn hơn gắn nhầm (vd Ám Ảnh/Obsession -> Bạch Dạ Ám Ảnh)
// Ưu tiên 1: khớp tmdb.id chính xác (phimapi search đã trả kèm tmdb.id). Fallback: tên/năm/loại.
function pickBestHeroMatch(foundItems: any[], opts: { title: string; originalTitle: string; year?: number; tmdbId?: string }): any | null {
  if (!Array.isArray(foundItems) || foundItems.length === 0) return null;
  const wantId = opts.tmdbId ? String(opts.tmdbId).trim() : '';
  if (wantId) {
    const byId = foundItems.find((c: any) => c && c.slug && String(c?.tmdb?.id ?? '').trim() === wantId);
    if (byId) return byId;
  }
  const t = normHeroTitle(opts.title);
  const ot = normHeroTitle(opts.originalTitle);
  const tFlat = normHeroTitle(stripHeroDiacritics(opts.title));
  const otFlat = normHeroTitle(stripHeroDiacritics(opts.originalTitle));
  let best: any = null;
  let bestScore = -Infinity;
  for (const c of foundItems) {
    if (!c || !c.slug) continue;
    const cName = normHeroTitle(c.name);
    const cOrigin = normHeroTitle(c.origin_name);
    const cNameFlat = normHeroTitle(stripHeroDiacritics(c.name));
    const cOriginFlat = normHeroTitle(stripHeroDiacritics(c.origin_name));
    let score = 0;
    if (cName && t && cName === t) score += 10;
    else if (cNameFlat && tFlat && cNameFlat === tFlat) score += 8;
    else if (t && cName && t.length >= 4 && (cName.includes(t) || t.includes(cName))) score += 2;
    if (cOrigin && ot && cOrigin === ot) score += 8;
    else if (cOriginFlat && otFlat && cOriginFlat === otFlat) score += 6;
    else if (cOrigin && t && cOrigin === t) score += 4;
    if (opts.year && Number(c.year) === Number(opts.year)) score += 3;
    if (c.type === 'single') score += 4;
    else if (c.type === 'series' || c.type === 'tvshows') score -= 2;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore < 10) return null;
  return best;
}

const HERO_LS_KEY = 'qtb_hero_popular_v1';
const HERO_LS_TTL = 24 * 60 * 60 * 1000;
function readHeroLS(): Movie[] | null {
  try {
    const raw = localStorage.getItem(HERO_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { items?: any[]; at?: number };
    if (!parsed?.items || !Array.isArray(parsed.items) || parsed.items.length < 8) return null;
    if (!parsed.at || Date.now() - parsed.at > HERO_LS_TTL) return null;
    return parsed.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
  } catch {
    return null;
  }
}
function saveHeroLS(items: any[]): void {
  try {
    localStorage.setItem(HERO_LS_KEY, JSON.stringify({ items, at: Date.now() }));
  } catch {}
}

/** Stale-while-revalidate: cache local có là trả ngay + refresh nền. */
export async function getTmdbHeroPopular(): Promise<Movie[]> {
  const ls = readHeroLS();
  if (ls) {
    refreshHeroPopular().catch(() => {});
    return ls;
  }
  return refreshHeroPopular();
}

async function refreshHeroPopular(): Promise<Movie[]> {
  const nowTs = Date.now();

  // 1. Direct Firebase Read (Firestore + RTDB)
  try {
    const cached = await readCacheFromFirebase('hero_banner');
    if (cached?.items && Array.isArray(cached.items) && cached.items.length >= 8) {
      saveHeroLS(cached.items);
      const items = cached.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
      return items;
    }
  } catch (err) {
    console.warn('[Firebase Hero Popular Read Error]:', err);
  }

  // 2. Try backend endpoint with precomputed data
  try {
    const fullUrl = getFullApiUrl(`/api/tmdb/hero-popular?t=${nowTs}`);
    const isLocalhostApk = typeof window !== 'undefined' && window.location.hostname === 'localhost' && !fullUrl.startsWith('http');
    if (!isLocalhostApk) {
      const data = await safeFetchJson<{ items: any[] }>(fullUrl, { cache: 'no-store' as RequestCache }, 4000);
      if (data?.items && Array.isArray(data.items) && data.items.length >= 8) {
        const normalized = data.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
        saveCacheToFirebase('hero_banner', { items: data.items, lastUpdated: nowTs });
        saveHeroLS(data.items);
        return normalized;
      }
    }
  } catch {}

  // 3. Direct Client-Side Fallback Engine: Discover TMDB + Search KKPhim
  try {
    const tmdbRes = await safeFetchJson<{ results?: any[] }>(
      `${TMDB_BASE_URL}/discover/movie?language=vi-VN&region=VN&sort_by=popularity.desc&page=1&api_key=${TMDB_API_KEY}`,
      {},
      4000
    );

    const candidates = tmdbRes?.results && Array.isArray(tmdbRes.results) && tmdbRes.results.length > 0
      ? tmdbRes.results
      : [];

    if (candidates.length > 0) {
      const resolvedItems: Movie[] = [];
      const usedSlugs = new Set<string>();

      // Batch search top candidates against KKPhim, concurrency 4
      // (nối tiếp từng phim: 16 x 2.5s = 40s; batch 4: ~10s)
      const resolveOne = async (item: any): Promise<Movie | null> => {
        const searchQuery = (item.title || item.original_title || '').replace(/\s*\(.*?\)/, '').trim();
        if (!searchQuery) return null;
        try {
          const searchData = await safeFetchJson<{ data?: { items?: any[] }; items?: any[] }>(
            `https://phimapi.com/v1/api/tim-kiem?keyword=${encodeURIComponent(searchQuery)}&limit=10`,
            {},
            2500
          );
          const foundItems = searchData?.data?.items || searchData?.items || [];
          const found = pickBestHeroMatch(foundItems, {
            title: item.title || '',
            originalTitle: item.original_title || '',
            year: item.release_date ? Number(String(item.release_date).slice(0, 4)) : undefined,
            tmdbId: String(item.id),
          });
          if (!found || !found.slug || usedSlugs.has(found.slug)) return null;
          const tmdbBackdrop = item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : undefined;
          const tmdbPoster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined;
          return {
            name: found.name || item.title,
            origin_name: found.origin_name || item.original_title || item.title,
            slug: found.slug,
            poster_url: tmdbPoster || found.poster_url || found.thumb_url || '',
            thumb_url: tmdbPoster || found.thumb_url || found.poster_url || '',
            backdrop_url: tmdbBackdrop || found.thumb_url || undefined,
            year: found.year || (item.release_date ? Number(item.release_date.slice(0, 4)) : 2024),
            quality: found.quality || 'FHD',
            lang: found.lang || 'Vietsub',
            content: item.overview || found.content || '',
            type: 'single',
            status: 'completed',
            source: 'kkphim',
            sourceLabel: 'KKPhim',
            tmdb: { id: String(item.id), type: 'movie', vote_average: item.vote_average },
          } as Movie;
        } catch {
          return null;
        }
      };
      const queue = candidates.slice(0, 16);
      for (let i = 0; i < queue.length && resolvedItems.length < 10; i += 4) {
        const batch = await Promise.all(queue.slice(i, i + 4).map(resolveOne));
        for (const m of batch) {
          if (m && resolvedItems.length < 10 && !usedSlugs.has(m.slug)) {
            usedSlugs.add(m.slug);
            resolvedItems.push(m);
          }
        }
      }

      // If resolved at least 6 movies, fill up with seed movies
      if (resolvedItems.length >= 6) {
        for (const seed of SEED_HERO_POPULAR) {
          if (resolvedItems.length >= 10) break;
          if (seed.slug && !usedSlugs.has(seed.slug)) {
            usedSlugs.add(seed.slug);
            resolvedItems.push(seed as Movie);
          }
        }
        saveCacheToFirebase('hero_banner', { items: resolvedItems, lastUpdated: nowTs });
        saveHeroLS(resolvedItems);
        return resolvedItems;
      }
    }
  } catch {}

  // 4. Ultimate Fallback: High Quality Pre-curated Seed List (all movies -> type movie avoids tv 404)
  const fallbackList = SEED_HERO_POPULAR.map((m) => normalizeMovieItem({ ...(m as any), tmdb: { ...((m as any).tmdb || {}), type: 'movie' } }, 'kkphim'));
  saveCacheToFirebase('hero_banner', { items: fallbackList, lastUpdated: nowTs });
  saveHeroLS(SEED_HERO_POPULAR as any);
  return fallbackList;
}

export function subscribeTmdbHeroPopular(callback: (items: Movie[]) => void): () => void {
  if (!rtdb) return () => {};
  try {
    const heroRef = ref(rtdb, 'system_cache/hero_banner');
    return onValue(heroRef, (snapshot) => {
      if (snapshot.exists()) {
        const cached = snapshot.val();
        if (cached?.items && Array.isArray(cached.items) && cached.items.length >= 8) {
          const items = cached.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
          callback(items);
        }
      }
    }, (err) => {
      console.warn('[RTDB Hero Subscription Error]:', err);
    });
  } catch {
    return () => {};
  }
}

export function subscribeNetflixTop10(
  callback: (data: { movies: Movie[]; tvShows: Movie[]; movieTitles: string[]; tvTitles: string[] }) => void
): () => void {
  if (!rtdb) return () => {};
  try {
    const netflixRef = ref(rtdb, 'system_cache/netflix_top10');
    return onValue(netflixRef, (snapshot) => {
      if (snapshot.exists()) {
        const cached = snapshot.val();
        if (cached?.data?.movies?.length >= 6 || cached?.data?.tvShows?.length >= 6) {
          const rawMovies = cached.data.movies || [];
          const rawTv = cached.data.tvShows || [];
          callback({
            movies: rawMovies.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
            tvShows: rawTv.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
            movieTitles: cached.data.movieTitles || rawMovies.map((m: any) => m.name || m.title || ''),
            tvTitles: cached.data.tvTitles || rawTv.map((m: any) => m.name || m.title || ''),
          });
        }
      }
    }, (err) => {
      console.warn('[RTDB Netflix Top10 Subscription Error]:', err);
    });
  } catch {
    return () => {};
  }
}

export function tmdbTrendingToMovie(item: TmdbTrendingItem): any {
  const year = item.release_date ? Number(item.release_date.slice(0, 4)) : new Date().getFullYear();
  return {
    name: item.title || item.original_title || "Chưa có tên",
    origin_name: item.original_title || item.title || "",
    slug: `tmdb-${item.tmdbId}`,
    content: item.overview || "",
    type: "single",
    status: "completed",
    poster_url: item.posterUrl || item.backdropUrl || "",
    thumb_url: item.posterUrl || item.backdropUrl || "",
    backdrop_url: item.backdropUrl || undefined,
    quality: "FHD",
    lang: "Vietsub",
    year,
    view: Math.round((item.vote_average || 0) * 1000),
    tmdb: { id: item.tmdbId, type: 'movie' },
    source: "kkphim",
    sourceLabel: "TMDB Hot",
  };
}

// Client-side bounded LRU cache to prevent memory buildup
class ClientLRUCache<K, V> {
  private max: number;
  private cache: Map<K, { data: V; time: number }>;

  constructor(max = 300) {
    this.max = max;
    this.cache = new Map();
  }

  get(key: K, ttlMs: number): V | null {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() - item.time > ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // Refresh LRU
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.data;
  }

  set(key: K, data: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.max) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { data, time: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

const cache = new ClientLRUCache<string, any>(300);
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Xóa cache list/detail khi tập enabled đổi (admin toggle nguồn). */
export function invalidateMovieCache(): void {
  try {
    cache.clear();
  } catch {}
}

/**
 * Lưới cuối: loại item thuộc nguồn đã disable khỏi mọi danh sách.
 * Chặn cả 2 đường lọt: cache cũ (trước lúc disable) và server/proxy vẫn trả.
 */
function filterDisabledSources(items: Movie[]): Movie[] {
  try {
    const active = systemApiService.getActiveEndpointsForCategory('movie');
    if (!active || active.length === 0) return items;
    const enabledSet = new Set(active.map((e) => e.id));
    return items.filter((m) => {
      const src = (m as any).source as string | undefined;
      if (!src) return true;
      return enabledSet.has(src);
    });
  } catch {
    return items;
  }
}

function gatedList<T extends { items?: Movie[] }>(p: Promise<T>): Promise<T> {
  return p.then((res) => {
    try {
      if (res && Array.isArray(res.items)) {
        return { ...res, items: filterDisabledSources(res.items || []) };
      }
    } catch {}
    return res;
  });
}

try {
  systemApiService.onEnabledChange(() => {
    try {
      cache.clear();
    } catch {}
  });
} catch {}

const inflight = new Map<string, Promise<any>>();
async function cachedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const cached = cache.get(key, CACHE_TTL);
  if (cached !== null) {
    return cached;
  }
  // Dedupe: nhiều gọi cùng key 1 lúc (home + trending...) chỉ fetch 1 lần
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const result = await fetcher();
      cache.set(key, result);
      return result;
    } catch (err) {
      // If cache had stale data, we can fallback, otherwise rethrow or return empty
      throw err;
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Base Fetcher for each source with safe error catching — respects admin disable toggle
async function fetchKKPhim<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
  if (!isMovieSourceEnabled('kkphim')) return { status: false, items: [], msg: 'KKPhim disabled' } as unknown as T;
  const clean = endpoint.replace(/^\//, '');
  const query = params ? '?' + new URLSearchParams(params as any).toString() : '';

  // 1. Try proxy
  try {
    const res = await fetch(getFullApiUrl(`/api/proxy/kkphim/${clean}${query}`));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.status === true || data.items || data.data?.items || data.movie)) return data;
    }
  } catch {}

  // 2. Try direct
  try {
    const directUrl = `${getKKPhimUrl(clean)}${query}`;
    const res = await fetch(directUrl);
    if (res.ok) {
      return await res.json();
    }
  } catch {}

  return { status: false, items: [], msg: 'KKPhim fetch failed' } as unknown as T;
}

async function fetchOPhim<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
  if (!isMovieSourceEnabled('ophim')) return { status: false, items: [], msg: 'OPhim disabled' } as unknown as T;
  const clean = endpoint.replace(/^\//, '');
  const query = params ? '?' + new URLSearchParams(params as any).toString() : '';

  // 1. Try proxy
  try {
    const res = await fetch(getFullApiUrl(`/api/proxy/ophim/${clean}${query}`));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.status === true || data.status === 'success' || data.items || data.data?.items || data.movie)) return data;
    }
  } catch {}

  // 2. Try direct
  try {
    const directUrl = `${getOPhimUrl(clean)}${query}`;
    const res = await fetch(directUrl);
    if (res.ok) {
      return await res.json();
    }
  } catch {}

  return { status: false, items: [], msg: 'OPhim fetch failed' } as unknown as T;
}

async function fetchNguonC<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
  if (!isMovieSourceEnabled('nguonc')) return { status: 'error', items: [], msg: 'NguonC disabled' } as unknown as T;
  const clean = endpoint.replace(/^\//, '');
  const query = params ? '?' + new URLSearchParams(params as any).toString() : '';

  // 1. Try proxy (server now returns 200 with empty items for 404 genres to avoid console spam)
  try {
    const res = await fetch(getFullApiUrl(`/api/proxy/nguonc/${clean}${query}`));
    if (res.ok) {
      const data = await res.json();
      if (data && (data.status === 'success' || data.status === true || data.items || data.movie)) return data;
    }
  } catch {}

  // 2. Try direct (only for detail, not for list that is known to 404)
  if (clean.includes('phim-chieu-rap') || clean.includes('vien-tuong')) {
    return { status: 'success', items: [], msg: 'NguonC empty genre' } as unknown as T;
  }
  try {
    const directUrl = `${getNguonCUrl(clean)}${query}`;
    const res = await fetch(directUrl);
    if (res.ok) {
      return await res.json();
    }
  } catch {}

  return { status: 'success', items: [], msg: 'NguonC fetch failed' } as unknown as T;
}

export const GENRES = [
  { name: 'Hành Động', slug: 'hanh-dong' },
  { name: 'Tình Cảm', slug: 'tinh-cam' },
  { name: 'Hài Hước', slug: 'hai-huoc' },
  { name: 'Cổ Trang', slug: 'co-trang' },
  { name: 'Tâm Lý', slug: 'tam-ly' },
  { name: 'Hình Sự', slug: 'hinh-su' },
  { name: 'Chiến Tranh', slug: 'chien-tranh' },
  { name: 'Thể Thao', slug: 'the-thao' },
  { name: 'Võ Thuật', slug: 'vo-thuat' },
  { name: 'Viễn Tưởng', slug: 'vien-tuong' },
  { name: 'Phiêu Lưu', slug: 'phieu-luu' },
  { name: 'Khoa Học', slug: 'khoa-hoc' },
  { name: 'Kinh Dị', slug: 'kinh-di' },
  { name: 'Âm Nhạc', slug: 'am-nhac' },
  { name: 'Thần Thoại', slug: 'than-thoai' },
  { name: 'Tài Liệu', slug: 'tai-lieu' },
  { name: 'Gia Đình', slug: 'gia-dinh' },
  { name: 'Bí Ẩn', slug: 'bi-an' },
  { name: 'Học Đường', slug: 'hoc-duong' },
  { name: 'Kinh Điển', slug: 'kinh-dien' },
];

export const COUNTRIES = [
  { name: 'Hàn Quốc', slug: 'han-quoc' },
  { name: 'Trung Quốc', slug: 'trung-quoc' },
  { name: 'Âu Mỹ', slug: 'au-my' },
  { name: 'Nhật Bản', slug: 'nhat-ban' },
  { name: 'Việt Nam', slug: 'viet-nam' },
  { name: 'Thái Lan', slug: 'thai-lan' },
  { name: 'Hồng Kông', slug: 'hong-kong' },
  { name: 'Đài Loan', slug: 'dai-loan' },
  { name: 'Ấn Độ', slug: 'an-do' },
  { name: 'Anh', slug: 'anh' },
  { name: 'Pháp', slug: 'phap' },
];

export const YEARS = Array.from({ length: 15 }, (_, i) => 2026 - i);

// Normalize single movie item
function normalizeMovieItem(raw: any, source: ApiSource = 'kkphim'): Movie {
  const src = raw.source || source;
  const srcLabel = src === 'kkphim' ? 'KKPhim' : src === 'ophim' ? 'OPhim' : 'NguonC';

  const backdrops = Array.isArray((raw as any).backdrops) ? (raw as any).backdrops : undefined;
  const logos = Array.isArray((raw as any).logos) ? (raw as any).logos : undefined;
  const primaryBackdrop = backdrops?.find((b: any) => b.primary)?.url;
  const primaryLogo = logos?.find((l: any) => l.primary)?.url;

  return {
    _id: raw._id || raw.id || raw.slug,
    id: raw.id || raw._id || raw.slug,
    name: raw.name || raw.title || 'Chưa có tên',
    origin_name: raw.origin_name || raw.original_name || raw.name || '',
    slug: raw.slug || '',
    content: raw.content || raw.description || '',
    type: raw.type || 'single',
    status: raw.status || 'completed',
    poster_url: getImageUrl(raw.poster_url || raw.thumb_url, src),
    thumb_url: getImageUrl(raw.thumb_url || raw.poster_url, src),
    backdrop_url: primaryBackdrop || (raw as any).backdrop_url || (raw as any).backdrop || (raw as any).cover_url || undefined,
    logo_url: primaryLogo || (raw as any).logo_url || undefined,
    backdrops,
    logos,
    color_palette: (raw as any).color_palette || undefined,
    tmdb: (raw as any).tmdb || undefined,
    imdb: (raw as any).imdb || undefined,
    is_copyright: raw.is_copyright || false,
    sub_docquyen: raw.sub_docquyen || false,
    chieurap: raw.chieurap || false,
    time: raw.time || raw.total_episodes || '',
    episode_current: raw.episode_current || raw.current_episode || (raw.episodes ? `${raw.episodes.length} tập` : 'Full'),
    episode_total: raw.episode_total || '',
    quality: raw.quality || 'FHD',
    lang: raw.lang || raw.language || 'Vietsub',
    notify: raw.notify || '',
    showtimes: raw.showtimes || '',
    year: raw.year ? Number(raw.year) : new Date().getFullYear(),
    view: raw.view || 0,
    actor: Array.isArray(raw.actor) ? raw.actor : raw.casts ? [raw.casts] : [],
    director: Array.isArray(raw.director) ? raw.director : raw.director ? [raw.director] : [],
    category: Array.isArray(raw.category) ? raw.category : Array.isArray(raw.categories) ? raw.categories : [],
    country: Array.isArray(raw.country) ? raw.country : Array.isArray(raw.countries) ? raw.countries : [],
    created: raw.created ? (typeof raw.created === 'string' ? { time: raw.created } : raw.created) : undefined,
    modified: raw.modified ? (typeof raw.modified === 'string' ? { time: raw.modified } : raw.modified) : undefined,
    source: src,
    sourceLabel: srcLabel,
  };
}

// Normalize movie list format across all API response types
function normalizeMovieList(raw: any, defaultSource: ApiSource = 'kkphim'): MovieListResponse {
  if (!raw) return { status: false, items: [] };

  if (raw?.data?.items && Array.isArray(raw.data.items)) {
    return {
      status: true,
      items: raw.data.items.map((m: any) => normalizeMovieItem(m, defaultSource)),
      pagination: raw.data.params?.pagination || raw.data.pagination,
      titlePage: raw.data.titlePage,
      breadCrumb: raw.data.breadCrumb,
    };
  }

  if (raw?.items && Array.isArray(raw.items)) {
    return {
      status: true,
      items: raw.items.map((m: any) => normalizeMovieItem(m, defaultSource)),
      pagination: raw.paginate
        ? {
            totalItems: raw.paginate.total_items || 0,
            totalItemsPerPage: raw.paginate.items_per_page || 24,
            currentPage: raw.paginate.current_page || 1,
            totalPages: raw.paginate.total_page || 1,
          }
        : raw.pagination,
      titlePage: raw.titlePage || raw.cat?.name || raw.cat?.title,
    };
  }

  return {
    status: false,
    items: [],
  };
}

export const movieApi = {
  // Current active source
  getActiveSource(): ApiSource {
    return getActiveApiSource();
  },

  setSource(source: ApiSource) {
    setActiveApiSource(source);
  },

  // 1. Phim mới cập nhật
  async getNewUpdated(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `new-updated:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('danh-sach/phim-moi-cap-nhat', { page });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>('danh-sach/phim-moi-cap-nhat', { page });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/phim-moi-cap-nhat', { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      // 'all' Mode: Fetch KKPhim + OPhim + NguonC concurrently & merge
      const [kk, op, nc] = await Promise.allSettled([
        fetchKKPhim<any>('danh-sach/phim-moi-cap-nhat', { page }),
        fetchOPhim<any>('danh-sach/phim-moi-cap-nhat', { page }),
        fetchNguonC<any>('films/phim-moi-cap-nhat', { page }),
      ]);

      const kkItems = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opItems = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
      const ncItems = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];

      const map = new Map<string, Movie>();
      // Interleave items from each source for variety
      const maxLen = Math.max(kkItems.length, opItems.length, ncItems.length);
      for (let i = 0; i < maxLen; i++) {
        if (kkItems[i] && !map.has(kkItems[i].slug)) map.set(kkItems[i].slug, kkItems[i]);
        if (opItems[i] && !map.has(opItems[i].slug)) map.set(opItems[i].slug, opItems[i]);
        if (ncItems[i] && !map.has(ncItems[i].slug)) map.set(ncItems[i].slug, ncItems[i]);
      }

      const merged = Array.from(map.values());
      return {
        status: true,
        items: merged,
        pagination: {
          totalItems: merged.length * 20,
          totalItemsPerPage: limit,
          currentPage: page,
          totalPages: 50,
        },
      };
    }));
  },

  // 2. Phim bộ
  async getSeries(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `series:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('v1/api/danh-sach/phim-bo', { page, limit });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>('v1/api/danh-sach/phim-bo', { page, limit });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/danh-sach/phim-bo', { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      // 'all' Mode
      const [kk, op] = await Promise.allSettled([
        fetchKKPhim<any>('v1/api/danh-sach/phim-bo', { page, limit }),
        fetchOPhim<any>('v1/api/danh-sach/phim-bo', { page, limit }),
      ]);
      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];

      const map = new Map<string, Movie>();
      for (const m of [...kkList, ...opList]) {
        if (!map.has(m.slug)) map.set(m.slug, m);
      }

      return {
        status: true,
        items: Array.from(map.values()),
      };
    }));
  },

  // 3. Phim lẻ
  async getSingleMovies(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `single:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('v1/api/danh-sach/phim-le', { page, limit });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>('v1/api/danh-sach/phim-le', { page, limit });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/danh-sach/phim-le', { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      const [kk, op] = await Promise.allSettled([
        fetchKKPhim<any>('v1/api/danh-sach/phim-le', { page, limit }),
        fetchOPhim<any>('v1/api/danh-sach/phim-le', { page, limit }),
      ]);
      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];

      const map = new Map<string, Movie>();
      for (const m of [...kkList, ...opList]) {
        if (!map.has(m.slug)) map.set(m.slug, m);
      }
      return { status: true, items: Array.from(map.values()) };
    }));
  },

  // 4. Hoạt hình / Anime
  async getAnime(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `anime:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('v1/api/danh-sach/hoat-hinh', { page, limit });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>('v1/api/danh-sach/hoat-hinh', { page, limit });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/danh-sach/hoat-hinh', { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      const [kk, op, nc] = await Promise.allSettled([
        fetchKKPhim<any>('v1/api/danh-sach/hoat-hinh', { page, limit }),
        fetchOPhim<any>('v1/api/danh-sach/hoat-hinh', { page, limit }),
        fetchNguonC<any>('films/danh-sach/hoat-hinh', { page }),
      ]);
      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
      const ncList = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];

      const map = new Map<string, Movie>();
      const maxLen = Math.max(kkList.length, opList.length, ncList.length);
      for (let i = 0; i < maxLen; i++) {
        if (kkList[i] && !map.has(kkList[i].slug)) map.set(kkList[i].slug, kkList[i]);
        if (opList[i] && !map.has(opList[i].slug)) map.set(opList[i].slug, opList[i]);
        if (ncList[i] && !map.has(ncList[i].slug)) map.set(ncList[i].slug, ncList[i]);
      }
      
      const merged = Array.from(map.values());
      return {
        status: true,
        items: merged,
        pagination: {
          totalItems: merged.length * 20,
          totalItemsPerPage: limit,
          currentPage: page,
          totalPages: 50,
        }
      };
    }));
  },

  // 5. TV Shows
  async getTvShows(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `tvshows:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('v1/api/danh-sach/tv-shows', { page, limit });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>('v1/api/danh-sach/tv-shows', { page, limit });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/danh-sach/tv-shows', { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      const [kk, op, nc] = await Promise.allSettled([
        fetchKKPhim<any>('v1/api/danh-sach/tv-shows', { page, limit }),
        fetchOPhim<any>('v1/api/danh-sach/tv-shows', { page, limit }),
        fetchNguonC<any>('films/danh-sach/tv-shows', { page }),
      ]);
      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
      const ncList = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];

      const map = new Map<string, Movie>();
      const maxLen = Math.max(kkList.length, opList.length, ncList.length);
      for (let i = 0; i < maxLen; i++) {
        if (kkList[i] && !map.has(kkList[i].slug)) map.set(kkList[i].slug, kkList[i]);
        if (opList[i] && !map.has(opList[i].slug)) map.set(opList[i].slug, opList[i]);
        if (ncList[i] && !map.has(ncList[i].slug)) map.set(ncList[i].slug, ncList[i]);
      }
      
      const merged = Array.from(map.values());
      return {
        status: true,
        items: merged,
        pagination: {
          totalItems: merged.length * 20,
          totalItemsPerPage: limit,
          currentPage: page,
          totalPages: 50,
        }
      };
    }));
  },

  // 6. Lọc theo Thể loại
  async getByGenre(genreSlug: string, page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `genre:${genreSlug}:${source}:${page}:${limit}`;

    // Aliases for genres that have different slugs across providers (e.g. vien-tuong vs khoa-hoc-vien-tuong)
    const genreAliases: Record<string, string[]> = {
      'vien-tuong': ['vien-tuong', 'khoa-hoc-vien-tuong', 'khoa-hoc', 'phieu-luu'],
      'khoa-hoc': ['khoa-hoc', 'khoa-hoc-vien-tuong', 'vien-tuong'],
      'phieu-luu': ['phieu-luu', 'vien-tuong', 'hanh-dong'],
      'tinh-cam': ['tinh-cam', 'tam-ly', 'lang-man'],
      'kinh-di': ['kinh-di', 'bi-an', 'ma'],
      'hanh-dong': ['hanh-dong', 'vo-thuat'],
    };

    return gatedList(cachedFetch(cacheKey, async () => {
      const slugsToTry = genreAliases[genreSlug] || [genreSlug];

      for (const currentSlug of slugsToTry) {
        if (source === 'kkphim') {
          const raw = await fetchKKPhim<any>(`v1/api/the-loai/${currentSlug}`, { page, limit });
          const res = normalizeMovieList(raw, 'kkphim');
          if (res.items.length > 0) return res;
        } else if (source === 'ophim') {
          const raw = await fetchOPhim<any>(`v1/api/the-loai/${currentSlug}`, { page, limit });
          const res = normalizeMovieList(raw, 'ophim');
          if (res.items.length > 0) return res;
        } else if (source === 'nguonc') {
          const raw = await fetchNguonC<any>(`films/the-loai/${currentSlug}`, { page });
          const res = normalizeMovieList(raw, 'nguonc');
          if (res.items.length > 0) return res;
        } else {
          // 'all' Mode
          const [kk, op, nc] = await Promise.allSettled([
            fetchKKPhim<any>(`v1/api/the-loai/${currentSlug}`, { page, limit }),
            fetchOPhim<any>(`v1/api/the-loai/${currentSlug}`, { page, limit }),
            fetchNguonC<any>(`films/the-loai/${currentSlug}`, { page }),
          ]);
          const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
          const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
          const ncList = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];
          const map = new Map<string, Movie>();
          for (const m of [...kkList, ...opList, ...ncList]) {
            if (!map.has(m.slug)) map.set(m.slug, m);
          }
          if (map.size > 0) {
            return { status: true, items: Array.from(map.values()) };
          }
        }
      }

      return { status: true, items: [] };
    }));
  },

  // 7. Lọc theo Quốc gia
  async getByCountry(countrySlug: string, page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `country:${countrySlug}:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>(`v1/api/quoc-gia/${countrySlug}`, { page, limit });
        return normalizeMovieList(raw, 'kkphim');
      }
      if (source === 'ophim') {
        const raw = await fetchOPhim<any>(`v1/api/quoc-gia/${countrySlug}`, { page, limit });
        return normalizeMovieList(raw, 'ophim');
      }
      if (source === 'nguonc') {
        const raw = await fetchNguonC<any>(`films/quoc-gia/${countrySlug}`, { page });
        return normalizeMovieList(raw, 'nguonc');
      }

      const [kk, op] = await Promise.allSettled([
        fetchKKPhim<any>(`v1/api/quoc-gia/${countrySlug}`, { page, limit }),
        fetchOPhim<any>(`v1/api/quoc-gia/${countrySlug}`, { page, limit }),
      ]);
      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
      const map = new Map<string, Movie>();
      for (const m of [...kkList, ...opList]) {
        if (!map.has(m.slug)) map.set(m.slug, m);
      }
      return { status: true, items: Array.from(map.values()) };
    }));
  },

  // 8. Tìm kiếm đa nguồn & Diễn viên thông minh (Smart Multi-Source & Cast Search)
  async search(keyword: string, page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    if (!keyword.trim()) return { status: true, items: [] };
    const kw = keyword.trim();
    let source = sourceOverride || getActiveApiSource();
    // Nếu nguồn được chọn đã bị admin disable, tự động fallback về 'all' (đã lọc)
    if (source !== 'all' && !isMovieSourceEnabled(source)) {
      source = 'all';
    }
    const cacheKey = `search:${kw}:${source}:${page}:${limit}`;

    const applyEnabledFilter = (items: Movie[]): Movie[] => {
      try {
        const active = systemApiService.getActiveEndpointsForCategory('movie');
        if (!active || active.length === 0) return items;
        const enabledSet = new Set(active.map((e) => e.id));
        return items.filter((m) => {
          const src = (m as any).source as string | undefined;
          if (!src) return true;
          return enabledSet.has(src);
        });
      } catch {
        return items;
      }
    };

    const rawResult = await cachedFetch(cacheKey, async () => {
      // If a specific source is selected, try it first
      if (source !== 'all') {
        let singleResult: MovieListResponse | null = null;
        try {
          if (source === 'kkphim') {
            const raw = await fetchKKPhim<any>('v1/api/tim-kiem', { keyword: kw, page, limit });
            singleResult = normalizeMovieList(raw, 'kkphim');
          } else if (source === 'ophim') {
            const raw = await fetchOPhim<any>('v1/api/tim-kiem', { keyword: kw, page, limit });
            singleResult = normalizeMovieList(raw, 'ophim');
          } else if (source === 'nguonc') {
            const raw = await fetchNguonC<any>('films/search', { keyword: kw, page });
            singleResult = normalizeMovieList(raw, 'nguonc');
          }
        } catch {}

        // If specific source found items, return it!
        if (singleResult && singleResult.items && singleResult.items.length > 0) {
          return singleResult;
        }
        // If 0 items were found (common when searching for actors/directors because upstream only indexes titles),
        // seamlessly fallback to our Smart Actor/Multi-source search below!
      }

      // Smart Aggregator & Cast Search via server proxy
      try {
        const res = await fetch(getFullApiUrl(`/api/proxy/search-all?keyword=${encodeURIComponent(kw)}`));
        if (res.ok) {
          const payload = await res.json();
          if (payload?.items && Array.isArray(payload.items) && payload.items.length > 0) {
            let filtered = payload.items;
            if (source !== 'all') {
              const bySource = payload.items.filter((m: any) => m.source === source);
              if (bySource.length > 0) filtered = bySource;
            }
            return {
              status: true,
              items: filtered.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
              pagination: {
                totalItems: filtered.length,
                totalItemsPerPage: limit,
                currentPage: 1,
                totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
              },
            };
          }
        }
      } catch {}

      // Fallback: parallel client search across all sources
      const [kk, op, nc] = await Promise.allSettled([
        fetchKKPhim<any>('v1/api/tim-kiem', { keyword: kw, limit: 16 }),
        fetchOPhim<any>('v1/api/tim-kiem', { keyword: kw, limit: 16 }),
        fetchNguonC<any>('films/search', { keyword: kw }),
      ]);

      const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
      const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
      const ncList = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];

      const map = new Map<string, Movie>();
      for (const m of [...kkList, ...opList, ...ncList]) {
        if (!map.has(m.slug)) map.set(m.slug, m);
      }

      const merged = Array.from(map.values());
      return {
        status: true,
        items: merged,
        pagination: {
          totalItems: merged.length,
          totalItemsPerPage: limit,
          currentPage: 1,
          totalPages: Math.max(1, Math.ceil(merged.length / limit)),
        },
      };
    });

    // Hậu xử lý: luôn lọc bỏ các nguồn đã bị disable (quan trọng khi cache hit hoặc server vẫn trả về ophim)
    if (rawResult && Array.isArray((rawResult as any).items)) {
      const filteredItems = applyEnabledFilter((rawResult as any).items);
      // Nếu đang filter theo source cụ thể mà sau khi lọc disabled còn rỗng, giữ nguyên để tránh mất kết quả actor fallback
      if (filteredItems.length !== (rawResult as any).items.length) {
        return {
          ...(rawResult as any),
          items: filteredItems,
          pagination: {
            totalItems: filteredItems.length,
            totalItemsPerPage: limit,
            currentPage: 1,
            totalPages: Math.max(1, Math.ceil(filteredItems.length / limit)),
          },
        };
      }
    }
    return rawResult;
  },

  // 9. Top Trending (Movies with most views) - ưu tiên view cao + năm mới như chophim
  /** Xếp top theo lượt xem (dùng chung cho trending + các hàng). */
  sortByPopularity(items: Movie[], limit: number): Movie[] {
    const uniqueItems = items.filter((m, index, self) => self.findIndex(t => t.slug === m.slug) === index);
    const sorted = [...uniqueItems].sort((a, b) => {
      const viewDiff = (b.view || 0) - (a.view || 0);
      if (viewDiff !== 0) return viewDiff;
      if ((b as any).chieurap && !(a as any).chieurap) return 1;
      if ((a as any).chieurap && !(b as any).chieurap) return -1;
      const yearDiff = (b.year || 0) - (a.year || 0);
      if (yearDiff !== 0) return yearDiff;
      return 0;
    });
    return sorted.slice(0, limit);
  },

  async getTrending(limit = 10, type?: 'series' | 'single'): Promise<MovieListResponse> {
    const source = getActiveApiSource();
    const cacheKey = `trending:${source}:${limit}:${type || 'all'}`;

    return cachedFetch(cacheKey, async () => {
      // TÁI DÙNG cache của getSeries/getSingleMovies/getNewUpdated (home đã fetch):
      // chỉ lấy top theo view, không fetch 3 trang riêng nữa.
      const collect = (v: any): Movie[] => (v && v.items && v.items.length ? v.items : []);
      let items: Movie[] = [];
      if (type === 'series') {
        const res = await this.getSeries(1, 24).catch(() => null);
        items = collect(res);
      } else if (type === 'single') {
        const res = await this.getSingleMovies(1, 24).catch(() => null);
        items = collect(res);
      } else {
        const [nu, th] = await Promise.allSettled([
          this.getNewUpdated(1, 24),
          this.getTheaterMovies(1, 12),
        ]);
        if (nu.status === 'fulfilled') items = [...items, ...collect(nu.value)];
        if (th.status === 'fulfilled') items = [...items, ...collect(th.value)];
      }

      if (items.length === 0) {
        const fallback = await this.getNewUpdated(1, limit + 4).catch(() => null);
        if (fallback?.items?.length) {
          return { status: true, items: fallback.items.slice(0, limit) };
        }
        return { status: false, items: [] };
      }

      return {
        status: true,
        items: this.sortByPopularity(items, limit),
      };
    });
  },

  // 10. Phim Chiếu Rạp
  async getTheaterMovies(page = 1, limit = 24, sourceOverride?: ApiSource): Promise<MovieListResponse> {
    const source = sourceOverride || getActiveApiSource();
    const cacheKey = `theater:${source}:${page}:${limit}`;

    return gatedList(cachedFetch(cacheKey, async () => {
      let items: Movie[] = [];

      if (source === 'kkphim') {
        const raw = await fetchKKPhim<any>('v1/api/danh-sach/phim-chieu-rap', { page, limit });
        const res = normalizeMovieList(raw, 'kkphim');
        if (res.items.length > 0) items = res.items;
      } else if (source === 'ophim') {
        const raw = await fetchOPhim<any>('v1/api/danh-sach/phim-chieu-rap', { page, limit });
        const res = normalizeMovieList(raw, 'ophim');
        if (res.items.length > 0) items = res.items;
      } else if (source === 'nguonc') {
        const raw = await fetchNguonC<any>('films/danh-sach/phim-chieu-rap', { page });
        const res = normalizeMovieList(raw, 'nguonc');
        if (res.items.length > 0) items = res.items;
      } else {
        const [kk, op, nc] = await Promise.allSettled([
          fetchKKPhim<any>('v1/api/danh-sach/phim-chieu-rap', { page, limit }),
          fetchOPhim<any>('v1/api/danh-sach/phim-chieu-rap', { page, limit }),
          fetchNguonC<any>('films/danh-sach/phim-chieu-rap', { page }),
        ]);
        const kkList = kk.status === 'fulfilled' ? normalizeMovieList(kk.value, 'kkphim').items : [];
        const opList = op.status === 'fulfilled' ? normalizeMovieList(op.value, 'ophim').items : [];
        const ncList = nc.status === 'fulfilled' ? normalizeMovieList(nc.value, 'nguonc').items : [];
        const map = new Map<string, Movie>();
        for (const m of [...kkList, ...opList, ...ncList]) {
          if (!map.has(m.slug)) map.set(m.slug, m);
        }
        items = Array.from(map.values());
      }

      // Robust fallback if upstream phim-chieu-rap endpoint returns empty
      if (items.length === 0) {
        const [singleRes, actionRes] = await Promise.allSettled([
          this.getSingleMovies(page, limit, sourceOverride),
          this.getByGenre('hanh-dong', page, limit, sourceOverride),
        ]);
        const sItems = singleRes.status === 'fulfilled' ? singleRes.value.items : [];
        const aItems = actionRes.status === 'fulfilled' ? actionRes.value.items : [];
        const combined = [...sItems, ...aItems];
        const theaterMatches = combined.filter((m) => m.chieurap);
        if (theaterMatches.length >= 4) {
          items = theaterMatches.slice(0, limit);
        } else if (sItems.length > 0) {
          items = sItems.slice(0, limit);
        }
      }

      return { status: true, items: items.slice(0, limit) };
    }));
  },

  // 11. Chi tiết phim + Danh sách tập (Hỗ trợ đổi nguồn & gộp Server phát).
  // Race các nguồn, thằng nào PLAYABLE trước (có tập + link m3u8) thì thắng —
  // không phải thằng HTTP về trước. Enrich TMDB tách ra cho caller tự làm nền
  // (MovieDetailModal đã gọi getTmdbAssets riêng) để khỏi chặn render modal.
  parseDetailData(data: any, detectedSource: ApiSource): { movie: Movie; episodes: EpisodeServer[]; msg: string } | null {
    if (!data || (!data.status && !data.movie)) return null;
    const rawMovie = data.movie || data;
    if (!rawMovie || typeof rawMovie !== 'object') return null;
    const movie = normalizeMovieItem(rawMovie, detectedSource);
    const rawEpisodes = data.episodes || rawMovie.episodes || [];
    let episodes: EpisodeServer[] = Array.isArray(rawEpisodes)
      ? rawEpisodes.map((s: any) => {
          const serverName = s.server_name || s.name || 'Server Vietsub';
          const items = s.server_data || s.items || [];
          return {
            server_name: serverName,
            source: detectedSource,
            server_data: Array.isArray(items)
              ? items.map((ep: any) => ({
                  name: String(ep.name || ep.episode_name || '1'),
                  slug: String(ep.slug || ep.episode_slug || ep.name || '1'),
                  filename: ep.filename || movie.name,
                  link_embed: ep.link_embed || ep.embed || '',
                  link_m3u8: ep.link_m3u8 || ep.m3u8 || ep.link_embed || '',
                }))
              : [],
          };
        })
      : [];
    // Sort: TM (thuyết minh sạch) > SN (song ngữ) > LT > PD (thường dính watermark/qc)
    const score = (name: string) => {
      const n = String(name || '').toLowerCase();
      if (n.includes('tm') || n.includes('thuyet minh')) return 0;
      if (n.includes('sn') || n.includes('song ngu')) return 1;
      if (n.includes('lt') || n.includes('long tieng')) return 2;
      if (n.includes('pd') || n.includes('phu de')) return 3;
      if (n.includes('vietsub')) return 4;
      return 5;
    };
    episodes = episodes.sort((a, b) => score(a.server_name) - score(b.server_name));
    return { movie: { ...movie, episodes }, episodes, msg: data.msg || 'done' };
  },

  hasPlayableEpisodes(episodes: EpisodeServer[]): boolean {
    try {
      return episodes.some((s) =>
        (s.server_data || []).some((ep) => !!(ep.link_m3u8 || ep.link_embed)),
      );
    } catch {
      return false;
    }
  },

  // Nguồn HLS thật (có link m3u8) — player chính GauPlayer chỉ phát được HLS.
  // Nguồn embed-only (vd NguonC chỉ trả `embed`, không có `m3u8`) vẫn xem được
  // qua iframe nhưng chất lượng/khả năng tua kém hơn nên chỉ làm fallback.
  hasM3u8Episodes(episodes: EpisodeServer[]): boolean {
    try {
      return episodes.some((s) =>
        (s.server_data || []).some((ep) => !!ep.link_m3u8),
      );
    } catch {
      return false;
    }
  },

  async getMovieDetail(slug: string, preferredSource?: ApiSource): Promise<MovieDetailResponse> {
    if (!slug) throw new Error('Mã phim không hợp lệ');
    const cacheKey = `detail:${slug}:${preferredSource || 'any'}`;

    return cachedFetch(cacheKey, async () => {
      type Src = ApiSource | 'proxy';
      const sources: Src[] =
        preferredSource && preferredSource !== 'all'
          ? [preferredSource]
          : (['kkphim', 'ophim', 'nguonc'] as ApiSource[]);
      const fetchOne = async (src: Src): Promise<any> => {
        try {
          if (src === 'kkphim') return await fetchKKPhim<any>(`phim/${slug}`);
          if (src === 'ophim') return await fetchOPhim<any>(`phim/${slug}`);
          if (src === 'nguonc') return await fetchNguonC<any>(`film/${slug}`);
          const res = await fetch(getFullApiUrl(`/api/proxy/movie/phim/${slug}`));
          if (res.ok) return await res.json();
        } catch {}
        return null;
      };
      // Race: ưu tiên nguồn có M3U8 thật (player chính phát HLS).
      // Nguồn embed-only (vd NguonC) về trước cũng chỉ giữ làm fallback.
      // Bound 2.5s: quá hạn mà có fallback thì phát ngay (perceived performance),
      // khỏi đợi nguồn chậm — M3U8 thường về trong <2.5s nên ít khi rớt vào nhánh này.
      // Giữ lại nguồn đầu có movie để fallback nếu không thằng nào playable.
      const pending = new Map<number, Promise<{ i: number; data: any }>>();
      const allSources: Src[] = [...sources, 'proxy'];
      allSources.forEach((src, i) => {
        pending.set(
          i,
          fetchOne(src)
            .then((data) => ({ i, data }))
            .catch(() => ({ i, data: null })),
        );
      });
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const fallbackTimeout = new Promise<null>((res) => {
        fallbackTimer = setTimeout(() => res(null), 2500);
      });
      const clearFallbackTimer = () => {
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      };
      let fallback: { movie: Movie; episodes: EpisodeServer[]; msg: string } | null = null;
      let timerArmed = true;
      const toResult = (p: { movie: Movie; episodes: EpisodeServer[]; msg: string }) => {
        clearFallbackTimer();
        return { status: true as const, msg: p.msg, movie: p.movie, episodes: p.episodes };
      };
      while (pending.size > 0) {
        const racers: Promise<{ i: number; data: any } | null>[] = [...pending.values()];
        if (timerArmed) racers.push(fallbackTimeout);
        const res = await Promise.race(racers);
        if (!res) {
          // Hết 2.5s: có fallback thì phát ngay, chưa có gì thì đợi tiếp
          timerArmed = false;
          if (fallback) return toResult(fallback);
          continue;
        }
        const { i, data } = res;
        pending.delete(i);
        const src = allSources[i];
        const parsed = this.parseDetailData(data, (src === 'proxy' ? 'kkphim' : src) as ApiSource);
        if (!parsed) continue;
        if (this.hasM3u8Episodes(parsed.episodes)) {
          return toResult(parsed);
        }
        if (this.hasPlayableEpisodes(parsed.episodes)) {
          if (!fallback) fallback = parsed;
          continue;
        }
        if (!fallback) fallback = parsed;
      }
      clearFallbackTimer();
      if (fallback) {
        return { status: true, msg: fallback.msg, movie: fallback.movie, episodes: fallback.episodes };
      }
      throw new Error('Không thể tải thông tin chi tiết phim từ các nguồn Vietsub');
    });
  },

  // 12. Hero Popular TMDB (en-US, region VN) - validated có trong API phim hiện tại
  async getTmdbHeroPopular(): Promise<Movie[]> {
    return getTmdbHeroPopular();
  },

  subscribeTmdbHeroPopular(callback: (items: Movie[]) => void): () => void {
    return subscribeTmdbHeroPopular(callback);
  },

  subscribeNetflixTop10(
    callback: (data: { movies: Movie[]; tvShows: Movie[]; movieTitles: string[]; tvTitles: string[] }) => void
  ): () => void {
    return subscribeNetflixTop10(callback);
  },

  // 13. Netflix Vietnam Top 10 API - Đọc trực tiếp từ RTDB / Firebase để luôn mới nhất
  // TV perf: bọc cache + dedupe inflight (trước đây đọc Firebase mỗi lần,
  // remount Home là fetch lại).
  async getNetflixTop10VN(): Promise<{ movies: Movie[]; tvShows: Movie[]; movieTitles: string[]; tvTitles: string[] }> {
    return cachedFetch('netflixTop10VN', () => this.loadNetflixTop10VN());
  },
  async loadNetflixTop10VN(): Promise<{ movies: Movie[]; tvShows: Movie[]; movieTitles: string[]; tvTitles: string[] }> {
    const nowTs = Date.now();

    // 1. Đọc trực tiếp từ RTDB (Primary Database)
    try {
      const rtdbJson = await readCacheFromFirebase('netflix_top10');
      if (rtdbJson?.data?.movies?.length >= 6 || rtdbJson?.data?.tvShows?.length >= 6) {
        const rawMovies = rtdbJson.data.movies || [];
        const rawTv = rtdbJson.data.tvShows || [];
        const result = {
          movies: rawMovies.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
          tvShows: rawTv.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
          movieTitles: rtdbJson.data.movieTitles || rawMovies.map((m: any) => m.name || m.title || ''),
          tvTitles: rtdbJson.data.tvTitles || rawTv.map((m: any) => m.name || m.title || ''),
        };
        return result;
      }
    } catch (err) {
      console.warn('[Firebase Netflix Top10 Read Error]:', err);
    }

    // 2. Thử gọi backend endpoint
    try {
      const fullUrl = getFullApiUrl(`/api/top10/netflix-vn?t=${nowTs}`);
      const isLocalhostApk = typeof window !== 'undefined' && window.location.hostname === 'localhost' && !fullUrl.startsWith('http');
      if (!isLocalhostApk) {
        const json = await safeFetchJson<{ status?: boolean; data?: any }>(fullUrl, { cache: 'no-store' as RequestCache }, 4000);
        if (json?.data?.movies?.length >= 6 || json?.data?.tvShows?.length >= 6) {
          const rawMovies = json.data.movies || [];
          const rawTv = json.data.tvShows || [];
          const result = {
            movies: rawMovies.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
            tvShows: rawTv.map((m: any) => normalizeMovieItem(m, m.source || 'kkphim')),
            movieTitles: json.data.movieTitles || rawMovies.map((m: any) => m.name || m.title || ''),
            tvTitles: json.data.tvTitles || rawTv.map((m: any) => m.name || m.title || ''),
          };
          saveCacheToFirebase('netflix_top10', { status: true, data: json.data, lastUpdated: nowTs });
          return result;
        }
      }
    } catch {}

    // 3. Fallback máy khách (Client-side Seed Data cho APK khi không có backend server)
    const seedMovies = [
      { slug: "anora", name: "Anora", origin_name: "Anora", poster_url: "uploads/movies/202410/anora-thumb.jpg", thumb_url: "uploads/movies/202410/anora-poster.jpg", year: 2024, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "2012", name: "2012", origin_name: "2012", poster_url: "uploads/movies/202203/2012-thumb.jpg", thumb_url: "uploads/movies/202203/2012-poster.jpg", year: 2009, quality: "FHD", lang: "Thuyết Minh", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "safe", name: "Safe", origin_name: "Safe", poster_url: "uploads/movies/202204/safe-thumb.jpg", thumb_url: "uploads/movies/202204/safe-poster.jpg", year: 2012, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "oceans-eleven", name: "11 Tên Cướp Thế Kỷ", origin_name: "Ocean's Eleven", poster_url: "uploads/movies/202205/oceans-eleven-thumb.jpg", thumb_url: "uploads/movies/202205/oceans-eleven-poster.jpg", year: 2001, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "wolf-man", name: "Người Sói", origin_name: "Wolf Man", poster_url: "uploads/movies/202501/wolf-man-thumb.jpg", thumb_url: "uploads/movies/202501/wolf-man-poster.jpg", year: 2025, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "the-magnificent-seven", name: "Bảy Tay Súng Huyền Thoại", origin_name: "The Magnificent Seven", poster_url: "uploads/movies/202204/the-magnificent-seven-thumb.jpg", thumb_url: "uploads/movies/202204/the-magnificent-seven-poster.jpg", year: 2016, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "gohan", name: "Bảy Viên Ngọc Rồng: Siêu Anh Hùng", origin_name: "Dragon Ball Super: Super Hero", poster_url: "uploads/movies/202208/dragon-ball-super-super-hero-thumb.jpg", thumb_url: "uploads/movies/202208/dragon-ball-super-super-hero-poster.jpg", year: 2022, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "the-whisper-man", name: "Người Thì Thầm", origin_name: "The Whisper Man", poster_url: "uploads/movies/202411/the-whisper-man-thumb.jpg", thumb_url: "uploads/movies/202411/the-whisper-man-poster.jpg", year: 2024, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "tho-oi", name: "Thỏ Ơi!!", origin_name: "Bunny!!", poster_url: "https://phimimg.com/upload/vod/20260601-1/034afe4d9f1198904977bb7cd8297a56.jpg", thumb_url: "https://phimimg.com/upload/vod/20260601-1/a93bfd52980655de0571d55d9c9f2440.jpg", year: 2026, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
      { slug: "red-notice", name: "Lệnh Truy Nã Đỏ", origin_name: "Red Notice", poster_url: "uploads/movies/202111/lenh-truy-na-do-thumb.jpg", thumb_url: "uploads/movies/202111/lenh-truy-na-do-poster.jpg", year: 2021, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "single", status: "completed" },
    ];

    const seedTv = [
      { slug: "agent-kim-reactivated", name: "Đặc Vụ Kim Tái Xuất", origin_name: "Agent Kim Reactivated", poster_url: "uploads/movies/202501/agent-kim-thumb.jpg", thumb_url: "uploads/movies/202501/agent-kim-poster.jpg", year: 2025, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "ongoing" },
      { slug: "spooky-in-love", name: "Yêu Em Ma Quỷ", origin_name: "Spooky in Love", poster_url: "uploads/movies/202501/spooky-in-love-thumb.jpg", thumb_url: "uploads/movies/202501/spooky-in-love-poster.jpg", year: 2025, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "ongoing" },
      { slug: "mousetrap", name: "Bẫy Chuột", origin_name: "Mousetrap", poster_url: "uploads/movies/202412/mousetrap-thumb.jpg", thumb_url: "uploads/movies/202412/mousetrap-poster.jpg", year: 2024, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
      { slug: "the-early-spring", name: "Đầu Xuân", origin_name: "The Early Spring", poster_url: "uploads/movies/202501/the-early-spring-thumb.jpg", thumb_url: "uploads/movies/202501/the-early-spring-poster.jpg", year: 2025, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
      { slug: "our-sticky-love", name: "Tình Yêu Gắn Kết", origin_name: "Our Sticky Love", poster_url: "uploads/movies/202501/our-sticky-love-thumb.jpg", thumb_url: "uploads/movies/202501/our-sticky-love-poster.jpg", year: 2025, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "ongoing" },
      { slug: "the-east-palace", name: "Đông Cung", origin_name: "The East Palace", poster_url: "uploads/movies/202411/the-east-palace-thumb.jpg", thumb_url: "uploads/movies/202411/the-east-palace-poster.jpg", year: 2024, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
      { slug: "can-this-love-be-translated", name: "Tình Yêu Này Có Thể Dịch Không?", origin_name: "Can This Love Be Translated?", poster_url: "uploads/movies/202501/can-this-love-be-translated-thumb.jpg", thumb_url: "uploads/movies/202501/can-this-love-be-translated-poster.jpg", year: 2025, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "ongoing" },
      { slug: "teach-you-a-lesson", name: "Dạy Cho Bài Học", origin_name: "Teach You a Lesson", poster_url: "uploads/movies/202412/teach-you-a-lesson-thumb.jpg", thumb_url: "uploads/movies/202412/teach-you-a-lesson-poster.jpg", year: 2024, quality: "HD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
      { slug: "squid-game-season-2", name: "Trò Chơi Con Mực: Mùa 2", origin_name: "Squid Game: Season 2", poster_url: "uploads/movies/202412/squid-game-season-2-thumb.jpg", thumb_url: "uploads/movies/202412/squid-game-season-2-poster.jpg", year: 2024, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
      { slug: "sweet-home-season-3", name: "Thế Giới Ma Quái: Mùa 3", origin_name: "Sweet Home: Season 3", poster_url: "uploads/movies/202407/sweet-home-season-3-thumb.jpg", thumb_url: "uploads/movies/202407/sweet-home-season-3-poster.jpg", year: 2024, quality: "FHD", lang: "Vietsub", source: "kkphim", sourceLabel: "Netflix", type: "series", status: "completed" },
    ];

    const fallbackResult = {
      movies: seedMovies.map((m: any) => normalizeMovieItem(m, 'kkphim')),
      tvShows: seedTv.map((m: any) => normalizeMovieItem(m, 'kkphim')),
      movieTitles: seedMovies.map((m) => m.name),
      tvTitles: seedTv.map((t) => t.name),
    };

    // QUAN TRỌNG: KHÔNG ghi seed fallback vào Firebase. Seed chỉ để hiển thị
    // tạm trong bộ nhớ — nếu ghi vào RTDB sẽ ghi đè dữ liệu Batch thật của
    // server khác, gây sai thứ tự + ảnh hỏng cho toàn bộ client khác.
    return fallbackResult;
  },
};

export async function getHeroAdminList(): Promise<{ success: boolean; items: Movie[]; total?: number; lastUpdated?: number }> {
  // 1. Try Firebase first
  try {
    const val = await readCacheFromFirebase('hero_banner');
    if (val?.items && Array.isArray(val.items)) {
      const items = val.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
      return { success: true, items, total: items.length, lastUpdated: val.lastUpdated };
    }
  } catch {}

  // 2. Try backend endpoint
  try {
    const fullUrl = getFullApiUrl("/api/hero/admin/list");
    const res = await safeFetchJson<{ success: boolean; items: any[]; total: number; lastUpdated: number }>(fullUrl, {}, 4000);
    if (res?.items && Array.isArray(res.items)) {
      const items = res.items.map((m: any) => normalizeMovieItem(m, (m.source as ApiSource) || 'kkphim'));
      return { success: true, items, total: res.total, lastUpdated: res.lastUpdated };
    }
  } catch {}

  return { success: false, items: [] };
}

export async function selectHeroAsset(
  slug: string,
  assetType: 'backdrop' | 'logo',
  selectedUrl: string
): Promise<{ success: boolean; message?: string; movie?: Movie; error?: string }> {
  try {
    let updatedMovie: Movie | null = null;
    let fullPayload: any = null;

    // 1. Read existing hero banner data from Firebase (Firestore / RTDB)
    try {
      fullPayload = await readCacheFromFirebase('hero_banner');
    } catch (e) {
      console.warn('[selectHeroAsset Firebase get error]:', e);
    }

    // 2. If Firebase didn't have payload yet, get admin list from server
    if (!fullPayload || !Array.isArray(fullPayload.items)) {
      const adminList = await getHeroAdminList();
      if (adminList.success && adminList.items.length > 0) {
        fullPayload = { items: adminList.items, lastUpdated: Date.now() };
      }
    }

    if (fullPayload && Array.isArray(fullPayload.items)) {
      const target = fullPayload.items.find((m: any) => m.slug === slug);
      if (target) {
        if (assetType === 'backdrop') {
          target.backdrop_url = selectedUrl;
          if (Array.isArray(target.backdrops)) {
            let found = false;
            target.backdrops = target.backdrops.map((b: any) => {
              const isMatch = b.url === selectedUrl;
              if (isMatch) found = true;
              return { ...b, primary: isMatch };
            });
            if (!found) {
              target.backdrops.unshift({ url: selectedUrl, primary: true });
            }
          } else {
            target.backdrops = [{ url: selectedUrl, primary: true }];
          }
        } else if (assetType === 'logo') {
          target.logo_url = selectedUrl;
          if (Array.isArray(target.logos)) {
            let found = false;
            target.logos = target.logos.map((l: any) => {
              const isMatch = l.url === selectedUrl;
              if (isMatch) found = true;
              return { ...l, primary: isMatch };
            });
            if (!found) {
              target.logos.unshift({ url: selectedUrl, primary: true });
            }
          } else {
            target.logos = [{ url: selectedUrl, primary: true }];
          }
        }

        fullPayload.lastUpdated = Date.now();
        updatedMovie = normalizeMovieItem(target, target.source || 'kkphim');

        // 3. Save directly to Firebase (Firestore + RTDB)
        await saveCacheToFirebase('hero_banner', fullPayload);
        
        // Save to individual movie override in Firebase
        const overrideItem = {
          slug: target.slug,
          name: target.name,
          logo_url: target.logo_url,
          backdrop_url: target.backdrop_url,
          logos: target.logos,
          backdrops: target.backdrops,
          lastUpdated: Date.now(),
        };
        await saveCacheToFirebase(`movie_overrides/${slug}`, overrideItem);
      }
    }

    // Also notify server endpoint to update memory cache
    try {
      const fullUrl = getFullApiUrl("/api/hero/select-asset");
      await fetch(fullUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, assetType, selectedUrl }),
      });
    } catch {}

    if (updatedMovie) {
      clientTmdbHeroCache = null;
      clearTmdbAssetsCache();
      return { success: true, message: `Đã đổi ${assetType} và lưu vào Firebase thành công!`, movie: updatedMovie };
    }

    return { success: false, error: "Không tìm thấy phim để cập nhật trong Firebase" };
  } catch (err: any) {
    return { success: false, error: err?.message || "Lỗi kết nối máy chủ" };
  }
}
