import React, { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import Hls from 'hls.js';
import { Play, Pause, Settings, Captions, X, RotateCcw, RotateCw, SkipForward, SkipBack, List, ChevronDown, FastForward, Lock } from 'lucide-react';
import { EpisodeServer, Movie, MovieEpisode, Account, UserProfile } from '../types';
import { getMirrorUrls } from '../utils/mirrorUrls';
import { loadCleanedM3u8Url, revokeBlobUrl } from '../utils/m3u8Cleaner';
import { getFullApiUrl, verifyBackendUrl } from '../services/apiConfig';
import { resolveImdbId } from '../utils/introResolve';
import { presenceService } from '../services/presenceService';
import { Capacitor } from '@capacitor/core';
import { setNativeVideoPlaying, setImmersiveMode, isNativeAndroidApp } from '../utils/nativeVideoPlayer';
import { focusNearest, isTvModeActive, markProgrammaticFocus } from '../utils/tvRemote';
import { useTvMode } from '../hooks/useTvMode';
import { getCachedCleaned } from '../utils/m3u8Cleaner';

/** Điểm đến đã có trong buffer chưa (loop index: TimeRanges không iterable). */
function isBufferedAt(v: HTMLVideoElement, t: number): boolean {
  try {
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return true;
    }
  } catch {}
  return false;
}

/** Thiết bị yếu (TV/box RAM thấp): buffer HLS gọn nhẹ hơn. */
function isWeakPlaybackDevice(): boolean {
  try {
    if (document.documentElement.classList.contains('tv-mode')) return true;
    const mem = (navigator as any)?.deviceMemory;
    if (typeof mem === 'number' && mem <= 4) return true;
  } catch {}
  return false;
}

function isNativeAndroid(): boolean {
  try { return isNativeAndroidApp(); } catch { return false; }
}

/** Seek Mode kiểu Netflix (TV filmstrip): số thumbnail + bước nhảy mỗi thumbnail. */
const SEEK_STRIP_N = 5;
const SEEK_STEP_SEC = 30;

/** Dựng dải mốc giờ cho filmstrip: clamp trong [0, duration], bỏ trùng. */
function buildSeekTimes(start: number, duration: number): number[] {
  const d = duration > 0 ? duration : 0;
  const arr: number[] = [];
  for (let i = 0; i < SEEK_STRIP_N; i++) {
    const t = Math.max(0, Math.min(d > 0 ? d - 0.5 : 0, start + i * SEEK_STEP_SEC));
    if (!arr.some((x) => Math.abs(x - t) < 1)) arr.push(t);
  }
  return arr.length ? arr : [0];
}

/** Chụp 1 frame của video vào canvas ẩn, lưu cache theo bucket 2s (chung với preview). */
function storeThumbFromVideo(
  el: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  cache: Map<number, string>,
  t: number,
): boolean {
  try {
    if (!el || !canvas || !el.videoWidth) return false;
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    (ctx as any).imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = 'high';
    ctx.drawImage(el, 0, 0, 320, 180);
    const url = canvas.toDataURL('image/jpeg', 0.7);
    if (cache.size > 120) cache.clear();
    cache.set(Math.floor(t / 2), url);
    return true;
  } catch {
    return false;
  }
}

