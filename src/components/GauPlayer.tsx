import React, { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import Hls from 'hls.js';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, PictureInPicture2, X, RotateCcw, RotateCw, SkipForward, SkipBack, List, Server, Sun, ChevronDown, FastForward, Lock } from 'lucide-react';
import { EpisodeServer, Movie, MovieEpisode, Account, UserProfile } from '../types';
import { getMirrorUrls } from '../utils/mirrorUrls';
import { loadCleanedM3u8Url, revokeBlobUrl } from '../utils/m3u8Cleaner';
import { getFullApiUrl, verifyBackendUrl } from '../services/apiConfig';
import { resolveImdbId } from '../utils/introResolve';
import { presenceService } from '../services/presenceService';
import { Capacitor } from '@capacitor/core';
import { enterNativePip, setNativeVideoPlaying, checkNativePipSupported, setImmersiveMode, isNativeAndroidApp } from '../utils/nativeVideoPlayer';
import { focusNearest, isTvModeActive } from '../utils/tvRemote';
import { useTvMode } from '../hooks/useTvMode';

function isNativeAndroid(): boolean {
  try { return isNativeAndroidApp(); } catch { return false; }
}

type IntroSegment = { start_sec: number; end_sec: number; start_ms: number; end_ms: number; confidence?: number; submission_count?: number } | null;
type SegmentsResponse = { imdb_id: string; season: number; episode: number; intro: IntroSegment; recap: IntroSegment; outro: IntroSegment };

// Some IntroDB records only carry start_ms/end_ms (no start_sec/end_sec).
// Normalize so segment detection always has second-based bounds.
function normalizeSegments(data: SegmentsResponse | null | undefined): SegmentsResponse | null {
  if (!data || typeof data !== 'object') return null;
  const fix = (seg: IntroSegment): IntroSegment => {
    if (!seg || typeof seg !== 'object') return null;
    const s = seg as any;
    const start_sec = typeof s.start_sec === 'number' ? s.start_sec : (typeof s.start_ms === 'number' ? s.start_ms / 1000 : NaN);
    const end_sec = typeof s.end_sec === 'number' ? s.end_sec : (typeof s.end_ms === 'number' ? s.end_ms / 1000 : NaN);
    if (!isFinite(start_sec) || !isFinite(end_sec) || end_sec <= start_sec) return null;
    return { ...s, start_sec, end_sec };
  };
  return { ...data, intro: fix(data.intro), recap: fix(data.recap), outro: fix(data.outro) };
}

