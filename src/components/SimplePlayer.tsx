import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  memo,
} from 'react';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  List,
  X,
  AlertCircle,
  Server,
  SkipForward,
  PictureInPicture2,
} from 'lucide-react';
import { EpisodeServer, Movie, MovieEpisode, Account, UserProfile } from '../types';
import { presenceService } from '../services/presenceService';
import { watchHistoryService } from '../services/watchHistoryService';
import { offlineMovieService } from '../services/offlineMovieService';
import { enterNativePip, setNativeVideoPlaying, checkNativePipSupported } from '../utils/nativeVideoPlayer';
import { Capacitor } from '@capacitor/core';
import { useTvMode } from '../hooks/useTvMode';
import { motion } from 'motion/react';

interface SimplePlayerProps {
  movie: Movie;
  currentEpisode: MovieEpisode;
  currentServer: EpisodeServer;
  allServers: EpisodeServer[];
  onBack: () => void;
  onSelectEpisode: (ep: MovieEpisode, server: EpisodeServer, currentTime?: number) => void;
  onSaveProgress: (currentTime: number, duration: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  initialTime?: number;
  autoFullscreen?: boolean; // 👈 Thêm prop này, mặc định true
  currentAccount?: Account | null;
  activeProfile?: UserProfile | null;
  disableHistory?: boolean; // when true, skip built-in history writes (caller records instead)
}

import { getMirrorUrls } from '../utils/mirrorUrls';
import { loadCleanedM3u8Url, revokeBlobUrl } from '../utils/m3u8Cleaner';
import { getFullApiUrl, verifyBackendUrl } from '../services/apiConfig';
import { resolveImdbId } from '../utils/introResolve';

type IntroSegment = { start_sec: number; end_sec: number; start_ms: number; end_ms: number } | null;
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

// Build ad-clean proxied m3u8 URL (server strips SSAI ad segments)
function getAdCleanUrl(raw: string): string {
  if (!raw) return raw;
  // keep local blob/file urls as-is
  if (raw.startsWith('blob:') || raw.startsWith('data:') || raw.startsWith('file:')) return raw;
  try {
    // btoa works for ASCII urls (opstream) - fallback to encodeURIComponent
    const b64 = btoa(unescape(encodeURIComponent(raw)));
    return getFullApiUrl(`/api/proxy/m3u8?url=${encodeURIComponent(b64)}`);
  } catch {
    return getFullApiUrl(`/api/proxy/m3u8?url=${encodeURIComponent(raw)}`);
  }
}

export const SimplePlayer: React.FC<SimplePlayerProps> = memo(({
  movie,
  currentEpisode,
  currentServer,
  allServers,
  onBack,
  onSelectEpisode,
  onSaveProgress,
  onTimeUpdate,
  initialTime = 0,
  autoFullscreen = false, // 👈 Mặc định bật
  currentAccount,
  activeProfile,
  disableHistory = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimeout = useRef<NodeJS.Timeout | null>(null);
  const saveInterval = useRef<NodeJS.Timeout | null>(null);
  const lastSavedTimeRef = useRef<number>(0);

  const isTv = useTvMode();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const saved = localStorage.getItem('player_volume');
      return saved ? parseFloat(saved) : 1;
    } catch {
      return 1;
    }
  });
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [qualityLevels, setQualityLevels] = useState<{ height: number; level: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState<number>(-1);
  const [brightness, setBrightness] = useState(() => {
    try {
      const saved = localStorage.getItem('player_brightness');
      return saved ? parseFloat(saved) : 1;
    } catch {
      return 1;
    }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [useEmbed, setUseEmbed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isServerMenuOpen, setIsServerMenuOpen] = useState(false);
  const [isEpisodesOpen, setIsEpisodesOpen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [segments, setSegments] = useState<SegmentsResponse | null>(null);
  const [activeSegment, setActiveSegment] = useState<'intro' | 'recap' | 'outro' | null>(null);

  // Thumbnail preview state (hover/drag/keyboard)
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewHlsRef = useRef<Hls | null>(null);
  const progressTrackRef = useRef<HTMLDivElement>(null);
  const previewSeekTimer = useRef<NodeJS.Timeout | null>(null);
  const previewDebounce = useRef<NodeJS.Timeout | null>(null);
  // Cache frame preview theo bucket 2s để hover lại hiện ngay, khỏi seek lại
  const previewFrameCache = useRef(new Map<number, string>());
  const lastPreviewTarget = useRef(-1);
  const [preview, setPreview] = useState<{ time: number; xPct: number; img: string | null; visible: boolean; loading: boolean } | null>(null);

  const [hud, setHud] = useState<{ type: 'volume' | 'brightness'; value: number } | null>(null);
  const hudTimer = useRef<NodeJS.Timeout | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioInitializedRef = useRef<boolean>(false);

  const initAudioBoost = () => {
    if (audioInitializedRef.current || !videoRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          audioCtxRef.current = new AudioCtx();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const gainNode = ctx.createGain();
        gainNodeRef.current = gainNode;
        const source = ctx.createMediaElementSource(videoRef.current);
        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        audioInitializedRef.current = true;
      }
    } catch (e) {
      // AudioContext source might already be connected or restricted
    }
  };

  // Safe cleanup of AudioContext on unmount
  useEffect(() => {
    return () => {
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        try {
          audioCtxRef.current.close().catch(() => {});
        } catch {}
        audioCtxRef.current = null;
      }
      audioInitializedRef.current = false;
    };
  }, []);

  const touchData = useRef<{
    x: number;
    y: number;
    mode: 'brightness' | 'volume';
    startVal: number;
    startTime: number;
    hasMoved: boolean;
  } | null>(null);
  const lastTouchTapTime = useRef<number>(0);
  const lastTouchTime = useRef<number>(0);

  const handleMouseMove = () => {
    if (Date.now() - lastTouchTime.current < 600) return;
    resetControlsTimer();
  };

  const showHud = useCallback((type: 'volume' | 'brightness', value: number) => {
    if (hudTimer.current) clearTimeout(hudTimer.current);
    setHud({ type, value });
    hudTimer.current = setTimeout(() => setHud(null), 1200);
  }, []);

  const changeBrightness = useCallback(
    (val: number, showToast = true) => {
      const clamped = Math.min(1.0, Math.max(0.2, val));
      setBrightness(clamped);
      localStorage.setItem('player_brightness', String(clamped));
      if (showToast) showHud('brightness', clamped);
    },
    [showHud]
  );

  const changeVolume = useCallback(
    (val: number, showToast = true) => {
      const clamped = Math.min(1.0, Math.max(0, val));
      setVolume(clamped);
      setIsMuted(clamped === 0);

      const video = videoRef.current;
      if (video) {
        video.volume = clamped;
        video.muted = clamped === 0;
      }
      localStorage.setItem('player_volume', String(clamped));
      if (showToast) showHud('volume', clamped);
    },
    [showHud]
  );

  const toggleMute = useCallback(() => {
    if (isMuted || volume === 0) {
      const newVol = volume > 0 ? volume : 0.8;
      changeVolume(newVol);
    } else {
      changeVolume(0);
    }
  }, [isMuted, volume, changeVolume]);

  // Thumbnail preview helpers
  const capturePreviewFrame = useCallback(() => {
    const pv = previewVideoRef.current;
    const cv = previewCanvasRef.current;
    if (!pv || !cv) return;
    try {
      const w = 160, h = 90;
      // Responsive thumbnail size
      const isMobile = window.innerWidth < 640;
      const isTv = window.innerWidth >= 1280 && window.matchMedia('(hover: none)').matches === false;
      const cw = isMobile ? 120 : isTv ? 200 : w;
      const ch = isMobile ? 68 : isTv ? 112 : h;
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(pv, 0, 0, cw, ch);
      const dataUrl = cv.toDataURL('image/jpeg', 0.65);
      try {
        const bucket = Math.floor((pv.currentTime || 0) / 2);
        if (previewFrameCache.current.size > 120) previewFrameCache.current.clear();
        previewFrameCache.current.set(bucket, dataUrl);
      } catch {}
      setPreview(prev => prev ? { ...prev, img: dataUrl, loading: false } : prev);
    } catch (e) {
      // CORS taint fallback - keep time label only
      setPreview(prev => prev ? { ...prev, loading: false } : prev);
    }
  }, []);

  const seekPreviewTo = useCallback((time: number) => {
    const pv = previewVideoRef.current;
    if (!pv || !duration || duration <= 0) return;
    const clamped = Math.max(0, Math.min(duration - 0.5, time));
    // Đã có frame trong cache -> hiện ngay, khỏi seek
    const bucket = Math.floor(clamped / 2);
    const cached = previewFrameCache.current.get(bucket);
    if (cached) {
      if (previewSeekTimer.current) clearTimeout(previewSeekTimer.current);
      lastPreviewTarget.current = clamped;
      setPreview(prev => prev ? { ...prev, time: clamped, img: cached, loading: false } : prev);
      return;
    }
    if (Math.abs(clamped - lastPreviewTarget.current) < 1) return;
    lastPreviewTarget.current = clamped;
    setPreview(prev => prev ? { ...prev, time: clamped, loading: true } : prev);
    if (previewSeekTimer.current) clearTimeout(previewSeekTimer.current);
    // Debounce seek a bit to avoid spamming
    previewSeekTimer.current = setTimeout(() => {
      try {
        pv.currentTime = clamped;
      } catch {}
    }, 180);
  }, [duration]);

  const getTimeFromClientX = useCallback((clientX: number) => {
    const track = progressTrackRef.current;
    if (!track || !duration) return { time: 0, pct: 0 };
    const rect = track.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const pct = rect.width > 0 ? (x / rect.width) * 100 : 0;
    const time = (pct / 100) * duration;
    return { time, pct };
  }, [duration]);

  const showPreviewAtClientX = useCallback((clientX: number) => {
    if (!duration || duration <= 0) return;
    const { time, pct } = getTimeFromClientX(clientX);
    setPreview({ time, xPct: pct, img: null, visible: true, loading: true });
    seekPreviewTo(time);
  }, [duration, getTimeFromClientX, seekPreviewTo]);

  const hidePreview = useCallback(() => {
    if (previewDebounce.current) clearTimeout(previewDebounce.current);
    setPreview(null);
  }, []);

  const handleProgressPointerMove = useCallback((clientX: number) => {
    if (previewDebounce.current) clearTimeout(previewDebounce.current);
    // debounce slightly for performance
    previewDebounce.current = setTimeout(() => showPreviewAtClientX(clientX), 30);
  }, [showPreviewAtClientX]);

  // 👇 Hàm togglePlay có auto fullscreen
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().catch(() => {});
      // Tự động fullscreen nếu chưa fullscreen và autoFullscreen=true
      if (autoFullscreen && !document.fullscreenElement) {
        // iOS Safari
        if (typeof (video as any).webkitEnterFullscreen === 'function') {
          (video as any).webkitEnterFullscreen();
        } else if (container?.requestFullscreen) {
          container.requestFullscreen().then(() => {
            if ((window.screen?.orientation as any)?.lock) {
              (window.screen.orientation as any).lock('landscape').catch(() => {});
            }
          }).catch(() => {});
        }
      }
    } else {
      video.pause();
    }
  }, [autoFullscreen]);

  const skip = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const target = Math.min(duration, Math.max(0, video.currentTime + seconds));
      video.currentTime = target;
      setCurrentTime(target);
    },
    [duration]
  );

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    
    const isMobile = window.innerWidth <= 1024;
    const isLandscape = isMobile && window.innerWidth > window.innerHeight;
    const isFs = !!document.fullscreenElement;

    if (!isFs && (!isMobile || !isLandscape)) {
      try {
        if (typeof (videoRef.current as any)?.webkitEnterFullscreen === 'function') {
          (videoRef.current as any).webkitEnterFullscreen();
        } else {
          await container.requestFullscreen?.();
        }
        if ((window.screen?.orientation as any)?.lock) {
          await (window.screen.orientation as any).lock('landscape').catch(() => {});
        }
      } catch (err) {}
    } else {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen?.();
        }
        if (window.screen?.orientation?.unlock) {
          window.screen.orientation.unlock();
        }
      } catch (err) {}
    }
  }, []);

  const togglePip = useCallback(async () => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const res = await enterNativePip();
      if (res) return;
    }

    const video = videoRef.current;
    
    // Fallback for Document Picture-in-Picture API (Chrome 116+ PWA & Desktop) when video is embed or standard PiP fails
    if ((!video || useEmbed) && typeof window !== 'undefined' && 'documentPictureInPicture' in window && containerRef.current) {
      try {
        if ((window as any).pipWindowInstance) {
          (window as any).pipWindowInstance.close();
          (window as any).pipWindowInstance = null;
          setIsPip(false);
          return;
        }
        const pipWin = await (window as any).documentPictureInPicture.requestWindow({
          width: 640,
          height: 360,
        });
        (window as any).pipWindowInstance = pipWin;
        setIsPip(true);
        pipWin.addEventListener('pagehide', () => {
          (window as any).pipWindowInstance = null;
          setIsPip(false);
        });
        pipWin.document.body.appendChild(containerRef.current);
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.backgroundColor = 'black';
        return;
      } catch (e) {
        void 0;
      }
    }

    if (!video) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === 'function') {
        // Direct call without checking document.pictureInPictureEnabled (which can be false/undefined in PWA)
        await video.requestPictureInPicture();
      } else if ((video as any).webkitSupportsPresentationMode && typeof (video as any).webkitSetPresentationMode === 'function') {
        const currentMode = (video as any).webkitPresentationMode;
        (video as any).webkitSetPresentationMode(currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (typeof window !== 'undefined' && 'documentPictureInPicture' in window && containerRef.current) {
        const pipWin = await (window as any).documentPictureInPicture.requestWindow({
          width: 640,
          height: 360,
        });
        (window as any).pipWindowInstance = pipWin;
        setIsPip(true);
        pipWin.addEventListener('pagehide', () => {
          (window as any).pipWindowInstance = null;
          setIsPip(false);
        });
        pipWin.document.body.appendChild(containerRef.current);
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.backgroundColor = 'black';
      }
    } catch (err) {
      void 0;
      // Fallback for iOS WebKit Presentation Mode
      if ((video as any).webkitSetPresentationMode && typeof (video as any).webkitSetPresentationMode === 'function') {
        try {
          const currentMode = (video as any).webkitPresentationMode;
          (video as any).webkitSetPresentationMode(currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        } catch (e2) {}
      }
    }
  }, [useEmbed]);

  // Offline file check (Filesystem) — only mobile
  useEffect(() => {
    let cancelled = false;
    const checkLocal = async () => {
      if (!Capacitor.isNativePlatform() || !currentAccount || !activeProfile) {
        if (!cancelled) { setLocalVideoUrl(null); setIsOfflineMode(false); }
        return;
      }
      const offline = !navigator.onLine;
      setIsOfflineMode(offline);
      try {
        const uri = await offlineMovieService.getEpisodeLocalUri(
          currentAccount.id || currentAccount.username || 'user',
          activeProfile.id,
          movie.slug,
          currentEpisode.slug
        );
        if (!cancelled) setLocalVideoUrl(uri);
        if (uri) setIsOfflineMode(true); // has local file, treat as offline capable
        if (offline && !uri) {
          setErrorMsg('Bạn đang offline và tập này chưa được tải về. Vui lòng tải trước khi xem offline.');
        }
      } catch {
        if (!cancelled) setLocalVideoUrl(null);
      }
    };
    checkLocal();
    const onOnline = () => setIsOfflineMode(!navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
    };
  }, [movie.slug, currentEpisode.slug, currentAccount, activeProfile]);

  // Check PiP support on mount and default to true on Web/PWA
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      checkNativePipSupported().then((sup) => {
        const isStandardPip = typeof document !== 'undefined' && ('pictureInPictureEnabled' in document || typeof HTMLVideoElement !== 'undefined');
        setPipSupported(sup || isStandardPip);
      });
    } else {
      // Always enable PiP button on Web / PWA
      setPipSupported(true);
    }
  }, []);

  // PiP Event Listeners - re-run when useEmbed or videoRef changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    try {
      (video as any).autoPictureInPicture = true;
    } catch (e) {}

    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);
    const onWebkitPresentationChange = () => {
      if (video) {
        setIsPip((video as any).webkitPresentationMode === 'picture-in-picture');
      }
    };

    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    video.addEventListener('webkitpresentationmodechanged', onWebkitPresentationChange);

    const onNativePipChange = (e: any) => {
      setIsPip(!!e.detail?.isPip);
    };
    window.addEventListener('native-pip-change', onNativePipChange);

    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
      video.removeEventListener('webkitpresentationmodechanged', onWebkitPresentationChange);
      window.removeEventListener('native-pip-change', onNativePipChange);
    };
  }, [useEmbed]);

  // Auto PiP when exiting/leaving app or switching tabs while video is playing
  useEffect(() => {
    setNativeVideoPlaying(isPlaying);

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        const video = videoRef.current;
        if (video && !video.paused && !video.ended) {
          if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
            await enterNativePip();
          } else {
            try {
              if (typeof video.requestPictureInPicture === 'function' && !document.pictureInPictureElement) {
                await video.requestPictureInPicture();
              } else if ((video as any).webkitSupportsPresentationMode && (video as any).webkitPresentationMode !== 'picture-in-picture') {
                (video as any).webkitSetPresentationMode('picture-in-picture');
              }
            } catch (e) {
              void 0;
            }
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      setNativeVideoPlaying(false);
    };
  }, [isPlaying]);

  // MediaSession API setup
  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${movie.name} - ${currentEpisode.name}`,
        artist: 'Gấu Cinema',
        album: currentServer.server_name || 'Stream HLS',
        artwork: [
          {
            src: movie.poster_url || movie.thumb_url || '/app_logo.jpg',
            sizes: '512x512',
            type: 'image/jpeg',
          },
        ],
      });
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

      try {
        navigator.mediaSession.setActionHandler('play', () => {
          videoRef.current?.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          videoRef.current?.pause();
        });
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          skip(-(details.seekOffset || 10));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          skip(details.seekOffset || 10);
        });
        (navigator.mediaSession.setActionHandler as any)('enterpictureinpicture', () => {
          togglePip();
        });
      } catch (e) {
        void 0;
      }
      // TV memory: gỡ handler khi effect re-run/unmount, kẻo giữ closure
      // của player đã đóng (lặp Home->Player->Back).
      return () => {
        try {
          const noop = () => {};
          navigator.mediaSession.setActionHandler('play', noop);
          navigator.mediaSession.setActionHandler('pause', noop);
          navigator.mediaSession.setActionHandler('seekbackward', noop);
          navigator.mediaSession.setActionHandler('seekforward', noop);
          (navigator.mediaSession.setActionHandler as any)('enterpictureinpicture', noop);
        } catch {}
      };
    }
    return undefined;
  }, [movie, currentEpisode, currentServer, skip, togglePip, isPlaying]);

  // TV memory: dọn timer + PiP window khi player unmount. Trước đây
  // controlsTimeout/previewSeek/previewDebounce/hud sót lại và PiP giữ
  // container DOM đã unmount -> leak mỗi vòng Home->Player->Back.
  useEffect(() => {
    return () => {
      try {
        if (controlsTimeout.current) { clearTimeout(controlsTimeout.current); controlsTimeout.current = null; }
        if (previewSeekTimer.current) { clearTimeout(previewSeekTimer.current); previewSeekTimer.current = null; }
        if (previewDebounce.current) { clearTimeout(previewDebounce.current); previewDebounce.current = null; }
        if (hudTimer.current) { clearTimeout(hudTimer.current); hudTimer.current = null; }
      } catch {}
      try {
        const pipWin = (window as any).pipWindowInstance;
        if (pipWin && typeof pipWin.close === 'function') pipWin.close();
        (window as any).pipWindowInstance = null;
      } catch {}
    };
  }, []);

  const nextEpisode = useMemo(() => {
    const idx = currentServer.server_data.findIndex((e) => e.slug === currentEpisode.slug);
    return idx !== -1 && idx < currentServer.server_data.length - 1
      ? currentServer.server_data[idx + 1]
      : null;
  }, [currentServer, currentEpisode]);

  const goToNextEpisode = useCallback(() => {
    if (nextEpisode) {
      const time = videoRef.current?.currentTime || 0;
      onSelectEpisode(nextEpisode, currentServer, time);
    }
  }, [nextEpisode, currentServer, onSelectEpisode]);

  const switchServer = useCallback(
    (targetServer: EpisodeServer) => {
      const currentIdx = currentServer.server_data.findIndex((e) => e.slug === currentEpisode.slug);
      let matched = targetServer.server_data.find(
        (e) => e.slug === currentEpisode.slug || e.name === currentEpisode.name
      );
      if (!matched && currentIdx >= 0 && currentIdx < targetServer.server_data.length) {
        matched = targetServer.server_data[currentIdx];
      }
      if (!matched) matched = targetServer.server_data[0];
      if (matched) {
        const time = Math.max(0, (videoRef.current?.currentTime || 0) - 1);
        onSelectEpisode(matched, targetServer, time);
        setIsServerMenuOpen(false);
      }
    },
    [currentServer, currentEpisode, onSelectEpisode]
  );

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
    controlsTimeout.current = setTimeout(() => {
      if (!isSettingsOpen && !isServerMenuOpen && !isEpisodesOpen) {
        setShowControls(false);
      }
    }, 3000);
  }, [isSettingsOpen, isServerMenuOpen, isEpisodesOpen]);

  // IntroDB: single fetch per episode. 3-tier imdb resolve (direct -> tmdb external_ids -> TMDB title search)
  // để phim thiếu cả tmdb_id/imdb_id (vd Hồ Tâm) vẫn có nút skip khi IntroDB đã có dữ liệu.
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
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => { try { controller.abort(); } catch {} }, 12000);
    (async () => {
      try {
        try { await verifyBackendUrl(); } catch { /* dùng base hiện tại */ }
        if (cancelled) return;
        const imdbId = await resolveImdbId(movie as any, controller.signal as any);
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
          setSegments(normalizeSegments(data));
          const n: any = normalizeSegments(data);
          console.info(`[intro] ${imdbId} s${season}e${epNum}:`, n?.intro ? `intro ${n.intro.start_sec}-${n.intro.end_sec}s` : 'no intro');
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
      const idx = currentServer.server_data.findIndex(e => e.slug === currentEpisode.slug);
      const nxt = idx !== -1 && idx < currentServer.server_data.length - 1 ? currentServer.server_data[idx + 1] : null;
      if (nxt) onSelectEpisode(nxt, currentServer);
      else if (seg && typeof seg.end_sec === 'number' && seg.end_sec > 0) v.currentTime = Math.min(v.duration || seg.end_sec, seg.end_sec);
      return;
    }
    if (seg && typeof seg.end_sec === 'number') v.currentTime = seg.end_sec + 0.2;
  }, [segments, currentServer, currentEpisode, onSelectEpisode]);

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.player-menu-btn') && !target.closest('.player-menu-content')) {
        setIsSettingsOpen(false);
        setIsServerMenuOpen(false);
        setIsEpisodesOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      // Check if we are physically in landscape mode (mobile mostly) or in actual fullscreen
      const isFs = !!document.fullscreenElement;
      const isLandscape = window.innerWidth > window.innerHeight;
      
      // On small screens, being in landscape is practically "fullscreen"
      if (window.innerWidth <= 1024) {
        setIsFullscreen(isFs || isLandscape);
      } else {
        setIsFullscreen(isFs);
      }
    };
    
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('resize', onFsChange);
    window.addEventListener('orientationchange', onFsChange);
    
    // Initial check
    onFsChange();

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('resize', onFsChange);
      window.removeEventListener('orientationchange', onFsChange);
    };
  }, []);

  // Khởi tạo HLS — ưu tiên file offline local (Filesystem) nếu có
  useEffect(() => {
    const video = videoRef.current;
    // If offline file exists, allow playback even without remote link
    const hasLocal = !!localVideoUrl;
    if (!video || (!currentEpisode.link_m3u8 && !hasLocal) || useEmbed) return;

    // If offline mode and has local, use local file
    if (hasLocal && localVideoUrl) {
      setIsLoading(true);
      setErrorMsg(null);
      setQualityLevels([]);
      setCurrentQuality(-1);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      const isLocalHls = localVideoUrl.includes('.m3u8');
      if (isLocalHls && Hls.isSupported()) {
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
        hls.loadSource(localVideoUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoading(false);
          if (initialTime > 5) video.currentTime = initialTime;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) setErrorMsg('Lỗi phát file offline. Thử tải lại.');
        });
      } else {
        video.src = localVideoUrl;
        video.load();
        const onLoaded = () => {
          setIsLoading(false);
          if (initialTime > 5) video.currentTime = initialTime;
          video.play().catch(() => {});
        };
        video.addEventListener('loadedmetadata', onLoaded, { once: true });
        video.addEventListener('error', () => setErrorMsg('Không thể phát file offline'), { once: true });
      }
      // TV memory: nhánh offline trước đây return trần -> unmount leak HLS +
      // decoder. Trả cleanup đầy đủ như nhánh remote.
      return () => {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch {}
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
      };
    }

    setIsLoading(true);
    setErrorMsg(null);
    setQualityLevels([]);
    setCurrentQuality(-1);

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const rawCandidates = getMirrorUrls(currentEpisode.link_m3u8);
    // Direct first (cloud proxy IP blocked -> 502/404), proxied as ad-clean fallback
    const candidates: string[] = [];
    rawCandidates.forEach((u) => { if (u && !candidates.includes(u)) candidates.push(u); });
    rawCandidates.forEach((u) => { if (u) { const p = getAdCleanUrl(u); if (p && !candidates.includes(p)) candidates.push(p); } });
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
      const other = allServers.find((s) => s.server_name !== currentServer.server_name);
      if (other) {
        const ep = other.server_data.find((e) => e.slug === currentEpisode.slug) || other.server_data[0];
        if (ep) {
          const time = Math.max(0, (video.currentTime || 0) - 1);
          onSelectEpisode(ep, other, time);
          return;
        }
      }
      if (currentEpisode.link_embed) {
        setUseEmbed(true);
        setIsLoading(false);
        return;
      }
      setErrorMsg('Không thể tải luồng phát. Vui lòng thử lại hoặc chọn server khác.');
      setIsLoading(false);
    };

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 30 * 1000 * 1000, // 30MB limit for mobile stability
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 20000,
        startLevel: -1,
        capLevelToPlayerSize: true,
      });
      hlsRef.current = hls;

      // Client-side ad-clean first (browser IP works, cloud IP blocked)
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
        } catch { /* fall through */ }
        if (!cancelled) hls.loadSource(candidates[0]);
      })();
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        setIsLoading(false);
        setErrorMsg(null);
        const levels = data.levels.map((lvl, i) => ({ height: lvl.height, level: i }));
        setQualityLevels(levels);
        if (initialTime > 5) video.currentTime = initialTime;
        video.play().catch(() => {});
        video.volume = isMuted ? 0 : volume;
        video.muted = isMuted;
      });

      let errorCount = 0;
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          errorCount++;
          if (errorCount <= 2 && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (errorCount <= 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            tryNext(hls);
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = getMirrorUrls(currentEpisode.link_m3u8)[0] || getAdCleanUrl(currentEpisode.link_m3u8);
      video.addEventListener('loadedmetadata', () => {
        setIsLoading(false);
        if (initialTime > 5) video.currentTime = initialTime;
        video.play().catch(() => {});
      });
      video.onerror = () => {
        if (currentEpisode.link_embed) setUseEmbed(true);
        else setErrorMsg('Không thể phát video trên trình duyệt này.');
        setIsLoading(false);
      };
    } else if (currentEpisode.link_embed) {
      setUseEmbed(true);
      setIsLoading(false);
    } else {
      setErrorMsg('Trình duyệt không hỗ trợ HLS.');
      setIsLoading(false);
    }

    return () => {
      cancelled = true;
      revokeBlobUrl([blobUrl, ...extraBlobs]);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {}
    };
  }, [currentEpisode.link_m3u8, useEmbed, allServers, currentServer, initialTime, onSelectEpisode, localVideoUrl]);

  // Preview video HLS setup (thumbnail)
  useEffect(() => {
    const pv = previewVideoRef.current;
    if (!pv || !currentEpisode.link_m3u8 || useEmbed) return;
    // reset preview state on source change
    setPreview(null);
    previewFrameCache.current.clear();
    lastPreviewTarget.current = -1;
    if (previewHlsRef.current) {
      previewHlsRef.current.destroy();
      previewHlsRef.current = null;
    }
    const directRaw = getMirrorUrls(currentEpisode.link_m3u8)[0];
    if (!directRaw) return;
    let previewBlobs: string[] = [];
    let cancelled = false;
    const onSeeked = () => {
      capturePreviewFrame();
    };
    pv.addEventListener('seeked', onSeeked);
    pv.muted = true;
    pv.preload = 'metadata';
    // @ts-ignore
    pv.crossOrigin = 'anonymous';

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
          startLevel: 0, // lowest quality for fast preview
          capLevelToPlayerSize: true,
        });
        previewHlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(pv);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            // fallback: try canvas from main video if preview fails (CORS)
            setPreview(prev => prev ? { ...prev, loading: false } : prev);
          }
        });
      } else if (pv.canPlayType('application/vnd.apple.mpegurl')) {
        pv.src = src;
      }
    };
    // Same cleaner as main player so preview aligns with cleaned timeline
    loadCleanedM3u8Url(directRaw).then((cleaned) => {
      if (cancelled) { if (cleaned) revokeBlobUrl([cleaned.blobUrl, ...(cleaned.extraBlobs || [])]); return; }
      if (cleaned) { previewBlobs = [cleaned.blobUrl, ...(cleaned.extraBlobs || [])]; attachPreview(cleaned.blobUrl); }
      else attachPreview(directRaw);
    }).catch(() => { if (!cancelled) attachPreview(directRaw); });

    return () => {
      cancelled = true;
      pv.removeEventListener('seeked', onSeeked);
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
      revokeBlobUrl(previewBlobs);
    };
  }, [currentEpisode.link_m3u8, useEmbed, capturePreviewFrame]);

  useEffect(() => {
    presenceService.startSession({
      accountId: currentAccount?.id || currentAccount?.username || 'user',
      accountDisplayName: currentAccount?.displayName || currentAccount?.username || 'Khán Giả Phim',
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
  }, [movie.name, currentEpisode.name, currentServer.server_name, currentAccount, activeProfile]);

  useEffect(() => {
    lastSavedTimeRef.current = 0;
    saveInterval.current = setInterval(() => {
      const video = videoRef.current;
      if (!video || duration <= 0) return;
      if (video.paused) return;
      const cur = video.currentTime;
      if (lastSavedTimeRef.current > 0 && cur - lastSavedTimeRef.current < 15) return;
      lastSavedTimeRef.current = cur;
      onSaveProgress(cur, duration);
      if (!disableHistory) watchHistoryService.recordWatch({
        accountId: currentAccount?.id || currentAccount?.username || 'user',
        accountDisplayName: currentAccount?.displayName || currentAccount?.username || 'Khán Giả Phim',
        profileId: activeProfile?.id || 'movie_profile',
        profileName: activeProfile?.name || 'Người xem',
        profileAvatar: activeProfile?.avatar || '',
        mediaType: 'movie',
        contentId: movie.slug || movie._id || movie.id || '',
        title: movie.name,
        subtitle: currentEpisode.name ? `Tập ${currentEpisode.name}` : undefined,
        coverUrl: movie.poster_url || movie.thumb_url,
        apiSource: currentServer.server_name || 'movie',
        currentTime: cur,
        duration: duration,
        progressPercent: Math.round((cur / duration) * 100),
        watchedDurationSeconds: 30,
      });
    }, 30000);
    return () => {
      if (saveInterval.current) clearInterval(saveInterval.current);
    };
  }, [duration, onSaveProgress]);

  // Save progress on unmount (when player closes)
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      // Read live duration from the video element because this effect has
      // empty deps and would otherwise capture the initial `duration` (= 0).
      const liveDuration = video?.duration || duration;
      if (video && liveDuration > 0 && currentAccount && activeProfile && !disableHistory) {
        const cur = video.currentTime;
        const progressPercent = Math.round((cur / liveDuration) * 100);
        onSaveProgress(cur, liveDuration);
        watchHistoryService.recordWatch({
          accountId: currentAccount.id || currentAccount.username || 'user',
          accountDisplayName: currentAccount.displayName || currentAccount.username || 'Khán Giả Phim',
          profileId: activeProfile.id || 'movie_profile',
          profileName: activeProfile.name || 'Người xem',
          profileAvatar: activeProfile.avatar || '',
          mediaType: 'movie',
          contentId: movie.slug || movie._id || movie.id || '',
          title: movie.name,
          subtitle: currentEpisode.name ? `Tập ${currentEpisode.name}` : undefined,
          coverUrl: movie.poster_url || movie.thumb_url,
          apiSource: currentServer.server_name || 'movie',
          currentTime: cur,
          duration: liveDuration,
          progressPercent,
          watchedDurationSeconds: 0,
        });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phím tắt (giữ nguyên)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'f':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'p':
          e.preventDefault();
          togglePip();
          break;
        case 'm':
          e.preventDefault();
          toggleMute();
          break;
        case 'arrowleft':
        case 'j': {
          e.preventDefault();
          // TV/desktop preview: show thumbnail at target before seek
          if (duration > 0) {
            const target = Math.max(0, (videoRef.current?.currentTime || 0) - 10);
            const pct = (target / duration) * 100;
            setPreview({ time: target, xPct: pct, img: null, visible: true, loading: true });
            seekPreviewTo(target);
            setTimeout(hidePreview, 1200);
          }
          skip(-10);
          break;
        }
        case 'arrowright':
        case 'l': {
          e.preventDefault();
          if (duration > 0) {
            const target = Math.min(duration, (videoRef.current?.currentTime || 0) + 10);
            const pct = (target / duration) * 100;
            setPreview({ time: target, xPct: pct, img: null, visible: true, loading: true });
            seekPreviewTo(target);
            setTimeout(hidePreview, 1200);
          }
          skip(10);
          break;
        }
        case 'arrowup':
          e.preventDefault();
          changeVolume(Math.min(1, volume + 0.05));
          break;
        case 'arrowdown':
          e.preventDefault();
          changeVolume(Math.max(0, volume - 0.05));
          break;
        case '[':
          e.preventDefault();
          changeBrightness(Math.max(0.2, brightness - 0.1));
          break;
        case ']':
          e.preventDefault();
          changeBrightness(Math.min(2, brightness + 0.1));
          break;
        case 's':
          if (activeSegment) { e.preventDefault(); handleSkipSegment(activeSegment); }
          break;
        default:
          break;
      }
      resetControlsTimer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    togglePlay,
    toggleFullscreen,
    togglePip,
    toggleMute,
    skip,
    changeVolume,
    changeBrightness,
    volume,
    brightness,
    resetControlsTimer,
    duration,
    seekPreviewTo,
    hidePreview,
    activeSegment,
    handleSkipSegment,
  ]);

  // Touch gesture & tap-to-toggle controls (mobile/tablet)
  const handleTouchStart = (e: React.TouchEvent) => {
    lastTouchTime.current = Date.now();
    const target = e.target as HTMLElement;
    if (target.closest('button, input, .controls-area, a, .player-menu-btn, .player-menu-content')) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const isLeft = touch.clientX < rect.left + rect.width / 2;
    touchData.current = {
      x: touch.clientX,
      y: touch.clientY,
      mode: isLeft ? 'brightness' : 'volume',
      startVal: isLeft ? brightness : volume,
      startTime: Date.now(),
      hasMoved: false,
    };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    lastTouchTime.current = Date.now();
    if (!touchData.current || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaY = touchData.current.y - touch.clientY;
    const deltaX = Math.abs(touch.clientX - touchData.current.x);

    if (Math.abs(deltaY) > 8 || deltaX > 8) {
      touchData.current.hasMoved = true;
    }

    if (Math.abs(deltaY) < 15 || deltaX > Math.abs(deltaY) * 0.7) return;

    const container = containerRef.current;
    if (!container) return;
    const height = container.clientHeight;
    const ratio = deltaY / (height * 0.6);

    if (touchData.current.mode === 'brightness') {
      const newVal = Math.min(1.0, Math.max(0.2, touchData.current.startVal + ratio));
      changeBrightness(newVal, true);
    } else {
      const newVal = Math.min(1.0, Math.max(0, touchData.current.startVal + ratio));
      changeVolume(newVal, true);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    lastTouchTime.current = Date.now();
    if (touchData.current) {
      const elapsed = Date.now() - touchData.current.startTime;
      // On mobile/touch: a clean tap (no swipe) only toggles overlay controls instantly, does NOT play/pause
      if (!touchData.current.hasMoved && elapsed < 350) {
        lastTouchTapTime.current = Date.now();
        setShowControls((prev) => {
          if (prev) {
            // Instantly hide overlay
            if (controlsTimeout.current) {
              clearTimeout(controlsTimeout.current);
              controlsTimeout.current = null;
            }
            return false;
          } else {
            // Show overlay and start timer
            resetControlsTimer();
            return true;
          }
        });
      }
      touchData.current = null;
    }
  };

  const handleVideoClick = (e: React.MouseEvent) => {
    // If click was triggered by recent touch tap on touch screen, do not toggle play
    const isRecentTouch = Date.now() - lastTouchTapTime.current < 450;
    if (isRecentTouch) return;

    // On PC (mouse click): play / pause
    togglePlay();
  };

  const formatTime = (seconds: number) => {
    if (!seconds || seconds < 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    const cur = video.currentTime;
    setCurrentTime(cur);
    onTimeUpdate?.(cur, video.duration || 0);
    if (segments) {
      const inIntro = segments.intro && cur >= segments.intro.start_sec && cur < segments.intro.end_sec - 0.15;
      const inRecap = segments.recap && cur >= segments.recap.start_sec && cur < segments.recap.end_sec - 0.15;
      const inOutro = segments.outro && cur >= segments.outro.start_sec && cur < (segments.outro.end_sec || (video.duration || 1e9));
      const nxt = inIntro ? 'intro' as const : inRecap ? 'recap' as const : inOutro ? 'outro' as const : null;
      setActiveSegment(prev => prev !== nxt ? nxt : prev);
    } else setActiveSegment(null);
    if (video.buffered.length > 0) {
      const b = video.buffered.end(video.buffered.length - 1);
      // TV perf: chỉ setState buffered khi lệch >2s (tránh re-render 4Hz)
      setBuffered((prev) => (Math.abs((prev || 0) - b) > 2 ? b : prev));
    }
  };

  // TV perf: kéo scrub chỉ đổi PREVIEW (giống GauPlayer), thả tay mới commit
  // 1 lần — tránh flush buffer + double cost main/preview mỗi pixel như trước.
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    const pct = duration > 0 ? (val / duration) * 100 : 0;
    setPreview({ time: val, xPct: pct, img: preview?.img || null, visible: true, loading: true });
    seekPreviewTo(val);
    resetControlsTimer();
  };
  const handleSeekCommit = (val: number) => {
    if (videoRef.current && isFinite(val)) {
      videoRef.current.currentTime = val;
      setCurrentTime(val);
    }
    resetControlsTimer();
  };

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, scale: 0.92, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.88, y: 16 }}
      transition={{ type: "spring", stiffness: 300, damping: 30, mass: 1.0 }}
      className="fixed inset-0 bg-black z-[70] flex items-center justify-center select-none touch-none will-change-transform"
      style={{ transformOrigin: "center center" } as React.CSSProperties}
      onMouseMove={handleMouseMove}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {useEmbed ? (
        <div className="relative w-full h-full bg-black">
          <iframe
            src={currentEpisode.link_embed}
            className="w-full h-full border-none"
            allowFullScreen
            sandbox="allow-same-origin allow-scripts allow-presentation allow-forms"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
            referrerPolicy="no-referrer"
            title={movie.name}
          />
          <button
            onClick={onBack}
            className="absolute top-[calc(env(safe-area-inset-top,0px)+16px)] left-4 z-50 bg-black/60 text-white p-2 rounded-full hover:bg-black/80"
          >
            <X className="w-6 h-6" />
          </button>
          <button
            onClick={() => setUseEmbed(false)}
            className="absolute top-[calc(env(safe-area-inset-top,0px)+16px)] right-4 z-50 bg-blue-600 text-white px-3 py-1 rounded text-sm"
          >
            Quay lại HLS
          </button>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            className="w-full h-full object-contain"
            style={{ filter: `brightness(${brightness * 100}%)` }}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onWaiting={() => setIsLoading(true)}
            onPlaying={() => setIsLoading(false)}
            onEnded={() => {
              if (nextEpisode) goToNextEpisode();
            }}
            playsInline
            {...({ autopictureinpicture: 'true' } as any)}
            onClick={handleVideoClick}
          />
          {/* Hidden preview video + canvas for thumbnail (desktop hover / mobile drag / TV dpad) */}
            <video ref={previewVideoRef} muted playsInline preload="metadata" crossOrigin="anonymous" className="pointer-events-none absolute left-0 top-0 h-[2px] w-[2px] opacity-0" tabIndex={-1} aria-hidden />
          <canvas ref={previewCanvasRef} className="hidden w-0 h-0 opacity-0 pointer-events-none" />

          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}

          {errorMsg && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mb-3" />
              <p className="text-white text-lg font-semibold">{errorMsg}</p>
              {currentEpisode.link_embed && (
                <button
                  onClick={() => setUseEmbed(true)}
                  className="mt-4 bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-500"
                >
                  Chuyển sang chế độ Embed
                </button>
              )}
            </div>
          )}

          {activeSegment && (
            <div className="absolute bottom-20 sm:bottom-24 right-4 sm:right-6 z-30 pointer-events-auto">
              {activeSegment === 'intro' && (
                <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('intro'); }} className="flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-xl text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                  <SkipForward className="w-4 h-4" /> Bỏ qua phần giới thiệu
                </button>
              )}
              {activeSegment === 'recap' && (
                <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('recap'); }} className="flex items-center gap-2 bg-white text-black px-4 py-2.5 rounded-xl text-sm font-bold shadow-2xl hover:bg-white/90 active:scale-95 transition-all border border-black/10">
                  <SkipForward className="w-4 h-4" /> Bỏ qua tóm tắt
                </button>
              )}
              {activeSegment === 'outro' && (
                <button onClick={(e) => { e.stopPropagation(); handleSkipSegment('outro'); }} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl text-sm font-bold shadow-2xl hover:bg-blue-500 active:scale-95 transition-all">
                  <SkipForward className="w-4 h-4" /> Tập tiếp theo
                </button>
              )}
            </div>
          )}

          {hud && (
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-lg flex items-center gap-3 pointer-events-none z-40">
              <span className="text-sm">
                {hud.type === 'brightness' ? '☀️' : hud.value === 0 ? '🔇' : '🔊'}
              </span>
              <span className="text-sm font-mono">
                {hud.type === 'brightness'
                  ? `${Math.round(hud.value * 100)}%`
                  : `${Math.round(hud.value * 100)}%`}
              </span>
              <div className="w-24 h-1 bg-gray-600 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white"
                  style={{
                    width: `${Math.min(100, Math.max(0, hud.value * 100))}%`,
                  }}
                />
              </div>
            </div>
          )}



          <div
            className={`absolute inset-0 flex flex-col justify-between pt-[max(2.75rem,env(safe-area-inset-top,0px))] pb-[max(1rem,env(safe-area-inset-bottom,0px))] px-3 sm:px-6 transition-opacity duration-300 pointer-events-none ${
              showControls ? 'opacity-100' : 'opacity-0'
            }`}
            style={{
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.3) 25%, transparent 45%, transparent 65%, rgba(0,0,0,0.4) 80%, rgba(0,0,0,0.9) 100%)',
            }}
          >
            {/* Top Bar Header - TV overscan safe */}
            <div className="tv-player-top flex items-center justify-between gap-3 pointer-events-auto shrink-0">
              <div className="flex flex-col min-w-0 pr-2">
                <h2 className="text-white text-base sm:text-lg font-bold drop-shadow-md truncate flex items-center gap-2">
                  <span>{movie.name}</span>
                  {localVideoUrl && (
                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-emerald-600 text-white border border-emerald-500">OFFLINE</span>
                  )}
                </h2>
                <span className="text-gray-300 text-xs sm:text-sm font-medium drop-shadow-md truncate">
                  {currentEpisode.name.startsWith('Tập')
                    ? currentEpisode.name
                    : `Tập ${currentEpisode.name}`} {localVideoUrl && '• Đã tải'}
                </span>
              </div>
              <button
                id="simple-player-close-btn"
                onClick={onBack}
                className="bg-black/60 hover:bg-black/80 text-white min-w-[42px] min-h-[42px] p-2.5 rounded-full border border-white/20 shadow-xl cursor-pointer active:scale-95 shrink-0 flex items-center justify-center transition-all"
                title="Đóng trình phát"
              >
                <X className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
              </button>
            </div>

            {/* Center Controls (Play/Pause & Seek 10s) for Mobile & Tablet */}
            <div className="flex items-center justify-center gap-6 sm:gap-10 my-auto pointer-events-auto">
              {/* Skip Back 10s */}
              <button
                onClick={() => skip(-10)}
                className="p-3.5 sm:p-4 rounded-full bg-black/60 hover:bg-black/80 text-white border border-white/20 shadow-2xl backdrop-blur-md active:scale-90 transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 group/center-skip"
                title="Lùi 10 giây"
              >
                <RotateCcw className="w-6 h-6 sm:w-7 sm:h-7 group-active/center-skip:-rotate-45 transition-transform" />
                <span className="text-[10px] sm:text-xs font-bold font-mono text-gray-200">-10s</span>
              </button>

              {/* Play / Pause Big Button */}
              <button
                onClick={togglePlay}
                className="p-5 sm:p-6 rounded-full bg-blue-600/90 hover:bg-blue-600 text-white border-2 border-white/40 shadow-2xl backdrop-blur-md active:scale-90 transition-all cursor-pointer flex items-center justify-center group/center-play"
                title={isPlaying ? 'Tạm dừng' : 'Phát'}
              >
                {isPlaying ? (
                  <Pause className="w-8 h-8 sm:w-10 sm:h-10 text-white fill-white" />
                ) : (
                  <Play className="w-8 h-8 sm:w-10 sm:h-10 text-white fill-white ml-1" />
                )}
              </button>

              {/* Skip Forward 10s */}
              <button
                onClick={() => skip(10)}
                className="p-3.5 sm:p-4 rounded-full bg-black/60 hover:bg-black/80 text-white border border-white/20 shadow-2xl backdrop-blur-md active:scale-90 transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 group/center-skip"
                title="Tới 10 giây"
              >
                <RotateCw className="w-6 h-6 sm:w-7 sm:h-7 group-active/center-skip:rotate-45 transition-transform" />
                <span className="text-[10px] sm:text-xs font-bold font-mono text-gray-200">+10s</span>
              </button>
            </div>

            {/* Bottom Controls Area - TV larger */}
            <div className="tv-player-bottom pointer-events-auto space-y-2 sm:space-y-3 shrink-0">
              {/* Progress Slider + Thumbnail Preview (Desktop hover / Mobile drag / TV dpad) */}
              <div
                ref={progressTrackRef}
                className={`relative w-full ${isTv ? 'h-7' : 'h-4'} group/seek cursor-pointer flex items-center touch-none`}
                onMouseMove={(e) => {
                  if (window.matchMedia('(hover: hover)').matches) {
                    handleProgressPointerMove(e.clientX);
                  }
                }}
                onMouseEnter={(e) => {
                  if (window.matchMedia('(hover: hover)').matches && duration > 0) {
                    handleProgressPointerMove(e.clientX);
                  }
                }}
                onMouseLeave={hidePreview}
                onTouchStart={(e) => {
                  if (e.touches[0]) handleProgressPointerMove(e.touches[0].clientX);
                }}
                onTouchMove={(e) => {
                  if (e.touches[0]) {
                    handleProgressPointerMove(e.touches[0].clientX);
                    // keep controls visible while dragging
                    resetControlsTimer();
                  }
                }}
                onTouchEnd={() => {
                  // keep preview 800ms after lift for mobile
                  setTimeout(hidePreview, 800);
                }}
                // TV remote: when focused, arrow keys move preview
                onFocus={() => setShowControls(true)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (!duration) return;
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const step = e.shiftKey ? 30 : 10;
                    const delta = e.key === 'ArrowLeft' ? -step : step;
                    const base = preview?.visible ? preview.time : currentTime;
                    const next = Math.max(0, Math.min(duration, base + delta));
                    const pct = duration > 0 ? (next / duration) * 100 : 0;
                    setPreview({ time: next, xPct: pct, img: preview?.img || null, visible: true, loading: true });
                    seekPreviewTo(next);
                    // show controls while navigating with remote
                    resetControlsTimer();
                    // auto hide after 1.5s for TV
                    setTimeout(hidePreview, 1500);
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    if (preview?.visible) {
                      if (videoRef.current) {
                        videoRef.current.currentTime = preview.time;
                        setCurrentTime(preview.time);
                      }
                      hidePreview();
                    }
                  }
                }}
                aria-label="Thanh thời lượng - di chuột/kéo để xem thumbnail, dùng phím mũi tên trên TV remote"
              >
                {/* Thumbnail preview tooltip */}
                {preview?.visible && (
                  <div
                    className="absolute -top-2 -translate-y-full pointer-events-none z-20 flex flex-col items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150"
                    style={{
                      left: `${preview.xPct}%`,
                      transform: `translateX(-50%) translateY(-8px)`,
                      // clamp to edges via max/min
                    }}
                  >
                    <div className="bg-black border border-white/20 rounded-lg overflow-hidden shadow-2xl">
                      {preview.img ? (
                        <img
                          src={preview.img}
                          alt={`Preview ${formatTime(preview.time)}`}
                          className="block object-cover bg-slate-900"
                          style={{
                            width: window.innerWidth < 640 ? 120 : window.innerWidth >= 1280 ? 200 : 160,
                            height: window.innerWidth < 640 ? 68 : window.innerWidth >= 1280 ? 112 : 90,
                          }}
                          draggable={false}
                        />
                      ) : (
                        <div
                          className="flex items-center justify-center bg-slate-800 text-white/80"
                          style={{
                            width: window.innerWidth < 640 ? 120 : window.innerWidth >= 1280 ? 200 : 160,
                            height: window.innerWidth < 640 ? 68 : window.innerWidth >= 1280 ? 112 : 90,
                          }}
                        >
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        </div>
                      )}
                      <div className="bg-black/90 text-white text-[11px] font-mono font-bold px-2 py-1 text-center border-t border-white/10">
                        {formatTime(preview.time)} {preview.loading ? '• đang tải...' : ''}
                      </div>
                    </div>
                    {/* small arrow */}
                    <div className="w-2 h-2 bg-black border-r border-b border-white/20 rotate-45 -mt-2 shadow-lg" />
                  </div>
                )}

                <div className={`absolute top-1/2 -translate-y-1/2 left-0 right-0 ${isTv ? 'h-2.5' : 'h-1.5'} bg-gray-700/80 rounded-full overflow-hidden`}>
                  <div
                    className="absolute top-0 left-0 h-full bg-gray-500/80 rounded-full transition-all"
                    style={{
                      width: `${duration > 0 ? (buffered / duration) * 100 : 0}%`,
                    }}
                  />
                  <div
                    className="absolute top-0 left-0 h-full bg-blue-500 rounded-full transition-all"
                    style={{
                      width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                    }}
                  />
                </div>
                {/* hover indicator dot */}
                {preview?.visible && (
                  <div
                    className={`absolute top-1/2 -translate-y-1/2 ${isTv ? 'w-5 h-5' : 'w-3 h-3'} bg-white border-2 border-blue-500 rounded-full shadow-lg pointer-events-none`}
                    style={{ left: `calc(${preview.xPct}% - ${isTv ? '10px' : '6px'})` }}
                  />
                )}
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  onPointerUp={(e) => {
                    handleSeekCommit(parseFloat((e.target as HTMLInputElement).value));
                  }}
                  onTouchEnd={(e) => {
                    try {
                      const t = e.target as HTMLInputElement;
                      handleSeekCommit(parseFloat(t.value));
                    } catch {}
                  }}
                  onInput={(e) => {
                    // mobile drag: update preview live
                    const val = parseFloat((e.target as HTMLInputElement).value);
                    const pct = duration > 0 ? (val / duration) * 100 : 0;
                    setPreview({ time: val, xPct: pct, img: preview?.img || null, visible: true, loading: true });
                    seekPreviewTo(val);
                  }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  aria-label="Tua video"
                />
              </div>

              {/* Controls Bar */}
              <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-1.5 sm:gap-2">
                {/* Left controls: Volume, Time */}
                <div className="flex items-center gap-1 sm:gap-2 shrink-0">
                  <div className="relative flex items-center group/vol">
                    <button
                      type="button"
                      onClick={toggleMute}
                      className="text-white hover:text-blue-400 p-1.5 rounded-lg cursor-pointer transition-colors"
                      title={isMuted || volume === 0 ? 'Bật âm thanh (M)' : 'Tắt âm thanh (M)'}
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-4 h-4 sm:w-5 sm:h-5 text-red-400" />
                      ) : (
                        <Volume2 className="w-4 h-4 sm:w-5 sm:h-5" />
                      )}
                    </button>

                    {/* PC volume slider on hover */}
                    <div className="hidden md:flex items-center w-0 opacity-0 group-hover/vol:w-20 group-hover/vol:opacity-100 transition-all duration-200 ease-out overflow-hidden ml-0 group-hover/vol:ml-1">
                      <input
                        type="range"
                        min={0}
                        max={1.0}
                        step={0.05}
                        value={isMuted ? 0 : volume}
                        onChange={(e) => {
                          changeVolume(parseFloat(e.target.value));
                        }}
                        className="w-18 h-1 bg-slate-600 rounded-lg cursor-pointer appearance-none accent-blue-500 hover:accent-sky-400"
                        title={`Âm lượng: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
                      />
                    </div>
                  </div>
                  <span className="text-white text-[11px] sm:text-xs font-mono whitespace-nowrap shrink-0 ml-0.5 sm:ml-1 tracking-tight">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>

                {/* Right controls: Next, Settings, Server, Episode List, Fullscreen */}
                <div className="flex items-center gap-1 sm:gap-2 ml-auto shrink-0">
                  {nextEpisode && (
                    <button
                      onClick={goToNextEpisode}
                      className="text-white hover:text-blue-400 p-1.5 rounded-lg flex items-center gap-1 cursor-pointer"
                      title="Tập tiếp theo"
                    >
                      <SkipForward className="w-4 h-4 sm:w-5 sm:h-5" />
                      <span className="text-xs hidden md:inline">Tập tiếp</span>
                    </button>
                  )}

                  <div className="relative">
                    <button
                      onClick={() => {
                        setIsSettingsOpen(!isSettingsOpen);
                        setIsServerMenuOpen(false);
                        setIsEpisodesOpen(false);
                      }}
                      className="text-white hover:text-blue-400 p-1.5 rounded-lg player-menu-btn cursor-pointer"
                      title="Cài đặt"
                    >
                      <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                    {isSettingsOpen && (
                      <div className="absolute right-0 bottom-10 bg-gray-900/95 backdrop-blur-md rounded-xl shadow-2xl p-3 w-48 z-50 player-menu-content border border-white/10">
                        <div className="mb-3">
                          <p className="text-gray-400 text-[10px] uppercase font-bold mb-1">Tốc độ phát</p>
                          <div className="grid grid-cols-3 gap-1">
                            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((spd) => (
                              <button
                                key={spd}
                                onClick={() => {
                                  setPlaybackRate(spd);
                                  if (videoRef.current) videoRef.current.playbackRate = spd;
                                  setIsSettingsOpen(false);
                                }}
                                className={`text-xs py-1 rounded transition-colors ${
                                  playbackRate === spd
                                    ? 'bg-blue-600 text-white font-bold'
                                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                                }`}
                              >
                                {spd}x
                              </button>
                            ))}
                          </div>
                        </div>
                        {qualityLevels.length > 0 && (
                          <div className="mb-3">
                            <p className="text-gray-400 text-[10px] uppercase font-bold mb-1">Chất lượng</p>
                            <div className="space-y-1">
                              <button
                                onClick={() => {
                                  if (hlsRef.current) hlsRef.current.currentLevel = -1;
                                  setCurrentQuality(-1);
                                  setIsSettingsOpen(false);
                                }}
                                className={`w-full text-left text-xs px-2 py-1 rounded transition-colors ${
                                  currentQuality === -1
                                    ? 'bg-blue-600 text-white font-bold'
                                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                                }`}
                              >
                                Tự động
                              </button>
                              {qualityLevels.map((lvl) => (
                                <button
                                  key={lvl.level}
                                  onClick={() => {
                                    if (hlsRef.current) hlsRef.current.currentLevel = lvl.level;
                                    setCurrentQuality(lvl.level);
                                    setIsSettingsOpen(false);
                                  }}
                                  className={`w-full text-left text-xs px-2 py-1 rounded transition-colors ${
                                    currentQuality === lvl.level
                                      ? 'bg-blue-600 text-white font-bold'
                                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                                  }`}
                                >
                                  {lvl.height}p
                                </button>
                              ))}
                            </div>
                          </div>
                        )}


                      </div>
                    )}
                  </div>

                  {allServers.length > 1 && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setIsServerMenuOpen(!isServerMenuOpen);
                          setIsSettingsOpen(false);
                          setIsEpisodesOpen(false);
                        }}
                        className="text-white hover:text-blue-400 p-1.5 rounded-lg flex items-center gap-1 player-menu-btn cursor-pointer"
                        title="Đổi server"
                      >
                        <Server className="w-4 h-4 sm:w-5 sm:h-5" />
                        <span className="text-xs hidden md:inline">{currentServer.server_name}</span>
                      </button>
                      {isServerMenuOpen && (
                        <div className="absolute right-0 bottom-10 bg-gray-900/95 backdrop-blur-md rounded-xl shadow-2xl p-2 w-56 z-50 player-menu-content overflow-y-auto max-h-60 border border-white/10">
                          {allServers.map((srv) => (
                            <button
                              key={srv.server_name}
                              onClick={() => switchServer(srv)}
                              className={`w-full text-left px-3 py-2.5 rounded text-xs mb-1 last:mb-0 transition-colors ${
                                srv.server_name === currentServer.server_name
                                  ? 'bg-blue-600 text-white font-bold'
                                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                              }`}
                            >
                              {srv.server_name}
                              {srv.sourceLabel && <span className="opacity-60 ml-1">({srv.sourceLabel})</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="relative">
                    <button
                      onClick={() => {
                        setIsEpisodesOpen(!isEpisodesOpen);
                        setIsSettingsOpen(false);
                        setIsServerMenuOpen(false);
                      }}
                      className="text-white hover:text-blue-400 p-1.5 rounded-lg flex items-center gap-1 player-menu-btn cursor-pointer"
                      title="Danh sách tập"
                    >
                      <List className="w-4 h-4 sm:w-5 sm:h-5" />
                      <span className="text-xs hidden md:inline">Tập phim</span>
                    </button>
                    {isEpisodesOpen && (
                      <div className="absolute right-0 bottom-10 bg-gray-900/95 backdrop-blur-md rounded-xl shadow-2xl p-3 w-64 z-50 player-menu-content overflow-y-auto max-h-64 custom-scrollbar border border-white/10">
                        <p className="text-gray-400 text-[10px] uppercase font-bold mb-3 px-1 tracking-wider">Danh sách tập</p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {currentServer.server_data.map((ep) => (
                            <button
                              key={ep.slug}
                              onClick={() => {
                                onSelectEpisode(ep, currentServer);
                                setIsEpisodesOpen(false);
                              }}
                              className={`text-[11px] py-2 rounded text-center truncate transition-colors ${
                                ep.slug === currentEpisode.slug
                                  ? 'bg-blue-600 text-white font-bold shadow-lg shadow-blue-600/30'
                                  : 'bg-gray-800/50 text-gray-300 hover:bg-gray-700 hover:text-white'
                              }`}
                            >
                              {(() => { const c = ep.name.replace(/^Tập\s*/i, '').trim(); return /^\d+$/.test(c) ? c.padStart(2, '0') : c; })()}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {pipSupported && (
                    <button
                      onClick={togglePip}
                      className={`text-white hover:text-blue-400 p-1.5 rounded-lg active:scale-90 transition-transform cursor-pointer ${
                        isPip ? 'text-blue-400 bg-blue-500/20' : ''
                      }`}
                      title={isPip ? 'Thoát Picture-in-Picture (P)' : 'Hình trong hình / Thu nhỏ (P)'}
                      aria-label="Picture-in-Picture"
                    >
                      <PictureInPicture2 className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                  )}

                  <button
                    onClick={toggleFullscreen}
                    className="text-white hover:text-blue-400 p-1.5 rounded-lg active:scale-90 transition-transform cursor-pointer"
                    title={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
                  >
                    {isFullscreen ? (
                      <Minimize className="w-4 h-4 sm:w-5 sm:h-5" />
                    ) : (
                      <Maximize className="w-4 h-4 sm:w-5 sm:h-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
});