/** Seek video preview tới mốc giờ rồi đợi frame (timeout để không kẹt hàng đợi). */
function waitPreviewFrame(pv: HTMLVideoElement, t: number, duration: number, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { pv.removeEventListener('seeked', onS); } catch {}
      resolve();
    };
    const onS = () => finish();
    try { pv.addEventListener('seeked', onS); } catch { finish(); return; }
    try {
      const max = duration > 0 ? duration - 0.5 : t;
      pv.currentTime = Math.max(0, Math.min(Math.max(0, max), t));
    } catch { finish(); return; }
    window.setTimeout(finish, timeoutMs);
  });
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
  /** Đang chờ source nền (mở player ngay kiểu Netflix): hiện shell + poster, chưa phát */
  isResolvingSource?: boolean;
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
  isResolvingSource = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isTv = useTvMode();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // Ref đồng bộ cho handler keydown (đăng ký 1 lần) khi đang chờ source
  const isResolvingRef = useRef(false);
  isResolvingRef.current = isResolvingSource;

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
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  // Giai đoạn load (D3): source -> stream -> buffering -> '' (đang phát)
  const [loadStage, setLoadStage] = useState<'source' | 'stream' | 'buffering' | ''>('source');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [qualityLevels, setQualityLevels] = useState<{ height: number; level: number; bitrate?: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number>(-1);
  const [showSettings, setShowSettings] = useState(false);
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [showEpisodes, setShowEpisodes] = useState(false);
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
  // Nguồn embed-only (vd NguonC chỉ có link_embed, không có m3u8): phát qua iframe
  // thay vì báo "chưa có dữ liệu phát" (giống SimplePlayer).
  const [useEmbed, setUseEmbed] = useState(false);
  // Chế độ khung hình: false = Fit (contain, đủ hình), true = Fill (cover, lấp màn hình)
  const [fillMode, setFillMode] = useState(false);
  const pinchRef = useRef<{ startDist: number } | null>(null);
  const saveProgressRef = useRef(onSaveProgress);
  saveProgressRef.current = onSaveProgress;
  // smartSeek khai báo phía dưới — mirror qua ref để seek callbacks dùng trước không dính TDZ
  const smartSeekRef = useRef<(t: number) => void>(() => {});
  // resetControlsTimer cũng khai báo phía dưới — tương tự
  const resetControlsTimerRef = useRef<() => void>(() => {});

  // Presence + analytics: báo admin ai đang xem phim gì (_GauPlayer là player chính,
  // SimplePlayer đã không còn dùng nên pipeline userStats/lịch sử bị thiếu phim).
  useEffect(() => {
    if (!currentAccount || isResolvingSource) return;
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
  }, [movie.slug, movie.name, currentEpisode.slug, currentEpisode.name, currentServer.server_name, currentAccount, activeProfile, isResolvingSource]);
  const isLockedRef = useRef(false);
  isLockedRef.current = isLocked;
  const [speedBoost, setSpeedBoost] = useState(false);
  const [nativeImmersive, setNativeImmersive] = useState(false);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleTapTimer = useRef<number | null>(null);
  // Tap này chỉ để tắt menu (đã xử lý ngay ở touchstart) -> touchend bỏ qua, khỏi toggle controls
  const consumeTapRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number; mode: null | 'volume' | 'brightness' | 'ignore'; startVolume: number; startBrightness: number; moved: boolean; holdFired: boolean } | null>(null);
  const gestureToastTimer = useRef<number | null>(null);
  const seekFlashTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  // Nút play/pause giữa màn hình: flash ~1s mỗi lần bấm rồi tự ẩn
  const [showCenterFlash, setShowCenterFlash] = useState(false);
  const centerFlashTimer = useRef<number | null>(null);
  const prevRateRef = useRef(1);
  const showControlsRef = useRef(true);
  showControlsRef.current = showControls;
  // Refs đồng bộ để handler keydown (đăng ký 1 lần) không đọc state stale
  const showSettingsRef = useRef(false);
  showSettingsRef.current = showSettings;
  const showServerMenuRef = useRef(false);
  showServerMenuRef.current = showServerMenu;
  const showEpisodesRef = useRef(false);
  showEpisodesRef.current = showEpisodes;
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
  // TV tua bằng D-pad: preview hiện rồi tự ẩn sau 1.5s (khỏi dính màn hình)
  const previewHideTimer = useRef<number | null>(null);
  // TV remote: nhớ nút đã mở menu để đóng menu trả focus về đúng chỗ (Netflix-style)
  const menuOpenerRef = useRef<HTMLButtonElement | null>(null);
  const episodeBtnRef = useRef<HTMLButtonElement | null>(null);
  const serverBtnRef = useRef<HTMLButtonElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  // TV remote: nút skip intro / tập tiếp theo (ưu tiên focus khi vừa hiện)
  const skipSegmentBtnRef = useRef<HTMLButtonElement | null>(null);
  // TV Seek Mode (filmstrip kiểu Netflix): actualTime (video thật, đứng yên) và
  // previewTime (thumbnail đang focus) tách riêng — chỉ OK mới gán actual = preview.
  const [seekMode, setSeekMode] = useState(false);
  const [seekWindowStart, setSeekWindowStart] = useState(0);
  const [seekFocusIdx, setSeekFocusIdx] = useState(0);
  const [seekTick, setSeekTick] = useState(0); // re-render khi thumbnail mới về
  const seekModeRef = useRef(false);
  const seekWindowRef = useRef(0);
  const seekFocusRef = useRef(0);
  const seekActualRef = useRef(0);
  const seekWasPlayingRef = useRef(false);
  const seekGenRef = useRef(0); // hủy hàng đợi capture cũ khi cửa sổ đổi/thoát

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
    // Đang chờ source nền: chưa có tập thật, bỏ qua resolving intro
    if (isResolvingSource) return;
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
  }, [(movie as any)?.imdb?.id, (movie as any)?.tmdb?.id, (movie as any)?.tmdb?.season, (movie as any)?.slug, (movie as any)?.name, (movie as any)?.origin_name, (movie as any)?.year, currentEpisode.slug, currentEpisode.name, currentServer, isResolvingSource]);

  const handleSkipSegment = useCallback((type: 'intro' | 'recap' | 'outro') => {
    const v = videoRef.current;
    if (!v) return;
    const seg = type === 'intro' ? segments?.intro : type === 'recap' ? segments?.recap : segments?.outro;
    if (type === 'outro') {
      if (nextEpisode) onSelectEpisode(nextEpisode, currentServer);
      else if (seg && typeof seg.end_sec === 'number' && seg.end_sec > 0) {
        const t = Math.min(v.duration || seg.end_sec, seg.end_sec);
        try { v.currentTime = t; } catch {}
        setCurrentTime(t);
      }
      return;
    }
    if (seg && typeof seg.end_sec === 'number') {
      const t = seg.end_sec + 0.2;
      try { v.currentTime = t; } catch {}
      setCurrentTime(t);
    }
  // NOTE: bỏ qua intro/recap là nhảy có chủ đích (điểm đến ngoài buffer là
  // bình thường) nên set trực tiếp, không qua smartSeek.
  }, [segments, nextEpisode, currentServer, onSelectEpisode]);

  // ---- TV Seek Mode (filmstrip): capture thumbnail cho dải mốc giờ hiện tại ----
  // Chạy nền theo hàng đợi, từng mốc một (đợi 'seeked'/timeout). Đổi cửa sổ hoặc
  // thoát mode là tăng generation để hủy lượt cũ. Frame lưu vào previewFrameCache.
  const queueSeekCaptures = useCallback((start: number, d: number) => {
    const gen = ++seekGenRef.current;
    const times = buildSeekTimes(start, d);
    (async () => {
      const pv = previewVideoRef.current;
      if (!pv) return;
      // Đợi preview engine gắn xong (setup effect chạy sau commit) tối đa ~4s
      for (let w = 0; w < 40; w++) {
        if (seekGenRef.current !== gen) return;
        try {
          if (previewHlsRef.current || (pv as any).readyState >= 1) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      for (const t of times) {
        if (seekGenRef.current !== gen) return;
        if (previewFrameCache.current.has(Math.floor(t / 2))) continue;
        try {
          await waitPreviewFrame(pv, t, d);
        } catch {}
        if (seekGenRef.current !== gen) return;
        setSeekTick((x) => x + 1);
      }
    })();
  }, []);

  // Vào Seek Mode: đóng băng actualTime, pause video, dựng cửa sổ 5 thumbnails
  // quanh vị trí hiện tại, focus vào mốc gần nhất. Video chính KHÔNG seek.
  const enterSeekMode = useCallback(() => {
    const v = videoRef.current;
    const d = (v?.duration && isFinite(v.duration) ? v.duration : 0) || duration;
    if (!v || !d || useEmbed) return false;
    const actual = v.currentTime || 0;
    seekActualRef.current = actual;
    seekWasPlayingRef.current = !v.paused;
    if (!v.paused) v.pause();
    const start = Math.max(
      0,
      Math.min(actual - 2 * SEEK_STEP_SEC, Math.max(0, d - (SEEK_STRIP_N - 1) * SEEK_STEP_SEC)),
    );
    const times = buildSeekTimes(start, d);
    let fi = 0;
    let best = Infinity;
    times.forEach((t, i) => {
      const dd = Math.abs(t - actual);
      if (dd < best) { best = dd; fi = i; }
    });
    seekWindowRef.current = start;
    seekFocusRef.current = fi;
    setSeekWindowStart(start);
    setSeekFocusIdx(fi);
    seekModeRef.current = true;
    setSeekMode(true);
    // Frame hiện tại làm thumbnail giữa ngay lập tức (khỏi đợi preview engine)
    try {
      if (storeThumbFromVideo(v, previewCanvasRef.current, previewFrameCache.current, actual)) {
        setSeekTick((x) => x + 1);
      }
    } catch {}
    queueSeekCaptures(start, d);
    resetControlsTimerRef.current();
    return true;
  }, [duration, useEmbed, queueSeekCaptures]);

  // Dời focus previewTime (video chính đứng yên tuyệt đối)
  const moveSeekFocus = useCallback((dir: 'left' | 'right') => {
    const v = videoRef.current;
    const d = (v?.duration && isFinite(v.duration) ? v.duration : 0) || duration;
    if (!d || !seekModeRef.current) return;
    const start = seekWindowRef.current;
    const times = buildSeekTimes(start, d);
    const fi = Math.min(seekFocusRef.current, times.length - 1);
    const prevT = times[fi] ?? seekActualRef.current;
    if (dir === 'right') {
      if (fi >= times.length - 1 && times[times.length - 1] >= d - 1) return; // hết phim
    } else {
      if (fi <= 0 && start <= 0) return; // đầu phim
    }
    // Trượt cửa sổ khi chạm biên, không thì đi trong cửa sổ
    let nextStart = start;
    if (dir === 'right' && fi >= times.length - 1) nextStart = start + SEEK_STEP_SEC;
    if (dir === 'left' && fi <= 0) nextStart = Math.max(0, start - SEEK_STEP_SEC);
    const nt = buildSeekTimes(nextStart, d);
    // Focus vào mốc kề theo hướng đi (kể cả khi trượt cửa sổ)
    const target = prevT + (dir === 'right' ? SEEK_STEP_SEC : -SEEK_STEP_SEC);
    let nfi = 0;
    let nbest = Infinity;
    nt.forEach((t, i) => {
      const dd = Math.abs(t - target);
      if (dd < nbest) { nbest = dd; nfi = i; }
    });
    seekWindowRef.current = nextStart;
    seekFocusRef.current = nfi;
    setSeekWindowStart(nextStart);
    setSeekFocusIdx(nfi);
    queueSeekCaptures(nextStart, d);
    resetControlsTimerRef.current();
  }, [duration, queueSeekCaptures]);

  // OK: actualTime = previewTime, thoát mode, PLAY LUÔN (kể cả vào seek lúc
  // đang pause — người dùng đã chọn điểm xem mới thì phát tiếp chứ không giữ pause)
  const commitSeek = useCallback(() => {
    const v = videoRef.current;
    const d = (v?.duration && isFinite(v.duration) ? v.duration : 0) || duration;
    const times = buildSeekTimes(seekWindowRef.current, d);
    const t = times[Math.min(seekFocusRef.current, times.length - 1)] ?? seekActualRef.current;
    seekGenRef.current++;
    seekModeRef.current = false;
    setSeekMode(false);
    // smartSeek khai báo sau (tránh TDZ) nên gọi qua ref
    if (v && d) smartSeekRef.current(t);
    if (v) v.play().catch(() => {});
    resetControlsTimerRef.current();
  }, [duration]);

  // Back: hủy, KHÔNG đổi currentTime, thoát mode, phát tiếp chỗ cũ
  const cancelSeek = useCallback(() => {
    const v = videoRef.current;
    seekGenRef.current++;
    seekModeRef.current = false;
    setSeekMode(false);
    if (v && seekWasPlayingRef.current) v.play().catch(() => {});
    resetControlsTimerRef.current();
  }, []);

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

  // TV remote: nút Skip intro / Bỏ qua tóm tắt / Tập tiếp theo vừa hiện thì
  // ưu tiên focus ngay để bấm OK là nhảy, khỏi mò D-pad (Netflix-style).
  // Chỉ trên tv-mode; hết segment (nút unmount) thì trả focus về nút play.
  useEffect(() => {
    if (!activeSegment || isLocked || useEmbed) return;
    let tv = false;
    try { tv = document.documentElement.classList.contains('tv-mode'); } catch {}
    if (!tv) return;
    const t = window.setTimeout(() => {
      try {
        const btn = skipSegmentBtnRef.current;
        if (btn && document.contains(btn)) {
          try { markProgrammaticFocus(); } catch {}
          btn.focus({ preventScroll: true } as FocusOptions);
        }
      } catch {}
    }, 150); // box TV render chậm, focus ngay dễ trượt
    return () => {
      window.clearTimeout(t);
      try {
        const a = document.activeElement as HTMLElement | null;
        if (a && a.hasAttribute?.('data-tv-skip-segment')) {
          const play = containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]');
          const target = play || containerRef.current;
          if (target) {
            try { markProgrammaticFocus(); } catch {}
            target.focus({ preventScroll: true } as FocusOptions);
          }
        }
      } catch {}
    };
  }, [activeSegment, isLocked, useEmbed, currentEpisode.slug]);

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
        // Ngoại lệ: nút skip intro / tập tiếp theo vẫn hiện ngoài overlay -> giữ nguyên.
        try {
          if (document.documentElement.classList.contains('tv-mode')) {
            const root = containerRef.current;
            const a = document.activeElement as HTMLElement | null;
            if (root && a && a !== root && root.contains(a) && !a.hasAttribute?.('data-tv-skip-segment')) {
              root.focus({ preventScroll: true } as FocusOptions);
            }
          }
        } catch {}
      }
    }, 4000);
  }, [showSettings, showServerMenu, showEpisodes]);

  resetControlsTimerRef.current = resetControlsTimer;

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
      if (!showSettings && !showServerMenu && !showEpisodes && !isDraggingRef.current) {
        setShowControls(false);
        // TV: giống resetControlsTimer — dời focus khỏi nút sắp ẩn về khung player
        // để remote bấm tiếp không "mất hút" + WebView không vẽ viền vàng lên nút ẩn.
        // Ngoại lệ: nút skip intro / tập tiếp theo vẫn hiện ngoài overlay -> giữ nguyên.
        try {
          if (document.documentElement.classList.contains('tv-mode')) {
            const root = containerRef.current;
            const a = document.activeElement as HTMLElement | null;
            if (root && a && a !== root && root.contains(a) && !a.hasAttribute?.('data-tv-skip-segment')) {
              root.focus({ preventScroll: true } as FocusOptions);
            }
          }
        } catch {}
      }
    }, 4000);
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
  // otherwise thumbnails show ad frames that don't exist in cleaned playback.
  // Preview thumbnail: CHỈ desktop (pointer fine) + lúc TV Seek Mode cần filmstrip.
  // TV thường tắt (2 HLS + 2 decoder quá nặng cho box yếu); mobile/touch cũng tắt
  // (đỡ 1 HLS instance + tốn data/pin) — tooltip vẫn hiện giờ giấc.
  // Seek Mode TV bật riêng instance transient, thoát mode là destroy.
  useEffect(() => {
    const pv = previewVideoRef.current;
    if (!pv || !currentEpisode.link_m3u8) return;
    if (previewHlsRef.current) { previewHlsRef.current.destroy(); previewHlsRef.current = null; }
    // Đổi tập: xóa cache frame cũ để khỏi hiện nhầm ảnh tập trước
    previewFrameCache.current.clear();
    lastPreviewTarget.current = -1;
    setPreviewImg(null);
    let previewOff = false;
    try {
      previewOff = document.documentElement.classList.contains('tv-mode');
      if (!previewOff && typeof window !== 'undefined') {
        previewOff =
          ('ontouchstart' in window) ||
          (navigator.maxTouchPoints > 0) ||
          !!window.matchMedia?.('(pointer: coarse)').matches;
      }
    } catch {}
    // TV Seek Mode là ngoại lệ duy nhất được bật preview (lấy thumbnail filmstrip)
    if (previewOff && !seekMode) return;
    const directRaw = getMirrorUrls(currentEpisode.link_m3u8)[0];
    if (!directRaw) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode.link_m3u8, capturePreviewFrame, isTv, seekMode]);

  // D1: đang xem tập N thì chuẩn bị sẵn master + bản clean của tập N+1
  // (chỉ metadata/playlist vài KB, KHÔNG tải video). Bấm Next là phát ngay.
  useEffect(() => {
    try {
      const next = nextEpisode as any;
      const raw = next?.link_m3u8 ? getMirrorUrls(next.link_m3u8)[0] : null;
      if (!raw) return;
      let cancelled = false;
      // Đợi phát ổn định 5s rồi mới prefetch để khỏi tranh băng thông first-frame
      const t = window.setTimeout(() => {
        if (cancelled) return;
        loadCleanedM3u8Url(raw).catch(() => {});
      }, 5000);
      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    } catch {}
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisode.slug, nextEpisode]);

  // hls setup - single instance only, no preview video
  useEffect(() => {
    // Đang chờ source nền (mở player ngay): giữ shell + spinner, không báo lỗi
    if (isResolvingSource) {
      setIsLoading(true);
      setLoadStage('source');
      setErrorMsg(null);
      return;
    }
    if (!currentEpisode.link_m3u8) {
      // Nguồn embed-only (vd NguonC): phát qua iframe thay vì báo lỗi
      if (currentEpisode.link_embed) {
        if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
        setUseEmbed(true);
        setErrorMsg(null);
        setIsLoading(false);
        return;
      }
      setErrorMsg('Tập phim này chưa có dữ liệu phát. Vui lòng chọn server hoặc tập khác.');
      setIsLoading(false);
      return;
    }
    setUseEmbed(false);

    const video = videoRef.current;
    if (!video) return;

    setIsLoading(true);
    setLoadStage('source');
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
    let firstFrameTimer: number | null = null;
    const tryNext = (hls: Hls) => {
      candidateIndex++;
      if (candidateIndex < candidates.length) {
        setLoadStage('source');
        setIsLoading(true);
        hls.loadSource(candidates[candidateIndex]);
        hls.startLoad();
        return;
      }
      const other = allServers.find(s => s.server_name !== currentServer.server_name);
      if (other) {
        const ep = other.server_data.find(e => e.slug === currentEpisode.slug) || other.server_data[0];
        // Chỉ auto-chuyển server khi tập bên đó có HLS thật; tập embed-only
        // thì ở lại và rớt xuống iframe bên dưới (chuyển qua cũng lỗi tiếp).
        if (ep?.link_m3u8) { onSelectEpisode(ep, other, video.currentTime || 0); return; }
      }
      // HLS chết hết nhưng còn link_embed (nguồn embed-only) -> phát iframe
      if (currentEpisode.link_embed) {
        setUseEmbed(true);
        setErrorMsg(null);
        setIsLoading(false);
        return;
      }
      setErrorMsg('Không thể tải luồng phát HLS. Vui lòng chọn server khác.');
      setIsLoading(false);
    };

    if (Hls.isSupported()) {
      // Buffer gọn trên máy yếu (TV/box RAM thấp), đầy đủ trên máy khỏe
      const weak = isWeakPlaybackDevice();
      const hls = new Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: weak ? 15 : 30,
        maxMaxBufferLength: weak ? 30 : 60,
        maxBufferSize: (weak ? 12 : 30) * 1000 * 1000,
        manifestLoadingTimeOut: 8000,
        levelLoadingTimeOut: 8000,
        fragLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        startLevel: -1,
        capLevelToPlayerSize: true,
      });
      hlsRef.current = hls;
      // Chặn QC ngay từ frame đầu: đợi bản clean xong mới loadSource (tối đa 5s,
      // mạng VN thường <1s). KHÔNG swap playlist giữa playback (reset buffer/lệch
      // giờ) nên phát direct trước là QC lọt luôn cả tập — đúng bug QC phút 15.
      // Quá 5s chưa clean xong -> phát direct cho khỏi treo, bản clean (đã lưu
      // cache text) áp dụng từ lần mở sau + tập sau (prefetch D1).
      const cachedClean = getCachedCleaned(rawCandidates[0]);
      // Watchdog first-frame: quá 8s chưa có manifest/phát -> failover server
      // kế tiếp ngay, khỏi treo spinner (failover nhanh, không đợi timeout HLS).
      // Bắt đầu tính từ lúc loadSource thật (vì còn đợi clean), không tính lúc chờ.
      let gotFirstFrame = false;
      const startFirstFrameWatchdog = () => {
        if (firstFrameTimer) window.clearTimeout(firstFrameTimer);
        firstFrameTimer = window.setTimeout(() => {
          if (!cancelled && !gotFirstFrame) {
            try {
              tryNext(hls);
            } catch {}
          }
        }, 8000);
      };
      if (cachedClean) {
        blobUrl = cachedClean.blobUrl;
        extraBlobs = [cachedClean.blobUrl, ...(cachedClean.extraBlobs || [])];
        candidates.unshift(blobUrl);
        candidateIndex = 0;
        hls.loadSource(blobUrl);
        startFirstFrameWatchdog();
      } else {
        let settled = false;
        const cleanWaitTimer = window.setTimeout(() => {
          // Clean quá chậm -> phát direct kẻo treo spinner (bản clean vẫn
          // cache text xong sau, dùng cho lần sau)
          if (cancelled || settled) return;
          settled = true;
          hls.loadSource(candidates[0]);
          startFirstFrameWatchdog();
        }, 5000);
        loadCleanedM3u8Url(rawCandidates[0])
          .then((cleaned) => {
            if (cancelled) {
              window.clearTimeout(cleanWaitTimer);
              if (cleaned) revokeBlobUrl([cleaned.blobUrl, ...(cleaned.extraBlobs || [])]);
              return;
            }
            if (settled) {
              // Đã phát direct do timeout: chỉ giữ blob để revoke đúng lúc
              // (cache text bản clean đã được lưu bên trong cho lần sau)
              if (cleaned) extraBlobs.push(cleaned.blobUrl, ...(cleaned.extraBlobs || []));
              return;
            }
            settled = true;
            window.clearTimeout(cleanWaitTimer);
            if (cleaned) {
              blobUrl = cleaned.blobUrl;
              extraBlobs.push(cleaned.blobUrl, ...(cleaned.extraBlobs || []));
              candidates.unshift(blobUrl);
              candidateIndex = 0;
              hls.loadSource(blobUrl);
            } else {
              // Không có QC để cắt -> phát URL gốc, khỏi tốn blob
              hls.loadSource(candidates[0]);
            }
            startFirstFrameWatchdog();
          })
          .catch(() => {
            if (cancelled || settled) return;
            settled = true;
            window.clearTimeout(cleanWaitTimer);
            hls.loadSource(candidates[0]);
            startFirstFrameWatchdog();
          });
      }
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        gotFirstFrame = true;
        if (firstFrameTimer) {
          try {
            window.clearTimeout(firstFrameTimer);
          } catch {}
          firstFrameTimer = null;
        }
        setLoadStage('stream');
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
    return () => {
      cancelled = true;
      if (firstFrameTimer) {
        try {
          window.clearTimeout(firstFrameTimer);
        } catch {}
        firstFrameTimer = null;
      }
      revokeBlobUrl([blobUrl, ...extraBlobs]);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
  }, [currentEpisode.link_m3u8, currentEpisode.link_embed, isResolvingSource, allServers, currentServer, initialTime, onSelectEpisode, retryKey]);

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

  // time update - segment detection (intro/recap/outro) + progress.
  // Thanh bar chạy bằng ref (không re-render); state giờ chỉ set tối đa 1Hz
  // để nhãn giờ cập nhật, còn cây player không render theo từng frame.
  const lastUiTickRef = useRef(0);
  const lastBufferedUiRef = useRef(-1);
  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const cur = v.currentTime;
    const now = Date.now();
    if (now - lastUiTickRef.current >= 1000 || v.paused) {
      lastUiTickRef.current = now;
      setCurrentTime(cur);
      onTimeUpdate?.(cur, v.duration || 0);
    }
    if (segments) {
      const inIntro = segments.intro && cur >= segments.intro.start_sec && cur < segments.intro.end_sec - 0.15;
      const inRecap = segments.recap && cur >= segments.recap.start_sec && cur < segments.recap.end_sec - 0.15;
      const inOutro = segments.outro && cur >= segments.outro.start_sec && cur < (segments.outro.end_sec || (v.duration || 1e9));
      const next = inIntro ? 'intro' as const : inRecap ? 'recap' as const : inOutro ? 'outro' as const : null;
      setActiveSegment(prev => prev !== next ? next : prev);
    } else {
      setActiveSegment(null);
    }
    if (v.buffered.length > 0) {
      const bEnd = v.buffered.end(v.buffered.length - 1);
      if (Math.abs(bEnd - lastBufferedUiRef.current) > 2) {
        lastBufferedUiRef.current = bEnd;
        setBuffered(bEnd);
      }
    }
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
    // Nút play giữa màn hình flash ~1s rồi ẩn (không theo timer controls 4s)
    try {
      if (centerFlashTimer.current) window.clearTimeout(centerFlashTimer.current);
    } catch {}
    setShowCenterFlash(true);
    centerFlashTimer.current = window.setTimeout(() => setShowCenterFlash(false), 1000);
  }, []);
  /** Smart seek: trong buffer thì set trực tiếp (nhanh nhất); ngoài buffer
   * thì fastSeek nếu browser hỗ trợ, không thì currentTime thường. */
  const smartSeek = useCallback((target: number) => {
    const v = videoRef.current;
    if (!v || !isFinite(target)) return;
    const d = v.duration && isFinite(v.duration) ? v.duration : 0;
    const t = Math.max(0, d > 0 ? Math.min(d, target) : target);
    try {
      if (isBufferedAt(v, t)) {
        v.currentTime = t;
      } else if (typeof (v as any).fastSeek === 'function') {
        try {
          (v as any).fastSeek(t);
        } catch {
          v.currentTime = t;
        }
      } else {
        v.currentTime = t;
      }
    } catch {
      try {
        v.currentTime = t;
      } catch {}
    }
    setCurrentTime(t);
  }, []);
  const skip = useCallback((s: number) => {
    const v = videoRef.current;
    if (!v) return;
    smartSeek(v.currentTime + s);
  }, [smartSeek]);
  smartSeekRef.current = smartSeek;
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const nv = !isMuted;
    setIsMuted(nv);
    v.muted = nv;
  }, [isMuted]);
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
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      try { setImmersiveMode(false).catch(() => {}); } catch {}
    };
  }, []);

  // TV: refs trỏ tới handler khai báo ở dưới (tránh lỗi dùng trước khai báo).
  // Quyết định Back tập trung: menu mở -> đóng menu; hiện -> ẩn controls; ẩn -> thoát.
  const handleTvBackRef = useRef<() => void>(() => {});
  const focusBottomRowRef = useRef<(dir: 'left' | 'right') => 'moved' | 'end' | 'outside'>(() => 'outside');

  // TV: App (nút Back native) chuyển quyết định Back về đây qua event này.
  // Giữ wake cũ cho tương thích.
  useEffect(() => {
    const onBack = () => {
      try {
        handleTvBackRef.current();
      } catch {}
    };
    const wake = () => {
      resetControlsTimer();
      window.setTimeout(() => {
        try {
          containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
        } catch {}
      }, 150);
    };
    window.addEventListener('gau_tv_back_player' as any, onBack as any);
    window.addEventListener('gau_tv_wake_player' as any, wake as any);
    return () => {
      window.removeEventListener('gau_tv_back_player' as any, onBack as any);
      window.removeEventListener('gau_tv_wake_player' as any, wake as any);
    };
  }, [resetControlsTimer]);

  // Mở player là hẹn giờ tự ẩn controls (kẻo hiện mãi nếu không chạm gì)
  useEffect(() => {
    resetControlsTimer();
  }, [resetControlsTimer]);

  // TV: mở player là focus ngay nút play để remote bấm OK phát/dừng được
  // (bỏ qua khi đang chờ source nền — tập thật mount sau sẽ focus lại)
  useEffect(() => {
    if (!isTv || isResolvingSource) return;
    const t = window.setTimeout(() => {
      try {
        containerRef.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus();
      } catch {}
    }, 400);
    return () => window.clearTimeout(t);
  }, [isTv, isResolvingSource]);

  // TV remote: mở menu tập/server/cài đặt là focus ngay item đầu/current
  // để D-pad đi được trong menu; đóng menu (bằng chuột) trả focus về nút mở.
  useEffect(() => {
    try {
      if (!document.documentElement.classList.contains('tv-mode')) return;
    } catch { return; }
    const opened = showEpisodes || showServerMenu || showSettings;
    if (!opened) {
      if (menuOpenerRef.current) {
        try {
          const opener = menuOpenerRef.current;
          const a = document.activeElement as HTMLElement | null;
          // Chỉ trả focus khi focus đang kẹt trong panel vừa đóng
          if (a && a.closest?.('.player-menu-panel')) opener.focus();
        } catch {}
        menuOpenerRef.current = null;
      }
      return;
    }
    const t = window.setTimeout(() => {
      try {
        const root = containerRef.current;
        if (!root) return;
        const panels = Array.from(root.querySelectorAll<HTMLElement>('.player-menu-panel'));
        const panel = panels[panels.length - 1];
        if (!panel) return;
        // Ưu tiên item hiện tại (tập đang xem / server đang dùng), không thì nút đầu
        const target =
          panel.querySelector<HTMLElement>('.bg-blue-500') ||
          panel.querySelector<HTMLElement>('button, input');
        try {
          target?.focus({ preventScroll: true } as FocusOptions);
        } catch {
          target?.focus();
        }
      } catch {}
    }, 80);
    return () => window.clearTimeout(t);
  }, [showEpisodes, showServerMenu, showSettings]);

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

  // Controls ẩn theo bất kỳ đường nào -> tắt preview tua còn sót + hủy hẹn
  useEffect(() => {
    if (!showControls) {
      if (previewHideTimer.current) {
        window.clearTimeout(previewHideTimer.current);
        previewHideTimer.current = null;
      }
      hideScrubPreview();
    }
  }, [showControls, hideScrubPreview]);
  const handleScrubPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    const v = videoRef.current;
    if (!v || !duration) return;
    isDraggingRef.current = true;
    scrubWasPlayingRef.current = !v.paused;
    if (!v.paused) v.pause();
    // Đang kéo: dừng hẳn việc tải luồng chính (kẻo tốn băng thông buffer chỗ cũ),
    // chỉ preview thumbnail được tải. Thả tay mới seek + tải tiếp.
    try { hlsRef.current?.stopLoad(); } catch {}
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
    // Commit 1 lần khi thả tay (không seek theo từng pixel lúc kéo):
    // mở lại tải luồng chính rồi mới seek tới điểm đã chọn
    try { hlsRef.current?.startLoad(); } catch {}
    smartSeek(pct * duration);
    if (progressBarRef.current) progressBarRef.current.style.width = `${pct * 100}%`;
    // Trả lại trạng thái phát như trước khi chạm (đang phát thì phát tiếp, pause thì giữ pause)
    if (scrubWasPlayingRef.current) v.play().catch(() => {});
    hideScrubPreview();
    resetControlsTimer();
  }, [duration, hideScrubPreview, resetControlsTimer, smartSeek]);
  const handleScrubPointerLeave = useCallback(() => {
    // Rời chuột khi không kéo: ẩn preview + trả thanh về vị trí phát thật (kẻo kẹt khi pause)
    if (!isDraggingRef.current) hideScrubPreview(true);
  }, [hideScrubPreview]);
  // Touch bị ngắt giữa chừng (cuộc gọi đến, vuốt hệ thống): kết thúc kéo (không commit
  // điểm mới), trả thanh + tải tiếp luồng chính + phát tiếp nếu trước đó đang phát
  const handleScrubPointerCancel = useCallback(() => {
    if (!isDraggingRef.current) { hideScrubPreview(true); return; }
    isDraggingRef.current = false;
    setIsScrubbing(false);
    restoreProgressBar();
    try { hlsRef.current?.startLoad(); } catch {}
    const v = videoRef.current;
    if (v && scrubWasPlayingRef.current) v.play().catch(() => {});
    hideScrubPreview();
  }, [hideScrubPreview, restoreProgressBar]);
  const handleScrubKeyDown = useCallback((e: React.KeyboardEvent) => {
    // TV: handler toàn cục (capture) đã tua + stopPropagation, bỏ qua để khỏi tua 2 lần
    try {
      if (document.documentElement.classList.contains('tv-mode')) return;
    } catch {}
    const v = videoRef.current;
    if (!v || !duration) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); smartSeek(v.currentTime - 5); resetControlsTimer(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); smartSeek(v.currentTime + 5); resetControlsTimer(); }
    else if (e.key === 'Home') { e.preventDefault(); smartSeek(0); resetControlsTimer(); }
    else if (e.key === 'End') { e.preventDefault(); smartSeek(Math.max(0, (v.duration || 0) - 1)); resetControlsTimer(); }
  }, [duration, resetControlsTimer, smartSeek]);

  // Netflix TV: Back -> Seek Mode đang mở thì hủy seek (giữ nguyên currentTime);
  // menu mở thì đóng menu (focus giữ ở nút menu vừa mở);
  // controls hiện thì ẩn đi; controls ẩn thì thoát. Dùng chung cho phím
  // browser + nút Back native (App).
  const handleTvBack = useCallback(() => {
    if (seekModeRef.current) {
      cancelSeek();
      return;
    }
    if (showSettingsRef.current || showServerMenuRef.current || showEpisodesRef.current) {
      // Focus nút mở menu NGAY (đồng bộ, lúc panel còn mounted) rồi mới đóng —
      // để effect đóng-menu thấy focus đã ở ngoài panel nên không giật về play.
      try {
        const opener = menuOpenerRef.current;
        if (opener && document.contains(opener)) {
          try { markProgrammaticFocus(); } catch {}
          opener.focus({ preventScroll: true } as FocusOptions);
        }
      } catch {}
      menuOpenerRef.current = null;
      setShowEpisodes(false);
      setShowServerMenu(false);
      setShowSettings(false);
      resetControlsTimer();
      return;
    }
    if (showControlsRef.current) {
      if (hideControlsTimer.current) window.clearTimeout(hideControlsTimer.current);
      setShowControls(false);
      try {
        const root = containerRef.current;
        const a = document.activeElement as HTMLElement | null;
        if (root && a && a !== root && root.contains(a)) {
          root.focus({ preventScroll: true } as FocusOptions);
        }
      } catch {}
    } else {
      onBackRef.current();
    }
  }, [resetControlsTimer, cancelSeek]);
  handleTvBackRef.current = handleTvBack;

  // Nút bấm trong hàng controls bottom (timeline slider tính riêng).
  // Đi ngang BỊ GIỚI HẠN trong hàng: hết hàng thì đứng yên, không nhảy timeline.
  const getBottomButtons = (): { items: HTMLElement[]; active: HTMLElement | null } => {
    try {
      const root = containerRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!root || !active) return { items: [], active };
      const items = Array.from(
        root.querySelectorAll<HTMLElement>('.tv-player-bottom button:not([disabled])'),
      ).filter((el) => {
        if (el.hasAttribute('data-tv-skip')) return false;
        if (el.closest?.('.player-menu-panel')) return false;
        try {
          const r = el.getBoundingClientRect();
          return r.width > 4 && r.height > 4;
        } catch {
          return false;
        }
      });
      return { items, active };
    } catch {
      return { items: [], active: null };
    }
  };
  const focusBottomRow = (dir: 'left' | 'right'): 'moved' | 'end' | 'outside' => {
    try {
      const { items, active } = getBottomButtons();
      if (!active || !items.includes(active)) return 'outside';
      const cr = active.getBoundingClientRect();
      let best: HTMLElement | null = null;
      let bestScore = Infinity;
      for (const el of items) {
        if (el === active) continue;
        const r = el.getBoundingClientRect();
        if (dir === 'left' && r.right > cr.left - 4) continue;
        if (dir === 'right' && r.left < cr.right + 4) continue;
        const dx = dir === 'left' ? cr.left - r.right : r.left - cr.right;
        const dy = Math.abs(r.top + r.height / 2 - (cr.top + cr.height / 2));
        const score = dx + dy * 1.5;
        if (score < bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best) return 'end';
      try {
        best.focus({ preventScroll: true } as FocusOptions);
      } catch {
        best.focus();
      }
      return 'moved';
    } catch {
      return 'outside';
    }
  };
  focusBottomRowRef.current = focusBottomRow;

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
      // Nút Back của remote TV: Escape (Android TV/box hay gửi) / GoBack /
      // BrowserBack / Tizen 10009 / LG 461.
      // Thứ tự kiểu Netflix: menu mở -> đóng menu; controls hiện -> ẩn đi;
      // controls ẩn -> thoát. Mở lại bằng D-pad/OK.
      if (tv && (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || kc === 10009 || kc === 461)) {
        e.preventDefault();
        handleTvBackRef.current();
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
        // TV Seek Mode (filmstrip): D-pad/OK/Back do seek mode xử lý riêng,
        // video chính đứng yên tuyệt đối cho tới khi OK commit
        if (seekModeRef.current) {
          if (k === 'ArrowLeft' || k === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            moveSeekFocus(k === 'ArrowLeft' ? 'left' : 'right');
            return;
          }
          if (k === ' ' || k === 'Enter' || k === 'NumpadEnter') {
            e.preventDefault();
            e.stopPropagation();
            commitSeek();
            return;
          }
          // Back/Return do handleTvBack funnel (cancelSeek) — đã chặn ở trên
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Netflix TV: ←/→ trên timeline mở thẳng Seek Mode (filmstrip).
        // Phát đầu vừa mở mode vừa dời focus theo hướng bấm; video chính đứng yên.
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          const ae = document.activeElement as HTMLElement | null;
          // Slider âm lượng/độ sáng: để browser chỉnh native
          if (ae && ae.tagName === 'INPUT' && (ae as HTMLInputElement).type === 'range') {
            resetControlsTimer();
            return;
          }
          const scrub = ae?.closest?.('.group\\/scrub') as HTMLElement | null;
          if (!hidden && scrub) {
            e.preventDefault();
            e.stopPropagation(); // chặn handleScrubKeyDown bubble kẻo tua 2 lần
            if (enterSeekMode()) {
              moveSeekFocus(k === 'ArrowLeft' ? 'left' : 'right');
              return;
            }
            // Fallback khi không vào được seek mode (embed/chưa có duration):
            // tua ±10s như cũ + hiện preview tại điểm mới, preview tự ẩn sau 1.5s
            const v = videoRef.current;
            const d = (v?.duration && isFinite(v.duration) ? v.duration : 0) || duration;
            if (v && d > 0) {
              const nt = Math.max(0, Math.min(d, v.currentTime + (k === 'ArrowLeft' ? -10 : 10)));
              smartSeek(nt);
              renderScrubPreview(nt / d, { hoverTrack: false, moveProgress: true });
              if (previewHideTimer.current) window.clearTimeout(previewHideTimer.current);
              previewHideTimer.current = window.setTimeout(() => hideScrubPreview(), 1500);
            }
            resetControlsTimer();
            return;
          }
          // Ẩn -> chỉ mở overlay. Hiện -> đi ngang TRONG hàng nút
          // (hết hàng thì đứng yên, không nhảy lên timeline).
          // Ngoại lệ: đang đứng trên nút skip intro / tập tiếp theo (hiện ngoài
          // overlay) -> D-pad vẫn điều hướng bình thường, không nuốt phím.
          e.preventDefault();
          const onSkipBtn = !!ae?.hasAttribute?.('data-tv-skip-segment');
          if (hidden && !onSkipBtn) {
            // Controls đang ẩn: ←/→ vào thẳng Seek Mode (filmstrip) + dời 1 bước.
            // Không vào được (embed/chưa có duration) thì đánh thức controls như cũ.
            if (enterSeekMode()) {
              moveSeekFocus(k === 'ArrowLeft' ? 'left' : 'right');
            } else {
              wakeControls();
            }
            return;
          }
          if (hidden) {
            wakeControls();
            return;
          }
          const dir = k === 'ArrowLeft' ? 'left' as const : 'right' as const;
          const rowRes = focusBottomRowRef.current(dir);
          if (rowRes === 'moved' || rowRes === 'end') {
            hideScrubPreview(); // rời timeline -> tắt preview cũ
            resetControlsTimer();
            return;
          }
          // Ngoài hàng nút (top bar, menu...) -> điều hướng chung
          hideScrubPreview();
          focusNearest(dir);
          resetControlsTimer();
          return;
        }
        // ↑/↓: ẩn -> hiện overlay; hiện -> đi vào / di chuyển trong cụm tùy chọn.
        // Ngoại lệ: nút skip intro / tập tiếp theo -> điều hướng bình thường.
        if (k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault();
          const active0 = document.activeElement as HTMLElement | null;
          if (hidden && !active0?.hasAttribute?.('data-tv-skip-segment')) {
            wakeControls();
            return;
          }
          const active = document.activeElement as HTMLElement | null;
          const inControls = !!active?.closest?.(
            '.tv-player-bottom, .tv-player-top, .player-menu-panel, .group\\/center-skip, .group\\/center-play, .group\\/scrub',
          );
          const isBtn = active?.tagName === 'BUTTON';
          if (inControls || isBtn) {
            const dir = k === 'ArrowUp' ? 'up' as const : 'down' as const;
            hideScrubPreview(); // rời timeline -> tắt preview cũ
            focusNearest(dir);
            resetControlsTimer();
            return;
          }
          wakeControls();
          return;
        }
        // OK: nút (kể cả skip khi controls ẩn) thì để browser click;
        // controls ẩn thì play/pause NGAY + flash nút giữa 1s (không đánh thức trước);
        // hiện + focus ngoài nút -> card thì click, còn lại play/dừng
        // (kể cả đang đứng trên timeline — chỉ ←/→ mới vào Seek Mode).
        if (k === ' ' || k === 'Enter' || k === 'NumpadEnter') {
          const activeOk = document.activeElement as HTMLElement | null;
          if (activeOk && (activeOk.tagName === 'BUTTON' || activeOk.tagName === 'A')) {
            return; // browser tự click, không chặn
          }
          e.preventDefault();
          if (hidden) {
            togglePlay();
            return;
          }
          const active = activeOk;
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
      // Đang chờ source nền: chỉ cho Back/Thoát (xử lý ở trên), nuốt phím còn lại
      // vì chưa có gì để điều khiển
      if (isResolvingRef.current) { e.preventDefault(); return; }
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
      if (centerFlashTimer.current) window.clearTimeout(centerFlashTimer.current);
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
    };
  }, [togglePlay, skip, toggleFullscreen, toggleMute, activeSegment, handleSkipSegment, duration, renderScrubPreview, smartSeek, enterSeekMode, moveSeekFocus, commitSeek]);

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
        {useEmbed && currentEpisode.link_embed ? (
          <div className="absolute inset-0 bg-black">
            <iframe
              src={currentEpisode.link_embed}
              className="w-full h-full border-none"
              allowFullScreen
              sandbox="allow-same-origin allow-scripts allow-presentation allow-forms"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
              referrerPolicy="no-referrer"
              title={movie.name}
            />
            {!isTv && (
            <button
              onClick={(e) => { e.stopPropagation(); onBack(); }}
              aria-label="Thoát"
              className="absolute top-[calc(env(safe-area-inset-top,0px)+12px)] left-3 z-50 rounded-full bg-white/10 active:bg-white/30 flex items-center justify-center border-0 w-11 h-11"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-5 h-5 text-white shrink-0" />
            </button>
            )}
            {currentEpisode.link_m3u8 && (
              <button
                onClick={(e) => { e.stopPropagation(); setUseEmbed(false); setRetryKey(k => k + 1); }}
                className="absolute top-[calc(env(safe-area-inset-top,0px)+12px)] right-3 z-50 bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-bold"
                style={{ touchAction: 'manipulation' }}
              >
                Quay lại HLS
              </button>
            )}
          </div>
        ) : (
        <>
        <video
            ref={videoRef}
            poster={movie.backdrop_url || movie.thumb_url || movie.poster_url || undefined}
            className={`w-full h-full ${fillMode ? 'object-cover' : 'object-contain'}`}
            style={{ filter: screenBrightness < 1 ? `brightness(${screenBrightness})` : undefined, WebkitTouchCallout: 'none' }}
            onContextMenu={e => e.preventDefault()}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => { setIsPlaying(false); saveProgressNow(); }}
            onWaiting={() => { setIsLoading(true); setLoadStage('buffering'); }}
            onPlaying={() => { setIsLoading(false); setLoadStage(''); }}
            onEnded={() => { if (nextEpisode) onSelectEpisode(nextEpisode, currentServer); }}
            playsInline
            disablePictureInPicture={false}
            onClick={handleVideoClick}
          />
        {/* hidden preview video + canvas for hover thumbnail - chophim smooth */}
        <video ref={previewVideoRef} muted playsInline preload="metadata" crossOrigin="anonymous" className="pointer-events-none absolute left-0 top-0 h-[2px] w-[2px] opacity-0" tabIndex={-1} aria-hidden />
        <canvas ref={previewCanvasRef} className="hidden w-0 h-0 pointer-events-none" />
        </>)}
        {!useEmbed && isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 pointer-events-none">
            <div className="w-12 h-12 sm:w-10 sm:h-10 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
            <span className="text-xs font-semibold text-white/85 bg-black/60 px-2.5 py-1 rounded-full">
              {loadStage === 'source'
                ? 'Đang tìm nguồn phát...'
                : loadStage === 'buffering'
                  ? 'Đang đệm, mạng hơi chậm...'
                  : 'Đang tải luồng...'}
            </span>
            {duration > 0 && (
              <span className="text-xs font-bold text-white/80 tabular-nums bg-black/60 px-2.5 py-1 rounded-full">
                Đã đệm {Math.min(100, Math.round((buffered / duration) * 100))}%
              </span>
            )}
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
              {!useEmbed && currentEpisode.link_embed && (
                <button onClick={() => { setUseEmbed(true); setErrorMsg(null); setIsLoading(false); }} className="px-5 py-2.5 rounded-xl bg-white/15 active:bg-white/25 text-white text-sm font-medium transition-all min-h-[44px]" style={{ touchAction: 'manipulation' }}>
                  Chuyển sang Embed
                </button>
              )}
              <button onClick={onBack} className="px-5 py-2.5 rounded-xl bg-white/10 active:bg-white/20 text-white/80 text-sm font-medium transition-all min-h-[44px]" style={{ touchAction: 'manipulation' }}>
                Thoát
              </button>
            </div>
          </div>
        )}

        {/* Shell mở ngay kiểu Netflix: đang chờ source nền thì hiện poster +
            spinner, che controls chết phía dưới; chỉ nút Thoát hoạt động */}
        {isResolvingSource && (
          <div className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center overflow-hidden" data-tv-hidden-pool>
            {(movie.backdrop_url || movie.thumb_url || movie.poster_url) && (
              <img
                src={movie.backdrop_url || movie.thumb_url || movie.poster_url}
                alt=""
                aria-hidden
                draggable={false}
                className="absolute inset-0 w-full h-full object-cover scale-110 blur-[14px] opacity-50"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-black/60" />
            {!isTv && (
            <button
              onClick={(e) => { e.stopPropagation(); onBack(); }}
              aria-label="Thoát"
              className="absolute top-[calc(env(safe-area-inset-top,0px)+12px)] right-3 z-10 rounded-full bg-white/10 active:bg-white/30 flex items-center justify-center border-0 w-11 h-11 sm:w-8 sm:h-8"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-5 h-5 sm:w-4 sm:h-4 text-white shrink-0" />
            </button>
            )}
            <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
              <div className="w-12 h-12 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />
              <p className="text-white text-base font-semibold truncate max-w-[80vw]">{movie.name}</p>
              <p className="text-white/70 text-sm">Đang tìm nguồn phát...</p>
            </div>
          </div>
        )}

        {/* Skip intro/recap/outro - ẩn khi khóa màn hình / chế độ embed */}
        {!useEmbed && !isLocked && activeSegment && (
          <div
            className="absolute bottom-40 sm:bottom-24 right-4 sm:right-6 z-30 pointer-events-auto"
            onTouchStart={e => { e.stopPropagation(); resetControlsTimer(); }}
            onTouchMove={e => e.stopPropagation()}
            onTouchEnd={e => e.stopPropagation()}
          >
            {activeSegment === 'intro' && (
              <button ref={skipSegmentBtnRef} data-tv-skip-segment onClick={(e) => { e.stopPropagation(); handleSkipSegment('intro'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                <SkipForward className="w-4 h-4" /> Bỏ qua phần giới thiệu
              </button>
            )}
            {activeSegment === 'recap' && (
              <button ref={skipSegmentBtnRef} data-tv-skip-segment onClick={(e) => { e.stopPropagation(); handleSkipSegment('recap'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                <SkipForward className="w-4 h-4" /> Bỏ qua tóm tắt
              </button>
            )}
            {activeSegment === 'outro' && (
              nextEpisode ? (
                <button ref={skipSegmentBtnRef} data-tv-skip-segment onClick={(e) => { e.stopPropagation(); handleSkipSegment('outro'); }} className="cursor-pointer relative overflow-hidden flex items-center gap-2.5 bg-white text-black pl-4 pr-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10 min-w-[210px]">
                  {/* Netflix-style: whole button is the progress bar, fill 0 -> 100% in 3s */}
                  {autoNextEnabled && (
                    <span ref={nextFillRef} className="absolute inset-y-0 left-0 bg-black/15" style={{ width: '0%' }} />
                  )}
                  <SkipForward className="w-4 h-4 shrink-0 relative" />
                  <span className="relative flex-1 text-left">Tập tiếp theo</span>
                </button>
              ) : (
                <button ref={skipSegmentBtnRef} data-tv-skip-segment onClick={(e) => { e.stopPropagation(); handleSkipSegment('outro'); }} className="cursor-pointer flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-lg text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                  <SkipForward className="w-4 h-4" /> Bỏ qua outro
                </button>
              )
            )}
          </div>
        )}

        {/* TV Seek Mode filmstrip: actualTime đứng yên, previewTime theo focus.
            OK = seek tới mốc focus, Back = hủy giữ nguyên. */}
        {seekMode && (() => {
          const vv = videoRef.current;
          const dd = (vv?.duration && isFinite(vv.duration) ? vv.duration : 0) || duration;
          const times = buildSeekTimes(seekWindowStart, dd);
          const fi = Math.min(seekFocusIdx, times.length - 1);
          const previewT = times[fi] ?? 0;
          void seekTick; // subscribe re-render khi thumbnail mới capture xong
          return (
            <div
              className="absolute inset-x-0 bottom-0 z-50 pt-10 pb-[max(18px,env(safe-area-inset-bottom,0px))] px-4 bg-gradient-to-t from-black via-black/85 to-transparent"
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
              <div className="text-center mb-3">
                <div className="text-white text-3xl font-bold tabular-nums leading-none">{formatTime(previewT)}</div>
                <div className="text-white/60 text-xs mt-1.5 font-medium">OK để phát từ đây • Back để hủy</div>
              </div>
              <div className="flex items-end justify-center gap-2 sm:gap-3">
                {times.map((t, i) => {
                  const img = previewFrameCache.current.get(Math.floor(t / 2));
                  const focused = i === fi;
                  return (
                    <div key={`${t}-${i}`} className="flex flex-col items-center gap-1.5 transition-all duration-150">
                      <div
                        className={`rounded-lg overflow-hidden bg-white/10 transition-all duration-150 ${
                          focused
                            ? 'w-44 sm:w-56 aspect-video ring-[3px] ring-white shadow-[0_0_24px_rgba(255,255,255,0.35)] brightness-100'
                            : 'w-28 sm:w-36 aspect-video ring-1 ring-white/20 brightness-[0.65]'
                        }`}
                      >
                        {img ? (
                          <img src={img} alt="" draggable={false} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <div className="w-6 h-6 border-2 border-white/30 border-t-white/80 rounded-full animate-spin" />
                          </div>
                        )}
                      </div>
                      <span className={`text-xs tabular-nums font-semibold ${focused ? 'text-white' : 'text-white/50'}`}>
                        {formatTime(t)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Minimal top bar like chophim */}
        <div
          className={`tv-player-top absolute top-0 left-0 right-0 pt-[calc(env(safe-area-inset-top,0px)+12px)] sm:pt-[calc(env(safe-area-inset-top,0px)+16px)] pb-6 px-3 sm:px-4 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 z-30 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
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
              {!isTv && (
              <button onClick={(e) => { e.stopPropagation(); onBack(); }} aria-label="Thoát" className="shrink-0 rounded-full bg-white/10 active:bg-white/30 hover:bg-white/20 flex items-center justify-center border-0 w-11 h-11 sm:w-8 sm:h-8" style={{ touchAction: 'manipulation' }}>
                <X className="w-5 h-5 sm:w-4 sm:h-4 text-white shrink-0" />
              </button>
              )}
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
            Desktop không dùng nút giữa màn hình (play + tua đã có ở hàng bottom).
            TV: chỉ giữ nút play giữa, BỎ 2 nút tua 10s (tua bằng timeline + D-pad). */}
        {(isTouchDevice || isTv) ? (
          !isLocked && !isLoading && !errorMsg && !seekMode && showCenterFlash && (
            <div
              className="absolute inset-0 flex items-center justify-center gap-14 sm:gap-12 pointer-events-none z-20"
              onTouchStart={e => e.stopPropagation()}
              onTouchMove={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              {!isTv && (
                <button
                  onClick={(e) => { e.stopPropagation(); skip(-10); flashSeek(-10); resetControlsTimer(); }}
                  aria-label="Tua lại 10 giây"
                  className="relative rounded-full bg-black/50 backdrop-blur flex items-center justify-center pointer-events-auto active:bg-black/70 transition w-16 h-16"
                  style={{ touchAction: 'manipulation' }}
                >
                  <RotateCcw className="w-10 h-10 text-white shrink-0" strokeWidth={1.5} />
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-white tabular-nums">10</span>
                </button>
              )}
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
              {!isTv && (
                <button
                  onClick={(e) => { e.stopPropagation(); skip(10); flashSeek(10); resetControlsTimer(); }}
                  aria-label="Tua tới 10 giây"
                  className="relative rounded-full bg-black/50 backdrop-blur flex items-center justify-center pointer-events-auto active:bg-black/70 transition w-16 h-16"
                  style={{ touchAction: 'manipulation' }}
                >
                  <RotateCw className="w-10 h-10 text-white shrink-0" strokeWidth={1.5} />
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-white tabular-nums">10</span>
                </button>
              )}
            </div>
          )
        ) : null}

        {/* Bottom controls - mobile-first: touch lớn + safe-area.
            Chặn touch bubbling lên video-area để gesture (swipe/tap/giữ-x2)
            không đánh nhau với kéo timeline -> hết lag. */}
        <div
          className={`tv-player-bottom absolute bottom-0 left-0 right-0 pt-10 px-3 sm:px-6 bg-gradient-to-t from-black/90 via-black/40 to-transparent transition-all duration-300 ${showControls ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'}`}
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
                data-tv-timeline
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
                <div className={`scrub-track relative w-full rounded-full bg-white/15 transition-all ${isScrubbing ? 'h-[10px]' : 'h-2 sm:h-[5px] group-hover/scrub:h-[7px]'}`}>
                  <div ref={bufferedBarRef} className="absolute left-0 top-0 h-full rounded-full bg-white/25 pointer-events-none" style={{ width: `${duration ? (buffered / duration) * 100 : 0}%` }} />
                  <div ref={hoverTrackRef} className="absolute left-0 top-0 h-full rounded-full bg-white/30 pointer-events-none" style={{ width: '0%' }} />
                  <div
                    ref={progressBarRef}
                    className={`scrub-progress absolute left-0 top-0 h-full rounded-full pointer-events-none after:absolute after:right-0 after:top-1/2 after:bg-white after:rounded-full after:-translate-y-1/2 after:translate-x-1/2 after:shadow-[0_0_8px_rgba(0,0,0,0.6)] after:ring-4 after:ring-blue-500/25 after:transition-all ${isScrubbing ? 'bg-blue-400 after:w-5 after:h-5' : 'bg-blue-500 after:w-4 after:h-4 sm:after:w-2.5 sm:after:h-2.5'}`}
                    style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <span className="hidden sm:block shrink-0 text-[11px] font-medium text-white/80 tabular-nums">{formatTime(duration)}</span>
            </div>

            {/* Controls row: trái = play/tua 10s, giữa = tập trước/tiếp + số tập, phải = list/server/cài đặt/pip/fullscreen */}
            <div className="relative flex items-center justify-between gap-1">
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
                {/* Tua -10s (thế chỗ nút âm lượng đã bỏ) */}
                <button
                  onClick={() => { skip(-10); resetControlsTimer(); }}
                  aria-label="Tua lại 10 giây"
                  title="Tua lại 10 giây (←)"
                  className="flex tv-seek-btn rounded-full hover:bg-white/10 active:scale-95 items-center justify-center text-white w-11 h-11 sm:w-9 sm:h-9 shrink-0 transition"
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="relative flex items-center justify-center">
                    <RotateCcw className="w-5 h-5 shrink-0" strokeWidth={1.75} />
                    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white tabular-nums pt-0.5">10</span>
                  </span>
                </button>
                {/* Tua +10s (thế chỗ nút âm lượng đã bỏ) */}
                <button
                  onClick={() => { skip(10); resetControlsTimer(); }}
                  aria-label="Tua tới 10 giây"
                  title="Tua tới 10 giây (→)"
                  className="flex tv-seek-btn rounded-full hover:bg-white/10 active:scale-95 items-center justify-center text-white w-11 h-11 sm:w-9 sm:h-9 shrink-0 transition"
                  style={{ touchAction: 'manipulation' }}
                >
                  <span className="relative flex items-center justify-center">
                    <RotateCw className="w-5 h-5 shrink-0" strokeWidth={1.75} />
                    <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white tabular-nums pt-0.5">10</span>
                  </span>
                </button>
              </div>
              {/* Giữa: tập trước / số tập / tập tiếp (desktop căn tuyệt đối giữa hàng) */}
              {currentServer.server_data.length > 1 && (
                <div className="flex items-center gap-0.5 sm:gap-1 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
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
                </div>
              )}
              <div className="flex items-center gap-0.5 sm:gap-1">
                {/* Episode list - bottom-sheet trên mobile, popup trên desktop */}
                {currentServer.server_data.length > 1 && (
                  <div className="relative">
                    <button ref={episodeBtnRef} onClick={(e) => { if (!showEpisodes) menuOpenerRef.current = e.currentTarget; setShowEpisodes(!showEpisodes); setShowServerMenu(false); setShowSettings(false); }} aria-label="Danh sách tập" className="player-menu-btn rounded-full sm:rounded-lg bg-transparent active:bg-white/20 hover:bg-white/10 border border-transparent hover:border-white/10 text-white flex items-center justify-center sm:justify-start gap-1.5 transition-colors w-11 h-11 sm:w-auto sm:h-8 sm:px-2.5" style={{ touchAction: 'manipulation' }} title="Danh sách tập"><List className="w-5 h-5 sm:w-3.5 sm:h-3.5 shrink-0" /> <span className="hidden sm:inline text-xs truncate">Danh sách tập</span></button>
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
                {/* Phụ đề và âm thanh (kiểu Netflix): chọn audio = đổi server Vietsub/Thuyết minh */}
                <div className="relative">
                  <button ref={serverBtnRef} onClick={(e) => { if (!showServerMenu) menuOpenerRef.current = e.currentTarget; setShowServerMenu(!showServerMenu); setShowSettings(false); setShowEpisodes(false); }} aria-label="Phụ đề và âm thanh" title="Phụ đề và âm thanh" className="player-menu-btn rounded-full sm:rounded-lg bg-transparent active:bg-white/20 hover:bg-white/10 border border-transparent hover:border-white/10 text-white flex items-center justify-center sm:justify-start gap-1.5 transition-colors w-11 h-11 sm:w-auto sm:h-8 sm:px-2.5" style={{ touchAction: 'manipulation' }}><Captions className="w-5 h-5 sm:w-3.5 sm:h-3.5 shrink-0" /> <span className="hidden sm:inline text-xs truncate">Phụ đề và âm thanh</span></button>
                  {showServerMenu && (
                    <>
                      <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setShowServerMenu(false)} onTouchEnd={() => setShowServerMenu(false)} />
                      <div className="player-menu-panel z-50 bg-[#1c1c1e] border border-white/10 shadow-2xl fixed inset-x-0 bottom-0 rounded-t-2xl p-4 pb-[max(20px,env(safe-area-inset-bottom,0px))] max-h-[60vh] overflow-auto sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-10 sm:rounded-xl sm:p-3 sm:w-64 sm:max-h-72 sm:pb-3">
                        <div className="sm:hidden w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
                        <p className="text-[11px] font-bold text-white/50 uppercase mb-2 px-1">Âm thanh</p>
                        {allServers.map(s => (
                          <button key={s.server_name} onClick={() => { const ep = s.server_data.find(e => e.slug === currentEpisode.slug) || s.server_data[0]; if (ep) onSelectEpisode(ep, s, videoRef.current?.currentTime); setShowServerMenu(false); }} className={`w-full text-left px-3 py-3 sm:py-2 rounded-xl sm:rounded-lg text-sm sm:text-xs mb-1 active:scale-[0.98] transition ${s.server_name===currentServer.server_name ? 'bg-blue-500 text-white' : 'text-white/80 bg-white/5 sm:bg-transparent active:bg-white/15'}`}>{s.server_name}</button>
                        ))}
                        {allServers.length===0 && <span className="text-xs text-white/40 px-3">Không có nguồn âm thanh khác</span>}
                        <p className="text-[11px] font-bold text-white/50 uppercase mt-3 mb-2 px-1">Phụ đề</p>
                        <div className="w-full text-left px-3 py-3 sm:py-2 rounded-xl sm:rounded-lg text-sm sm:text-xs bg-blue-500 text-white">Tiếng Việt <span className="opacity-70">(có sẵn trong phim)</span></div>
                      </div>
                    </>
                  )}
                </div>
                <div className="relative">
                  <button ref={settingsBtnRef} onClick={(e) => { if (!showSettings) menuOpenerRef.current = e.currentTarget; setShowSettings(!showSettings); setShowServerMenu(false); setShowEpisodes(false); }} aria-label="Cài đặt" className="player-menu-btn rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11 sm:w-8 sm:h-8" style={{ touchAction: 'manipulation' }}><Settings className="w-5 h-5 sm:w-4 sm:h-4 shrink-0" /></button>
                  {showSettings && (
                    <>
                      <div className="sm:hidden fixed inset-0 z-40 bg-black/60" onClick={() => setShowSettings(false)} onTouchEnd={() => setShowSettings(false)} />
                      <div className="player-menu-panel z-50 bg-[#1c1c1e] border border-white/10 shadow-2xl fixed inset-x-0 bottom-0 rounded-t-2xl p-4 pb-[max(20px,env(safe-area-inset-bottom,0px))] max-h-[75vh] overflow-auto sm:absolute sm:inset-x-auto sm:right-0 sm:bottom-10 sm:rounded-xl sm:p-3 sm:w-56 sm:max-h-none sm:pb-3">
                        <div className="sm:hidden w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" />
                        <div className="flex items-center justify-between mb-3 sm:mb-0">
                          <p className="sm:hidden text-sm font-bold text-white">Cài đặt phát lại</p>
                          <button onClick={() => setShowSettings(false)} className="sm:hidden w-8 h-8 rounded-full bg-white/10 flex items-center justify-center" aria-label="Đóng"><ChevronDown className="w-4 h-4 text-white" /></button>
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
                {/* Khóa màn hình: chỉ mobile (touch) mới cần, desktop ẩn */}
                <button onClick={toggleLock} aria-label="Khóa màn hình" title="Khóa màn hình" className="sm:hidden rounded-full active:bg-white/20 hover:bg-white/10 flex items-center justify-center text-white w-11 h-11" style={{ touchAction: 'manipulation' }}><Lock className="w-5 h-5 shrink-0" /></button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
GauPlayer.displayName = 'GauPlayer';
