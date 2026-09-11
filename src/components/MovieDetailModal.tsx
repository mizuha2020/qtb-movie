import React, { useEffect, useState, useMemo, useRef } from 'react';
import { EpisodeServer, Movie, MovieEpisode, RoomListItem, RoomVisibility, Account, UserProfile } from '../types';
import { movieApi, getImageUrl, getTmdbAssets, tmdbFetch } from '../services/movieApi';
import {
  Play,
  Plus,
  Check,
  Calendar,
  Clock,
  Globe,
  Tv,
  Sparkles,
  Video,
  Share2,
  Bookmark,
  Info,
  X,
  Search,
  User,
  Users,
  Lock,
  Loader2,
  Download,
  Trash2,
  CalendarClock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import DOMPurify from 'dompurify';
import { CreateRoomModal, JoinRoomModal } from './watch-together';
import { offlineMovieService } from '../services/offlineMovieService';
import { followMovieService } from '../services/followMovieService';
import { Capacitor } from '@capacitor/core';

interface MovieDetailModalProps {
  movie: Movie | null;
  onClose: () => void;
  onPlayEpisode?: (movie: Movie, episode: MovieEpisode, server: EpisodeServer) => void;
  onPlayMovie?: (movie: Movie) => void;
  onToggleMyList: (movie: Movie) => void;
  isInMyList: boolean | ((slug: string) => boolean);
  onSelectRelatedMovie?: (movie: Movie) => void;
  onSearchSubmit?: (query: string) => void;
  onSelectGenre?: (genreSlug: string) => void;
  onSelectCountry?: (countrySlug: string) => void;
  currentAccount?: Account | null;
  activeProfile?: UserProfile | null;
  activeRooms?: RoomListItem[];
  userActiveRoomId?: string | null;
  onCreateRoom?: (filmId: string, filmName: string, filmThumb: string, episode: string, episodeSlug: string, serverName: string, linkM3u8: string, password: string, visibility: RoomVisibility) => Promise<void>;
  onJoinRoom?: (roomId: string, password: string) => Promise<void>;
  onShowToast?: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void;
}

// Helper to parse Trailer URL (supports YouTube watch, embed, short links, or direct videos)
function parseTrailerUrl(url?: string): { type: 'youtube' | 'direct'; videoId?: string; embedUrl?: string; directUrl?: string } | null {
  if (!url || typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();

  // YouTube match regex
  const ytRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = trimmed.match(ytRegex);

  if (match && match[1]) {
    const videoId = match[1];
    return {
      type: 'youtube',
      videoId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    };
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return {
      type: 'direct',
      directUrl: trimmed,
    };
  }

  return null;
}

export const MovieDetailModal: React.FC<MovieDetailModalProps> = ({
  movie,
  onClose,
  onPlayEpisode,
  onPlayMovie,
  onToggleMyList,
  isInMyList,
  onSelectRelatedMovie,
  onSearchSubmit,
  onSelectGenre,
  onSelectCountry,
  currentAccount,
  activeProfile,
  activeRooms = [],
  userActiveRoomId,
  onCreateRoom,
  onJoinRoom,
  onShowToast,
}) => {
  const [fullMovieData, setFullMovieData] = useState<Movie | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeServer[]>([]);
  const [selectedServerIndex, setSelectedServerIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [relatedMovies, setRelatedMovies] = useState<Movie[]>([]);
  const [episodeSearch, setEpisodeSearch] = useState('');
  const [isCopiedLink, setIsCopiedLink] = useState(false);

  // Trailer states
  const [showTrailer, setShowTrailer] = useState(false);

  // Watch Together states
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false);
  const [joinTargetRoom, setJoinTargetRoom] = useState<RoomListItem | null>(null);
  const [selectedEpisodeForRoom, setSelectedEpisodeForRoom] = useState<{ ep: MovieEpisode; server: EpisodeServer } | null>(null);
  const [isSynopsisExpanded, setIsSynopsisExpanded] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Lock background scroll while modal is open to ensure only 1 scrollbar exists
  useEffect(() => {
    const originalHtmlOverflow = document.documentElement.style.overflow;
    const originalBodyOverflow = document.body.style.overflow;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.overflow = originalHtmlOverflow;
      document.body.style.overflow = originalBodyOverflow;
    };
  }, []);

  // Close on Escape (closes trailer popup if open, else closes detail modal)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showTrailer) {
          setShowTrailer(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showTrailer, onClose]);

  // Next episode + full schedule cho phim bộ chưa hoàn thành (giống chophim.app)
  const [nextEpisode, setNextEpisode] = useState<{ episode_number: number; air_date: string; name?: string } | null>(null);
  const [seasonEpisodes, setSeasonEpisodes] = useState<Array<{ episode_number: number; air_date: string | null; name?: string }>>([]);
  const [showSchedule, setShowSchedule] = useState(false);

  // Scroll to top on mount or movie change
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [movie?.slug]);

  // Fetch full details, episodes, related movies, and schedule (lịch chiếu)
  useEffect(() => {
    if (!movie) return;

    let isMounted = true;
    setIsLoading(true);
    setError(null);
    setShowTrailer(false);
    setNextEpisode(null);
    setSeasonEpisodes([]);
    setShowSchedule(false);

    const fetchScheduleForMovie = async (movieData: Movie, localServers?: EpisodeServer[]) => {
      const isSeries = movieData.type === 'series' || movieData.type === 'tvshows' || (movieData as any)?.tmdb?.type === 'tv';
      if (!isSeries) return { nextEp: null, seasonEps: [] };

      const status = (movieData.status || '').toLowerCase();
      const isCompleted = status === 'completed' || status === 'ended';
      const epCur = movieData.episode_current || '';
      const epTotal = movieData.episode_total || '';
      if ((epTotal && epCur.includes(epTotal)) || isCompleted) {
        return { nextEp: null, seasonEps: [] };
      }

      const tmdbId = (movieData as any)?.tmdb?.id ? String((movieData as any).tmdb.id).trim() : '';
      const tmdbType = (movieData as any)?.tmdb?.type ? String((movieData as any).tmdb.type).trim() : '';
      const tmdbSeason = (movieData as any)?.tmdb?.season ?? 1;

      if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return { nextEp: null, seasonEps: [] };
      }
      if (tmdbType && tmdbType !== 'tv' && movieData.type !== 'series' && movieData.type !== 'tvshows') {
        return { nextEp: null, seasonEps: [] };
      }

      // Tập đã có nguồn local (playable) -> không coi là "sắp chiếu" nữa
      const localNums = new Set<number>();
      try {
        (localServers || []).forEach((srv) => {
          (srv.server_data || []).forEach((ep: any) => {
            const m = String(ep?.name ?? '').match(/\d+/);
            if (m) {
              const n = parseInt(m[0], 10);
              if (!isNaN(n) && ep?.link_m3u8) localNums.add(n);
            }
          });
        });
      } catch {}

      const startOfToday = () => {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        return t;
      };

      let nextEp: { episode_number: number; air_date: string; name?: string } | null = null;
      let seasonEps: Array<{ episode_number: number; air_date: string | null; name?: string }> = [];

      try {
        const tvData: any = await tmdbFetch(`tv/${tmdbId}`, { language: 'vi-VN' });
        const next = tvData?.next_episode_to_air;
        if (next?.air_date && next?.episode_number) {
          const air = new Date(next.air_date);
          air.setHours(0, 0, 0, 0);
          // Chỉ nhận next khi ngày chiếu còn ở tương lai/hôm nay (TMDB hay lag 1-2 ngày)
          if (!isNaN(air.getTime()) && air >= startOfToday()) {
            const n = Number(next.episode_number);
            if (!localNums.has(n)) {
              nextEp = { episode_number: n, air_date: next.air_date, name: next.name };
            }
          }
        }
        const seasonNum = Number(tmdbSeason) || 1;
        const seasonData: any = await tmdbFetch(`tv/${tmdbId}/season/${seasonNum}`, { language: 'vi-VN' }).catch(() => null);
        if (seasonData?.episodes?.length) {
          const today = startOfToday();

          const rawEps = (seasonData.episodes as any[]).map((ep: any) => ({
            episode_number: ep.episode_number,
            air_date: ep.air_date || null,
            name: ep.name || '',
          }));

          // Chỉ giữ các tập thực sự chưa chiếu: air_date >= hôm nay, chưa có nguồn local.
          // Tập quá khứ (như 04/09 khi hôm nay 05/09) bị loại -> lịch bắt đầu từ tập sắp chiếu thật (17).
          seasonEps = rawEps.filter((ep: any) => {
            if (localNums.has(ep.episode_number)) return false;
            if (!ep.air_date) {
              // Chưa có lịch: chỉ giữ nếu >= next thật (tránh lôi lại tập cũ)
              if (nextEp?.episode_number) return ep.episode_number >= nextEp.episode_number;
              return true;
            }
            const d = new Date(ep.air_date);
            if (isNaN(d.getTime())) return false;
            d.setHours(0, 0, 0, 0);
            return d >= today;
          });
          seasonEps.sort((a, b) => a.episode_number - b.episode_number);

          // Nếu TMDB next đã quá hạn/bị loại (lag) -> lấy tập tương lai đầu tiên làm next thật
          if (!nextEp && seasonEps.length > 0) {
            const first = seasonEps.find((e) => e.air_date);
            if (first?.air_date) {
              nextEp = { episode_number: first.episode_number, air_date: first.air_date, name: first.name };
            }
          }
          // Chốt: next vẫn quá khứ (phòng thủ múi giờ) -> ẩn luôn
          if (nextEp?.air_date) {
            const nd = new Date(nextEp.air_date);
            nd.setHours(0, 0, 0, 0);
            if (isNaN(nd.getTime()) || nd < today) nextEp = null;
          }
          if (!nextEp) seasonEps = seasonEps.filter((e) => {
            if (!e.air_date) return true;
            const d = new Date(e.air_date);
            d.setHours(0, 0, 0, 0);
            return d >= today;
          });
        }
      } catch {}

      return { nextEp, seasonEps };
    };

    const loadDetail = async () => {
      try {
        const data = await movieApi.getMovieDetail(movie.slug);
        if (isMounted) {
          // Merge with movie prop to never lose existing backdrop_url, backdrops, logos, etc.
          const mergedMovie: Movie = {
            ...data.movie,
            backdrop_url: data.movie.backdrop_url || movie.backdrop_url,
            backdrops: (data.movie.backdrops && data.movie.backdrops.length > 0) ? data.movie.backdrops : movie.backdrops,
            logos: (data.movie.logos && data.movie.logos.length > 0) ? data.movie.logos : movie.logos,
            logo_url: data.movie.logo_url || movie.logo_url,
            color_palette: data.movie.color_palette || movie.color_palette,
            tmdb: data.movie.tmdb || movie.tmdb,
          };
          setFullMovieData(mergedMovie);
          setEpisodes(data.episodes || []);
          setSelectedServerIndex(0);

          const fetches: Promise<any>[] = [];

          // 1. Fetch related movies by category
          if (data.movie.category && data.movie.category.length > 0) {
            const firstCat = data.movie.category[0].slug;
            fetches.push(
              movieApi.getByGenre(firstCat, 1, 12).then((relatedRes) => {
                if (isMounted) {
                  setRelatedMovies(
                    (relatedRes.items || []).filter((m) => m.slug !== movie.slug).slice(0, 8)
                  );
                }
              }).catch(() => {})
            );
          }

          // 2. Fetch schedule (lịch chiếu) WHILE loading screen is active
          fetches.push(
            fetchScheduleForMovie(data.movie, data.episodes || []).then(({ nextEp, seasonEps }) => {
              if (isMounted) {
                setNextEpisode(nextEp);
                setSeasonEpisodes(seasonEps);
              }
            }).catch(() => {})
          );

          await Promise.allSettled(fetches);
        }
      } catch (err: any) {
        void 0;
        if (isMounted) {
          setError(err.message || 'Không thể tải thông tin chi tiết phim');
          setFullMovieData(movie);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadDetail();
    return () => {
      isMounted = false;
    };
  }, [movie]);

  const currentData = fullMovieData || movie;

  // --- Detail backdrop logic: ưu tiên TMDB backdrop nếu có tmdb, fallback thumb_url ---
  // 1+2: Backend đã enrich trong getMovieDetail, FE chỉ cần fallback + preload mượt
  const [tmdbBackdrop, setTmdbBackdrop] = useState<string | null>(null);
  const [loadedTmdbSrc, setLoadedTmdbSrc] = useState<string | null>(null);

  // Song song: nếu movie prop đã có tmdb.id thì fetch ngay, không chờ fullMovieData (giảm waterfall)
  useEffect(() => {
    const target = currentData || movie;
    if (!target) { setTmdbBackdrop(null); return; }
    const primaryUrl = target.backdrops?.find((b) => b.primary)?.url || '';
    const inlineUrl = primaryUrl.includes('image.tmdb.org') ? primaryUrl : (target.backdrop_url?.includes('image.tmdb.org') ? target.backdrop_url : '');
    if (inlineUrl) {
      setTmdbBackdrop(inlineUrl);
      return;
    }
    const tmdbId = (target as any)?.tmdb?.id || (movie as any)?.tmdb?.id ? String((target as any)?.tmdb?.id || (movie as any)?.tmdb?.id).trim() : '';
    if (!tmdbId || !/^\d+$/.test(tmdbId)) { return; }
    const tmdbType = (target as any)?.tmdb?.type || (target as any)?.type || (movie as any)?.tmdb?.type || (movie as any)?.type
      ? String((target as any)?.tmdb?.type || (target as any)?.type || (movie as any)?.tmdb?.type || (movie as any)?.type).trim()
      : undefined;
    let cancelled = false;
    getTmdbAssets(tmdbId, tmdbType).then((assets) => {
      if (!cancelled && assets.backdropUrl) setTmdbBackdrop(assets.backdropUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [movie?.slug, (movie as any)?.tmdb?.id, (movie as any)?.tmdb?.type, currentData?.slug, (currentData as any)?.tmdb?.id, (currentData as any)?.tmdb?.type, currentData?.backdrop_url, currentData?.backdrops]);

  // Preload TMDB image trước khi đổi src -> tránh flash kkphim -> tmdb khi ảnh chưa tải xong
  useEffect(() => {
    if (!tmdbBackdrop) { setLoadedTmdbSrc(null); return; }
    let cancelled = false;
    const img = new Image();
    img.src = tmdbBackdrop;
    // Nếu đã cache thì onload có thể không fire -> check complete
    const done = () => { if (!cancelled) setLoadedTmdbSrc(tmdbBackdrop); };
    img.onload = done;
    img.onerror = () => { if (!cancelled) setLoadedTmdbSrc(null); };
    if ((img as any).complete && img.naturalWidth) done();
    return () => { cancelled = true; };
  }, [tmdbBackdrop]);

  // Reset loaded khi đổi phim
  useEffect(() => { setLoadedTmdbSrc(null); setTmdbBackdrop(null); }, [movie?.slug]);

  const fallbackThumbSrc = useMemo(() => {
    if (!currentData) return '';
    return getImageUrl(currentData.thumb_url || currentData.poster_url, (currentData as any).source);
  }, [currentData]);

  const detailBackdropSrc = useMemo(() => {
    if (!currentData) return '';
    if (loadedTmdbSrc) return loadedTmdbSrc;
    if (tmdbBackdrop) return tmdbBackdrop;

    const primary = currentData.backdrops?.find((b) => b.primary)?.url;
    if (primary && primary.includes('image.tmdb.org')) {
      return primary.includes('/original') ? primary : primary.replace(/\/w\d+/, '/original');
    }
    if (currentData.backdrop_url && currentData.backdrop_url.includes('image.tmdb.org')) {
      return currentData.backdrop_url.includes('/original') ? currentData.backdrop_url : currentData.backdrop_url.replace(/\/w\d+/, '/original');
    }

    const moviePrimary = movie?.backdrops?.find((b) => b.primary)?.url;
    if (moviePrimary && moviePrimary.includes('image.tmdb.org')) {
      return moviePrimary.includes('/original') ? moviePrimary : moviePrimary.replace(/\/w\d+/, '/original');
    }
    if (movie?.backdrop_url && movie.backdrop_url.includes('image.tmdb.org')) {
      return movie.backdrop_url.includes('/original') ? movie.backdrop_url : movie.backdrop_url.replace(/\/w\d+/, '/original');
    }

    if (primary) return primary;
    if (currentData.backdrop_url) return currentData.backdrop_url;

    return fallbackThumbSrc;
  }, [currentData, loadedTmdbSrc, tmdbBackdrop, fallbackThumbSrc, movie]);

  const isShowingTmdb = Boolean(detailBackdropSrc && detailBackdropSrc !== fallbackThumbSrc && detailBackdropSrc.includes('image.tmdb.org'));

  const inList =
    typeof isInMyList === 'function'
      ? currentData
        ? isInMyList(currentData.slug)
        : false
      : Boolean(isInMyList);
  const currentServer = episodes[selectedServerIndex];

  // Offline save state (only on native) - đặt sau currentData để tránh TS2448
  const isNativeApp = useMemo(() => {
    try { return Capacitor.isNativePlatform(); } catch { return false; }
  }, []);
  const [isOfflineSaved, setIsOfflineSaved] = useState(false);

  useEffect(() => {
    if (!isNativeApp || !currentData || !currentAccount || !activeProfile) {
      setIsOfflineSaved(false);
      return;
    }
    setIsOfflineSaved(offlineMovieService.isSaved(currentAccount.id, activeProfile.id, currentData.slug));
    const unsub = offlineMovieService.subscribe(currentAccount.id, activeProfile.id, (list) => {
      setIsOfflineSaved(list.some((m) => m.slug === currentData.slug));
    });
    return unsub;
  }, [isNativeApp, currentData?.slug, currentAccount?.id, activeProfile?.id]);

  const [isOfflineDownloading, setIsOfflineDownloading] = useState(false);
  const [offlineProgress, setOfflineProgress] = useState(0);

  // Listen download progress
  useEffect(() => {
    if (!currentData || !currentAccount || !activeProfile) return;
    const handler = (e: any) => {
      const d = e.detail;
      if (d.slug === currentData.slug && d.accountId === currentAccount.id) {
        setOfflineProgress(d.progress);
        if (d.done) { setIsOfflineDownloading(false); setOfflineProgress(100); }
      }
    };
    window.addEventListener('gau_offline_progress', handler as any);
    return () => window.removeEventListener('gau_offline_progress', handler as any);
  }, [currentData?.slug, currentAccount?.id, activeProfile?.id]);

  const handleToggleOfflineSave = async () => {
    if (!currentData || !currentAccount || !activeProfile) return;
    if (isOfflineSaved) {
      offlineMovieService.remove(currentAccount.id, activeProfile.id, currentData.slug);
      onShowToast?.('Đã xóa khỏi Đã lưu (Offline)', 'info');
      setIsOfflineDownloading(false);
      setOfflineProgress(0);
    } else {
      const res = offlineMovieService.save(currentAccount.id, activeProfile.id, currentData);
      if (res.already) {
        onShowToast?.('Phim đã có trong Đã lưu', 'info');
        return;
      }
      onShowToast?.('Đã lưu • Bắt đầu tải video để xem offline...', 'success');
      // Only on native: download video file via Filesystem
      if (offlineMovieService.isNativeApp()) {
        setIsOfflineDownloading(true);
        setOfflineProgress(0);
        try {
          // Try to get first episode/server from snapshot
          const anyData = currentData as any;
          let server: any = null;
          let episode: any = null;
          // Try to find server_data from movieSnapshot or currentData
          if (anyData.episodeServers && anyData.episodeServers[0]) {
            server = anyData.episodeServers[0];
            episode = server.server_data?.[0];
          } else if (anyData.servers && anyData.servers[0]) {
            server = anyData.servers[0];
            episode = server.server_data?.[0];
          } else if (anyData.link_m3u8) {
            episode = { slug: currentData.slug, name: '1', link_m3u8: anyData.link_m3u8, link_embed: '' };
            server = { server_name: 'default', server_data: [episode] };
          }
          if (episode && server) {
            const dlRes = await offlineMovieService.downloadEpisode(
              currentAccount.id,
              activeProfile.id,
              currentData,
              episode,
              server,
              (pct) => setOfflineProgress(pct)
            );
            if (dlRes.success) {
              onShowToast?.(`Đã tải xong "${currentData.name}" để xem offline`, 'success');
            } else {
              onShowToast?.(dlRes.error || 'Lưu metadata, tải video thất bại (sẽ thử lại)', 'warning');
            }
          } else {
            onShowToast?.('Đã lưu metadata (không tìm thấy link tập để tải)', 'info');
          }
        } catch (e: any) {
          onShowToast?.(e?.message || 'Lỗi tải offline', 'error');
        } finally {
          setIsOfflineDownloading(false);
        }
      } else {
        onShowToast?.('Đã lưu để xem offline (tự xóa sau 7 ngày)', 'success');
      }
    }
  };

  // Follow state
  const [isFollowed, setIsFollowed] = useState(false);
  const [hasNewEp, setHasNewEp] = useState(false);
  useEffect(() => {
    if (!currentData || !currentAccount || !activeProfile) {
      setIsFollowed(false); setHasNewEp(false); return;
    }
    const check = () => {
      const list = followMovieService.getAll(currentAccount.id, activeProfile.id);
      const found = list.find(m=> m.slug === currentData.slug);
      setIsFollowed(!!found);
      setHasNewEp(!!found?.hasNewEpisode);
    };
    check();
    const unsub = followMovieService.subscribe(currentAccount.id, activeProfile.id, check);
    return unsub;
  }, [currentData?.slug, currentAccount?.id, activeProfile?.id]);

  const handleToggleFollow = () => {
    if (!currentData || !currentAccount || !activeProfile) return;
    if (isFollowed) {
      followMovieService.unfollow(currentAccount.id, activeProfile.id, currentData.slug);
      onShowToast?.('Đã bỏ theo dõi phim', 'info');
    } else {
      const r = followMovieService.follow(currentAccount.id, activeProfile.id, currentData);
      if (r.already) onShowToast?.('Đã theo dõi trước đó', 'info');
      else onShowToast?.('Đã theo dõi • Sẽ báo khi có tập mới', 'success');
    }
  };
  const serverEpisodes = currentServer?.server_data || [];

  // Build full episode list: hiển thị đủ số tập, tập chưa ra disable + soon (chophim style)
  const allEpisodesForDisplay = useMemo(() => {
    const base = serverEpisodes as Array<MovieEpisode & { isSoon?: boolean; airDate?: string | null }>;
    // Ưu tiên TMDB season length
    let total = 0;
    if (seasonEpisodes.length > 0) total = seasonEpisodes.length;
    else if (currentData?.episode_total) {
      const parsed = parseInt(String(currentData.episode_total).replace(/\D/g, ''), 10);
      if (!isNaN(parsed) && parsed > 0) total = parsed;
    }
    if (!total || total <= base.length) return base;
    // Tạo map số tập đã có
    const existingNums = new Set<number>();
    base.forEach((ep) => {
      const m = String(ep.name).match(/\d+/);
      const n = m ? parseInt(m[0], 10) : NaN;
      if (!isNaN(n)) existingNums.add(n);
      else existingNums.add(9999);
    });
    const full: Array<MovieEpisode & { isSoon?: boolean; airDate?: string | null }> = [...base];
    for (let i = 1; i <= total; i++) {
      if (existingNums.has(i)) continue;
      const sched = seasonEpisodes.find((s) => s.episode_number === i);
      full.push({
        name: String(i),
        slug: `soon-${i}`,
        filename: currentData?.name || '',
        link_embed: '',
        link_m3u8: '',
        isSoon: true,
        airDate: sched?.air_date || null,
      } as any);
    }
    // Sắp xếp theo số tập
    full.sort((a, b) => {
      const na = parseInt(String(a.name).match(/\d+/)?.[0] || '0', 10);
      const nb = parseInt(String(b.name).match(/\d+/)?.[0] || '0', 10);
      return na - nb;
    });
    return full;
  }, [serverEpisodes, seasonEpisodes, currentData?.episode_total, currentData?.name]);

  // Parse trailer url from movie data
  const trailerInfo = useMemo(() => {
    return parseTrailerUrl(currentData?.trailer_url);
  }, [currentData?.trailer_url]);

  const hasTrailer = Boolean(trailerInfo);

  // Static YouTube embed URL for trailer popup modal
  const youtubeEmbedUrl = useMemo(() => {
    if (!trailerInfo || trailerInfo.type !== 'youtube') return '';
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${trailerInfo.embedUrl}?autoplay=1&controls=1&rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=${origin}`;
  }, [trailerInfo]);

  // User clicks "Xem Trailer" -> Open centered popup modal
  const handleUserWatchTrailer = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setShowTrailer(true);
  };

  const handleCloseTrailer = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setShowTrailer(false);
  };

  // Copy share link
  const handleShareMovie = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
      setIsCopiedLink(true);
      setTimeout(() => setIsCopiedLink(false), 2500);
    }
  };

  const filteredEpisodes = useMemo(() => {
    const src = allEpisodesForDisplay as Array<MovieEpisode & { isSoon?: boolean }>;
    if (!episodeSearch.trim()) return src;
    const q = episodeSearch.toLowerCase();
    return src.filter((ep) => ep.name.toLowerCase().includes(q) || ep.slug.toLowerCase().includes(q));
  }, [allEpisodesForDisplay, episodeSearch]);

  const handleStartPlay = async () => {
    if (!currentData) return;
    if (serverEpisodes.length > 0 && currentServer) {
      if (onPlayEpisode) {
        onPlayEpisode(currentData, serverEpisodes[0], currentServer);
      } else if (onPlayMovie) {
        onPlayMovie(currentData);
      }
      return;
    }

    try {
      setIsLoading(true);
      const data = await movieApi.getMovieDetail(currentData.slug);
      if (data.episodes && data.episodes.length > 0 && data.episodes[0].server_data.length > 0) {
        setFullMovieData(data.movie);
        setEpisodes(data.episodes);
        setSelectedServerIndex(0);
        if (onPlayEpisode) {
          onPlayEpisode(data.movie || currentData, data.episodes[0].server_data[0], data.episodes[0]);
        } else if (onPlayMovie) {
          onPlayMovie(data.movie || currentData);
        }
      } else {
        setError('Hiện chưa có luồng phát cho phim này. Vui lòng thử lại sau.');
      }
    } catch (err: any) {
      setError(err?.message || 'Không thể tải luồng phát của phim');
    } finally {
      setIsLoading(false);
    }
  };

  if (!movie || !currentData) return null;

  // TV remote: mở trang chi tiết là focus ngay nút Xem để D-pad đi được liền
  useEffect(() => {
    let isTv = false;
    try {
      isTv = document.documentElement.classList.contains('tv-mode');
    } catch {}
    if (!isTv) return;
    const t = window.setTimeout(() => {
      try {
        const btn = document.querySelector<HTMLElement>(
          '#hero-primary-play-btn, #detail-floating-close-btn',
        );
        btn?.focus({ preventScroll: true } as FocusOptions);
      } catch {}
    }, 350);
    return () => window.clearTimeout(t);
  }, [movie?.slug]);

  return (
    <motion.div
        ref={containerRef}
        id="movie-detail-fullpage"
        role="dialog"
        aria-modal="true"
        aria-label={currentData?.name || movie?.name || 'Chi tiết phim'}
        initial={{ opacity: 0, scale: 0.90, y: 28 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.86, y: 32 }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 30,
          mass: 1.0,
        }}
        className="fixed inset-0 z-[60] bg-[#060a14] overflow-y-auto overflow-x-hidden text-white flex flex-col selection:bg-blue-600 selection:text-white overscroll-contain will-change-transform"
        style={{ WebkitOverflowScrolling: 'touch', transformOrigin: 'center center' } as React.CSSProperties}
      >
        {/* Top-Right Circular Close Button */}
        <button
          id="detail-floating-close-btn"
          onClick={onClose}
          className="absolute z-50 flex items-center justify-center w-10 h-10 rounded-full bg-black/60 hover:bg-rose-600/90 text-white backdrop-blur-md border border-white/20 hover:border-rose-400 shadow-xl transition-all hover:scale-105 active:scale-95 cursor-pointer group top-[calc(env(safe-area-inset-top,0px)+16px)] right-4 sm:top-6 sm:right-6"
          title="Đóng (Esc)"
          aria-label="Đóng chi tiết phim"
        >
          <X className="w-5 h-5 transition-transform group-hover:rotate-90" />
        </button>

        {/* Loading overlay - minimalist luxurious, mờ sâu */}
        <AnimatePresence>
          {isLoading && (
            <motion.div
              id="detail-loading-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="absolute inset-0 z-40 flex items-center justify-center pointer-events-auto"
              style={{
                background: 'radial-gradient(ellipse at center, rgba(12,20,39,0.55) 0%, rgba(6,10,20,0.72) 55%, rgba(2,4,10,0.88) 100%)',
                backdropFilter: 'blur(28px) saturate(1.25)',
                WebkitBackdropFilter: 'blur(28px) saturate(1.25)',
              }}
            >
              {/* subtle grain / vignette */}
              <div className="absolute inset-0 bg-gradient-to-b from-white/[0.04] via-transparent to-black/20 pointer-events-none" />
              <motion.div
                initial={{ opacity: 0, scale: 0.94, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 6 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
                className="relative flex flex-col items-center"
              >
                {/* soft ambient glow */}
                <div className="absolute -inset-16 bg-sky-400/10 blur-[50px] rounded-full pointer-events-none" />
                <div className="absolute -inset-8 bg-indigo-400/5 blur-[36px] rounded-full pointer-events-none" />

                {/* minimalist spinner - thin hairline */}
                <div className="relative w-14 h-14 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full border border-white/[0.07]" />
                  <motion.div
                    className="absolute inset-0 rounded-full border border-t-white/90 border-r-white/15 border-b-white/5 border-l-white/15"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                  />
                  <div className="w-[3px] h-[3px] rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9),0_0_22px_rgba(125,211,252,0.5)]" />
                </div>

                <div className="mt-7 flex flex-col items-center gap-3">
                  <p className="text-[10px] sm:text-[11px] tracking-[0.42em] font-light text-white/85 uppercase">
                    Đang tải
                  </p>
                  {/* minimalist dots */}
                  <div className="flex items-center gap-1.5">
                    <motion.span
                      className="w-1 h-1 rounded-full bg-white/90"
                      animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }}
                      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <motion.span
                      className="w-1 h-1 rounded-full bg-white/90"
                      animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }}
                      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
                    />
                    <motion.span
                      className="w-1 h-1 rounded-full bg-white/90"
                      animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1, 0.8] }}
                      transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
                    />
                  </div>
                  <p className="text-[11px] font-light tracking-wide text-white/30 max-w-[220px] truncate text-center">
                    {currentData?.name || movie?.name || 'Gấu Cinema'}
                  </p>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Desktop Full-bleed Hero Stage (Panoramic Backdrop) */}
        <section
          id="detail-hero-stage"
          className="relative w-full min-h-[calc(env(safe-area-inset-top,0px)+440px)] sm:min-h-[520px] md:min-h-[580px] lg:min-h-[640px] bg-[#060a14] select-none flex flex-col justify-end pt-[env(safe-area-inset-top,24px)] sm:pt-0"
        >
          {/* Panoramic Backdrop layers span fully across the top background of the section */}
          {/* Base layer: dùng detailBackdropSrc (TMDB / high quality backdrop) trực tiếp để luôn nét */}
          <img
            src={detailBackdropSrc}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
            className="absolute top-0 left-0 w-full h-[calc(env(safe-area-inset-top,0px)+210px)] sm:h-full object-cover object-center pointer-events-none blur-none opacity-100"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (fallbackThumbSrc && img.src !== fallbackThumbSrc) {
                img.src = fallbackThumbSrc;
                return;
              }
              img.src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1200&auto=format&fit=crop&q=80';
            }}
          />
          {/* Top layer: TMDB backdrop - chỉ hiện khi đã preload xong, fade mượt */}
          <AnimatePresence>
            {isShowingTmdb && (
              <motion.img
                key={detailBackdropSrc}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                src={detailBackdropSrc}
                alt={currentData.name}
                referrerPolicy="no-referrer"
                className="absolute top-0 left-0 w-full h-[calc(env(safe-area-inset-top,0px)+210px)] sm:h-full object-cover object-center pointer-events-none blur-none opacity-100"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  img.style.display = 'none';
                }}
              />
            )}
          </AnimatePresence>
          {/* Mobile-specific cover photo gradient overlay */}
          <div className="absolute top-0 left-0 w-full h-[calc(env(safe-area-inset-top,0px)+210px)] sm:hidden bg-gradient-to-t from-[#060a14] via-[#060a14]/20 to-transparent pointer-events-none z-[5]" />

          {/* Multi-layered cinematic gradients */}
          <div className="absolute inset-0 hidden sm:block bg-gradient-to-t from-[#060a14] via-[#060a14]/75 sm:via-[#060a14]/65 to-black/30 pointer-events-none" />
          <div className="absolute inset-0 hidden sm:block bg-gradient-to-r from-[#060a14]/95 via-[#060a14]/50 to-transparent pointer-events-none" />

          {/* Inner Content Area */}
          <div className="relative w-full h-full min-h-[calc(env(safe-area-inset-top,0px)+440px)] sm:min-h-[520px] md:min-h-[580px] lg:min-h-[640px] flex flex-col justify-end pt-[calc(env(safe-area-inset-top,0px)+160px)] sm:pt-28 pb-4 sm:pb-12 z-10">
              {/* Hero Content - giống chophim.app: poster trái + info phải */}
              <div className="relative z-20 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
                <div className="flex flex-row gap-4 sm:gap-7 lg:gap-8 items-end">
                  {/* Poster - chophim style */}
                  <div className="shrink-0 hidden sm:block">
                    <div className="w-[160px] sm:w-[180px] lg:w-[210px] aspect-[2/3] rounded-xl sm:rounded-2xl overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,0.6)] border border-white/10 bg-slate-900">
                      <img
                        src={currentData.poster_url ? getImageUrl(currentData.poster_url, (currentData as any).source) : getImageUrl(currentData.thumb_url, (currentData as any).source)}
                        alt={currentData.name}
                        className="w-full h-full object-cover"
                        loading="eager"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80';
                        }}
                      />
                    </div>
                  </div>
                  {/* Mobile poster small (inline) */}
                  <div className="shrink-0 sm:hidden z-30">
                    <div className="w-[105px] aspect-[2/3] rounded-xl overflow-hidden shadow-2xl border-4 border-[#060a14] bg-slate-900">
                      <img
                        src={currentData.poster_url ? getImageUrl(currentData.poster_url, (currentData as any).source) : getImageUrl(currentData.thumb_url, (currentData as any).source)}
                        alt={currentData.name}
                        className="w-full h-full object-cover"
                        loading="eager"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80';
                        }}
                      />
                    </div>
                  </div>
 
                  <div className="flex-1 min-w-0 space-y-1.5 sm:space-y-4 pb-1">
                    {/* Badges - chophim: FHD Song Ngữ Tập 10 */}
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      {currentData.quality && (
                        <span className="bg-slate-900/90 text-sky-300 border border-blue-800/80 text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded-md">
                          {currentData.quality}
                        </span>
                      )}
                      {currentData.lang && (
                        <span className="bg-slate-900/90 text-slate-200 border border-slate-700 text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded-md">
                          {currentData.lang}
                        </span>
                      )}
                      {currentData.episode_current && (
                        <span className="bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] sm:text-xs font-bold px-2 py-0.5 rounded-md">
                          {currentData.episode_current}
                        </span>
                      )}
                      {(currentData as any)?.tmdb?.vote_average ? (
                        <span className="bg-yellow-500 text-black text-[10px] sm:text-xs font-black px-1.5 sm:px-2 py-0.5 rounded flex items-center gap-1">
                          TMDb {(currentData as any).tmdb.vote_average.toFixed(1)}
                        </span>
                      ) : null}
                    </div>
 
                    {/* Title & Origin Name */}
                    <div className="space-y-1">
                      <h1 className="text-xl sm:text-3xl md:text-4xl lg:text-5xl font-black text-white drop-shadow-2xl tracking-tight leading-tight line-clamp-2">
                        {currentData.name}
                      </h1>
                      {currentData.origin_name && (
                        <p className="text-xs sm:text-sm md:text-base text-slate-300 font-medium drop-shadow line-clamp-1">
                          {currentData.origin_name}
                        </p>
                      )}
                    </div>
 
                    {/* Meta line chophim: Trạng thái / Loại / Năm / Thời lượng */}
                    <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-0.5 sm:gap-y-1 text-[10px] sm:text-xs text-slate-200 sm:text-slate-300 font-medium sm:font-normal">
                      {currentData.episode_current && currentData.episode_total && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Trạng thái:</span> <span className="text-white font-semibold">{currentData.episode_current} / {currentData.episode_total}</span></span>
                      )}
                      {!currentData.episode_total && currentData.episode_current && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Trạng thái:</span> <span className="text-white font-semibold">{currentData.episode_current}</span></span>
                      )}
                      {currentData.type && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Loại:</span> <span className="text-white">{currentData.type === 'series' ? 'Phim Bộ' : currentData.type === 'single' ? 'Phim Lẻ' : currentData.type}</span></span>
                      )}
                      {currentData.year && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Năm:</span> <span className="text-white">{currentData.year}</span></span>
                      )}
                      {currentData.time && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Thời lượng:</span> <span className="text-white">{currentData.time}</span></span>
                      )}
                      {currentData.country?.[0] && (
                        <span className="flex items-center gap-1"><span className="text-slate-500">Quốc gia:</span> <span className="text-white">{currentData.country[0].name}</span></span>
                      )}
                    </div>
 
                  {/* Primary Hero Actions */}
                  <div className="hidden sm:flex flex-wrap items-center gap-3 pt-1 sm:pt-2">
                    <button
                      id="hero-primary-play-btn"
                      onClick={handleStartPlay}
                      className="flex items-center gap-2 bg-gradient-to-r from-blue-600 via-sky-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white px-6 sm:px-8 py-2.5 sm:py-3.5 rounded-2xl font-bold text-sm sm:text-base shadow-2xl shadow-blue-600/40 transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                    >
                      <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-white" />
                      <span>Xem Phim Ngay</span>
                    </button>
 
                    {hasTrailer && (
                      <button
                        id="hero-open-trailer-btn"
                        onClick={handleUserWatchTrailer}
                        className="flex items-center gap-2 bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-white px-4 sm:px-5 py-2.5 sm:py-3.5 rounded-2xl font-bold text-xs sm:text-sm shadow-xl transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                      >
                        <Video className="w-4 h-4 text-rose-400" />
                        <span>Xem Trailer</span>
                      </button>
                    )}
 
                    <button
                      id="hero-toggle-list-btn"
                      onClick={() => onToggleMyList(currentData)}
                      className={`flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3.5 rounded-2xl font-bold text-xs sm:text-sm border transition-all cursor-pointer ${
                        inList
                          ? 'bg-emerald-600 border-emerald-500 text-white shadow-xl shadow-emerald-600/30'
                          : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      {inList ? (
                        <>
                          <Check className="w-4 h-4" />
                          <span>Đã lưu</span>
                        </>
                      ) : (
                        <>
                          <Bookmark className="w-4 h-4 text-sky-400" />
                          <span>Lưu phim</span>
                        </>
                      )}
                    </button>
 
                    {/* Share / Copy Link Button next to Save */}
                    <button
                      id="hero-share-btn"
                      onClick={handleShareMovie}
                      className="relative flex items-center justify-center p-2.5 sm:p-3.5 rounded-2xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white transition-all hover:scale-105 active:scale-95 cursor-pointer shadow-xl"
                      title="Sao chép link phim"
                      aria-label="Chia sẻ phim"
                    >
                      <Share2 className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
                      {isCopiedLink && (
                        <span className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1 rounded-md shadow-2xl animate-in fade-in z-30">
                          Đã sao chép link!
                        </span>
                      )}
                    </button>
 
                    {/* Watch Together Button */}
                    {currentAccount && activeProfile && episodes.length > 0 && (
                      <button
                        id="hero-watch-together-btn"
                        onClick={() => {
                          const ep = episodes[selectedServerIndex]?.server_data[0];
                          const server = episodes[selectedServerIndex];
                          if (ep && server && onCreateRoom) {
                            setSelectedEpisodeForRoom({ ep, server });
                            setShowCreateRoomModal(true);
                          }
                        }}
                        disabled={!!userActiveRoomId}
                        className={`flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3.5 rounded-2xl font-bold text-xs sm:text-sm border transition-all cursor-pointer ${
                          userActiveRoomId
                            ? 'bg-slate-800/50 border-slate-700/30 text-slate-500 cursor-not-allowed'
                            : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/50 text-emerald-300 hover:text-emerald-200'
                        }`}
                        title={userActiveRoomId ? 'Bạn đang ở trong một phòng khác' : 'Tạo phòng xem chung'}
                      >
                        <Users className="w-4 h-4" />
                        <span>Xem Chung</span>
                      </button>
                    )}
 
                    {/* Follow Button - Báo tập mới */}
                    {currentAccount && activeProfile && (
                      <button
                        id="hero-follow-btn"
                        onClick={handleToggleFollow}
                        className={`relative flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3.5 rounded-2xl font-bold text-xs sm:text-sm border transition-all cursor-pointer ${
                          isFollowed
                            ? 'bg-violet-600 border-violet-500 text-white shadow-xl shadow-violet-600/30'
                            : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:text-white hover:bg-slate-800'
                        }`}
                        title={isFollowed ? 'Đang theo dõi - bấm để bỏ' : 'Theo dõi để báo khi có tập mới'}
                      >
                        {isFollowed ? (
                          <>
                            <Check className="w-4 h-4" />
                            <span>Đang theo dõi</span>
                          </>
                        ) : (
                          <>
                            <Plus className="w-4 h-4 text-violet-400" />
                            <span>Theo dõi</span>
                          </>
                        )}
                        {hasNewEp && (
                          <span className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-red-500 rounded-full animate-pulse border-2 border-[#060a14]" title="Có tập mới!" />
                        )}
                      </button>
                    )}
 
                    {/* Offline Save Button - ONLY on Native App */}
                    {isNativeApp && currentAccount && activeProfile && (
                      <button
                        id="hero-offline-save-btn"
                        onClick={handleToggleOfflineSave}
                        disabled={isOfflineDownloading}
                        className={`flex items-center gap-2 px-4 sm:px-5 py-2.5 sm:py-3.5 rounded-2xl font-bold text-xs sm:text-sm border transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait ${
                          isOfflineSaved
                            ? 'bg-amber-600 border-amber-500 text-white shadow-xl shadow-amber-600/30'
                            : 'bg-slate-900/90 border-slate-700 text-slate-200 hover:text-white hover:bg-slate-800'
                        }`}
                        title={isOfflineSaved ? 'Đã lưu offline - bấm để xóa' : 'Tải xem offline (lưu 7 ngày) - chỉ trên App'}
                      >
                        {isOfflineDownloading ? (
                          <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>{offlineProgress}%</span>
                          </>
                        ) : isOfflineSaved ? (
                          <>
                            <Check className="w-4 h-4" />
                            <span>Đã lưu Offline</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4 text-amber-400" />
                            <span>Tải xem Offline</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Mobile Actions (Visible on Mobile, hidden on sm) */}
              <div className="sm:hidden mt-4 space-y-3 w-full">
                {/* Primary "Xem Phim Ngay" Button */}
                <button
                  onClick={handleStartPlay}
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 via-sky-600 to-indigo-600 active:from-blue-500 active:to-indigo-500 text-white py-3 rounded-xl font-bold text-sm shadow-xl shadow-blue-600/35 cursor-pointer active:scale-[0.98] transition-all"
                >
                  <Play className="w-4 h-4 fill-white" />
                  <span>Xem Phim Ngay</span>
                </button>

                {/* Grid of secondary actions */}
                <div className="grid grid-cols-2 gap-2.5 w-full">
                  {hasTrailer && (
                    <button
                      onClick={handleUserWatchTrailer}
                      className="flex items-center justify-center gap-1.5 bg-slate-900 border border-slate-800 text-white py-2.5 rounded-xl font-bold text-xs cursor-pointer active:bg-slate-800 transition-all active:scale-95 duration-150"
                    >
                      <Video className="w-3.5 h-3.5 text-rose-400" />
                      <span>Xem Trailer</span>
                    </button>
                  )}

                  <button
                    onClick={() => onToggleMyList(currentData)}
                    className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs border cursor-pointer transition-all active:scale-95 duration-150 ${
                      inList
                        ? 'bg-emerald-600/15 border-emerald-500 text-emerald-300'
                        : 'bg-slate-900 border-slate-800 text-slate-200 active:bg-slate-800'
                    }`}
                  >
                    {inList ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Đã lưu</span>
                      </>
                    ) : (
                      <>
                        <Bookmark className="w-3.5 h-3.5 text-sky-400" />
                        <span>Lưu phim</span>
                      </>
                    )}
                  </button>

                  {currentAccount && activeProfile && episodes.length > 0 && onCreateRoom && (
                    <button
                      onClick={() => {
                        const ep = episodes[selectedServerIndex]?.server_data[0];
                        const server = episodes[selectedServerIndex];
                        if (ep && server) {
                          setSelectedEpisodeForRoom({ ep, server });
                          setShowCreateRoomModal(true);
                        }
                      }}
                      disabled={!!userActiveRoomId}
                      className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs border cursor-pointer transition-all active:scale-95 duration-150 ${
                        userActiveRoomId
                          ? 'bg-slate-800/40 border-slate-800/20 text-slate-600 cursor-not-allowed'
                          : 'bg-emerald-600/10 border-emerald-500/40 text-emerald-400 hover:text-emerald-300'
                      }`}
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>Xem Chung</span>
                    </button>
                  )}

                  {currentAccount && activeProfile && (
                    <button
                      onClick={handleToggleFollow}
                      className={`relative flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-bold text-xs border cursor-pointer transition-all active:scale-95 duration-150 ${
                        isFollowed
                          ? 'bg-violet-600/15 border-violet-500 text-violet-300'
                          : 'bg-slate-900 border-slate-800 text-slate-200 active:bg-slate-800'
                      }`}
                    >
                      {isFollowed ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Đang theo dõi</span>
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5 text-violet-400" />
                          <span>Theo dõi</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* "Chia sẻ" as a clean full-width button right below the grid */}
                <button
                  onClick={handleShareMovie}
                  className="relative w-full flex items-center justify-center gap-1.5 py-2.5 bg-slate-900 border border-slate-800 text-slate-200 transition-all rounded-xl cursor-pointer active:bg-slate-800 font-bold text-xs active:scale-95 duration-150"
                >
                  <Share2 className="w-3.5 h-3.5 text-sky-400" />
                  <span>Chia sẻ</span>
                  {isCopiedLink && (
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow-xl animate-in fade-in z-30">
                      Copied!
                    </span>
                  )}
                </button>
              </div>
            </div>
            </div>
          </section>
 
        {/* Mobile-Only Premium Hero Section (Disabled in favor of Unified responsive hero) */}
        {false && (
        <section
          id="detail-hero-stage-mobile"
          className="block sm:hidden relative w-full pt-16 pb-4 bg-[#060a14] overflow-hidden select-none"
        >
          {/* Blurred Gradient Backdrop Cover */}
          <div className="absolute inset-0 z-0 pointer-events-none">
            <img
              src={detailBackdropSrc || fallbackThumbSrc || 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80'}
              alt=""
              className="w-full h-full object-cover scale-110 blur-[18px] opacity-65"
              onError={(e) => {
                (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80';
              }}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-[#060a14]/65 to-[#060a14]" />
          </div>
 
          {/* Core Content Layout */}
          <div className="relative z-10 px-4 pt-6 pb-2 space-y-4">
            {/* Poster & Meta Info Side-by-Side */}
            <div className="flex gap-4 items-start">
              {/* Left Side: Rectangular Poster Thumbnail */}
              <div className="w-[105px] shrink-0 aspect-[2/3] rounded-xl overflow-hidden shadow-[0_8px_24px_rgba(0,0,0,0.6)] border border-white/15 bg-slate-950 z-10">
                <img
                  src={getImageUrl(currentData.poster_url || currentData.thumb_url, (currentData as any).source)}
                  alt={currentData.name}
                  className="w-full h-full object-cover"
                  loading="eager"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80';
                  }}
                />
              </div>
 
              {/* Right Side: Title, Origin, Badges, and Metadata stacked */}
              <div className="flex-1 min-w-0 space-y-2 pt-1">
                <h1 className="text-base sm:text-lg font-black text-white leading-snug tracking-tight line-clamp-2">
                  {currentData.name}
                </h1>
                {currentData.origin_name && (
                  <p className="text-[11px] text-slate-300 font-medium line-clamp-1">
                    {currentData.origin_name}
                  </p>
                )}

                {/* Badges Row - Clean and Non-duplicating */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-[9px] font-black uppercase px-1.5 py-0.5 rounded shadow">
                    {currentData.quality || 'FHD'}
                  </span>
                  {currentData.lang && (
                    <span className="bg-slate-950/80 text-sky-400 border border-blue-900/40 text-[9px] font-bold px-1.5 py-0.5 rounded">
                      {currentData.lang}
                    </span>
                  )}
                  {currentData.episode_current && (
                    <span className="bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[9px] font-bold px-1.5 py-0.5 rounded">
                      {currentData.episode_current}
                    </span>
                  )}
                </div>

                {/* Clean non-repeating Meta row */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-200 font-semibold">
                  {currentData.year && (
                    <span>{currentData.year}</span>
                  )}
                  {currentData.time && (
                    <>
                      <span className="text-slate-500">•</span>
                      <span>{currentData.time}</span>
                    </>
                  )}
                  {currentData.country?.[0] && (
                    <>
                      <span className="text-slate-500">•</span>
                      <span className="truncate max-w-[90px]">{currentData.country[0].name}</span>
                    </>
                  )}
                </div>

                {/* Star rating match match % */}
                <div className="flex items-center gap-1.5 text-[10px] font-bold">
                  <span className="text-emerald-400">98% Phù hợp</span>
                  {(currentData as any)?.tmdb?.vote_average ? (
                    <>
                      <span className="text-slate-500">•</span>
                      <span className="text-yellow-400 flex items-center gap-0.5">
                        TMDb {(currentData as any).tmdb.vote_average.toFixed(1)}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
 
            {/* CTA section for Mobile: Prominent Watch Now and Horizontal-Scrollable actions */}
            <div className="space-y-3 pt-1">
              {/* Primary Full Width button */}
              <button
                onClick={handleStartPlay}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 via-sky-600 to-indigo-600 active:from-blue-500 active:to-indigo-500 text-white py-3 rounded-xl font-bold text-sm shadow-xl shadow-blue-600/30 active:scale-[0.98] transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-white" />
                <span>Xem Phim Ngay</span>
              </button>
 
              {/* Horizontal Scrollable Row for secondary actions */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 scrollbar-none snap-x snap-mandatory">
                {/* Xem Trailer */}
                {hasTrailer && (
                  <button
                    onClick={handleUserWatchTrailer}
                    className="flex items-center gap-1.5 bg-slate-900 border border-slate-800/80 text-white px-4 py-2 rounded-xl font-bold text-xs shrink-0 cursor-pointer snap-start active:bg-slate-800"
                  >
                    <Video className="w-3.5 h-3.5 text-rose-400" />
                    <span>Xem Trailer</span>
                  </button>
                )}
 
                {/* Lưu Phim */}
                <button
                  onClick={() => onToggleMyList(currentData)}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold text-xs border shrink-0 cursor-pointer snap-start transition-all ${
                    inList
                      ? 'bg-emerald-600/15 border-emerald-500 text-emerald-300'
                      : 'bg-slate-900 border-slate-800/80 text-slate-200 active:bg-slate-800'
                  }`}
                >
                  {inList ? (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Đã lưu</span>
                    </>
                  ) : (
                    <>
                      <Bookmark className="w-3.5 h-3.5 text-sky-400" />
                      <span>Lưu phim</span>
                    </>
                  )}
                </button>
 
                {/* Xem Chung */}
                {currentAccount && activeProfile && episodes.length > 0 && (
                  <button
                    onClick={() => {
                      const ep = episodes[selectedServerIndex]?.server_data[0];
                      const server = episodes[selectedServerIndex];
                      if (ep && server && onCreateRoom) {
                        setSelectedEpisodeForRoom({ ep, server });
                        setShowCreateRoomModal(true);
                      }
                    }}
                    disabled={!!userActiveRoomId}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold text-xs border shrink-0 cursor-pointer snap-start transition-all ${
                      userActiveRoomId
                        ? 'bg-slate-800/40 border-slate-800/20 text-slate-600 cursor-not-allowed'
                        : 'bg-emerald-600/10 border-emerald-500/40 text-emerald-400 hover:text-emerald-300'
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>Xem Chung</span>
                  </button>
                )}
 
                {/* Theo Dõi */}
                {currentAccount && activeProfile && (
                  <button
                    onClick={handleToggleFollow}
                    className={`relative flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold text-xs border shrink-0 cursor-pointer snap-start transition-all ${
                      isFollowed
                        ? 'bg-violet-600/15 border-violet-500 text-violet-300'
                        : 'bg-slate-900 border-slate-800/80 text-slate-200 active:bg-slate-800'
                    }`}
                  >
                    {isFollowed ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Đang theo dõi</span>
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5 text-violet-400" />
                        <span>Theo dõi</span>
                      </>
                    )}
                    {hasNewEp && (
                      <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    )}
                  </button>
                )}
 
                {/* Chia Sẻ */}
                <button
                  onClick={handleShareMovie}
                  className="relative flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 border border-slate-800/80 text-slate-200 transition-all cursor-pointer snap-start active:bg-slate-800 shrink-0 font-bold text-xs"
                >
                  <Share2 className="w-3.5 h-3.5 text-sky-400" />
                  <span>Chia sẻ</span>
                  {isCopiedLink && (
                    <span className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap bg-blue-600 text-white text-[9px] font-bold px-2 py-0.5 rounded shadow-xl animate-in fade-in z-30">
                      Copied!
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </section>
        )}

        {/* Dedicated Centered Trailer Popup Modal */}
        <AnimatePresence>
          {showTrailer && hasTrailer && trailerInfo && (
            <motion.div
              id="trailer-modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[80] bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 md:p-8"
              onClick={handleCloseTrailer}
            >
              <motion.div
                id="trailer-modal-card"
                initial={{ opacity: 0, scale: 0.95, y: 15 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 15 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="relative w-full max-w-4xl bg-[#090e1a] border border-slate-700/90 rounded-2xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header of Trailer Modal */}
                <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-3.5 bg-slate-900/95 border-b border-slate-800">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-rose-600/20 text-rose-400 border border-rose-500/30 shrink-0">
                      <Video className="w-4 h-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-sm sm:text-base font-bold text-white truncate">
                        Trailer: {currentData.name}
                      </h3>
                      {currentData.origin_name && (
                        <p className="text-xs text-slate-400 truncate hidden sm:block">
                          {currentData.origin_name}
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    id="trailer-modal-close-btn"
                    onClick={handleCloseTrailer}
                    className="flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white transition-all cursor-pointer border border-slate-700 hover:border-rose-500 shrink-0"
                    title="Đóng trailer (Esc)"
                    aria-label="Đóng trailer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Video Stage */}
                <div className="relative w-full aspect-video bg-black flex items-center justify-center">
                  {trailerInfo.type === 'youtube' ? (
                    <iframe
                      ref={iframeRef}
                      src={youtubeEmbedUrl}
                      title={`Trailer ${currentData.name}`}
                      className="w-full h-full border-0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                    />
                  ) : (
                    <video
                      ref={videoRef}
                      src={trailerInfo.directUrl}
                      autoPlay
                      controls
                      playsInline
                      className="w-full h-full object-contain"
                    />
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main Content Body - Optimized for Desktop, Tablet, and Mobile */}
        <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8 sm:space-y-10 flex-1">

          {/* Details & Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
            {/* Left 2 Cols on tablet/desktop: Highlights & Synopsis */}
            <div className="md:col-span-2 space-y-6">
              {/* Highlights Bar - Hidden on Mobile, Flex on Desktop */}
              <div className="hidden sm:flex flex-wrap items-center gap-2.5 sm:gap-3 p-4 rounded-2xl bg-[#0c1427] border border-slate-800/80 text-xs sm:text-sm">
                <span className="text-emerald-400 font-bold">98% Phù hợp</span>
                <span className="text-slate-600">•</span>
                <span className="text-slate-300 flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-400" />
                  <span>Năm {currentData.year || '2024'}</span>
                </span>
                {currentData.time && (
                  <>
                    <span className="text-slate-600">•</span>
                    <span className="text-slate-300 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-400" />
                      <span>{currentData.time}</span>
                    </span>
                  </>
                )}
                {currentData.episode_current && (
                  <>
                    <span className="text-slate-600">•</span>
                    <span className="text-sky-300 font-bold bg-sky-950/60 border border-sky-800/60 px-2 py-0.5 rounded-md">
                      {currentData.episode_current}
                    </span>
                  </>
                )}
              </div>
 
              {/* Synopsis Section (Desktop & Tablet) */}
              <div className="hidden sm:block p-5 sm:p-6 rounded-2xl bg-[#0c1427] border border-slate-800/80 space-y-3">
                <h3 className="text-sm sm:text-base font-black text-white uppercase tracking-wider flex items-center gap-2">
                  <Info className="w-4 h-4 text-sky-400" />
                  <span>Nội dung phim</span>
                </h3>
                <div className="text-xs sm:text-sm md:text-base text-slate-300 leading-relaxed max-h-72 overflow-y-auto pr-2">
                  {currentData.content ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(currentData.content),
                      }}
                    />
                  ) : (
                    <p>
                      Trải nghiệm bộ phim hấp dẫn với độ phân giải cao và âm thanh sống động. Bạn có thể
                      lựa chọn bất kỳ tập phim nào bên dưới để thưởng thức ngay lập tức mà không có
                      bất kỳ quảng cáo phiền toái nào.
                    </p>
                  )}
                </div>
              </div>
 
              {/* Synopsis Section (Mobile Only with "Xem thêm" expander toggle) */}
              <div className="block sm:hidden p-4 rounded-xl bg-[#0c1427] border border-slate-800/60 space-y-2.5">
                <h3 className="text-xs font-black text-white uppercase tracking-wider flex items-center gap-2 pb-1 border-b border-slate-800/40">
                  <Info className="w-3.5 h-3.5 text-sky-400" />
                  <span>Nội dung phim</span>
                </h3>
                <div className="relative text-xs text-slate-300 leading-relaxed pr-1">
                  <div
                    className={isSynopsisExpanded ? '' : 'line-clamp-4 overflow-hidden'}
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(currentData.content || 'Trải nghiệm bộ phim hấp dẫn với độ phân giải cao và âm thanh sống động. Bạn có thể lựa chọn bất kỳ tập phim nào bên dưới để thưởng thức ngay lập tức mà không có bất kỳ quảng cáo phiền toái nào.'),
                    }}
                  />
                  
                  {/* Expand/Collapse Toggle Button */}
                  <button
                    onClick={() => setIsSynopsisExpanded(!isSynopsisExpanded)}
                    className="mt-2 text-xs font-bold text-sky-400 active:text-sky-300 flex items-center gap-1 cursor-pointer focus:outline-none"
                  >
                    <span>{isSynopsisExpanded ? 'Thu gọn' : 'Xem thêm'}</span>
                    <span>{isSynopsisExpanded ? '▲' : '▼'}</span>
                  </button>
                </div>
              </div>

              {/* Episode List — đưa lên lấp khoảng trống dưới Nội dung phim (cột trái) */}
              <section id="detail-episodes-section" className="p-5 sm:p-6 rounded-2xl bg-[#0c1427] border border-blue-900/50 space-y-5">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-sky-400 shrink-0">
                      <Tv className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base sm:text-lg font-bold text-white">
                        Danh Sách Tập Phim
                      </h3>
                      <p className="text-xs text-slate-400">
                        Tổng cộng {allEpisodesForDisplay.length} tập • Hỗ trợ phát chuẩn Full HD
                      </p>
                    </div>
                  </div>

                  {/* Server Selector if multiple servers exist */}
                  {episodes.length > 1 && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                      <span className="text-xs text-slate-400 shrink-0">Chọn Nguồn / Server:</span>
                      {episodes.map((srv, idx) => (
                        <button
                          key={idx}
                          id={`select-server-tab-${idx}`}
                          onClick={() => setSelectedServerIndex(idx)}
                          className={`text-xs px-3.5 py-1.5 rounded-xl font-medium transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                            selectedServerIndex === idx
                              ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-bold border border-blue-400'
                              : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-700'
                          }`}
                        >
                          {srv.sourceLabel && (
                            <span className="text-[10px] px-1 py-0.2 rounded bg-slate-950/80 text-sky-300 font-extrabold border border-blue-800/60">
                              {srv.sourceLabel}
                            </span>
                          )}
                          <span>{srv.server_name || `Server ${idx + 1}`}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Chophim-style next episode notification + dropdown lịch chiếu */}
                {nextEpisode && (() => {
                  const airDate = new Date(nextEpisode.air_date);
                  const isValid = !isNaN(airDate.getTime());
                  const formatted = isValid
                    ? airDate.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
                    : nextEpisode.air_date;
                  const today = new Date(); today.setHours(0,0,0,0);
                  const air0 = new Date(airDate); air0.setHours(0,0,0,0);
                  const diffDays = Math.round((air0.getTime() - today.getTime()) / 86400000);
                  let countdown = '';
                  if (diffDays === 0) countdown = ' • Hôm nay';
                  else if (diffDays === 1) countdown = ' • Ngày mai';
                  else if (diffDays > 1 && diffDays <= 7) countdown = ` • Còn ${diffDays} ngày nữa`;
                  else if (diffDays < 0) countdown = ` • Đã qua ${Math.abs(diffDays)} ngày`;
                  return (
                    <div className="rounded-xl bg-gradient-to-r from-sky-500/10 via-blue-500/10 to-indigo-500/10 border border-sky-500/20 backdrop-blur-sm overflow-hidden">
                      <div className="flex items-start gap-3 sm:gap-3.5 p-3.5 sm:p-4">
                        <div className="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-sky-500/15 border border-sky-500/20 flex items-center justify-center text-sky-400">
                          <CalendarClock className="w-4 h-4 sm:w-5 sm:h-5" />
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <p className="text-xs sm:text-sm font-bold text-sky-200">
                            Tập {nextEpisode.episode_number} dự kiến phát sóng
                          </p>
                          <p className="text-xs sm:text-sm text-slate-200">
                            <span className="font-semibold text-white capitalize">{formatted}</span>
                            <span className="text-sky-300 font-medium">{countdown}</span>
                          </p>
                        </div>
                        {seasonEpisodes.length > 0 && (
                          <button
                            onClick={() => setShowSchedule(!showSchedule)}
                            className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-sky-300 hover:text-white bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/20 px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                          >
                            <span>Lịch chiếu</span>
                            <motion.span animate={{ rotate: showSchedule ? 180 : 0 }} transition={{ duration: 0.2 }} className="text-[10px]">▼</motion.span>
                          </button>
                        )}
                      </div>
                      <AnimatePresence>
                        {showSchedule && seasonEpisodes.length > 0 && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.25, ease: 'easeOut' }}
                            className="border-t border-sky-500/15 bg-slate-900/30 overflow-hidden"
                          >
                            <div className="p-3 sm:p-4">
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-1.5 max-h-64 overflow-y-auto pr-1">
                                {seasonEpisodes.map((ep) => {
                                  const epAir = ep.air_date ? new Date(ep.air_date) : null;
                                  const isFuture = epAir ? epAir.getTime() > Date.now() : false;
                                  const fmt = epAir && !isNaN(epAir.getTime())
                                    ? epAir.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
                                    : 'Chưa có lịch';
                                  return (
                                    <div key={ep.episode_number} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs border ${ep.episode_number === nextEpisode.episode_number ? 'bg-sky-500/15 border-sky-500/30 text-sky-200' : isFuture ? 'bg-slate-800/50 border-slate-700/50 text-slate-400' : 'bg-slate-800/80 border-slate-700/60 text-slate-200'}`}>
                                      <span className="font-semibold">Tập {ep.episode_number}</span>
                                      <span className="text-[11px]">{fmt}</span>
                                      {isFuture && <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded">soon</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })()}

                {/* Episode Search for long series */}
                {allEpisodesForDisplay.length > 15 && (
                  <div className="max-w-xs">
                    <input
                      type="text"
                      placeholder="Tìm nhanh tập (vd: 1, 10, tập cuối...)"
                      value={episodeSearch}
                      onChange={(e) => setEpisodeSearch(e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}

                {/* Episode Grid */}
                {isLoading ? (
                  <div className="p-12 text-center text-slate-400 text-sm animate-pulse">
                    Đang nạp danh sách tập phim...
                  </div>
                ) : filteredEpisodes.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-5 gap-2.5 sm:gap-3 max-h-96 overflow-y-auto overflow-x-hidden p-1 -m-1 pr-2 scrollbar-thin">
                    {filteredEpisodes.map((ep, idx) => {
                      const isSoon = (ep as any).isSoon;
                      if (isSoon) {
                        return (
                          <div
                            key={ep.slug || idx}
                            id={`detail-ep-btn-${ep.slug}`}
                            className="flex flex-col items-center justify-center p-2.5 sm:p-3 bg-slate-800/40 border border-slate-700/40 rounded-xl text-center opacity-60 cursor-not-allowed select-none"
                          >
                            <span className="text-xs sm:text-sm font-bold text-slate-400 line-clamp-1">
                              {ep.name.startsWith('Tập') ? ep.name : `Tập ${ep.name}`}
                            </span>
                            <span className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/20 px-1.5 py-0.5 rounded-full mt-1 font-semibold">soon</span>
                          </div>
                        );
                      }
                      return (
                        <button
                          key={ep.slug || idx}
                          id={`detail-ep-btn-${ep.slug}`}
                          onClick={() => {
                            if (onPlayEpisode) {
                              onPlayEpisode(currentData, ep, currentServer);
                            } else if (onPlayMovie) {
                              onPlayMovie(currentData);
                            }
                          }}
                          className="group flex flex-col items-center justify-center p-2.5 sm:p-3 bg-slate-900 hover:bg-blue-600 border border-slate-800 hover:border-blue-500 rounded-xl transition-colors duration-200 text-center cursor-pointer shadow-sm hover:shadow-md will-change-transform"
                        >
                          <span className="text-xs sm:text-sm font-bold text-white group-hover:text-white line-clamp-1">
                            {ep.name.startsWith('Tập') ? ep.name : `Tập ${ep.name}`}
                          </span>
                          <span className="text-[10px] text-sky-400 group-hover:text-sky-100 flex items-center gap-1 mt-1 font-semibold">
                            <Play className="w-2.5 h-2.5 fill-current" /> Phát HD
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="p-8 bg-slate-900/50 rounded-xl text-center text-slate-400 text-sm border border-slate-800">
                    {episodeSearch
                      ? 'Không tìm thấy tập phim phù hợp.'
                      : 'Phim đang cập nhật tập mới, bạn có thể nhấn "Xem Phim Ngay" để phát nguồn chính.'}
                  </div>
                )}
              </section>
            </div>

            {/* Right Column: Cast, Directors, Meta Card */}
            <div className="space-y-6">
              <div className="p-5 sm:p-6 rounded-2xl bg-[#0c1427] border border-slate-800/80 space-y-4 text-xs sm:text-sm">
                <h4 className="text-xs uppercase font-extrabold tracking-wider text-sky-400 pb-2 border-b border-slate-800">
                  Thông Tin Chi Tiết
                </h4>

                {currentData.actor && currentData.actor.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-slate-400 font-semibold flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-sky-400" />
                        <span>Diễn viên:</span>
                      </span>
                      {onSearchSubmit && (
                        <span className="text-[10px] text-slate-500 italic">Bấm để tìm phim</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(Array.isArray(currentData.actor) ? currentData.actor : [String(currentData.actor)]).map(
                        (act, i) => {
                          const actorName = typeof act === 'string' ? act.trim() : String(act).trim();
                          if (!actorName) return null;
                          return (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                if (onSearchSubmit) {
                                  onSearchSubmit(actorName);
                                  onClose();
                                }
                              }}
                              title={`Tìm tất cả phim của diễn viên ${actorName}`}
                              className="group/act inline-flex items-center gap-1.5 bg-slate-900/90 hover:bg-sky-600/90 text-slate-200 hover:text-white px-2.5 py-1 rounded-lg border border-slate-800 hover:border-sky-500 text-xs font-medium transition-all active:scale-95 text-left cursor-pointer"
                            >
                              <Search className="w-3 h-3 text-slate-400 group-hover/act:text-white transition-colors" />
                              <span>{actorName}</span>
                            </button>
                          );
                        }
                      )}
                    </div>
                  </div>
                )}

                {currentData.director && currentData.director.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-slate-400 font-semibold flex items-center gap-1.5">
                        <span>Đạo diễn:</span>
                      </span>
                      {onSearchSubmit && (
                        <span className="text-[10px] text-slate-500 italic">Bấm để tìm phim</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(Array.isArray(currentData.director) ? currentData.director : [String(currentData.director)]).map(
                        (dir, i) => {
                          const dirName = typeof dir === 'string' ? dir.trim() : String(dir).trim();
                          if (!dirName) return null;
                          return (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                if (onSearchSubmit) {
                                  onSearchSubmit(dirName);
                                  onClose();
                                }
                              }}
                              title={`Tìm tất cả phim của đạo diễn ${dirName}`}
                              className="group/dir inline-flex items-center gap-1.5 bg-slate-900/90 hover:bg-sky-600/90 text-slate-200 hover:text-white px-2.5 py-1 rounded-lg border border-slate-800 hover:border-sky-500 text-xs font-medium transition-all active:scale-95 text-left cursor-pointer"
                            >
                              <Search className="w-3 h-3 text-slate-400 group-hover/dir:text-white transition-colors" />
                              <span>{dirName}</span>
                            </button>
                          );
                        }
                      )}
                    </div>
                  </div>
                )}

                {currentData.category && currentData.category.length > 0 && (
                  <div>
                    <span className="text-slate-400 block mb-1.5 font-semibold">Thể loại:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {currentData.category.map((cat) => (
                        <button
                          key={cat.slug}
                          type="button"
                          onClick={() => {
                            if (onSelectGenre) {
                              onSelectGenre(cat.slug);
                              onClose();
                            } else if (onSearchSubmit) {
                              onSearchSubmit(cat.name);
                              onClose();
                            }
                          }}
                          title={`Xem phim thể loại ${cat.name}`}
                          className="bg-blue-950/60 hover:bg-blue-800/80 text-sky-300 hover:text-white px-2.5 py-1 rounded-lg border border-blue-900/60 hover:border-sky-500 text-xs font-medium transition-all active:scale-95 cursor-pointer"
                        >
                          {cat.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {currentData.country && currentData.country.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-slate-400 font-semibold flex items-center gap-1.5">
                        <Globe className="w-3.5 h-3.5 text-slate-400" />
                        <span>Quốc gia:</span>
                      </span>
                      {onSearchSubmit && (
                        <span className="text-[10px] text-slate-500 italic">Bấm để tìm phim</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {currentData.country.map((c) => (
                        <button
                          key={c.slug}
                          type="button"
                          onClick={() => {
                            if (onSelectCountry) {
                              onSelectCountry(c.slug);
                              onClose();
                            } else if (onSearchSubmit) {
                              onSearchSubmit(c.name);
                              onClose();
                            }
                          }}
                          title={`Lọc phim quốc gia ${c.name}`}
                          className="group/country inline-flex items-center gap-1.5 bg-slate-900/90 hover:bg-sky-600/90 text-slate-200 hover:text-white px-2.5 py-1 rounded-lg border border-slate-800 hover:border-sky-500 text-xs font-medium transition-all active:scale-95 text-left cursor-pointer"
                        >
                          <Search className="w-3 h-3 text-slate-400 group-hover/country:text-white transition-colors" />
                          <span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Episode List Section - đã chuyển lên cột trái, ẩn bản full-width cũ */}
          {false && (
          <section id="detail-episodes-section-hidden" className="p-5 sm:p-8 rounded-2xl bg-[#0c1427] border border-blue-900/50 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-sky-400">
                  <Tv className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base sm:text-xl font-bold text-white">
                    Danh Sách Tập Phim
                  </h3>
                  <p className="text-xs text-slate-400">
                    Tổng cộng {allEpisodesForDisplay.length} tập • Hỗ trợ phát chuẩn Full HD
                  </p>
                </div>
              </div>

              {/* Server Selector if multiple servers exist */}
              {episodes.length > 1 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="text-xs text-slate-400 shrink-0">Chọn Nguồn / Server:</span>
                  {episodes.map((srv, idx) => (
                    <button
                      key={idx}
                      id={`select-server-tab-${idx}`}
                      onClick={() => setSelectedServerIndex(idx)}
                      className={`text-xs px-3.5 py-1.5 rounded-xl font-medium transition-all shrink-0 cursor-pointer flex items-center gap-1.5 ${
                        selectedServerIndex === idx
                          ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 font-bold border border-blue-400'
                          : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-700'
                      }`}
                    >
                      {srv.sourceLabel && (
                        <span className="text-[10px] px-1 py-0.2 rounded bg-slate-950/80 text-sky-300 font-extrabold border border-blue-800/60">
                          {srv.sourceLabel}
                        </span>
                      )}
                      <span>{srv.server_name || `Server ${idx + 1}`}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Chophim-style next episode notification + dropdown lịch chiếu */}
            {nextEpisode && (() => {
              const airDate = new Date(nextEpisode.air_date);
              const isValid = !isNaN(airDate.getTime());
              const formatted = isValid
                ? airDate.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
                : nextEpisode.air_date;
              const today = new Date(); today.setHours(0,0,0,0);
              const air0 = new Date(airDate); air0.setHours(0,0,0,0);
              const diffDays = Math.round((air0.getTime() - today.getTime()) / 86400000);
              // Ẩn banner nếu ngày chiếu đã qua (TMDB lag) – tránh "dự kiến + đã qua N ngày"
              if (diffDays < 0) return null;
              let countdown = '';
              if (diffDays === 0) countdown = ' • Hôm nay';
              else if (diffDays === 1) countdown = ' • Ngày mai';
              else if (diffDays > 1 && diffDays <= 7) countdown = ` • Còn ${diffDays} ngày nữa`;
              return (
                <div className="rounded-xl bg-gradient-to-r from-sky-500/10 via-blue-500/10 to-indigo-500/10 border border-sky-500/20 backdrop-blur-sm overflow-hidden">
                  <div className="flex items-start gap-3 sm:gap-3.5 p-3.5 sm:p-4">
                    <div className="shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-sky-500/15 border border-sky-500/20 flex items-center justify-center text-sky-400">
                      <CalendarClock className="w-4 h-4 sm:w-5 sm:h-5" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <p className="text-xs sm:text-sm font-bold text-sky-200">
                        Tập {nextEpisode.episode_number} dự kiến phát sóng
                      </p>
                      <p className="text-xs sm:text-sm text-slate-200">
                        <span className="font-semibold text-white capitalize">{formatted}</span>
                        <span className="text-sky-300 font-medium">{countdown}</span>
                      </p>
                    </div>
                    {seasonEpisodes.length > 0 && (
                      <button
                        onClick={() => setShowSchedule(!showSchedule)}
                        className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-sky-300 hover:text-white bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/20 px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                      >
                        <span>Lịch chiếu</span>
                        <motion.span animate={{ rotate: showSchedule ? 180 : 0 }} transition={{ duration: 0.2 }} className="text-[10px]">▼</motion.span>
                      </button>
                    )}
                  </div>
                  <AnimatePresence>
                    {showSchedule && seasonEpisodes.length > 0 && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeOut' }}
                        className="border-t border-sky-500/15 bg-slate-900/30 overflow-hidden"
                      >
                        <div className="p-3 sm:p-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-64 overflow-y-auto pr-1">
                            {seasonEpisodes.map((ep) => {
                              const epAir = ep.air_date ? new Date(ep.air_date) : null;
                              const isFuture = epAir ? epAir.getTime() > Date.now() : false;
                              const fmt = epAir && !isNaN(epAir.getTime())
                                ? epAir.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
                                : 'Chưa có lịch';
                              return (
                                <div key={ep.episode_number} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs border ${ep.episode_number === nextEpisode.episode_number ? 'bg-sky-500/15 border-sky-500/30 text-sky-200' : isFuture ? 'bg-slate-800/50 border-slate-700/50 text-slate-400' : 'bg-slate-800/80 border-slate-700/60 text-slate-200'}`}>
                                  <span className="font-semibold">Tập {ep.episode_number}</span>
                                  <span className="text-[11px]">{fmt}</span>
                                  {isFuture && <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded">soon</span>}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })()}

            {/* Episode Search for long series */}
            {allEpisodesForDisplay.length > 15 && (
              <div className="max-w-xs">
                <input
                  type="text"
                  placeholder="Tìm nhanh tập (vd: 1, 10, tập cuối...)"
                  value={episodeSearch}
                  onChange={(e) => setEpisodeSearch(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Episode Grid */}
            {isLoading ? (
              <div className="p-12 text-center text-slate-400 text-sm animate-pulse">
                Đang nạp danh sách tập phim...
              </div>
            ) : filteredEpisodes.length > 0 ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-2.5 sm:gap-3 max-h-96 overflow-y-auto overflow-x-hidden p-1 -m-1 pr-2 scrollbar-thin">
                {filteredEpisodes.map((ep, idx) => {
                  const isSoon = (ep as any).isSoon;
                  if (isSoon) {
                    return (
                      <div
                        key={ep.slug || idx}
                        id={`detail-ep-btn-${ep.slug}`}
                        className="flex flex-col items-center justify-center p-2.5 sm:p-3 bg-slate-800/40 border border-slate-700/40 rounded-xl text-center opacity-60 cursor-not-allowed select-none"
                      >
                        <span className="text-xs sm:text-sm font-bold text-slate-400 line-clamp-1">
                          {ep.name.startsWith('Tập') ? ep.name : `Tập ${ep.name}`}
                        </span>
                        <span className="text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/20 px-1.5 py-0.5 rounded-full mt-1 font-semibold">soon</span>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={ep.slug || idx}
                      id={`detail-ep-btn-${ep.slug}`}
                      onClick={() => {
                        if (onPlayEpisode) {
                          onPlayEpisode(currentData, ep, currentServer);
                        } else if (onPlayMovie) {
                          onPlayMovie(currentData);
                        }
                      }}
                      className="group flex flex-col items-center justify-center p-2.5 sm:p-3 bg-slate-900 hover:bg-blue-600 border border-slate-800 hover:border-blue-500 rounded-xl transition-colors duration-200 text-center cursor-pointer shadow-sm hover:shadow-md will-change-transform"
                    >
                      <span className="text-xs sm:text-sm font-bold text-white group-hover:text-white line-clamp-1">
                        {ep.name.startsWith('Tập') ? ep.name : `Tập ${ep.name}`}
                      </span>
                      <span className="text-[10px] text-sky-400 group-hover:text-sky-100 flex items-center gap-1 mt-1 font-semibold">
                        <Play className="w-2.5 h-2.5 fill-current" /> Phát HD
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 bg-slate-900/50 rounded-xl text-center text-slate-400 text-sm border border-slate-800">
                {episodeSearch
                  ? 'Không tìm thấy tập phim phù hợp.'
                  : 'Phim đang cập nhật tập mới, bạn có thể nhấn "Xem Phim Ngay" để phát nguồn chính.'}
              </div>
            )}
          </section>
          )}

          {/* Related Movies Section */}
          {relatedMovies.length > 0 && (
            <section id="detail-related-section" className="space-y-4 pt-2 sm:pt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base sm:text-xl font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
                  <span>Phim Tương Tự Cùng Thể Loại</span>
                </h3>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3 sm:gap-4">
                {relatedMovies.map((m) => (
                  <div
                    key={m.slug}
                    id={`detail-related-movie-${m.slug}`}
                    tabIndex={0}
                    role="button"
                    aria-label={`Xem ${m.name}`}
                    data-tv-card={`related-${m.slug}`}
                    onClick={() => {
                      if (onSelectRelatedMovie) {
                        onSelectRelatedMovie(m);
                      }
                      if (containerRef.current) {
                        containerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                        e.preventDefault();
                        (e.currentTarget as HTMLElement).click();
                      }
                    }}
                    className="group cursor-pointer bg-slate-900 rounded-xl overflow-hidden border border-slate-800 hover:border-blue-500/80 transition-all hover:scale-105 shadow-md flex flex-col"
                  >
                    <div className="aspect-[2/3] w-full overflow-hidden relative">
                      <img
                        src={getImageUrl(m.poster_url || m.thumb_url)}
                        alt={m.name}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src =
                            'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80';
                        }}
                      />
                      <div className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="p-2 bg-blue-600 rounded-full text-white shadow-lg">
                          <Play className="w-4 h-4 fill-white" />
                        </span>
                      </div>
                    </div>
                    <div className="p-2 sm:p-2.5 flex-1 flex flex-col justify-between">
                      <h4 className="text-xs font-semibold text-white truncate group-hover:text-sky-300">
                        {m.name}
                      </h4>
                      <span className="text-[10px] text-slate-400 mt-1">{m.year || '2024'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Active Watch Together Rooms */}
          {activeRooms.length > 0 && (
            <section className="px-4 sm:px-6 md:px-8 py-6">
              <div className="flex items-center gap-2 mb-4">
                <Users className="w-5 h-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-white">
                  Phòng đang xem chung
                  <span className="ml-2 text-sm font-normal text-slate-400">({activeRooms.length})</span>
                </h3>
              </div>
              <div className="space-y-2">
                {activeRooms.map((room) => (
                  <div
                    key={room.roomId}
                    className="flex items-center justify-between p-3 sm:p-4 rounded-xl bg-slate-800/40 border border-slate-700/30 hover:border-emerald-500/30 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-emerald-600/20 flex items-center justify-center shrink-0">
                        <Users className="w-5 h-5 text-emerald-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-white truncate">{room.hostName}</span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-700/50 text-slate-400">
                            {room.episode}
                          </span>
                          {room.visibility === 'private' ? (
                            <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                          ) : (
                            <Globe className="w-3 h-3 text-sky-400 shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-400 mt-0.5">
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {room.viewersCount} đang xem
                          </span>
                          <span>•</span>
                          <span>{new Date(room.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (userActiveRoomId) {
                          onShowToast?.('Bạn đang ở trong một phòng khác. Vui lòng rời phòng trước khi tham gia phòng mới.', 'warning');
                          return;
                        }
                        if (room.visibility === 'public') {
                          onJoinRoom?.(room.roomId, '');
                        } else {
                          setJoinTargetRoom(room);
                        }
                      }}
                      disabled={!!userActiveRoomId}
                      className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all shrink-0 ml-3 ${
                        userActiveRoomId
                          ? 'bg-slate-700/30 text-slate-500 cursor-not-allowed'
                          : 'bg-sky-600 hover:bg-sky-500 text-white'
                      }`}
                    >
                      Vào phòng
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Bottom Footer */}
          <footer className="pt-6 pb-4 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between gap-3 text-slate-500 text-xs">
            <p>© 2026 Gấu Cinema • Trải nghiệm điện ảnh gia đình chất lượng cao</p>
            <button
              onClick={onClose}
              className="text-sky-400 hover:text-sky-300 font-semibold cursor-pointer"
            >
              ← Quay lại danh sách phim
            </button>
          </footer>
        </main>

      {/* Watch Together Modals */}
      {showCreateRoomModal && currentAccount && activeProfile && selectedEpisodeForRoom && currentData && (
        <CreateRoomModal
          isOpen={showCreateRoomModal}
          filmName={currentData.name}
          episode={selectedEpisodeForRoom.ep.name}
          onClose={() => { setShowCreateRoomModal(false); setSelectedEpisodeForRoom(null); }}
          onSubmit={async (password, visibility) => {
            if (onCreateRoom) {
              await onCreateRoom(
                currentData.slug,
                currentData.name,
                currentData.thumb_url || currentData.poster_url,
                selectedEpisodeForRoom.ep.name,
                selectedEpisodeForRoom.ep.slug,
                selectedEpisodeForRoom.server.server_name,
                selectedEpisodeForRoom.ep.link_m3u8,
                password,
                visibility
              );
              setShowCreateRoomModal(false);
              setSelectedEpisodeForRoom(null);
            }
          }}
        />
      )}

      {joinTargetRoom && (
        <JoinRoomModal
          isOpen={!!joinTargetRoom}
          roomId={joinTargetRoom.roomId}
          hostName={joinTargetRoom.hostName}
          episode={joinTargetRoom.episode}
          viewersCount={joinTargetRoom.viewersCount}
          onClose={() => setJoinTargetRoom(null)}
          onSubmit={async (password) => {
            if (onJoinRoom) {
              await onJoinRoom(joinTargetRoom.roomId, password);
              setJoinTargetRoom(null);
            }
          }}
        />
      )}
    </motion.div>
  );
};
