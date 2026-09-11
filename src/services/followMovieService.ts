import { Movie } from '../types';
import { movieApi } from './movieApi';

export interface FollowedMovie {
  slug: string;
  name: string;
  origin_name: string;
  thumb_url: string;
  poster_url: string;
  year?: number;
  quality?: string;
  lang?: string;
  episode_current?: string;
  // snapshot when followed
  followedAt: number;
  lastKnownEpisode: string; // e.g. "Tập 12" or "12"
  lastKnownTotal?: string;
  hasNewEpisode: boolean;
  latestEpisode?: string;
  lastCheckedAt: number;
  movieSnapshot?: Movie;
}

function getKey(accountId: string, profileId: string): string {
  return `gau_follow_${accountId}_${profileId}`;
}

function safeParse(raw: string | null): FollowedMovie[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function loadRaw(accountId: string, profileId: string): FollowedMovie[] {
  try { return safeParse(localStorage.getItem(getKey(accountId, profileId))); } catch { return []; }
}
function saveRaw(accountId: string, profileId: string, list: FollowedMovie[]) {
  try {
    localStorage.setItem(getKey(accountId, profileId), JSON.stringify(list));
    window.dispatchEvent(new CustomEvent('gau_follow_changed', { detail: { accountId, profileId } }));
  } catch {}
}

// Parse episode number from string like "Tập 12", "12", "Full 12/24", "Tập 12/24"
function parseEpisodeCount(epStr?: string): number | null {
  if (!epStr) return null;
  const m = epStr.match(/(\d+)\s*(?:\/\s*\d+)?\s*$/);
  if (m) return parseInt(m[1], 10);
  const m2 = epStr.match(/(\d+)/);
  return m2 ? parseInt(m2[1], 10) : null;
}

function isNewEpisode(oldEp?: string, newEp?: string): boolean {
  const oldN = parseEpisodeCount(oldEp);
  const newN = parseEpisodeCount(newEp);
  if (oldN !== null && newN !== null) return newN > oldN;
  // fallback string compare
  if (!oldEp || !newEp) return false;
  return oldEp.trim() !== newEp.trim();
}

export const followMovieService = {
  getAll(accountId: string, profileId: string): FollowedMovie[] {
    const list = loadRaw(accountId, profileId);
    // newest follow first
    return [...list].sort((a,b)=> b.followedAt - a.followedAt);
  },

  getWithNew(accountId: string, profileId: string): FollowedMovie[] {
    return this.getAll(accountId, profileId).filter(m=> m.hasNewEpisode);
  },

  isFollowed(accountId: string, profileId: string, slug: string): boolean {
    return loadRaw(accountId, profileId).some(m=> m.slug === slug);
  },

  follow(accountId: string, profileId: string, movie: Movie): { already: boolean } {
    const list = loadRaw(accountId, profileId);
    if (list.some(m=> m.slug === movie.slug)) return { already: true };
    const now = Date.now();
    const item: FollowedMovie = {
      slug: movie.slug,
      name: movie.name,
      origin_name: movie.origin_name,
      thumb_url: movie.thumb_url,
      poster_url: movie.poster_url,
      year: movie.year,
      quality: movie.quality,
      lang: movie.lang,
      episode_current: movie.episode_current,
      followedAt: now,
      lastKnownEpisode: movie.episode_current || '',
      lastKnownTotal: movie.episode_total || undefined,
      hasNewEpisode: false,
      lastCheckedAt: now,
      movieSnapshot: movie,
    };
    saveRaw(accountId, profileId, [item, ...list]);
    return { already: false };
  },

  unfollow(accountId: string, profileId: string, slug: string) {
    const list = loadRaw(accountId, profileId);
    saveRaw(accountId, profileId, list.filter(m=> m.slug !== slug));
  },

  markSeen(accountId: string, profileId: string, slug: string, currentEpisode?: string) {
    const list = loadRaw(accountId, profileId);
    const idx = list.findIndex(m=> m.slug === slug);
    if (idx === -1) return;
    const it = list[idx];
    // user has seen latest, clear flag and update lastKnown
    it.hasNewEpisode = false;
    if (currentEpisode) it.lastKnownEpisode = currentEpisode;
    else if (it.latestEpisode) it.lastKnownEpisode = it.latestEpisode;
    it.latestEpisode = undefined;
    it.lastCheckedAt = Date.now();
    list[idx] = it;
    saveRaw(accountId, profileId, list);
  },

  // Check từng phim xem có tập mới không, trả về số phim có tập mới
  async checkForUpdates(accountId: string, profileId: string, onNewFound?: (items: FollowedMovie[])=>void): Promise<number> {
    const list = loadRaw(accountId, profileId);
    if (list.length === 0) return 0;
    let updated = 0;
    const newlyUpdated: FollowedMovie[] = [];
    // Batch concurrency 5 (nhanh gấp ~5 lần for-await nối tiếp mà không burst)
    const toCheck = list.slice(0, 20);
    const checkOne = async (item: (typeof toCheck)[number]) => {
      try {
        const detail = await movieApi.getMovieDetail(item.slug);
        const movie = detail.movie;
        const latestEp = movie.episode_current || movie.episode_total || '';
        const episodesCount = detail.episodes?.[0]?.server_data?.length;
        const latestFromCount = episodesCount ? `Tập ${episodesCount}` : latestEp;
        // use the richer one
        const effectiveLatest = latestFromCount || latestEp;
        if (!effectiveLatest) return;
        const hasNew = isNewEpisode(item.lastKnownEpisode, effectiveLatest);
        // also if count increased
        if (hasNew && !item.hasNewEpisode) {
          item.hasNewEpisode = true;
          item.latestEpisode = effectiveLatest;
          item.lastCheckedAt = Date.now();
          newlyUpdated.push({ ...item });
          updated++;
        } else {
          // update lastCheckedAt even if no new, to avoid spam
          item.lastCheckedAt = Date.now();
          // if previously had new but now user already on latest (maybe auto), keep flag until seen
        }
        // update thumb/poster if changed
        if (movie.thumb_url) item.thumb_url = movie.thumb_url;
        if (movie.poster_url) item.poster_url = movie.poster_url;
      } catch {}
    };
    for (let i = 0; i < toCheck.length; i += 5) {
      await Promise.all(toCheck.slice(i, i + 5).map(checkOne));
    }
    if (updated > 0) {
      saveRaw(accountId, profileId, list);
      onNewFound?.(newlyUpdated);
    } else {
      // still save lastCheckedAt updates
      saveRaw(accountId, profileId, list);
    }
    return updated;
  },

  subscribe(accountId: string, profileId: string, cb: (list: FollowedMovie[])=>void): ()=>void {
    const handler = () => cb(this.getAll(accountId, profileId));
    window.addEventListener('gau_follow_changed', handler as EventListener);
    const storageHandler = (e: StorageEvent) => {
      if (e.key === getKey(accountId, profileId)) handler();
    };
    window.addEventListener('storage', storageHandler);
    return () => {
      window.removeEventListener('gau_follow_changed', handler as EventListener);
      window.removeEventListener('storage', storageHandler);
    };
  },
};