interface GauPlayerProps {
  movie: Movie;
  currentEpisode: MovieEpisode;
  currentServer: EpisodeServer;
  allServers: EpisodeServer[];
  onBack: () => void;
  onSelectEpisode: (ep: MovieEpisode, server: EpisodeServer, currentTime?: number) => void;
  onSaveProgress?: (currentTime: number, duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  initialTime?: number;
  currentAccount?: Account | null;
  activeProfile?: UserProfile | null;
}

function getAdCleanUrl(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith('blob:') || raw.startsWith('data:') || raw.startsWith('file:')) return raw;
  try {
    const b64 = btoa(unescape(encodeURIComponent(raw)));
    return getFullApiUrl(`/api/proxy/m3u8?url=${encodeURIComponent(b64)}`);
  } catch {
    return getFullApiUrl(`/api/proxy/m3u8?url=${encodeURIComponent(raw)}`);
  }
}

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '00:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export const GauPlayer: React.FC<GauPlayerProps> = memo(({
  movie,
  currentEpisode,
  currentServer,
  allServers,
  onBack,
  onSelectEpisode,
  onSaveProgress,
  onTimeUpdate,
  initialTime = 0,
  currentAccount,
  activeProfile,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isTv = useTvMode();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // ui state
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const v = parseFloat(localStorage.getItem('gau_volume') || '1');
      return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    } catch { return 1; }
  });
  const [isMuted, setIsMuted] = useState(() => {
    try { return localStorage.getItem('gau_muted') === '1'; } catch { return false; }
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [qualityLevels, setQualityLevels] = useState<{ height: number; level: number; bitrate?: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number>(-1);
  const [showSettings, setShowSettings] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [isPip, setIsPip] = useState(false);
  // ---- Mobile / tablet UX ----
  const [isTouchDevice] = useState<boolean>(() => {
    try {
      if (typeof window === 'undefined') return false;
      return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || window.matchMedia?.('(pointer: coarse)').matches;
    } catch { return false; }
  });
  const [seekFlash, setSeekFlash] = useState<'left' | 'right' | null>(null);
  const [gestureToast, setGestureToast] = useState<{ text: string; sub?: string } | null>(null);
  const [screenBrightness, setScreenBrightness] = useState(() => {
    try {
      const b = parseFloat(localStorage.getItem('gau_brightness') || '1');
      return isFinite(b) ? Math.max(0.4, Math.min(1, b)) : 1;
    } catch { return 1; }
  });
  const [isLocked, setIsLocked] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // Chế độ khung hình: false = Fit (contain, đủ hình), true = Fill (cover, lấp màn hình)
  const [fillMode, setFillMode] = useState(false);
  const pinchRef = useRef<{ startDist: number } | null>(null);
  const saveProgressRef = useRef(onSaveProgress);
  saveProgressRef.current = onSaveProgress;

  // Presence + analytics: báo admin ai đang xem phim gì (_GauPlayer là player chính,
  // SimplePlayer đã không còn dùng nên pipeline userStats/lịch sử bị thiếu phim).
  useEffect(() => {
    if (!currentAccount) return;
    presenceService.startSession({
      accountId: currentAccount.id || currentAccount.username || 'user',
      accountDisplayName: currentAccount.displayName || currentAccount.username || 'Khán Giả Phim',
      profileId: activeProfile?.id || 'movie_profile',
      profileName: activeProfile?.name || 'Người xem',
      profileAvatar: activeProfile?.avatar || '',
      type: 'movie',
      contentId: movie.slug,
      itemTitle: movie.name,
      itemSubtitle: currentEpisode.name ? `Tập ${currentEpisode.name}` : undefined,
      itemCover: movie.poster_url || movie.thumb_url,
      apiSourceUsed: currentServer.server_name || 'movie',
    });
    return () => {
      presenceService.stopSession();
    };
  }, [movie.slug, movie.name, currentEpisode.slug, currentEpisode.name, currentServer.server_name, currentAccount, activeProfile]);
  const isLockedRef = useRef(false);
  isLockedRef.current = isLocked;
  const [speedBoost, setSpeedBoost] = useState(false);
  // APK Android: mặc định hiện nút PiP luôn (manifest đã khai báo support).
  // Chỉ ẩn khi native check trả về false *rõ ràng* — còn lỗi bridge thì giữ hiện
  // (trước đây catch -> false nên nút biến mất hẳn trên APK).
  const [pipSupported, setPipSupported] = useState<boolean>(() => {
    try { return isNativeAndroid(); } catch { return false; }
  });
  const [nativeImmersive, setNativeImmersive] = useState(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleTapTimer = useRef<number | null>(null);
  // Tap này chỉ để tắt menu (đã xử lý ngay ở touchstart) -> touchend bỏ qua, khỏi toggle controls
  const consumeTapRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number; mode: null | 'volume' | 'brightness' | 'ignore'; startVolume: number; startBrightness: number; moved: boolean; holdFired: boolean } | null>(null);
  const gestureToastTimer = useRef<number | null>(null);
  const seekFlashTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const prevRateRef = useRef(1);
  const showControlsRef = useRef(true);
  showControlsRef.current = showControls;
  const isTouchDeviceRef = useRef(false);
  isTouchDeviceRef.current = isTouchDevice;
  // intro/recap/outro segments (single fetch per episode, no cache)
  const [segments, setSegments] = useState<SegmentsResponse | null>(null);
  const [activeSegment, setActiveSegment] = useState<'intro' | 'recap' | 'outro' | null>(null);
  // Netflix-style auto next episode (persisted)
  const [autoNextEnabled, setAutoNextEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('gau_auto_next_episode') !== '0'; } catch { return true; }
  });
  const nextFillRef = useRef<HTMLSpanElement>(null);

  // timeline refs like chophim n4
  const progressBarRef = useRef<HTMLDivElement>(null);
  const bufferedBarRef = useRef<HTMLDivElement>(null);
  const hoverTrackRef = useRef<HTMLDivElement>(null);
  const hoverTooltipRef = useRef<HTMLDivElement>(null);
  const hoverTimeRef = useRef<HTMLDivElement>(null);
  const hideControlsTimer = useRef<number | null>(null);
  const isDraggingRef = useRef(false);  // preview refs - chophim sprite style (hidden video + canvas)
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewHlsRef = useRef<Hls | null>(null);
  const previewSeekTimer = useRef<number | null>(null);
  // Cache frame preview theo bucket 2s: hover lại chỗ cũ hiện ngay, khỏi seek lại
  const previewFrameCache = useRef(new Map<number, string>());
  const lastPreviewTarget = useRef(-1);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);

  const episodeIndex = useMemo(() => {
    return currentServer.server_data.findIndex(e => e.slug === currentEpisode.slug);
  }, [currentServer, currentEpisode]);
  const prevEpisode = useMemo(() => {
    return episodeIndex > 0 ? currentServer.server_data[episodeIndex - 1] : null;
  }, [currentServer, episodeIndex]);
  const nextEpisode = useMemo(() => {
    return episodeIndex !== -1 && episodeIndex < currentServer.server_data.length - 1
      ? currentServer.server_data[episodeIndex + 1]
      : null;
  }, [currentServer, episodeIndex]);

  // single fetch per episode: imdb from movie detail, fallback TMDB search by title.
  // Resilient chain (APK hay mất nút Bỏ qua intro vì 1 trong các khâu này):
  // 1) movie.imdb.id trực tiếp
  // 2) movie.tmdb.id -> TMDB external_ids
  // 3) TMDB search theo origin_name/name (+year) -> external_ids (phim thiếu cả 2 id như Hồ Tâm)
  // 4) proxy backend cold-start 502/timeout -> retry 1 lần sau 1.5s rồi mới bỏ.
  useEffect(() => {
    const season = Number((movie as any)?.tmdb?.season) > 0 ? Number((movie as any).tmdb.season) : 1;
    let epNum = NaN;
    const m = String(currentEpisode.name || '').match(/\d+/);
    if (m) epNum = parseInt(m[0], 10);
    if (isNaN(epNum)) {
      const idx2 = currentServer.server_data.findIndex(e => e.slug === currentEpisode.slug);
      epNum = idx2 >= 0 ? idx2 + 1 : 1;
    }
    if (epNum < 1) epNum = 1;
    let cancelled = false;
    setSegments(null); setActiveSegment(null);
    // APK-safe: use backend proxy via getFullApiUrl so relative URL resolves to CLOUD_BACKEND_URL on native
    // APK-safe timeout: AbortSignal.timeout() missing on old Android WebView -> would throw sync and kill segments
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => { try { controller.abort(); } catch {} }, 12000);
    const resolveImdbViaTmdb = async (): Promise<string> => {
      try {
        return await resolveImdbId(movie as any, controller.signal as any);
      } catch { return ''; }
    };
    (async () => {
      try {
        // Đảm bảo base backend còn sống (APK từng bake URL cũ đã chết) rồi mới fetch
        try { await verifyBackendUrl(); } catch { /* dùng base hiện tại */ }
        if (cancelled) return;
        const imdbId = await resolveImdbViaTmdb();
        if (cancelled) return;
        if (!imdbId) {
          console.info(`[intro] skip: no imdb_id for ${(movie as any)?.slug || '?'}, ep ${epNum}`);
          return;
        }
        const url = getFullApiUrl(`/api/intro/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${season}&episode=${epNum}`);
        // cache:no-store -> server ETag could answer 304 with empty body (res.ok=false), killing segments
        let data: SegmentsResponse | null = null;
        let lastErr = '';
        for (let attempt = 0; attempt < 2 && !cancelled; attempt++) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal as any, cache: 'no-store' as RequestCache });
            if (r.status === 404) { data = { imdb_id: imdbId, season, episode: epNum, intro: null, recap: null, outro: null } as any; break; }
            if (!r.ok) throw new Error(String(r.status));
            // eslint-disable-next-line no-await-in-loop
            data = await r.json();
            break;
          } catch (e: any) {
            lastErr = e?.message || String(e);
            if (attempt === 0 && !cancelled) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise(res => setTimeout(res, 1500));
            }
          }
        }
        if (cancelled) return;
        if (data) {
          const norm = normalizeSegments(data);
          setSegments(norm);
          console.info(`[intro] ${imdbId} s${season}e${epNum}:`, norm?.intro ? `intro ${norm.intro.start_sec}-${norm.intro.end_sec}s` : 'no intro');
        } else {
          console.info(`[intro] fetch failed ${imdbId} s${season}e${epNum}: ${lastErr}`);
          setSegments(null);
        }
      } catch {
        if (!cancelled) setSegments(null);
      } finally {
        window.clearTimeout(timeoutId);
      }
    })();
    return () => { cancelled = true; window.clearTimeout(timeoutId); try { controller.abort(); } catch {} };
  }, [(movie as any)?.imdb?.id, (movie as any)?.tmdb?.id, (movie as any)?.tmdb?.season, (movie as any)?.slug, (movie as any)?.name, (movie as any)?.origin_name, (movie as any)?.year, currentEpisode.slug, currentEpisode.name, currentServer]);

  const handleSkipSegment = useCallback((type: 'intro' | 'recap' | 'outro') => {
    const v = videoRef.current;
    if (!v) return;
    const seg = type === 'intro' ? segments?.intro : type === 'recap' ? segments?.recap : segments?.outro;
    if (type === 'outro') {
      if (nextEpisode) onSelectEpisode(nextEpisode, currentServer);
      else if (seg && typeof seg.end_sec === 'number' && seg.end_sec > 0) v.currentTime = Math.min(v.duration || seg.end_sec, seg.end_sec);
      return;
    }
    if (seg && typeof seg.end_sec === 'number') v.currentTime = seg.end_sec + 0.2;
  }, [segments, nextEpisode, currentServer, onSelectEpisode]);

  // Netflix-style auto next: one 3s timer + button fill animation driven by the
  // same clock (Web Animations API), so the fill hits 100% exactly when we advance.
  useEffect(() => {
    if (activeSegment !== 'outro' || !nextEpisode || !autoNextEnabled) return;
    const t = window.setTimeout(() => {
      onSelectEpisode(nextEpisode, currentServer);
    }, 3000);
    try {
      nextFillRef.current?.animate(
        [{ width: '0%' }, { width: '100%' }],
        { duration: 3000, easing: 'linear', fill: 'forwards' },
      );
    } catch { /* WAAPI unsupported -> plain button, timer still fires */ }
    return () => window.clearTimeout(t);
  }, [activeSegment, nextEpisode, autoNextEnabled, currentEpisode.slug, currentServer, onSelectEpisode]);

  const toggleAutoNext = useCallback(() => {
    setAutoNextEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('gau_auto_next_episode', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    hideControlsTimer.current = window.setTimeout(() => {
      if (!showSettings && !showServerMenu && !showEpisodes && !isDraggingRef.current) {
        setShowControls(false);
        // TV: focus đang nằm trên nút sắp ẩn (opacity-0) -> remote bấm tiếp sẽ "mất hút"
        // + WebView vẽ viền focus mặc định (vàng) lên nút ẩn. Chuyển focus về khung player.
        try {
          if (document.documentElement.classList.contains('tv-mode')) {
            const root = containerRef.current;
            const a = document.activeElement as HTMLElement | null;
            if (root && a && a !== root && root.contains(a)) {
              root.focus({ preventScroll: true } as FocusOptions);
            }
          }
        } catch {}
      }
    }, 5000);
  }, [showSettings, showServerMenu, showEpisodes]);

  // Toggle hiện/ẩn controls cho mobile (không ép hiện lại như resetControlsTimer)
  const toggleLock = useCallback(() => {
    setIsLocked(prev => {
      const next = !prev;
      if (next) {
        // Khóa: dọn menu + ẩn controls, giữ phát
        setShowEpisodes(false);
        setShowServerMenu(false);
        setShowSettings(false);
        if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
        setShowControls(false);
      } else {
        resetControlsTimer();
      }
      return next;
    });
  }, [resetControlsTimer]);

  // Toggle hiện/ẩn controls cho mobile (không ép hiện lại như resetControlsTimer)
  const toggleControls = useCallback(() => {
    if (showControlsRef.current) {
      if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
      setShowControls(false);
    } else {
      resetControlsTimer();
    }
  }, [resetControlsTimer]);

  // Hẹn lại giờ tự ẩn NHƯNG không ép hiện (dùng cho gesture: swipe/double-tap
  // không làm controls bật lên bất ngờ khi đang ẩn)
  const pokeControlsTimer = useCallback(() => {
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    if (!showControlsRef.current) return;
    hideControlsTimer.current = window.setTimeout(() => {
      if (!showSettings && !showServerMenu && !showEpisodes && !isDraggingRef.current) setShowControls(false);
    }, 5000);
  }, [showSettings, showServerMenu, showEpisodes]);

  const capturePreviewFrame = useCallback(() => {
    const pv = previewVideoRef.current;
    const cv = previewCanvasRef.current;
    if (!pv || !cv) return;
    try {
      // render 2x for retina sharpness (320x180 displayed as 160x90)
      const cw = 320, ch = 180;
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      // high quality scaling
      (ctx as any).imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = 'high';
      ctx.drawImage(pv, 0, 0, cw, ch);
      const url = cv.toDataURL('image/jpeg', 0.7);
      // Lưu cache theo bucket 2s để hover lại hiện ngay
      try {
        const bucket = Math.floor((pv.currentTime || 0) / 2);
        if (previewFrameCache.current.size > 120) previewFrameCache.current.clear();
        previewFrameCache.current.set(bucket, url);
      } catch {}
      setPreviewImg(url);
    } catch { setPreviewImg(null); }
  }, []);
  const seekPreviewTo = useCallback((time: number) => {
    const pv = previewVideoRef.current;
    if (!pv || !duration) return;
    const clamped = Math.max(0, Math.min(duration - 0.5, time));
    // Đã có frame trong cache -> hiện ngay, khỏi seek (nhanh + đỡ tải mạng)
    const bucket = Math.floor(clamped / 2);
    const cached = previewFrameCache.current.get(bucket);
    if (cached) {
      if (previewSeekTimer.current) window.clearTimeout(previewSeekTimer.current);
      lastPreviewTarget.current = clamped;
      setPreviewImg(cached);
      return;
    }
    // Lệch quá nhỏ so với lần seek trước -> bỏ qua, tránh spam fragment
    if (Math.abs(clamped - lastPreviewTarget.current) < 1) return;
    lastPreviewTarget.current = clamped;
    if (previewSeekTimer.current) window.clearTimeout(previewSeekTimer.current);
    previewSeekTimer.current = window.setTimeout(() => {
      try { pv.currentTime = clamped; } catch {}
    }, 180);
  }, [duration]);

  // preview hls setup: MUST use the same client-cleaned playlist as main player,
  // otherwise thumbnails show ad frames that don't exist in cleaned playback
  useEffect(() => {
    const pv = previewVideoRef.current;
    if (!pv || !currentEpisode.link_m3u8) return;
    if (previewHlsRef.current) { previewHlsRef.current.destroy(); previewHlsRef.current = null; }
    const directRaw = getMirrorUrls(currentEpisode.link_m3u8)[0];
    if (!directRaw) return;
    // Đổi tập: xóa cache frame cũ để khỏi hiện nhầm ảnh tập trước
    previewFrameCache.current.clear();
    lastPreviewTarget.current = -1;
    setPreviewImg(null);
    let previewBlobs: string[] = [];
    let cancelled = false;
    pv.muted = true;
    pv.preload = 'metadata';
    // @ts-ignore
    pv.crossOrigin = 'anonymous';
    const onSeeked = () => capturePreviewFrame();
    pv.addEventListener('seeked', onSeeked);
    const attachPreview = (src: string) => {
      if (cancelled) return;
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          backBufferLength: 10,
          maxBufferLength: 10,
          maxMaxBufferLength: 15,
          maxBufferSize: 10 * 1000 * 1000,
          manifestLoadingTimeOut: 8000,
          levelLoadingTimeOut: 8000,
          fragLoadingTimeOut: 15000,
          // Preview luôn dùng quality THẤP NHẤT: nhẹ băng thông, không tranh với player chính khi tua
          startLevel: 0,
          capLevelToPlayerSize: false,
        });
        previewHlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(pv);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          try {
            const levels = (hls as any).levels || [];
            if (levels.length > 1) hls.currentLevel = 0;
          } catch {}
        });
      } else if (pv.canPlayType('application/vnd.apple.mpegurl')) {
        pv.src = src;
      }
    };
    // Same cleaner as main player so preview frames align with cleaned timeline
    loadCleanedM3u8Url(directRaw).then((cleaned) => {
      if (cancelled) { if (cleaned) revokeBlobUrl([cleaned.blobUrl, ...(cleaned.extraBlobs || [])]); return; }
      if (cleaned) { previewBlobs = [cleaned.blobUrl, ...(cleaned.extraBlobs || [])]; attachPreview(cleaned.blobUrl); }
      else attachPreview(directRaw);
    }).catch(() => { if (!cancelled) attachPreview(directRaw); });
    return () => {
      cancelled = true;
      pv.removeEventListener('seeked', onSeeked);
      if (previewHlsRef.current) { previewHlsRef.current.destroy(); previewHlsRef.current = null; }
      revokeBlobUrl(previewBlobs);
    };
  }, [currentEpisode.link_m3u8, capturePreviewFrame]);

  // hls setup - single instance only, no preview video
  useEffect(() => {
    if (!currentEpisode.link_m3u8) {
      setErrorMsg('Tập phim này chưa có dữ liệu phát. Vui lòng chọn server hoặc tập khác.');
      setIsLoading(false);
      return;
    }

    const video = videoRef.current;
    if (!video) return;

    setIsLoading(true);
    setErrorMsg(null);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const rawCandidates = getMirrorUrls(currentEpisode.link_m3u8);
    const candidates: string[] = [];
    // 1. Client-side ad-cleaned blob will be prepended async below (same rules
    // as server proxy, but uses client IP so it isn't blocked like cloud IP).
    // 2. Direct raw m3u8 URLs (upstream allows CORS *, client VN IP works)
    rawCandidates.forEach((u) => {
      if (u && !candidates.includes(u)) candidates.push(u);
    });
    // 3. Server ad-cleaned proxy as last fallback (may 502/404 on cloud IP)
    rawCandidates.forEach((u) => {
      if (u) {
        const proxied = getAdCleanUrl(u);
        if (proxied && !candidates.includes(proxied)) candidates.push(proxied);
      }
    });

    let candidateIndex = 0;
    let blobUrl: string | null = null;
    let extraBlobs: string[] = [];
    let cancelled = false;
    const tryNext = (hls: Hls) => {
      candidateIndex++;
      if (candidateIndex < candidates.length) {
        hls.loadSource(candidates[candidateIndex]);
        hls.startLoad();
        return;
      }
      const other = allServers.find(s => s.server_name !== currentServer.server_name);
      if (other) {
        const ep = other.server_data.find(e => e.slug === currentEpisode.slug) || other.server_data[0];
        if (ep) { onSelectEpisode(ep, other, video.currentTime || 0); return; }
      }
      setErrorMsg('Không thể tải luồng phát HLS. Vui lòng chọn server khác.');
      setIsLoading(false);
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 30 * 1000 * 1000,
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 20000,
        startLevel: -1,
        capLevelToPlayerSize: true,
      });
      hlsRef.current = hls;
      // Client-side ad-clean first: fetch + strip ads in browser, then play blob
      (async () => {
        try {
          const cleaned = await loadCleanedM3u8Url(rawCandidates[0]);
          if (cancelled) { if (cleaned) revokeBlobUrl([cleaned.blobUrl, ...(cleaned.extraBlobs || [])]); return; }
          if (cleaned) {
            blobUrl = cleaned.blobUrl;
            extraBlobs = [cleaned.blobUrl, ...(cleaned.extraBlobs || [])];
            candidates.unshift(blobUrl);
            candidateIndex = 0;
            hls.loadSource(blobUrl);
            return;
          }
        } catch { /* fall through to direct */ }
        if (!cancelled) hls.loadSource(candidates[0]);
      })();
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        setIsLoading(false);
        const levels = (data.levels || [])
          .map((l: any, i: number) => ({
            height: l.height || (l.width ? Math.round((l.width * 9) / 16) : 0),
            level: i,
            bitrate: l.bitrate,
          }))
          .filter((l: any) => l.height > 0 || l.bitrate > 0);
        // dedupe by height
        const seen = new Set<number>();
        const deduped = levels.filter((l: any) => {
          if (l.height && seen.has(l.height)) return false;
          if (l.height) seen.add(l.height);
          return true;
        });
        setQualityLevels(deduped.length ? deduped : levels);
        if (initialTime > 5) video.currentTime = initialTime;
        video.play().catch(() => {});
      });
      let ec = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          ec++;
          if (ec <= 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (ec <= 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else tryNext(hls);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari/iOS): direct first, proxy blocked on cloud IP
      video.src = getMirrorUrls(currentEpisode.link_m3u8)[0] || getAdCleanUrl(currentEpisode.link_m3u8);
      const onLoaded = () => { setIsLoading(false); if (initialTime > 5) video.currentTime = initialTime; video.play().catch(() => {}); };
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.onerror = () => {
        setErrorMsg('Không thể phát trên trình duyệt này');
        setIsLoading(false);
      };
    } else {
      setErrorMsg('Trình duyệt không hỗ trợ HLS');
      setIsLoading(false);
    }
    return () => { cancelled = true; revokeBlobUrl([blobUrl, ...extraBlobs]); if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, [currentEpisode.link_m3u8, allServers, currentServer, initialTime, onSelectEpisode, retryKey]);

  const handleRetry = useCallback(() => {
    const v = videoRef.current;
    // Thử phát tiếp từ chỗ đang xem dở
    const resumeAt = v && isFinite(v.currentTime) ? v.currentTime : currentTime;
    if (v) {
      try { v.removeAttribute('src'); v.load(); } catch {}
      if (resumeAt > 5) {
        try { v.currentTime = resumeAt; } catch {}
      }
    }
    setErrorMsg(null);
    setIsLoading(true);
    setRetryKey(k => k + 1);
  }, [currentTime]);

  // Server khác cùng tập (dùng cho nút Đổi server khi lỗi)
  const altServerEp = useMemo(() => {
    const other = allServers.find(s => s.server_name !== currentServer.server_name);
    if (!other) return null;
    const ep = other.server_data.find(e => e.slug === currentEpisode.slug) || other.server_data[0];
    return ep ? { ep, server: other } : null;
  }, [allServers, currentServer, currentEpisode]);

  // sync volume/mute without recreating hls
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = isMuted ? 0 : volume;
    v.muted = isMuted;
  }, [volume, isMuted]);

  // Nhớ âm lượng + độ sáng vào máy
  useEffect(() => {
    try {
      localStorage.setItem('gau_volume', String(volume));
      localStorage.setItem('gau_muted', isMuted ? '1' : '0');
      localStorage.setItem('gau_brightness', String(screenBrightness));
    } catch {}
  }, [volume, isMuted, screenBrightness]);

  // Lưu tiến độ chắc ăn: pause + thoát player + app bị ẩn (không chỉ mỗi 30s)
  const saveProgressNow = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    if (v.currentTime < 5) return;
    saveProgressRef.current?.(v.currentTime, v.duration);
  }, []);
  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden') saveProgressNow(); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      saveProgressNow();
    };
  }, [saveProgressNow]);

  // time update - segment detection (intro/recap/outro) + progress
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cur = v.currentTime;
    setCurrentTime(cur);
    onTimeUpdate?.(cur, v.duration || 0);
    if (segments) {
      const inIntro = segments.intro && cur >= segments.intro.start_sec && cur < segments.intro.end_sec - 0.15;
      const inRecap = segments.recap && cur >= segments.recap.start_sec && cur < segments.recap.end_sec - 0.15;
      const inOutro = segments.outro && cur >= segments.outro.start_sec && cur < (segments.outro.end_sec || (v.duration || 1e9));
      const next = inIntro ? 'intro' as const : inRecap ? 'recap' as const : inOutro ? 'outro' as const : null;
      setActiveSegment(prev => prev !== next ? next : prev);
    } else {
      setActiveSegment(null);
    }
    if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    // Đang kéo timeline thì không đụng vào DOM scrub (tránh giật/lag do 2 luồng cùng set)
    if (isDraggingRef.current) return;
    // update progress bar width directly via ref for performance (no re-render)
    if (progressBarRef.current && v.duration) {
      progressBarRef.current.style.width = `${(cur / v.duration) * 100}%`;
    }
    if (bufferedBarRef.current && v.duration) {
      bufferedBarRef.current.style.width = `${(v.buffered.length ? (v.buffered.end(v.buffered.length - 1) / v.duration) * 100 : 0)}%`;
    }
  // NOTE: segments must be in deps — otherwise this handler keeps the stale
  // initial null and the skip button never appears even with data loaded.
  }, [onTimeUpdate, segments]);

  // controls handlers
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);
  const skip = useCallback((s: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + s));
  }, []);
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nv = !isMuted;
    setIsMuted(nv);
    v.muted = nv;
  }, [isMuted]);
  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    setIsMuted(v === 0);
    if (videoRef.current) { videoRef.current.volume = v; videoRef.current.muted = v === 0; }
  };
  const toggleFullscreen = useCallback(async () => {
    // APK Android: player vốn đã full màn hình -> nút này bật/tắt immersive
    // (ẩn status bar + nav bar) để có khác biệt thật sự.
    if (isNativeAndroid()) {
      setNativeImmersive(prev => {
        const next = !prev;
        setImmersiveMode(next);
        return next;
      });
      return;
    }
    // Detection có thể sai trên một số WebView -> vẫn thử lệnh native trước,
    // thành công thì thôi, thất bại mới dùng web fullscreen.
    try {
      const nativeOk = await setImmersiveMode(!nativeImmersive);
      if (nativeOk) {
        setNativeImmersive(!nativeImmersive);
        return;
      }
    } catch {}
    const c = containerRef.current;
    if (!c) return;
    try {
      if (!document.fullscreenElement) {
        await c.requestFullscreen?.();
        // Mobile web: auto-lock landscape cho trải nghiệm xem phim tốt hơn
        try {
          const orient = screen.orientation as any;
          if (isTouchDeviceRef.current && orient?.lock) await orient.lock('landscape');
        } catch {}
      } else {
        await document.exitFullscreen?.();
        try { (screen.orientation as any)?.unlock?.(); } catch {}
      }
    } catch {}
  }, [nativeImmersive]);
  const handlePip = useCallback(async () => {
    // APK: dùng native PiP (WebView thường không hỗ trợ requestPictureInPicture).
    // Nếu native fail thì rớt xuống thử web PiP.
    if (isNativeAndroid()) {
      try {
        if (await enterNativePip()) return;
      } catch {}
    }
    // Web / PWA (và fallback APK): dùng browser PiP nếu được hỗ trợ (Chrome/Android + Safari/iOS)
    const v = videoRef.current as any;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else if (typeof v.webkitSetPresentationMode === 'function') {
        // Safari macOS/iOS
        try {
          if (v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode('inline');
          else v.webkitSetPresentationMode('picture-in-picture');
        } catch { v.webkitSetPresentationMode('picture-in-picture'); }
      }
    } catch {}
  }, []);

  const showGestureToast = useCallback((text: string, sub?: string) => {
    if (gestureToastTimer.current) window.clearTimeout(gestureToastTimer.current);
    setGestureToast({ text, sub });
    gestureToastTimer.current = window.setTimeout(() => setGestureToast(null), 900);
  }, []);

  const flashSeek = useCallback((seconds: number) => {
    if (seekFlashTimer.current) window.clearTimeout(seekFlashTimer.current);
    setSeekFlash(seconds < 0 ? 'left' : 'right');
    try { (navigator as any)?.vibrate?.(15); } catch {}
    seekFlashTimer.current = window.setTimeout(() => setSeekFlash(null), 650);
  }, []);

  // Giữ màn hình để x2 tốc độ (kiểu YouTube), thả ra về như cũ.
  // Khi giữ thì ẩn controls cho thoáng, thả ra thì hiện lại.
  const activateSpeedBoost = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.paused) return;
    const s = touchStartRef.current;
    if (s) s.holdFired = true;
    prevRateRef.current = v.playbackRate || 1;
    v.playbackRate = 2;
    setPlaybackRate(2);
    setSpeedBoost(true);
    if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
    setShowControls(false);
    try { (navigator as any)?.vibrate?.(20); } catch {}
  }, []);
  const deactivateSpeedBoost = useCallback(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = prevRateRef.current || 1;
    setPlaybackRate(prevRateRef.current || 1);
    setSpeedBoost(false);
    resetControlsTimer();
  }, [resetControlsTimer]);

  const handleVideoAreaClick = useCallback(() => {
    if (isLockedRef.current) return;
    if (showEpisodes || showServerMenu || showSettings) {
      setShowEpisodes(false);
      setShowServerMenu(false);
      setShowSettings(false);
      return;
    }
    // Mobile/tablet: single tap chỉ hiện/ẩn controls (chuẩn YouTube/Netflix),
    // không toggle play nhầm. Desktop giữ click-to-play.
    if (isTouchDeviceRef.current) {
      toggleControls();
      return;
    }
    togglePlay();
  }, [showEpisodes, showServerMenu, showSettings, togglePlay, toggleControls]);

  const handleVideoClick = useCallback((e: React.MouseEvent) => {
    // Bỏ qua ghost-click sau touch trên mobile (touch handlers đã xử lý)
    if (isTouchDeviceRef.current) { e.stopPropagation(); return; }
    e.stopPropagation();
    handleVideoAreaClick();
  }, [handleVideoAreaClick]);

  // ---- Mobile gestures: double-tap seek + giữ để x2 + swipe dọc volume/brightness ----
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    const v = videoRef.current;
    // Đang khóa màn hình: mọi chạm lên video đều bỏ qua (nút mở khóa tự chặn riêng)
    if (isLockedRef.current) {
      touchStartRef.current = { x: t.clientX, y: t.clientY, mode: 'ignore', startVolume: 0, startBrightness: 1, moved: true, holdFired: false };
      return;
    }
    // Menu đang mở: tắt NGAY ở touchstart (không chờ click ~300ms hay single-tap 280ms),
    // tap này coi như đã tiêu thụ, touchend sẽ bỏ qua.
    if (showEpisodes || showServerMenu || showSettings) {
      setShowEpisodes(false);
      setShowServerMenu(false);
      setShowSettings(false);
      lastTapRef.current = null;
      if (singleTapTimer.current) { window.clearTimeout(singleTapTimer.current); singleTapTimer.current = null; }
      consumeTapRef.current = true;
      touchStartRef.current = { x: t.clientX, y: t.clientY, mode: 'ignore', startVolume: 0, startBrightness: 1, moved: true, holdFired: false };
      pokeControlsTimer();
      return;
    }
    // Chụm 2 ngón: đổi tỉ lệ khung hình Fit (contain) <-> Fill (cover)
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (d > 0) pinchRef.current = { startDist: d };
      if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
      touchStartRef.current = { x: t.clientX, y: t.clientY, mode: 'ignore', startVolume: 0, startBrightness: 1, moved: true, holdFired: false };
      return;
    }
    touchStartRef.current = {
      x: t.clientX, y: t.clientY, mode: null,
      startVolume: v ? (v.muted ? 0 : v.volume) : volume,
      startBrightness: screenBrightness,
      moved: false, holdFired: false,
    };
    // Chỉ dừng hẹn giờ tự ẩn, KHÔNG ép hiện controls ở đây (để tap-toggle sau đó chính xác).
    // Ép hiện ở touchstart là bug làm tap-hiện chớp tắt sau 280ms.
    if (hideControlsTimer.current) { window.clearTimeout(hideControlsTimer.current); hideControlsTimer.current = null; }
    // Giữ yên >450ms khi đang phát -> x2 tốc độ
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    if (v && !v.paused && e.touches.length === 1) {
      holdTimer.current = window.setTimeout(() => { activateSpeedBoost(); }, 450);
    }
  }, [volume, screenBrightness, activateSpeedBoost, showEpisodes, showServerMenu, showSettings, pokeControlsTimer]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    // Đang chụm: tách ra (OUT) -> Fill lấp màn hình, khép vào (IN) -> Fit đủ hình.
    // Đổi mốc sau mỗi lần chuyển để chụm 1 hơi vẫn đảo qua lại được.
    const pinch = pinchRef.current;
    if (pinch && e.touches.length >= 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (d > 0) {
        const ratio = d / pinch.startDist;
        if (ratio > 1.2) {
          setFillMode(prev => {
            if (!prev) showGestureToast('Lấp đầy màn hình', 'Chụm vào để thu lại');
            return true;
          });
          pinch.startDist = d;
        } else if (ratio < 0.85) {
          setFillMode(prev => {
            if (prev) showGestureToast('Vừa màn hình', 'Tách ra để lấp đầy');
            return false;
          });
          pinch.startDist = d;
        }
      }
      return;
    }
    const s = touchStartRef.current;
    const v = videoRef.current;
    if (!s || !v) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.mode) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
      // Chỉ swipe DỌC: phải = volume, trái = brightness. Ngang thì bỏ qua.
      if (Math.abs(dx) > Math.abs(dy) * 1.2) { s.mode = 'ignore'; s.moved = true; }
      else s.mode = s.x > window.innerWidth / 2 ? 'volume' : 'brightness';
      // Đã di chuyển -> hủy giữ-x2
      if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    }
    if (s.mode === 'ignore') return;
    s.moved = true;
    if (s.mode === 'volume') {
      const dv = -dy / 220;
      const nv = Math.max(0, Math.min(1, s.startVolume + dv));
      setVolume(nv);
      setIsMuted(nv === 0);
      if (v) { v.volume = nv; v.muted = nv === 0; }
      showGestureToast(`Âm lượng ${Math.round(nv * 100)}%`);
    } else if (s.mode === 'brightness') {
      const db = -dy / 220;
      const nb = Math.max(0.4, Math.min(1, s.startBrightness + db));
      setScreenBrightness(nb);
      showGestureToast(`Độ sáng ${Math.round(nb * 100)}%`);
    }
  }, [showGestureToast]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    // Kết thúc chụm: không tính là tap
    if (pinchRef.current) {
      if (e.touches.length < 2) pinchRef.current = null;
      touchStartRef.current = null;
      pokeControlsTimer();
      return;
    }
    // Đang giữ x2 -> thả ra về tốc độ cũ, không xử lý tap
    if (speedBoost) { deactivateSpeedBoost(); touchStartRef.current = null; return; }
    // Tap vừa dùng để tắt menu ở touchstart -> bỏ qua, không toggle gì thêm
    if (consumeTapRef.current) { consumeTapRef.current = false; touchStartRef.current = null; return; }
    const s = touchStartRef.current;
    touchStartRef.current = null;
    if (!s) return;
    // Nếu đã swipe thì không xử lý tap (hẹn lại giờ ẩn, không ép hiện)
    if (s.moved) { pokeControlsTimer(); return; }
    const now = Date.now();
    const last = lastTapRef.current;
    const changed = e.changedTouches[0];
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (changed.clientX - rect.left) / Math.max(1, rect.width);

    // Double-tap trong 300ms
    if (last && now - last.time < 300) {
      if (singleTapTimer.current) { window.clearTimeout(singleTapTimer.current); singleTapTimer.current = null; }
      lastTapRef.current = null;
      e.preventDefault();
      if (showEpisodes || showServerMenu || showSettings) {
        setShowEpisodes(false); setShowServerMenu(false); setShowSettings(false);
        return;
      }
      if (xRatio < 0.35) { skip(-10); flashSeek(-10); }
      else if (xRatio > 0.65) { skip(10); flashSeek(10); }
      else togglePlay();
      pokeControlsTimer();
      return;
    }
    // Single tap: delay 280ms để chờ double-tap
    lastTapRef.current = { time: now, x: changed.clientX, y: changed.clientY };
    if (singleTapTimer.current) window.clearTimeout(singleTapTimer.current);
    singleTapTimer.current = window.setTimeout(() => {
      singleTapTimer.current = null;
      handleVideoAreaClick();
    }, 280);
  }, [showEpisodes, showServerMenu, showSettings, skip, flashSeek, togglePlay, pokeControlsTimer, handleVideoAreaClick, speedBoost, deactivateSpeedBoost]);

  // Touch bị hủy giữa chừng (cuộc gọi đến, gesture hệ thống...): dọn state, hẹn lại giờ ẩn
  const handleTouchCancel = useCallback(() => {
    if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; }
    pinchRef.current = null;
    if (speedBoost) deactivateSpeedBoost();
    else pokeControlsTimer();
    touchStartRef.current = null;
  }, [speedBoost, deactivateSpeedBoost, pokeControlsTimer]);

  // click outside to close menus (episodes / server / settings) - use click so video handler runs first
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // let video-area clicks be handled by handleVideoAreaClick (which already closes without toggling)
      if (target.closest('.video-area')) return;
      if (!target.closest('.player-menu-panel') && !target.closest('.player-menu-btn')) {
        setShowEpisodes(false);
        setShowServerMenu(false);
        setShowSettings(false);
      }
    };
    document.addEventListener('click', handleClickOutside as any);
    return () => {
      document.removeEventListener('click', handleClickOutside as any);
    };
  }, []);

  // fullscreen + pip listeners
  useEffect(() => {
    const onFs = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFs);
    const v = videoRef.current;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    v?.addEventListener('enterpictureinpicture', onEnter);
    v?.addEventListener('leavepictureinpicture', onLeave);
    const onNativePip = (ev: any) => {
      try { setIsPip(!!ev?.detail?.isPip); } catch {}
    };
    window.addEventListener('native-pip-change' as any, onNativePip as any);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      v?.removeEventListener('enterpictureinpicture', onEnter);
      v?.removeEventListener('leavepictureinpicture', onLeave);
      window.removeEventListener('native-pip-change' as any, onNativePip as any);
    };
  }, []);

  // PiP hỗ trợ ở đâu thì hiện nút ở đó:
  // - APK Android: LUÔN hiện nút (kể cả khi probe native fail) để user bấm được.
  //   Bấm mà native fail thì tự rớt xuống thử web PiP.
  // - Web / PWA: browser PiP (Chrome Android hỗ trợ, iOS Safari 14.2+ hỗ trợ)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isNativeAndroid()) {
        try { await checkNativePipSupported(); } catch {}
        if (!cancelled) setPipSupported(true);
        return;
      }
      try {
        const v = document.createElement('video') as any;
        const stdOk = (document as any).pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function';
        const safariOk = typeof v.webkitSetPresentationMode === 'function';
        if (!cancelled) setPipSupported(!!(stdOk || safariOk));
      } catch { if (!cancelled) setPipSupported(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // APK: mở player là ẩn status bar luôn (immersive), thoát player thì hiện lại.
  // Re-apply khi app focus/visible lại vì Bridge hay reset systemUI (nguyên nhân
  // status bar hiện lại sau 1 chạm).
  // Gọi lệnh native KHÔNG gate theo detection (setImmersiveMode tự check robust
  // bên trong) để phòng detection sai trên một số WebView.
  useEffect(() => {
    let cancelled = false;
    setImmersiveMode(true).then((ok) => {
      if (!cancelled && ok) setNativeImmersive(true);
    }).catch(() => {});
    const reapply = () => { try { setImmersiveMode(true).catch(() => {}); } catch {} };
    const onVis = () => { if (document.visibilityState === 'visible') reapply(); };
    const onFocus = () => reapply();
    const onPipChange = () => { /* thoát PiP -> native tự re-apply sau 200ms */ };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('native-pip-change' as any, onPipChange as any);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('native-pip-change' as any, onPipChange as any);
      try { setImmersiveMode(false).catch(() => {}); } catch {}
    };
  }, []);

  // TV: App (nút Back native) gọi đánh thức overlay qua event này
  // (Back nấc 1 mở overlay, nấc 2 mới thoát — xem backButton handler trong App).
  useEffect(() => {
    const wake = () => {
      resetControlsTimer();
      window.setTimeout(() => {
        try {
          containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
        } catch {}
      }, 150);
    };
    window.addEventListener('gau_tv_wake_player' as any, wake as any);
    return () => window.removeEventListener('gau_tv_wake_player' as any, wake as any);
  }, [resetControlsTimer]);

  // Mở player là hẹn giờ tự ẩn controls (kẻo hiện mãi nếu không chạm gì)
  useEffect(() => {
    resetControlsTimer();
  }, [resetControlsTimer]);

  // TV: mở player là focus ngay nút play để remote bấm OK phát/dừng được
  useEffect(() => {
    if (!isTv) return;
    const t = window.setTimeout(() => {
      try {
        containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
      } catch {}
    }, 400);
    return () => window.clearTimeout(t);
  }, [isTv]);

  // APK: đồng bộ trạng thái phát để bấm Home tự vào PiP (native auto-enter)
  useEffect(() => {
    if (!isNativeAndroid()) return;
    setNativeVideoPlaying(isPlaying);
  }, [isPlaying]);

  // Thoát player là reset flag phát về false. Nếu không: thoát phim lúc đang
  // phát thì flag kẹt ở true, về trang chủ vuốt Home cũng bị lôi vào PiP.
  useEffect(() => {
    return () => { if (isNativeAndroid()) setNativeVideoPlaying(false); };
  }, []);

  // ---- Timeline scrub: 1 bộ pointer events cho cả chuột + touch ----
  // Kéo là thấy preview (dùng chung preview video ẩn), thả ra mới seek thật.
  const scrubWasPlayingRef = useRef(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const pctFromClientX = (clientX: number, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const renderScrubPreview = useCallback((pct: number, opts: { hoverTrack: boolean; moveProgress: boolean }) => {
    if (!duration) return;
    const t = pct * duration;
    const trackEl = document.querySelector('.group\\/scrub') as HTMLElement | null;
    const w = trackEl?.getBoundingClientRect().width || 1;
    if (hoverTooltipRef.current) {
      const tip = hoverTooltipRef.current;
      tip.style.opacity = '1';
      const tipW = tip.offsetWidth || 160;
      const r = Math.min(1 - tipW / 2 / w, Math.max(tipW / 2 / w, pct));
      tip.style.left = `${r * 100}%`;
    }
    if (hoverTimeRef.current) hoverTimeRef.current.innerText = formatTime(t);
    if (hoverTrackRef.current) hoverTrackRef.current.style.width = opts.hoverTrack ? `${pct * 100}%` : '0%';
    // Desktop hover CHỈ hiện tooltip + vệt trắng, KHÔNG đẩy thanh tiến trình thật (đẩy là hành vi mobile khi kéo).
    if (opts.moveProgress && progressBarRef.current) progressBarRef.current.style.width = `${pct * 100}%`;
    setPreviewVisible(true);
    seekPreviewTo(t);
  }, [duration, seekPreviewTo]);
  const restoreProgressBar = useCallback(() => {
    // Trả thanh tiến trình về vị trí phát thật (đọc từ video để khỏi kẹt khung khi đang pause)
    const v = videoRef.current;
    const d = (v?.duration && isFinite(v.duration) ? v.duration : 0) || duration;
    const t = v?.currentTime || 0;
    if (progressBarRef.current) progressBarRef.current.style.width = d ? `${(t / d) * 100}%` : '0%';
  }, [duration]);
  const hideScrubPreview = useCallback((restoreProgress = false) => {
    if (hoverTooltipRef.current) hoverTooltipRef.current.style.opacity = '0';
    if (hoverTrackRef.current) hoverTrackRef.current.style.width = '0%';
    setPreviewVisible(false);
    if (restoreProgress) restoreProgressBar();
  }, [restoreProgressBar]);
  const handleScrubPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v || !duration) return;
    isDraggingRef.current = true;
    scrubWasPlayingRef.current = !v.paused;
    if (!v.paused) v.pause();
    setIsScrubbing(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    renderScrubPreview(pctFromClientX(e.clientX, e.currentTarget as HTMLElement), { hoverTrack: e.pointerType === 'mouse', moveProgress: true });
  }, [duration, renderScrubPreview]);
  const handleScrubPointerMove = useCallback((e: React.PointerEvent) => {
    if (!duration) return;
    if (isDraggingRef.current) {
      renderScrubPreview(pctFromClientX(e.clientX, e.currentTarget as HTMLElement), { hoverTrack: e.pointerType === 'mouse', moveProgress: true });
    } else if (e.pointerType === 'mouse' && !isTouchDeviceRef.current) {
      // Hover desktop: chỉ tooltip + vệt trắng, thanh tiến trình đứng yên
      renderScrubPreview(pctFromClientX(e.clientX, e.currentTarget as HTMLElement), { hoverTrack: true, moveProgress: false });
    }
  }, [duration, renderScrubPreview]);
  const handleScrubPointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    isDraggingRef.current = false;
    setIsScrubbing(false);
    if (!v || !duration) { hideScrubPreview(); return; }
    const pct = pctFromClientX(e.clientX, e.currentTarget as HTMLElement);
    v.currentTime = pct * duration;
    setCurrentTime(pct * duration);
    if (progressBarRef.current) progressBarRef.current.style.width = `${pct * 100}%`;
    // Trả lại trạng thái phát như trước khi chạm (đang phát thì phát tiếp, pause thì giữ pause)
    if (scrubWasPlayingRef.current) v.play().catch(() => {});
    hideScrubPreview();
    resetControlsTimer();
  }, [duration, hideScrubPreview, resetControlsTimer]);
  const handleScrubPointerLeave = useCallback(() => {
    // Rời chuột khi không kéo: ẩn preview + trả thanh về vị trí phát thật (kẻo kẹt khi pause)
    if (!isDraggingRef.current) hideScrubPreview(true);
  }, [hideScrubPreview]);
  // Touch bị ngắt giữa chừng (cuộc gọi đến, vuốt hệ thống): kết thúc kéo, trả thanh + phát tiếp nếu trước đó đang phát
  const handleScrubPointerCancel = useCallback(() => {
    if (!isDraggingRef.current) { hideScrubPreview(true); return; }
    isDraggingRef.current = false;
    setIsScrubbing(false);
    restoreProgressBar();
    const v = videoRef.current;
    if (v && scrubWasPlayingRef.current) v.play().catch(() => {});
    hideScrubPreview();
  }, [hideScrubPreview, restoreProgressBar]);
  const handleScrubKeyDown = useCallback((e: React.KeyboardEvent) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); resetControlsTimer(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5); resetControlsTimer(); }
    else if (e.key === 'Home') { e.preventDefault(); v.currentTime = 0; resetControlsTimer(); }
    else if (e.key === 'End') { e.preventDefault(); v.currentTime = Math.max(0, (v.duration || 0) - 1); resetControlsTimer(); }
  }, [duration, resetControlsTimer]);

  // save progress every 30s
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.paused || !duration) return;
      onSaveProgress?.(v.currentTime, duration);
    }, 30000);
    return () => window.clearInterval(id);
  }, [duration, onSaveProgress]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && e.key !== 'Escape') return;
      const tv = isTvModeActive();
      const k = e.key;
      const kc = (e as any).keyCode;
      // Nút Back của remote TV (browser): Escape / GoBack / Tizen 10009 / LG 461.
      // 2 nấc kiểu Netflix: overlay ẩn -> Back chỉ mở overlay; overlay hiện -> Back thoát về chi tiết.
      if (tv && (k === 'GoBack' || k === 'BrowserBack' || kc === 10009 || kc === 461)) {
        e.preventDefault();
        if (!showControlsRef.current) {
          resetControlsTimer();
          window.setTimeout(() => {
            try {
              containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
            } catch {}
          }, 150);
        } else {
          onBackRef.current();
        }
        return;
      }
      // Media keys remote
      if (k === 'MediaPlayPause' || k === 'Play' || k === 'Pause' || kc === 179) {
        e.preventDefault(); togglePlay(); return;
      }
      if (k === 'MediaRewind') { e.preventDefault(); skip(-10); return; }
      if (k === 'MediaFastForward') { e.preventDefault(); skip(10); return; }
      if (tv) {
        const hidden = !showControlsRef.current;
        const wakeControls = () => {
          resetControlsTimer();
          window.setTimeout(() => {
            try {
              containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
            } catch {}
          }, 150); // box TV chậm, 60ms đôi khi chưa render xong
        };
        // Spec Netflix: ←/→ LUÔN tua ±10s (kể cả khi overlay hiện) + hiện overlay.
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          e.preventDefault();
          skip(k === 'ArrowLeft' ? -10 : 10);
          if (hidden) wakeControls();
          else resetControlsTimer();
          try {
            showGestureToast(k === 'ArrowLeft' ? 'Tua lại 10 giây' : 'Tua tới 10 giây');
          } catch {}
          flashSeek(k === 'ArrowLeft' ? -10 : 10);
          return;
        }
        // ↑/↓: ẩn -> hiện overlay; hiện -> đi vào / di chuyển trong cụm tùy chọn.
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault();
          if (hidden) {
            wakeControls();
            return;
          }
          const active = document.activeElement as HTMLElement | null;
          const inControls = !!active?.closest?.(
            '.tv-player-bottom, .tv-player-top, .player-menu-panel, .group\\/center-skip, .group\\/center-play',
          );
          const isBtn = active?.tagName === 'BUTTON';
          if (inControls || isBtn) {
            const dir = k === 'ArrowUp' ? 'up' as const : 'down' as const;
            focusNearest(dir);
            resetControlsTimer();
            return;
          }
          wakeControls();
          return;
        }
        // OK: ẩn -> chỉ đánh thức; hiện -> nút thì để browser click, card thì click tay, còn lại play/dừng.
        if (k === ' ' || k === 'Enter' || k === 'NumpadEnter') {
          if (hidden) {
            e.preventDefault();
            wakeControls();
            return;
          }
          const active = document.activeElement as HTMLElement | null;
          if (active && (active.tagName === 'BUTTON' || active.tagName === 'A')) {
            return; // browser tự click, không chặn
          }
          e.preventDefault();
          if (active && active.hasAttribute('data-tv-card')) {
            try {
              active.click();
            } catch {}
            return;
          }
          togglePlay();
          return;
        }
      }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      if (!tv && e.key === 'ArrowLeft') { e.preventDefault(); skip(-10); }
      if (!tv && e.key === 'ArrowRight') { e.preventDefault(); skip(10); }
      if (e.key === 'f') toggleFullscreen();
      if (e.key === 'm') toggleMute();
      if (e.key.toLowerCase() === 's' && activeSegment) { e.preventDefault(); handleSkipSegment(activeSegment); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (singleTapTimer.current) window.clearTimeout(singleTapTimer.current);
      if (gestureToastTimer.current) window.clearTimeout(gestureToastTimer.current);
      if (seekFlashTimer.current) window.clearTimeout(seekFlashTimer.current);
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
    };
  }, [togglePlay, skip, toggleFullscreen, toggleMute, activeSegment, handleSkipSegment]);

  return (
    <div
      ref={containerRef}
      id="gau-player-root"
      tabIndex={-1}
      data-controls={showControls ? 'shown' : 'hidden'}
      className="fixed inset-0 z-[70] bg-black flex flex-col select-none outline-none"
      onMouseMove={isTouchDevice ? undefined : resetControlsTimer}
      onClick={isTouchDevice ? undefined : resetControlsTimer}
      onContextMenu={e => e.preventDefault()}
      style={{ touchAction: 'manipulation' }}
    >
      <div
        className="video-area relative flex-1 bg-black flex items-center justify-center overflow-hidden"
        onClick={() => { if (!isTouchDeviceRef.current) handleVideoAreaClick(); }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onContextMenu={e => e.preventDefault()}
        style={{ touchAction: 'none', WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
      >
        <video
            ref={videoRef}
            className={`w-full h-full ${fillMode ? 'object-cover' : 'object-contain'}`}
            style={{ filter: screenBrightness < 1 ? `brightness(${screenBrightness})` : undefined, WebkitTouchCallout: 'none' }}
            onContextMenu={e => e.preventDefault()}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => { setIsPlaying(false); saveProgressNow(); }}
            onWaiting={() => setIsLoading(true)}
            onPlaying={() => setIsLoading(false)}
            onEnded={() => { if (nextEpisode) onSelectEpisode(nextEpisode, currentServer); }}
            playsInline
            disablePictureInPicture={false}
            onClick={handleVideoClick}
          />
        {/* hidden preview video + canvas for hover thumbnail - chophim smooth */}
        <video ref={previewVideoRef} muted playsInline preload="metadata" crossOrigin="anonymous" className="pointer-events-none absolute left-0 top-0 h-[2px] w-[2px] opacity-0" tabIndex={-1} aria-hidden />
        <canvas ref={previewCanvasRef} className="hidden w-0 h-0 pointer-events-none" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <div className="w-12 h-12 sm:w-10 sm:h-10 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
          </div>
        )}
        {/* Double-tap seek flash zones (mobile) - không dùng key để tránh trùng key với toast */}
        {seekFlash === 'left' && (
          <div className="absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-center bg-gradient-to-r from-black/50 to-transparent pointer-events-none animate-pulse">
            <div className="flex flex-col items-center gap-1 text-white bg-black/60 rounded-full w-20 h-20 justify-center">
              <RotateCcw className="w-6 h-6" />
              <span className="text-xs font-bold tabular-nums">-10s</span>
            </div>
          </div>
        )}
        {seekFlash === 'right' && (
          <div className="absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-center bg-gradient-to-l from-black/50 to-transparent pointer-events-none animate-pulse">
            <div className="flex flex-col items-center gap-1 text-white bg-black/60 rounded-full w-20 h-20 justify-center">
              <RotateCw className="w-6 h-6" />
              <span className="text-xs font-bold tabular-nums">+10s</span>
            </div>
          </div>
        )}
        {/* Giữ màn hình x2 indicator */}
        {speedBoost && (
          <div className="absolute top-[calc(env(safe-area-inset-top,0px)+64px)] left-1/2 -translate-x-1/2 pointer-events-none z-30">
            <div className="flex items-center gap-1.5 bg-black/70 backdrop-blur rounded-full px-4 py-2">
              <FastForward className="w-4 h-4 text-white" fill="white" />
              <span className="text-white text-sm font-bold tabular-nums">2x</span>
            </div>
          </div>
        )}
        {/* Đang khóa màn hình: nút mở khóa nổi, mọi chạm khác đều bỏ qua */}
        {isLocked && (
          <div className="absolute inset-y-0 right-3 sm:right-4 flex items-center z-30 pointer-events-none">
            <button
              onClick={(e) => { e.stopPropagation(); toggleLock(); }}
              onTouchStart={e => e.stopPropagation()}
              onTouchMove={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
              aria-label="Mở khóa màn hình"
              className="rounded-full bg-black/60 backdrop-blur border border-white/20 flex items-center justify-center pointer-events-auto active:bg-black/80 transition w-12 h-12"
              style={{ touchAction: 'manipulation' }}
            >
              <Lock className="w-5 h-5 text-white" />
            </button>
          </div>
        )}
        {/* Gesture toast: volume / brightness */}
        {gestureToast && !speedBoost && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30">
            <div className="flex flex-col items-center gap-0.5 bg-black/70 backdrop-blur rounded-2xl px-5 py-3 min-w-[120px]">
              <span className="text-white text-lg font-bold tabular-nums">{gestureToast.text}</span>
              {gestureToast.sub && <span className="text-white/70 text-xs">{gestureToast.sub}</span>}
            </div>
          </div>
        )}
        {/* Mobile hint lần đầu */}
        {errorMsg && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-6 text-center z-40">
            <p className="text-white font-medium">{errorMsg}</p>
            <div className="flex flex-wrap items-center justify-center gap-2.5 mt-5">
              <button onClick={handleRetry} className="px-5 py-2.5 rounded-xl bg-blue-500 active:bg-blue-600 text-white text-sm font-bold transition-all min-h-[44px]" style={{ touchAction: 'manipulation' }}>
                Thử lại
              </button>
              {altServerEp && (
                <button onClick={() => onSelectEpisode(altServerEp.ep, altServerEp.server, videoRef.current?.currentTime)} className="px-5 py-2.5 rounded-xl bg-white/15 active:bg-white/25 text-white text-sm font-medium transition-all min-h-[44px]" style={{ touchAction: 'manipulation' }}>
                  Đổi server ({altServerEp.server.server_name})
                </button>
              )}
              <button onClick={onBack} className="px-5 py-2.5 rounded-xl bg-white/10 active:bg-white/20 text-white/80 text-sm font-medium transition-all min-h-[44px]" style={{ touchAction: 'manipulation' }}>
                Thoát
              </button>
            </div>
          </div>
        )}

        {/* Skip intro/recap/outro - ẩn khi khóa màn hình */}
        {!isLocked && activeSegment && (
          <div
            className="absolute bottom-40 sm:bottom-24 right-4 sm:right-6 z-30 pointer-events-auto"
            onTouchStart={e => { e.stopPropagation(); resetControlsTimer(); }}
            onTouchMove={e => e.stopPropagation()}
            onTouchEnd={e => e.stopPropagation()}
          >
            {activeSegment === 'intro' && (
              <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('intro'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                <SkipForward className="w-4 h-4" /> Bỏ qua phần giới thiệu
              </button>
            )}
            {activeSegment === 'recap' && (
              <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('recap'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                <SkipForward className="w-4 h-4" /> Bỏ qua tóm tắt
              </button>
            )}
            {activeSegment === 'outro' && (
              nextEpisode ? (
                <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('outro'); }} className="cursor-pointer relative overflow-hidden flex items-center gap-2.5 bg-white text-black pl-4 pr-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10 min-w-[210px]">
                  {/* Netflix-style: whole button is the progress bar, fill 0 -> 100% in 3s */}
                  {autoNextEnabled && (
                    <span ref={nextFillRef} className="absolute inset-y-0 left-0 bg-black/15" style={{ width: '0%' }} />
                  )}
                  <SkipForward className="w-4 h-4 shrink-0 relative" />
                  <span className="relative flex-1 text-left">Tập tiếp theo</span>
                </button>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('outro'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                  <SkipForward className="w-4 h-4" /> Bỏ qua outro
                </button>
              )
            )}
          </div>
        )}

        {/* Minimal top bar like chophim */}
        <div
          className={`absolute top-0 left-0 right-0 pt-[calc(env(safe-area-inset-top,0px)+12px)] sm:pt-[calc(env(safe-area-inset-top,0px)+16px)] pb-6 px-3 sm:px-4 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onTouchStart={e => { e.stopPropagation(); resetControlsTimer(); }}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="pr-2 leading-snug min-w-0 flex-1">
              <span className="block text-white text-[15px] sm:text-base font-semibold truncate">{movie.name}</span>
              <span className="block text-white/70 text-xs sm:text-[13px] font-medium truncate mt-0.5">{currentEpisode.name}</span>
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={(e) => { e.stopPropagation(); onBack(); }} aria-label="Thoát" className="shrink-0 rounded-full bg-white/10 active:bg-white/30 hover:bg-white/20 flex items-center justify-center border-0 w-11 h-11 sm:w-8 sm:h-8" style={{ touchAction: 'manipulation' }}>
                <X className="w-5 h-5 sm:w-4 sm:h-4 text-white shrink-0" />
              </button>
            </div>
          </div>
          {/* Mobile: time + server nhanh */}
          <div className="sm:hidden mt-1 flex items-center gap-2 text-[11px] text-white/60 tabular-nums">
            <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
            <span className="w-1 h-1 rounded-full bg-white/30" />
            <span className="truncate">{currentServer.server_name}</span>
          </div>
        </div>

        {/* Center controls kiểu Netflix CHỈ trên mobile: -10s | play/pause | +10s khi controls hiện.
            Desktop không dùng nút giữa màn hình (play + tua đã có ở hàng bottom). */}
        {(isTouchDevice || isTv) ? (
          !isLocked && showControls && !isLoading && !errorMsg && (
            <div
              className="absolute inset-0 flex items-center justify-center gap-14 sm:gap-12 pointer-events-none z-20"
              onTouchStart={e => e.stopPropagation()}
              onTouchMove={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={(e) => { e.stopPropagation(); skip(-10); flashSeek(-10); resetControlsTimer(); }}
                aria-label="Tua lại 10 giây"
                className="relative rounded-full bg-black/50 backdrop-blur flex items-center justify-center pointer-events-auto active:bg-black/70 transition w-16 h-16"
                style={{ touchAction: 'manipulation' }}
              >
                <RotateCcw className="w-10 h-10 text-white shrink-0" strokeWidth={1.5} />
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-white tabular-nums">10</span>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); togglePlay(); resetControlsTimer(); }}
                aria-label={isPlaying ? 'Tạm dừng' : 'Phát'}
                className="rounded-full bg-black/50 backdrop-blur flex items-center justify-center pointer-events-auto active:bg-black/70 transition w-20 h-20"
                style={{ touchAction: 'manipulation' }}
              >
                {isPlaying
                  ? <Pause className="w-9 h-9 text-white shrink-0" fill="white" />
                  : <Play className="w-9 h-9 text-white ml-1 shrink-0" fill="white" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); skip(10); flashSeek(10); resetControlsTimer(); }}
                aria-label="Tua tới 10 giây"
                className="relative rounded-full bg-black/50 backdrop-blur flex items-center justify-center pointer-events-auto active:bg-black/70 transition w-16 h-16"
                style={{ touchAction: 'manipulation' }}
              >
                <RotateCw className="w-10 h-10 text-white shrink-0" strokeWidth={1.5} />
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-white tabular-nums">10</span>
              </button>
            </div>
          )
        ) : null}

        {/* Bottom controls - mobile-first: touch lớn + safe-area.
            Chặn touch bubbling lên video-area để gesture (swipe/tap/giữ-x2)
            không đánh nhau với kéo timeline -> hết lag. */}
        <div
          className={`absolute bottom-0 left-0 right-0 pt-10 px-3 sm:px-6 bg-gradient-to-t from-black/90 via-black/40 to-transparent transition-all duration-300 ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'}`}
          style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom, 0px))', paddingLeft: 'max(12px, env(safe-area-inset-left, 0px))', paddingRight: 'max(12px, env(safe-area-inset-right, 0px))' }}
          onClick={e => e.stopPropagation()}
          onTouchStart={e => { e.stopPropagation(); resetControlsTimer(); }}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        >
          <div className="max-w-screen-2xl mx-auto flex flex-col gap-1.5 sm:gap-2">
            {/* Timeline - pointer scrub + preview cả touch lẫn chuột */}
            <div className="flex items-center gap-2 w-full">
              <span className="hidden sm:block shrink-0 text-[11px] font-medium text-white/80 tabular-nums">{formatTime(currentTime)}</span>
              <div
                className="flex-1 group/scrub relative flex flex-col justify-center h-11 sm:h-8 cursor-pointer outline-none"
                style={{ touchAction: 'none' }}
                role="slider"
                tabIndex={0}
                aria-label="Thanh tiến trình phim"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration || 0)}
                aria-valuenow={Math.round(currentTime)}
                aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
                onPointerDown={handleScrubPointerDown}
                onPointerMove={handleScrubPointerMove}
                onPointerUp={handleScrubPointerUp}
                onPointerCancel={handleScrubPointerCancel}
                onPointerLeave={handleScrubPointerLeave}
                onKeyDown={handleScrubKeyDown}
              >
                {/* Tooltip preview - hiện khi hover (desktop) lẫn khi kéo (touch) */}
                <div ref={hoverTooltipRef} className="absolute bottom-full left-1/2 -translate-x-1/2 opacity-0 transition-opacity duration-150 pointer-events-none mb-2 w-44 sm:w-40 z-10">
                  <div className="relative h-[100px] sm:h-[90px] w-44 sm:w-40 overflow-hidden rounded-xl bg-black shadow-2xl ring-2 ring-white/90">
                    {previewVisible && previewImg ? (
                      <img src={previewImg} alt="" className="w-full h-full object-cover" draggable={false} />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-gray-900 to-black" />
                    )}
                  </div>
                  <div ref={hoverTimeRef} className="mx-auto mt-2 w-fit rounded-md bg-black/90 px-2.5 py-1 text-[13px] sm:text-xs font-semibold text-white shadow-lg tabular-nums">00:00</div>
                </div>
                {/* Track - dày 8px mobile / 5px desktop */}
                <div className={`relative w-full rounded-full bg-white/15 transition-all ${isScrubbing ? 'h-[10px]' : 'h-2 sm:h-[5px] group-hover/scrub:h-[7px]'}`}>
                  <div ref={bufferedBarRef} className="absolute left-0 top-0 h-full rounded-full bg-white/25 pointer-events-none" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
                  <div ref={hoverTrackRef} className="absolute left-0 top-0 h-full rounded-full bg-white/30 pointer-events-none" style={{ width: '0%' }} />
                  <div
                    ref={progressBarRef}
                    className={`absolute left-0 top-0 h-full rounded-full pointer-events-none after:absolute after:right-0 after:top-1/2 after:bg-white after:rounded-full after:-translate-y-1/2 after:translate-x-1/2 after:shadow-[0_0_8px_rgba(0,0,0,0.6)] after:ring-4 after:ring-blue-500/25 after:transition-all ${isScrubbing ? 'bg-blue-400 after:w-5 after:h-5' : 'bg-blue-500 after:w-4 after:h-4 sm:after:w-2.5 sm:after:h-2.5'}`}
                    style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <span className="hidden sm:block shrink-0 text-[11px] font-medium text-white/80 tabular-nums">{formatTime(duration)}</span>
            </div>

            {/* Controls row: trái = play/volume (desktop) + tập trước/tiếp, phải = list/server/cài đặt/pip/fullscreen */}
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-0.5 sm:gap-1">
                {/* Desktop: nút play/pause tròn trắng kiểu YouTube/Netflix web */}
                <button
                  onClick={() => { togglePlay(); resetControlsTimer(); }}
                  aria-label={isPlaying ? 'Tạm dừng' : 'Phát'}
                  data-tv-play
                  title={isPlaying ? 'Tạm dừng (Space)' : 'Phát (Space)'}
                  className="hidden sm:flex rounded-full bg-white text-black items-center justify-center hover:bg-white/90 active:scale-95 transition w-9 h-9 shrink-0"
                >
                  {isPlaying
                    ? <Pause className="w-4 h-4 shrink-0" fill="currentColor" />
                    : <Play className="w-4 h-4 ml-0.5 shrink-0" fill="currentColor" />}
                </button>
                {/* Desktop chuột: tua -10s cạnh play (mobile dùng phím giữa màn hình + vuốt) */}
                <button
                  onClick={() => { skip(-10); resetControlsTimer(); }}
                  aria-label="Tua lại 10 giây"
                  title="Tua lại 10 giây (←)"
                  className="hidden pointer-fine:flex tv-seek-btn rounded-full hover:bg-white/10 active:scale-95 items-center justify-center text-white w-9 h-9 shrink-0 transition"
                >
                  <span className="relative flex items-center justify-center">
                    <RotateCcw className="w-5 h-5 shrink-0" strokeWidth={1.75} />
                    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white tabular-nums pt-0.5">10</span>
                  </span>
                </button>
                {/* Desktop chuột: tua +10s cạnh play (mobile dùng phím giữa màn hình + vuốt) */}
                <button
                  onClick={() => { skip(10); resetControlsTimer(); }}
                  aria-label="Tua tới 10 giây"
                  title="Tua tới 10 giây (→)"
                  className="hidden pointer-fine:flex tv-seek-btn rounded-full hover:bg-white/10 active:scale-95 items-center justify-center text-white w-9 h-9 shrink-0 transition"
                >
                  <span className="relative flex items-center justify-center">
                    <RotateCw className="w-5 h-5 shrink-0" strokeWidth={1.75} />
                    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white tabular-nums pt-0.5">10</span>
                  </span>
                </button>
                {/* Desktop chuột: volume mute + slider (mobile dùng phím cứng của máy) */}
                <div className="hidden pointer-fine:flex items-center gap-0.5 group/vol">
                  <button
                    onClick={() => { toggleMute(); resetControlsTimer(); }}
                    aria-label={isMuted || volume === 0 ? 'Bật tiếng (M)' : 'Tắt tiếng (M)'}
                    title={isMuted || volume === 0 ? 'Bật tiếng (M)' : 'Tắt tiếng (M)'}
                    className="rounded-full hover:bg-white/10 flex items-center justify-center text-white w-8 h-8 shrink-0"
                  >
                    {isMuted || volume === 0
                      ? <VolumeX className="w-4 h-4 shrink-0" />
                      : <Volume2 className="w-4 h-4 shrink-0" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={handleVolume}
                    aria-label="Âm lượng"
                    className="w-0 opacity-0 group-hover/vol:w-20 group-hover/vol:opacity-100 focus-visible:w-20 focus-visible:opacity-100 transition-all accent-white h-1 cursor-pointer"
                  />
                </div>
                {currentServer.server_data.length > 1 && (
                  <>
                    <button
                      onClick={() => { if (prevEpisode) { onSelectEpisode(prevEpisode, currentServer); resetControlsTimer(); } }}
                      disabled={!prevEpisode}
                      aria-label="Tập trước"
                      title="Tập trước"
                      className="rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11 sm:w-8 sm:h-8 disabled:opacity-30 disabled:active:bg-transparent"
                      style={{ touchAction: 'manipulation' }}
                    >
                      <SkipBack className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" fill="currentColor" />
                    </button>
                    <button
                      onClick={() => { if (nextEpisode) { onSelectEpisode(nextEpisode, currentServer); resetControlsTimer(); } }}
                      disabled={!nextEpisode}
                      aria-label="Tập tiếp theo"
                      title="Tập tiếp theo"
                      className="rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11 sm:w-8 sm:h-8 disabled:opacity-30 disabled:active:bg-transparent"
                      style={{ touchAction: 'manipulation' }}
                    >
                      <SkipForward className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" fill="currentColor" />
                    </button>
                    <span className="ml-1 text-[11px] sm:text-xs text-white/60 font-medium tabular-nums whitespace-nowrap">
                      {episodeIndex >= 0 ? episodeIndex + 1 : '–'} / {currentServer.server_data.length} tập
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-0.5 sm:gap-1">
                {/* Episode list - bottom-sheet trên mobile, popup trên desktop */}
                {currentServer.server_data.length > 1 && (
                  <div className="relative">
                    <button onClick={() => { setShowEpisodes(!showEpisodes); setShowServerMenu(false); setShowSettings(false); }} aria-label="Danh sách tập" className="player-menu-btn rounded-full sm:rounded-lg bg-transparent active:bg-white/20 hover:bg-white/10 border border-transparent hover:border-white/10 text-white flex items-center justify-center sm:justify-start gap-1.5 transition-colors w-11 h-11 sm:w-auto sm:h-8 sm:px-2.5" style={{ touchAction: 'manipulation' }} title="Danh sách tập"><List className="w-5 h-5 sm:w-3.5 sm:h-3.5 shrink-0" /> <span className="hidden sm:inline text-xs truncate">Danh sách tập</span></button>
                    {showEpisodes && (
                      <>
                        {/* Backdrop mobile */}
                        <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setShowEpisodes(false)} onTouchEnd={() => setShowEpisodes(false)} />
                        <div className="player-menu-panel z-50 bg-[#1c1c1e] border border-white/10 shadow-2xl fixed inset-x-0 bottom-0 rounded-t-2xl p-4 pb-[max(20px,env(safe-area-inset-bottom,0px))] max-h-[70vh] overflow-auto sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-10 sm:rounded-xl sm:p-3 sm:w-72 sm:max-h-64 sm:pb-3">
                          <div className="sm:hidden w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[11px] font-bold text-white/50 uppercase">Danh sách tập ({currentServer.server_data.length})</p>
                            <button onClick={() => setShowEpisodes(false)} className="sm:hidden w-8 h-8 rounded-full bg-white/10 flex items-center justify-center" aria-label="Đóng"><ChevronDown className="w-4 h-4 text-white" /></button>
                          </div>
                          <div className="grid grid-cols-5 sm:grid-cols-4 gap-2 sm:gap-1.5">
                            {currentServer.server_data.map(ep => (
                              <button key={ep.slug} onClick={() => { onSelectEpisode(ep, currentServer); setShowEpisodes(false); }} className={`text-sm sm:text-xs py-3 sm:py-2 rounded-xl sm:rounded-lg font-medium active:scale-95 transition ${ep.slug===currentEpisode.slug ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>{ep.name.replace(/^Tập\s*/i,'').trim().padStart(2,'0')}</button>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {/* Server */}
                <div className="relative">
                  <button onClick={() => { setShowServerMenu(!showServerMenu); setShowSettings(false); setShowEpisodes(false); }} aria-label="Âm thanh & Phụ đề" title="Âm thanh & Phụ đề" className="player-menu-btn rounded-full sm:rounded-lg bg-transparent active:bg-white/20 hover:bg-white/10 border border-transparent hover:border-white/10 text-white flex items-center justify-center sm:justify-start gap-1.5 transition-colors w-11 h-11 sm:w-auto sm:h-8 sm:px-2.5" style={{ touchAction: 'manipulation' }}><Server className="w-5 h-5 sm:w-3 sm:h-3 shrink-0" /> <span className="hidden sm:inline text-xs truncate">Âm thanh & Phụ đề</span></button>
                  {showServerMenu && (
                    <>
                      <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setShowServerMenu(false)} onTouchEnd={() => setShowServerMenu(false)} />
                      <div className="player-menu-panel z-50 bg-[#1c1c1e] border border-white/10 shadow-2xl fixed inset-x-0 bottom-0 rounded-t-2xl p-4 pb-[max(20px,env(safe-area-inset-bottom,0px))] max-h-[60vh] overflow-auto sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-10 sm:rounded-xl sm:p-2 sm:w-48 sm:max-h-60 sm:pb-2">
                        <div className="sm:hidden w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
                        <p className="text-[11px] font-bold text-white/50 uppercase mb-2 px-1">Âm thanh & Phụ đề</p>
                        {allServers.map(s => (
                          <button key={s.server_name} onClick={() => { const ep = s.server_data.find(e => e.slug === currentEpisode.slug) || s.server_data[0]; if (ep) onSelectEpisode(ep, s, videoRef.current?.currentTime); setShowServerMenu(false); }} className={`w-full text-left px-3 py-3 sm:py-2 rounded-xl sm:rounded-lg text-sm sm:text-xs mb-1 active:scale-[0.98] transition ${s.server_name===currentServer.server_name ? 'bg-blue-500 text-white' : 'text-white/80 bg-white/5 sm:bg-transparent active:bg-white/15'}`}>{s.server_name}</button>
                        ))}
                        {allServers.length===0 && <span className="text-xs text-white/40 px-3">Không có server khác</span>}
                      </div>
                    </>
                  )}
                </div>
                <div className="relative">
                  <button onClick={() => { setShowSettings(!showSettings); setShowServerMenu(false); setShowEpisodes(false); }} aria-label="Cài đặt" className="player-menu-btn rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11 sm:w-8 sm:h-8" style={{ touchAction: 'manipulation' }}><Settings className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" /></button>
                  {showSettings && (
                    <>
                      <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setShowSettings(false)} onTouchEnd={() => setShowSettings(false)} />
                      <div className="player-menu-panel z-50 bg-[#1c1c1e] border border-white/10 shadow-2xl fixed inset-x-0 bottom-0 rounded-t-2xl p-4 pb-[max(20px,env(safe-area-inset-bottom,0px))] max-h-[75vh] overflow-auto sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-10 sm:rounded-xl sm:p-3 sm:w-56 sm:max-h-none sm:pb-3">
                        <div className="sm:hidden w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
                        <div className="flex items-center justify-between mb-3 sm:mb-0">
                          <p className="sm:hidden text-sm font-bold text-white">Cài đặt phát lại</p>
                          <button onClick={() => setShowSettings(false)} className="sm:hidden w-8 h-8 rounded-full bg-white/10 flex items-center justify-center" aria-label="Đóng"><ChevronDown className="w-4 h-4 text-white" /></button>
                        </div>
                        {/* Mobile: volume + brightness nhanh */}
                        <div className="sm:hidden mb-4 grid grid-cols-2 gap-2">
                          <div className="bg-white/5 rounded-xl p-3">
                            <p className="text-[11px] font-bold text-white/50 uppercase mb-2 flex items-center gap-1"><Volume2 className="w-3 h-3" /> Âm lượng</p>
                            <input type="range" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={handleVolume} className="w-full accent-blue-500 h-8" />
                            <p className="text-xs text-white/70 tabular-nums mt-1">{Math.round((isMuted ? 0 : volume) * 100)}%</p>
                          </div>
                          <div className="bg-white/5 rounded-xl p-3">
                            <p className="text-[11px] font-bold text-white/50 uppercase mb-2 flex items-center gap-1"><Sun className="w-3 h-3" /> Độ sáng</p>
                            <input type="range" min={0.4} max={1} step={0.05} value={screenBrightness} onChange={(e) => setScreenBrightness(parseFloat(e.target.value))} className="w-full accent-blue-500 h-8" />
                            <p className="text-xs text-white/70 tabular-nums mt-1">{Math.round(screenBrightness * 100)}%</p>
                          </div>
                        </div>
                      <div className="mb-3">
                        <p className="text-[11px] font-bold text-white/50 uppercase mb-2">Tốc độ</p>
                        <div className="grid grid-cols-5 sm:grid-cols-4 gap-1.5 sm:gap-1">
                          {[0.5,1,1.25,1.5,2].map(v => (
                            <button key={v} onClick={() => { if(videoRef.current) videoRef.current.playbackRate=v; setPlaybackRate(v); }} className={`px-2 py-2.5 sm:py-1.5 rounded-xl sm:rounded-lg text-sm sm:text-xs font-medium active:scale-95 transition ${playbackRate===v ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>{v}x</button>
                          ))}
                        </div>
                      </div>
                      <div className="mb-3">
                        <p className="text-[11px] font-bold text-white/50 uppercase mb-2">Tự động chuyển tập</p>
                        <div className="grid grid-cols-2 gap-1.5 sm:gap-1">
                          <button onClick={() => { if (!autoNextEnabled) toggleAutoNext(); }} className={`px-2 py-2.5 sm:py-1.5 rounded-xl sm:rounded-lg text-sm sm:text-xs font-medium ${autoNextEnabled ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>Bật</button>
                          <button onClick={() => { if (autoNextEnabled) toggleAutoNext(); }} className={`px-2 py-2.5 sm:py-1.5 rounded-xl sm:rounded-lg text-sm sm:text-xs font-medium ${!autoNextEnabled ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>Tắt</button>
                        </div>
                      </div>
                      <div>
                        <p className="text-[11px] font-bold text-white/50 uppercase mb-2">Chất lượng</p>
                        <div className="flex flex-col gap-1.5 sm:gap-1 max-h-40 sm:max-h-32 overflow-auto">
                          <button onClick={() => { if(hlsRef.current) hlsRef.current.currentLevel=-1; setCurrentQuality(-1); }} className={`px-3 py-2.5 sm:py-1.5 rounded-xl sm:rounded-lg text-sm sm:text-xs text-left ${currentQuality===-1 ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>Tự động</button>
                          {qualityLevels.map(lvl => (
                            <button key={lvl.level} onClick={() => { if(hlsRef.current) hlsRef.current.currentLevel=lvl.level; setCurrentQuality(lvl.level); }} className={`px-3 py-2.5 sm:py-1.5 rounded-xl sm:rounded-lg text-sm sm:text-xs text-left ${currentQuality===lvl.level ? 'bg-blue-500 text-white' : 'bg-white/10 text-white/80 active:bg-white/20'}`}>{lvl.height ? `${lvl.height}p` : `${Math.round((lvl.bitrate||0)/1000)}kbps`}</button>
                          ))}
                        </div>
                      </div>
                      </div>
                    </>
                  )}
                </div>
                {/* PiP: chỉ hiện khi nền tảng hỗ trợ (web/PWA có browser PiP, APK có native PiP) */}
                {pipSupported && (
                  <button onClick={handlePip} aria-label="Picture in picture" className={`rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 ${isPip ? 'text-blue-400' : 'text-white'}`} style={{ touchAction: 'manipulation' }}><PictureInPicture2 className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" /></button>
                )}
                {/* Khóa màn hình: chỉ mobile (touch) mới cần, desktop ẩn */}
                <button onClick={toggleLock} aria-label="Khóa màn hình" title="Khóa màn hình" className="sm:hidden rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11" style={{ touchAction: 'manipulation' }}><Lock className="w-5 h-5 shrink-0" /></button>
                <button onClick={toggleFullscreen} aria-label="Toàn màn hình" className={`rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 ${isNativeAndroid() && nativeImmersive ? 'text-blue-400' : 'text-white'}`} style={{ touchAction: 'manipulation' }}>{(isFullscreen || (isNativeAndroid() && nativeImmersive)) ? <Minimize className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" /> : <Maximize className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" />}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
GauPlayer.displayName = 'GauPlayer';
