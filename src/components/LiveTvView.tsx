import React, { useEffect, useState, useRef } from 'react';
import {
  Tv,
  Search,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RefreshCw,
  Sparkles,
  ChevronRight,
  Signal,
  X,
  Radio,
  Star,
  Grid,
  List,
  Server,
  ChevronDown,
  Check,
  SkipForward,
  SkipBack,
  Key,
  Globe,
  ShieldCheck,
  Zap,
  ExternalLink,
  PictureInPicture2,
} from 'lucide-react';
import Hls from 'hls.js';
import shaka from 'shaka-player';
import { Capacitor } from '@capacitor/core';
import { Account, Channel } from '../types';
import { firestoreStorage } from '../services/firestoreStorage';
import { getFullApiUrl } from '../services/apiConfig';
import { systemApiService } from '../services/systemApiService';
import { presenceService } from '../services/presenceService';
import { DEFAULT_CHANNELS } from '../data/defaultChannels';
import { parseClearkeyToHexMap, parseM3uWithDrmAndUA, isLicenseServerUrl } from '../utils/drmParser';
import { playInNativeExoPlayer, playInExternalPlayer, enterNativePip, setNativeVideoPlaying, checkNativePipSupported } from '../utils/nativeVideoPlayer';
import { isTvModeActive, TV_MEDIA_EVENT, markProgrammaticFocus } from '../utils/tvRemote';
import { useTvMode } from '../hooks/useTvMode';
import { CloudflareWorkerModal } from './livetv/CloudflareWorkerModal';
import { DrmChannelTesterModal } from './livetv/DrmChannelTesterModal';

interface LiveTvViewProps {
  currentAccount: Account | null;
}

export const LiveTvView: React.FC<LiveTvViewProps> = ({ currentAccount }) => {
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>(() => {
    try {
      return localStorage.getItem('gau_tv_selected_group') || 'Tất cả';
    } catch {
      return 'Tất cả';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('gau_tv_selected_group', selectedGroup);
    } catch {}
  }, [selectedGroup]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mobileTab, setMobileTab] = useState<'player' | 'channels'>('player');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [showDrmTesterModal, setShowDrmTesterModal] = useState(false);
  const [showCloudflareModal, setShowCloudflareModal] = useState(false);
  // TV gọn: false = trang chủ (danh mục + kênh), true = player toàn màn hình
  const [tvPlayerOpen, setTvPlayerOpen] = useState(false);
  const tvPlayerBoxRef = useRef<HTMLDivElement>(null);

  // Favorites state
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('qtb_tv_favorites');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const toggleFavorite = (channelUrl: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(channelUrl)
        ? prev.filter((u) => u !== channelUrl)
        : [...prev, channelUrl];
      try {
        localStorage.setItem('qtb_tv_favorites', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Source selection state
  const LIVE_SOURCES = [
    {
      id: 'default',
      name: 'Default',
      shortName: 'Default',
      count: '440+ Kênh',
      badge: 'ASEAN Cup & Ngoại Hạng Anh',
      desc: 'Nguồn mặc định: VTV1-6 HD, K+ Sport, ASEAN Cup 2026, Sky Sport, Canal+ Live',
      url: 'https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/main/vmttv',
    },
    {
      id: 'sports_epl',
      name: 'Ngoại Hạng Anh & Thể Thao VIP',
      shortName: 'Ngoại Hạng Anh',
      count: '50+ Kênh',
      badge: 'Bóng Đá Trực Tiếp',
      desc: 'K+ Sport 1-2, K+ Action, TNT Sports 1-4, Sky Sports Premier League, beIN Sports',
      url: 'https://raw.githubusercontent.com/vuminhthanh12/vuminhthanh12/main/vmttv',
    },
    {
      id: 'phaohoa_tv',
      name: 'Pháo Hoa TV (Thể Thao & Sự Kiện)',
      shortName: 'Pháo Hoa TV',
      count: '200+ Kênh',
      badge: 'Full HD',
      desc: 'Tổng hợp bóng đá Ngoại Hạng Anh, C1, VTV, HTV, Thể Thao TV',
      url: 'https://raw.githubusercontent.com/phut90/tv/main/iptv.m3u',
    }
  ];
  const [selectedSource, setSelectedSource] = useState<string>('default');

  const currentSourceObj = LIVE_SOURCES.find((s) => s.id === selectedSource) || LIVE_SOURCES[0];

  // Player state
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shakaPlayerRef = useRef<shaka.Player | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1.0);
  const [isLoadingStream, setIsLoadingStream] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isPip, setIsPip] = useState(false);
  const [pipSupported, setPipSupported] = useState(true);
  const isTv = useTvMode();

  // TV remote refs (tránh stale closure trong listener gau_tv_media)
  const tvTogglePlayRef = useRef<() => void>(() => {});
  const tvNextRef = useRef<() => void>(() => {});
  const tvPrevRef = useRef<() => void>(() => {});

  // Check PiP support on mount and default to true on Web/PWA
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      checkNativePipSupported().then((sup) => {
        const isStandardPip = typeof document !== 'undefined' && ('pictureInPictureEnabled' in document || typeof HTMLVideoElement !== 'undefined');
        setPipSupported(sup || isStandardPip);
      });
    } else {
      // Always enable PiP on Web / PWA
      setPipSupported(true);
    }
  }, []);

  // PiP Event Listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    try {
      (video as any).autoPictureInPicture = true;
    } catch (e) {}

    if (typeof (video as any).webkitSupportsPresentationMode === 'function' && (video as any).webkitSupportsPresentationMode('picture-in-picture')) {
      setPipSupported(true);
    }

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
  }, [activeChannel]);

  // Auto PiP when exiting/leaving app or switching tabs while Live TV is playing
  useEffect(() => {
    setNativeVideoPlaying(isPlaying && !!activeChannel);

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        const video = videoRef.current;
        if (video && !video.paused && !video.ended && activeChannel) {
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
  }, [isPlaying, activeChannel]);

  // Initialize Shaka polyfill
  useEffect(() => {
    try {
      shaka.polyfill.installAll();
    } catch (e) {
      void 0;
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setIsFullscreen(isFs);
      if (!isFs) {
        if (screen.orientation && (screen.orientation as any).unlock) {
          try {
            (screen.orientation as any).unlock();
          } catch (e) {}
        }
        if (window.history.state && window.history.state.liveTvFs) {
          window.history.back();
        }
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    document.addEventListener('webkitbeginfullscreen', handleFullscreenChange);
    document.addEventListener('webkitendfullscreen', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      document.removeEventListener('webkitbeginfullscreen', handleFullscreenChange);
      document.removeEventListener('webkitendfullscreen', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (isFullscreen && !(e.state && e.state.liveTvFs)) {
        setIsFullscreen(false);
        const isNativeFs = !!(
          document.fullscreenElement || (document as any).webkitFullscreenElement
        );
        if (isNativeFs) {
          if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
          else if ((document as any).webkitExitFullscreen)
            (document as any).webkitExitFullscreen();
        }
        if (videoRef.current && (videoRef.current as any).webkitExitFullscreen) {
          try {
            (videoRef.current as any).webkitExitFullscreen();
          } catch (e) {}
        }
        if (screen.orientation && (screen.orientation as any).unlock) {
          try {
            (screen.orientation as any).unlock();
          } catch (e) {}
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isFullscreen]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onWebkitEndFullscreen = () => {
      setIsFullscreen(false);
      if (window.history.state && window.history.state.liveTvFs) {
        window.history.back();
      }
      if (screen.orientation && (screen.orientation as any).unlock) {
        try {
          (screen.orientation as any).unlock();
        } catch (e) {}
      }
    };

    video.addEventListener('webkitendfullscreen', onWebkitEndFullscreen);
    return () => {
      video.removeEventListener('webkitendfullscreen', onWebkitEndFullscreen);
    };
  }, [activeChannel]);

  useEffect(() => {
    fetchChannels();
  }, [selectedSource]);

  const parseM3uContent = (text: string): Channel[] => {
    return parseM3uWithDrmAndUA(text);
  };

  const fetchChannels = async () => {
    try {
      setLoading(true);
      setError(null);

      // Check cache first for instant responsiveness
      const cacheKey = `qtb_tv_channels_${selectedSource}`;
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setChannels(parsed);
            if (!activeChannel) setActiveChannel(parsed[0]);
          }
        }
      } catch {}

      const sourceObj = LIVE_SOURCES.find((s) => s.id === selectedSource);
      const targetUrl = sourceObj?.url;
      let loadedChannels: Channel[] = [];
      const isNative = Capacitor.isNativePlatform();

      // 1. On Native APK, try direct fetch first for maximum speed and zero server dependency
      if (isNative && targetUrl && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const res = await fetch(targetUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const text = await res.text();
            const parsed = parseM3uContent(text);
            if (parsed.length > 0) {
              loadedChannels = parsed;
            }
          }
        } catch (e) {
          void 0;
        }
      }

      // 2. Try Backend Proxy (Handles multi-source aggregation & remote M3U parsing)
      if (loadedChannels.length === 0) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          let fetchUrl = getFullApiUrl('/api/tv/channels');
          if (targetUrl) {
            fetchUrl += `?url=${encodeURIComponent(targetUrl)}`;
          }

          const res = await fetch(fetchUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const data = await res.json();
            if (data.success && Array.isArray(data.channels) && data.channels.length > 0) {
              loadedChannels = data.channels;
            }
          }
        } catch (e) {
          void 0;
        }
      }

      // 3. Direct client-side fetch fallback (for Web browsers if proxy failed)
      if (loadedChannels.length === 0 && targetUrl) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const res = await fetch(targetUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const text = await res.text();
            const parsed = parseM3uContent(text);
            if (parsed.length > 0) {
              loadedChannels = parsed;
            }
          }
        } catch (e) {
          void 0;
        }
      }

      // 3. Fallback or update state
      if (loadedChannels.length > 0) {
        setChannels(loadedChannels);
        if (!activeChannel || !loadedChannels.some((c) => c.url === activeChannel.url)) {
          setActiveChannel(loadedChannels[0]);
        }
        try {
          localStorage.setItem(cacheKey, JSON.stringify(loadedChannels));
        } catch {}
      } else {
        // Safe fallback to built-in default channels
        setChannels(DEFAULT_CHANNELS);
        if (!activeChannel || !DEFAULT_CHANNELS.some((c) => c.url === activeChannel.url)) {
          setActiveChannel(DEFAULT_CHANNELS[0]);
        }
      }
    } catch (err: any) {
      void 0;
      setChannels(DEFAULT_CHANNELS);
    } finally {
      setLoading(false);
      window.dispatchEvent(new Event('app-data-loaded'));
    }
  };

  // Extract unique groups
  const groups = [
    'Tất cả',
    '⭐ Yêu thích',
    ...Array.from(new Set(channels.map((c) => c.group || 'Khác'))),
  ];

  const filteredChannels = channels.filter((c) => {
    let matchesGroup = true;
    if (selectedGroup === '⭐ Yêu thích') {
      matchesGroup = favorites.includes(c.url);
    } else if (selectedGroup !== 'Tất cả') {
      matchesGroup = c.group === selectedGroup;
    }
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesGroup && matchesSearch;
  });

  // Safe Play helper to prevent AbortError when switching streams rapidly
  // TV: WebView/Tizen thường chặn autoplay có tiếng -> retry muted 1 lần
  const safePlay = (mediaEl: HTMLVideoElement | null, retryMuted = true) => {
    if (!mediaEl) return;
    try {
      mediaEl.volume = isMuted ? 0 : volume;
      mediaEl.muted = isMuted;
      const promise = mediaEl.play();
      if (promise !== undefined) {
        promise
          .then(() => {
            setIsPlaying(true);
          })
          .catch((err: any) => {
            if (err?.name === 'AbortError' || String(err?.message || '').includes('interrupted')) {
              // Benign: switching streams interrupted previous play request
              return;
            }
            if (err?.name === 'NotAllowedError') {
              // Autoplay restricted — TV: thử muted autoplay để remote OK là chạy
              if (retryMuted && mediaEl && !mediaEl.muted) {
                try {
                  mediaEl.muted = true;
                  mediaEl.play().then(() => {
                    setIsPlaying(true);
                    setIsMuted(true);
                  }).catch(() => setIsPlaying(false));
                  return;
                } catch {}
              }
              setIsPlaying(false);
              return;
            }
            void 0;
            setIsPlaying(false);
          });
      }
    } catch (e) {}
  };

  // Handle stream playback (Auto choose Shaka for MPD / ClearKey DRM, HLS.js for M3U8)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeChannel) return;

    setIsLoadingStream(true);
    setStreamError(null);

    // Cleanup previous players
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (e) {}
      hlsRef.current = null;
    }
    if (shakaPlayerRef.current) {
      try {
        shakaPlayerRef.current.destroy();
      } catch (e) {}
      shakaPlayerRef.current = null;
    }
    try {
      video.pause();
    } catch (e) {}

    const streamUrl = activeChannel.url;
    const isMpd =
      streamUrl.includes('.mpd') ||
      streamUrl.includes('manifest') ||
      !!activeChannel.drmKey ||
      activeChannel.licenseType === 'org.w3.clearkey';

    const isTsStream =
      streamUrl.includes('extension=ts') ||
      streamUrl.endsWith('.ts') ||
      streamUrl.includes('/live.php?');

    if (isMpd) {
      // ===== 1. NATIVE EXOPLAYER FOR ANDROID APK OR SHAKA PLAYER FOR WEB =====
      if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
        void 0;
        setIsLoadingStream(false);
        playInNativeExoPlayer({
          url: activeChannel.url,
          drmKey: activeChannel.drmKey,
          title: `${activeChannel.name} (${activeChannel.group})`,
          userAgent: activeChannel.userAgent || 'Dalvik/2.1.0'
        });
      }

      try {
        if (!shaka.Player.isBrowserSupported()) {
          // TV cũ / WebView không có MSE/EME: kênh không DRM thì thử native <video>,
          // kênh DRM mới báo lỗi (TV không giải mã được ClearKey).
          if (!activeChannel.drmKey) {
            try {
              video.src = streamUrl;
              video.load();
              setIsLoadingStream(false);
              safePlay(video);
              return;
            } catch {}
          }
          setStreamError('Trình duyệt TV hiện tại không hỗ trợ Shaka Player / EME DRM. Hãy thử kênh HLS (.m3u8) hoặc đổi nguồn phát.');
          setIsLoadingStream(false);
          return;
        }

        const player = new shaka.Player();
        player.attach(video);
        shakaPlayerRef.current = player;

        // DRM ClearKey configuration (Static KID:KEY map or Dynamic AutoKey license server)
        const isNative = Capacitor.isNativePlatform();
        const drmConfig: any = {};
        const isServerUrl = isLicenseServerUrl(activeChannel.drmKey);

        if (isServerUrl) {
          const licenseEndpoint = isNative
            ? activeChannel.drmKey!
            : getFullApiUrl(
                `/api/tv/clearkey-license?url=${encodeURIComponent(activeChannel.drmKey!)}`
              );
          drmConfig.servers = {
            'org.w3.clearkey': licenseEndpoint,
          };
        } else if (activeChannel.drmKey) {
          const clearKeysHexMap = parseClearkeyToHexMap(activeChannel.drmKey);
          if (Object.keys(clearKeysHexMap).length > 0) {
            drmConfig.clearKeys = clearKeysHexMap;
          }
        }

        player.configure({
          drm: drmConfig,
          streaming: {
            lowLatencyMode: true,
            bufferingGoal: 10,
            rebufferingGoal: 2,
            retryParameters: {
              maxAttempts: 3,
              baseDelay: 1000,
              backoffFactor: 2,
              fuzzFactor: 0.5,
              timeout: 10000,
            },
          },
          manifest: {
            dash: {
              ignoreMinBufferTime: true,
              autoCorrectDrift: true,
            },
          },
        });

        // Register Shaka RequestFilter & ResponseFilter for custom User-Agent (Dalvik/2.1.0) & CORS Proxy
        const targetUA = activeChannel.userAgent || 'Dalvik/2.1.0 (Linux; U; Android 10; Build/QP1A.190711.020)';
        const networkingEngine = player.getNetworkingEngine();
        if (networkingEngine) {
          networkingEngine.clearAllRequestFilters();
          networkingEngine.clearAllResponseFilters();

          networkingEngine.registerRequestFilter((type, request) => {
            const originalUri = request.uris[0];
            if (!originalUri) return;

            // Handle DRM license requests directly
            if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
              request.headers['Content-Type'] = 'application/json';
              return;
            }

            // In native mode, try direct first, but ensure User-Agent header is set
            if (isNative) {
              request.headers['User-Agent'] = targetUA;
              return;
            }

            // Prevent double proxying
            if (originalUri.includes('/api/tv/stream-proxy') || originalUri.includes('/api/tv/clearkey-license')) return;

            // Resolve relative URLs against the stream's original base URL
            let absoluteUrl = originalUri;
            if (!originalUri.startsWith('http://') && !originalUri.startsWith('https://')) {
              try {
                absoluteUrl = new URL(originalUri, streamUrl).href;
              } catch (e) {
                absoluteUrl = originalUri;
              }
            }

            const proxyUri = getFullApiUrl(
              `/api/tv/stream-proxy?url=${encodeURIComponent(absoluteUrl)}&ua=${encodeURIComponent(
                targetUA
              )}`
            );
            request.uris = [proxyUri];
          });

          // Reset response.uri to original target URL so DASH manifests resolve relative segments correctly,
          // and sanitize ClearKey JWK responses to valid Base64URL
          networkingEngine.registerResponseFilter((type, response) => {
            if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
              try {
                const text = shaka.util.StringUtils.fromUTF8(response.data);
                if (text && text.includes('"keys"')) {
                  const json = JSON.parse(text);
                  if (json && Array.isArray(json.keys)) {
                    for (const item of json.keys) {
                      if (item.kid) {
                        item.kid = item.kid.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                      }
                      if (item.k) {
                        item.k = item.k.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
                      }
                    }
                    const sanitized = JSON.stringify(json);
                    response.data = shaka.util.StringUtils.toUTF8(sanitized);
                  }
                }
              } catch (e) {
                void 0;
              }
              return;
            }
            if (response.uri && response.uri.includes('/api/tv/stream-proxy')) {
              try {
                const u = new URL(response.uri, window.location.href);
                const originalUrl = u.searchParams.get('url');
                if (originalUrl) {
                  response.uri = originalUrl;
                }
              } catch (e) {}
            }
          });
        }

        // Shaka Player error listeners
        player.addEventListener('error', (event: any) => {
          const err = event.detail;
          void 0;
          let errText = 'Lỗi phát luồng MPD.';
          if (err?.code === 1001) {
            const httpStatus = err.data && err.data[1] ? ` (Mã HTTP ${err.data[1]})` : '';
            errText = `Lỗi kết nối${httpStatus}: Kênh trực tiếp không phản hồi hoặc link bị chặn/hết hạn.`;
          } else if (err?.code === 1002) {
            errText = 'Phản hồi từ máy chủ phát không đúng định dạng.';
          } else if (err?.code === 1003) {
            errText = 'Kết nối tới luồng phát quá thời gian chờ (Timeout).';
          } else if (err?.category === 6) {
            errText = 'Lỗi giải mã DRM ClearKey (Kiểm tra lại KID:KEY hoặc khóa bản quyền đã hết hạn).';
          } else if (err?.category === 1) {
            errText = 'Lỗi mạng luồng phát MPD (Kênh ngoại tuyến hoặc cần đổi nguồn).';
          } else {
            errText = `Lỗi phát luồng MPD: ${err?.message || 'Code ' + err?.code}`;
          }
          setStreamError(errText);
          setIsLoadingStream(false);
          setIsPlaying(false);
        });

        player
          .load(streamUrl)
          .then(() => {
            setIsLoadingStream(false);
            safePlay(video);
          })
          .catch((loadErr) => {
            void 0;
            let loadMsg = 'Không thể tải luồng MPD';
            if (loadErr?.code === 1001) {
              const httpStatus = loadErr.data && loadErr.data[1] ? ` (Mã HTTP ${loadErr.data[1]})` : '';
              loadMsg = `Không thể kết nối luồng MPD${httpStatus}: Kênh tạm thời ngoại tuyến hoặc sự kiện phát sóng đã kết thúc.`;
            } else if (loadErr?.category === 6) {
              loadMsg = 'Lỗi bản quyền DRM ClearKey (Khóa giải mã không chính xác hoặc hết hạn).';
            } else if (loadErr?.message) {
              loadMsg = `Không thể tải luồng MPD: ${loadErr.message}`;
            }
            setStreamError(loadMsg);
            setIsLoadingStream(false);
            setIsPlaying(false);
          });
      } catch (err: any) {
        setStreamError('Lỗi khởi tạo Shaka Player: ' + err.message);
        setIsLoadingStream(false);
      }
    } else if (isTsStream) {
      // ===== 2. TS STREAM / XTREAM CODES (Ngoại Hạng Anh & Sports) =====
      // If Xtream codes stream has extension=ts, also test extension=m3u8 with Hls.js, or fallback to HTML5 video
      const m3u8Candidate = streamUrl.includes('extension=ts')
        ? streamUrl.replace('extension=ts', 'extension=m3u8')
        : streamUrl;

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
        });
        hlsRef.current = hls;

        hls.loadSource(m3u8Candidate);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoadingStream(false);
          safePlay(video);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            void 0;
            try {
              hls.destroy();
            } catch (e) {}
            hlsRef.current = null;

            // Direct HTML5 video tag fallback for TS streaming (supported on Android WebView)
            video.src = streamUrl;
            video.load();
            safePlay(video);
            setIsLoadingStream(false);
          }
        });
      } else {
        video.src = streamUrl;
        setIsLoadingStream(false);
        safePlay(video);
      }
    } else if (streamUrl.includes('.m3u8') || Hls.isSupported()) {
      // ===== 3. HLS.JS FOR M3U8 STREAMS (TV: native HLS ưu tiên) =====
      // TV Tizen/WebOS/Safari phát HLS native tốt hơn hls.js (không có MSE).
      const canNativeHls =
        video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
        video.canPlayType('application/x-mpegURL') !== '';
      const tvMode = (() => { try { return isTvModeActive(); } catch { return false; } })();
      if (tvMode && canNativeHls && streamUrl.includes('.m3u8')) {
        const onMeta = () => {
          setIsLoadingStream(false);
          safePlay(video);
        };
        video.addEventListener('loadedmetadata', onMeta, { once: true });
        video.src = streamUrl;
        try { video.load(); } catch {}
        // Lưới an toàn: 8s chưa chạy thì báo lỗi để user đổi kênh
        window.setTimeout(() => {
          try {
            if (video.paused && !video.currentTime) {
              // vẫn chờ, không ép lỗi — một số TV load chậm
            }
          } catch {}
        }, 8000);
      } else if (Hls.isSupported()) {
        let isProxyAttempt = false;
        const initialPlayUrl = streamUrl;

        // TV box yếu: buffer gọn để đỡ RAM + decode
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          ...(tvMode
            ? { maxBufferLength: 15, maxMaxBufferLength: 30, maxBufferSize: 20 * 1000 * 1000 }
            : {}),
        });
        hlsRef.current = hls;

        hls.loadSource(initialPlayUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoadingStream(false);
          safePlay(video);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            void 0;
            if (!isProxyAttempt) {
              isProxyAttempt = true;
              const targetUA = activeChannel.userAgent || 'Dalvik/2.1.0';
              const proxyUrl = getFullApiUrl(
                `/api/tv/stream-proxy?url=${encodeURIComponent(streamUrl)}&ua=${encodeURIComponent(
                  targetUA
                )}`
              );
              try {
                hls.loadSource(proxyUrl);
              } catch {
                video.src = streamUrl;
                safePlay(video);
                setIsLoadingStream(false);
              }
            } else {
              // Final fallback to native video tag (TV phát được nhiều luồng thô)
              try { hls.destroy(); } catch {}
              hlsRef.current = null;
              video.src = streamUrl;
              try { video.load(); } catch {}
              safePlay(video);
              setIsLoadingStream(false);
            }
          }
        });
      } else if (canNativeHls) {
        video.src = streamUrl;
        video.addEventListener('loadedmetadata', () => {
          setIsLoadingStream(false);
          safePlay(video);
        }, { once: true });
        try { video.load(); } catch {}
      } else {
        // TV không MSE lẫn native HLS: thử native video tag trực tiếp
        video.src = streamUrl;
        try { video.load(); } catch {}
        video.addEventListener('loadedmetadata', () => {
          setIsLoadingStream(false);
          safePlay(video);
        }, { once: true });
        // Lưới an toàn kẻo kẹt loading vô hạn trên TV
        window.setTimeout(() => setIsLoadingStream(false), 10000);
      }
    } else {
      video.src = streamUrl;
      setIsLoadingStream(false);
      safePlay(video);
    }

    if (activeChannel) {
      presenceService.startSession({
        accountId: currentAccount?.id || currentAccount?.username || 'user',
        accountDisplayName: currentAccount?.displayName || 'Khách LiveTV',
        profileId: 'tv_profile',
        profileName: currentAccount?.displayName || 'Người xem TV',
        type: 'livetv',
        contentId: activeChannel.url,
        itemTitle: activeChannel.name,
        itemSubtitle: activeChannel.group || 'Kênh LiveTV',
        itemCover: activeChannel.logo,
        apiSourceUsed: 'livetv',
      });
    }

    return () => {
      presenceService.stopSession();
      if (video) {
        try {
          video.pause();
        } catch (e) {}
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (e) {}
        hlsRef.current = null;
      }
      if (shakaPlayerRef.current) {
        try {
          shakaPlayerRef.current.destroy();
        } catch (e) {}
        shakaPlayerRef.current = null;
      }
    };
  }, [activeChannel, currentAccount, tvPlayerOpen]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      safePlay(video);
    }
  };

  const handleVolumeChange = (val: number) => {
    setVolume(val);
    const video = videoRef.current;
    if (video) {
      video.volume = val;
      setIsMuted(val === 0);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    video.muted = nextMuted;
  };

  const toggleFullscreen = () => {
    const videoContainer = document.getElementById('live-tv-player-container');
    const isNativeFs = !!(
      document.fullscreenElement || (document as any).webkitFullscreenElement
    );

    if (!isNativeFs && !isFullscreen) {
      setIsFullscreen(true);
      window.history.pushState({ liveTvFs: true, tab: 'tv-live' }, '', '');
      if (videoContainer) {
        if (videoContainer.requestFullscreen) {
          videoContainer
            .requestFullscreen()
            .then(() => {
              if (screen.orientation && (screen.orientation as any).lock) {
                (screen.orientation as any).lock('landscape').catch(() => {});
              }
            })
            .catch(() => {});
        } else if ((videoContainer as any).webkitRequestFullscreen) {
          (videoContainer as any).webkitRequestFullscreen();
        } else if ((videoContainer as any).msRequestFullscreen) {
          (videoContainer as any).msRequestFullscreen();
        } else if (videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
          (videoRef.current as any).webkitEnterFullscreen();
        }
      }
    } else {
      if (isNativeFs) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
        }
      } else {
        setIsFullscreen(false);
        if (window.history.state && window.history.state.liveTvFs) {
          window.history.back();
        }
      }
      if (screen.orientation && (screen.orientation as any).unlock) {
        try {
          (screen.orientation as any).unlock();
        } catch (e) {}
      }
    }
  };

  const togglePip = async () => {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const res = await enterNativePip();
      if (res) return;
    }
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (typeof video.requestPictureInPicture === 'function') {
        // Direct call without checking document.pictureInPictureEnabled (falsy in PWA context)
        await video.requestPictureInPicture();
      } else if ((video as any).webkitSupportsPresentationMode && typeof (video as any).webkitSetPresentationMode === 'function') {
        const currentMode = (video as any).webkitPresentationMode;
        (video as any).webkitSetPresentationMode(currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      }
    } catch (e) {
      void 0;
      if (video && (video as any).webkitSetPresentationMode && typeof (video as any).webkitSetPresentationMode === 'function') {
        try {
          const currentMode = (video as any).webkitPresentationMode;
          (video as any).webkitSetPresentationMode(currentMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
        } catch (e2) {}
      }
    }
  };

  const handleNextChannel = () => {
    if (!activeChannel || filteredChannels.length === 0) return;
    const currIdx = filteredChannels.findIndex((c) => c.url === activeChannel.url);
    const nextIdx = (currIdx + 1) % filteredChannels.length;
    setActiveChannel(filteredChannels[nextIdx]);
  };

  const handlePrevChannel = () => {
    if (!activeChannel || filteredChannels.length === 0) return;
    const currIdx = filteredChannels.findIndex((c) => c.url === activeChannel.url);
    const prevIdx = (currIdx - 1 + filteredChannels.length) % filteredChannels.length;
    setActiveChannel(filteredChannels[prevIdx]);
  };

  const selectChannelAndPlay = (ch: Channel) => {
    setActiveChannel(ch);
    setMobileTab('player');
    try {
      if (isTvModeActive()) {
        // TV gọn: mở player toàn màn hình, playback effect tự chạy khi video mount
        setTvPlayerOpen(true);
        return;
      }
    } catch {}
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // TV gọn: đóng player toàn màn hình, trả focus về đúng thẻ kênh vừa xem
  const closeTvPlayer = () => {
    const url = activeChannel?.url;
    // Thoát fullscreen thật nếu đang giữ (TV nào hỗ trợ)
    try {
      if (document.fullscreenElement) {
        const p = document.exitFullscreen() as any;
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else if ((document as any).webkitFullscreenElement && (document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      }
    } catch {}
    setTvPlayerOpen(false);
    window.setTimeout(() => {
      try {
        let card: HTMLElement | null = null;
        if (url) {
          try {
            const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(url)
              : url.replace(/"/g, '');
            card = document.querySelector<HTMLElement>(`[data-tv-livetv-url="${esc}"]`);
          } catch {}
        }
        const target = card || document.querySelector<HTMLElement>('[data-tv-livetv-channel]');
        if (target) {
          try { markProgrammaticFocus(); } catch {}
          try { target.focus({ preventScroll: true } as FocusOptions); }
          catch { target.focus(); }
        }
      } catch {}
    }, 120);
  };

  // TV remote: giữ ref mới nhất cho media keys (tránh stale closure)
  tvTogglePlayRef.current = togglePlay;
  tvNextRef.current = handleNextChannel;
  tvPrevRef.current = handlePrevChannel;

  // TV: phím media remote (Play/Pause/Next/Prev) + autofocus khi vào trang
  useEffect(() => {
    const onMedia = (e: Event) => {
      try {
        if (!isTvModeActive()) return;
      } catch { return; }
      const action = (e as CustomEvent<string>).detail;
      if (action === 'toggle') tvTogglePlayRef.current?.();
      else if (action === 'next') tvNextRef.current?.();
      else if (action === 'prev') tvPrevRef.current?.();
    };
    window.addEventListener(TV_MEDIA_EVENT as any, onMedia as any);
    return () => window.removeEventListener(TV_MEDIA_EVENT as any, onMedia as any);
  }, []);

  // TV: vào trang là focus ngay kênh đầu để remote dùng được liền;
  // mở player thì bỏ focus + xin fullscreen thật; đóng player thì closeTvPlayer lo focus.
  useEffect(() => {
    if (!isTv) return;
    if (tvPlayerOpen) {
      const t = window.setTimeout(() => {
        try {
          if (!isTvModeActive()) return;
          // Player không còn nút nào: bỏ focus để D-pad không bấm nhầm nền
          try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch {}
          // Xin fullscreen thật của TV (Tizen/WebOS/Android TV): fail thì thôi,
          // overlay fixed inset-0 vốn đã phủ kín màn hình
          const box = tvPlayerBoxRef.current;
          if (box) {
            try {
              if (box.requestFullscreen) {
                const p = box.requestFullscreen() as any;
                if (p && typeof p.catch === 'function') p.catch(() => {});
              } else if ((box as any).webkitRequestFullscreen) {
                (box as any).webkitRequestFullscreen();
              } else if (videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
                (videoRef.current as any).webkitEnterFullscreen();
              }
            } catch {}
          }
        } catch {}
      }, 350);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      try {
        if (!isTvModeActive()) return;
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body) return; // đã có focus, không giật
        const target = document.querySelector<HTMLElement>('[data-tv-livetv-channel]');
        if (target) {
          try { markProgrammaticFocus(); } catch {}
          try { target.focus({ preventScroll: true } as FocusOptions); }
          catch { target.focus(); }
        }
      } catch {}
    }, 500);
    return () => window.clearTimeout(t);
  }, [isTv, tvPlayerOpen, activeChannel]);

  // TV gọn: bấm Back (remote) khi đang xem toàn màn hình -> về trang chủ.
  // App bỏ qua gau_tv_back ở livetv mode nên đây là handler duy nhất.
  useEffect(() => {
    if (!isTv) return;
    const onTvBack = () => {
      try {
        if (isTvModeActive() && tvPlayerOpen) closeTvPlayer();
      } catch {}
    };
    const onKey = (e: KeyboardEvent) => {
      try {
        if (!isTvModeActive() || !tvPlayerOpen) return;
        const k = e.key;
        const kc = (e as any).keyCode;
        if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack' || kc === 10009 || kc === 461) {
          e.preventDefault();
          e.stopPropagation();
          closeTvPlayer();
        }
      } catch {}
    };
    window.addEventListener('gau_tv_back', onTvBack);
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('gau_tv_back', onTvBack);
      window.removeEventListener('keydown', onKey, { capture: true } as any);
    };
  });

  // TV gọn: khóa scroll nền khi player toàn màn hình mở
  useEffect(() => {
    if (!isTv || !tvPlayerOpen) return;
    let prev = '';
    try {
      prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } catch {}
    return () => {
      try { document.body.style.overflow = prev; } catch {}
    };
  }, [isTv, tvPlayerOpen]);

  // TV gọn: kênh lỗi thì focus nút Thử lại để remote OK được ngay
  useEffect(() => {
    if (!isTv || !tvPlayerOpen || !streamError) return;
    const t = window.setTimeout(() => {
      try {
        if (!isTvModeActive()) return;
        const btn = document.querySelector<HTMLElement>('[data-tv-livetv-retry]');
        if (btn) {
          try { markProgrammaticFocus(); } catch {}
          try { btn.focus({ preventScroll: true } as FocusOptions); }
          catch { btn.focus(); }
        }
      } catch {}
    }, 300);
    return () => window.clearTimeout(t);
  }, [isTv, tvPlayerOpen, streamError]);

  // MediaSession API setup for Live TV
  useEffect(() => {
    if ('mediaSession' in navigator && activeChannel) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: activeChannel.name,
        artist: `Gấu TV • ${activeChannel.group}`,
        album: currentSourceObj.name || 'Live TV',
        artwork: [
          {
            src: activeChannel.logo || '/app_logo.jpg',
            sizes: '512x512',
            type: 'image/jpeg',
          },
        ],
      });

      try {
        navigator.mediaSession.setActionHandler('play', () => {
          videoRef.current?.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          videoRef.current?.pause();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
          handlePrevChannel();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          handleNextChannel();
        });
        (navigator.mediaSession.setActionHandler as any)('enterpictureinpicture', () => {
          togglePip();
        });
      } catch (e) {
        void 0;
      }
    }
  }, [activeChannel, currentSourceObj]);

  // ================= TV GỌN =================
  // Trang chủ: list category ngang + kênh của category đó.
  // Bấm kênh -> video fullscreen toàn màn hình, Back -> về trang chủ.
  // Player không có nút nào cả.
  if (isTv) {
    return (
      <div className="min-h-screen bg-[#070c18] text-slate-100 pt-16 sm:pt-20 pb-10 px-4 sm:px-6 font-sans">
        {/* Header gọn */}
        <div className="flex items-center gap-3 py-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 p-2 flex items-center justify-center text-white shrink-0">
            <Radio className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-black text-white tracking-tight">Gấu LiveTV</h1>
          <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
            LIVE
          </span>
          <span className="text-xs text-slate-400 font-medium">{filteredChannels.length} kênh</span>
        </div>

        {/* List category ngang */}
        <div
          className="flex items-center gap-2 overflow-x-auto pb-3 scrollbar-none"
          data-tv-row
          data-tv-row-id="livetv-tv-groups"
        >
          {groups.map((grp) => {
            const isSelected = selectedGroup === grp;
            return (
              <button
                key={grp}
                onClick={() => setSelectedGroup(grp)}
                className={`text-sm px-4 py-2 rounded-xl font-bold transition-all shrink-0 cursor-pointer ${
                  isSelected
                    ? 'bg-orange-600 text-white shadow-md'
                    : 'bg-slate-900 text-slate-300 border border-slate-800'
                }`}
              >
                {grp}
                {grp === '⭐ Yêu thích' && favorites.length > 0 && (
                  <span className="ml-1.5 text-[11px] bg-black/30 px-1.5 rounded-full">
                    {favorites.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Kênh của category */}
        {loading && channels.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm flex flex-col items-center gap-2">
            <RefreshCw className="w-6 h-6 text-orange-500 animate-spin" />
            <span>Đang tải danh sách kênh...</span>
          </div>
        ) : filteredChannels.length > 0 ? (
          <div data-tv-row data-tv-row-id="livetv-tv-channels">
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
              {filteredChannels.map((ch, idx) => {
                const isActive = activeChannel?.url === ch.url;
                return (
                  <div
                    key={ch.url || idx}
                    role="button"
                    tabIndex={0}
                    data-tv-card={`livetv-tv-${idx}`}
                    data-tv-livetv-channel
                    data-tv-livetv-url={ch.url}
                    aria-label={`Phát kênh ${ch.name}`}
                    onClick={() => selectChannelAndPlay(ch)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                        e.preventDefault();
                        selectChannelAndPlay(ch);
                      }
                    }}
                    className={`relative p-3 rounded-2xl border flex flex-col items-center justify-center text-center cursor-pointer focus:outline-none ${
                      isActive
                        ? 'bg-orange-950/60 border-orange-500'
                        : 'bg-slate-900/80 border-slate-800'
                    }`}
                  >
                    <img
                      src={ch.logo}
                      alt={ch.name}
                      className="w-14 h-14 rounded-xl object-contain bg-slate-950 p-1 border border-slate-800 my-1"
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=100&auto=format&fit=crop&q=60';
                      }}
                    />
                    <h4
                      className={`text-xs font-bold truncate w-full mt-1 ${
                        isActive ? 'text-amber-300' : 'text-slate-100'
                      }`}
                    >
                      {ch.name}
                    </h4>
                    <p className="text-[10px] text-slate-400 truncate w-full">{ch.group}</p>
                    {isActive && (
                      <span className="mt-1 bg-orange-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Play className="w-2.5 h-2.5 fill-white" /> Đang phát
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="py-12 text-center text-slate-400 text-sm bg-slate-900/40 rounded-2xl border border-slate-800">
            <p className="font-semibold text-slate-300">Không có kênh trong mục này</p>
            <p className="text-xs text-slate-500 mt-1">Chọn danh mục khác bằng remote</p>
          </div>
        )}

        {/* Player toàn màn hình: chỉ video, không nút nào.
            Back remote -> về trang chủ; remote có phím media thì Next/Prev chuyển kênh. */}
        {tvPlayerOpen && activeChannel && (
          <div ref={tvPlayerBoxRef} className="fixed inset-0 z-[70] bg-black">
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-contain bg-black"
              playsInline
              autoPlay
              preload="auto"
              tabIndex={-1}
              data-tv-skip
            />

            {/* Đang tải */}
            {isLoadingStream && (
              <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3 p-4 text-center pointer-events-none">
                <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-amber-300 font-bold">
                  Đang kết nối {activeChannel.name}...
                </p>
              </div>
            )}

            {/* Lỗi: chỉ nút thử lại, Back để về trang chủ */}
            {streamError && !isLoadingStream && (
              <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-base font-bold text-white">Kênh không kết nối được</p>
                <p className="text-xs text-slate-400 max-w-md">{streamError}</p>
                <button
                  data-tv-livetv-retry
                  onClick={() => {
                    const ch = activeChannel;
                    setActiveChannel(null);
                    window.setTimeout(() => setActiveChannel(ch), 80);
                  }}
                  className="mt-2 bg-orange-600 text-white px-6 py-3 rounded-2xl text-sm font-bold cursor-pointer"
                >
                  Thử lại
                </button>
                <p className="text-[11px] text-slate-500">Bấm Back trên remote để về danh sách kênh</p>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#070c18] text-slate-100 pt-16 sm:pt-20 pb-20 px-3 sm:px-6 lg:px-8 max-w-7xl mx-auto space-y-4 sm:space-y-6 font-sans">
      {/* Top Header & Compact Controls Bar */}
      <div className="bg-gradient-to-r from-orange-950/80 via-[#0d162d] to-[#0a1020] rounded-2xl p-3.5 sm:p-5 border border-orange-900/40 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-600 p-2 flex items-center justify-center text-white shadow-lg shadow-orange-500/20 shrink-0">
            <Radio className="w-5 h-5 sm:w-6 sm:h-6 animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base sm:text-xl font-black text-white tracking-tight">
                Gấu LiveTV
              </h1>
              <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
                LIVE
              </span>
              <span className="bg-orange-500/15 text-amber-300 border border-orange-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full">
                {channels.length} Kênh HD
              </span>
            </div>
            <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5 truncate">
              Truyền hình, thể thao & bóng đá chất lượng cao không quảng cáo
            </p>
          </div>
        </div>

        {/* Source Selector & Tool Trigger Buttons */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            onClick={() => setShowDrmTesterModal(true)}
            title="Thử nghiệm kênh DRM ClearKey (KID:KEY)"
            className="bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 hover:border-amber-400 px-3 py-2 sm:px-3.5 sm:py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-md flex items-center gap-1.5"
          >
            <Key className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden sm:inline">Thử DRM ClearKey</span>
          </button>

          <button
            onClick={() => setShowCloudflareModal(true)}
            title="Hướng dẫn cấu hình Cloudflare Worker Proxy Dalvik User-Agent"
            className="bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-500/40 hover:border-sky-400 px-3 py-2 sm:px-3.5 sm:py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-md flex items-center gap-1.5"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden sm:inline">Cloudflare Worker</span>
          </button>

          <button
            onClick={() => setShowSourceModal(true)}
            className="bg-slate-900/90 hover:bg-slate-800 text-slate-200 border border-slate-700/80 hover:border-orange-500/60 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg flex items-center justify-between gap-2.5 group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Server className="w-3.5 h-3.5 text-orange-400 shrink-0" />
              <div className="text-left truncate">
                <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">
                  Nguồn phát
                </div>
                <div className="text-xs font-bold text-amber-300 truncate">
                  {currentSourceObj.shortName}
                </div>
              </div>
            </div>
            <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-white transition-transform" />
          </button>

          <button
            onClick={() => fetchChannels()}
            title="Tải lại danh sách kênh"
            className="bg-slate-900/90 hover:bg-slate-800 text-slate-200 hover:text-white p-2.5 sm:px-3 sm:py-2.5 rounded-xl border border-slate-700/80 text-xs font-bold transition-all cursor-pointer shadow-lg flex items-center justify-center gap-1.5 shrink-0"
          >
            <RefreshCw className={`w-4 h-4 text-amber-400 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden md:inline">Làm mới</span>
          </button>
        </div>
      </div>

      {/* Mobile Tab Bar (Visible only on screens below lg) */}
      <div className="lg:hidden flex bg-[#0d162d] p-1 rounded-xl border border-slate-800/80 shadow-lg">
        <button
          onClick={() => setMobileTab('player')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            mobileTab === 'player'
              ? 'bg-orange-600 text-white shadow-md shadow-orange-600/30'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Tv className="w-4 h-4" />
          <span>📺 Trực Tiếp</span>
        </button>
        <button
          onClick={() => setMobileTab('channels')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            mobileTab === 'channels'
              ? 'bg-orange-600 text-white shadow-md shadow-orange-600/30'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Search className="w-4 h-4" />
          <span>📋 Danh Sách ({filteredChannels.length})</span>
        </button>
      </div>

      {/* Main Grid Layout: Video Player + Channel Directory */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Left Column: Player & Active Channel Card */}
        <div
          className={`lg:col-span-2 space-y-4 ${
            mobileTab === 'player' ? 'block' : 'hidden lg:block'
          }`}
        >
          {/* Video Player Box */}
          <div
            id="live-tv-player-container"
            onClick={() => setShowControls((prev) => !prev)}
            className={`relative bg-black transition-all duration-300 flex flex-col items-center justify-center cursor-pointer ${
              isFullscreen
                ? 'fixed inset-0 z-50 w-screen h-screen rounded-none'
                : 'aspect-video rounded-2xl overflow-hidden border border-slate-800 shadow-2xl group'
            }`}
          >
            {activeChannel ? (
              <>
                <video
                  ref={videoRef}
                  className="w-full h-full object-contain bg-black"
                  playsInline
                  autoPlay
                  preload="auto"
                  tabIndex={-1}
                  data-tv-skip
                  {...({ autopictureinpicture: 'true' } as any)}
                />

                {/* Stream Loading Overlay */}
                {isLoadingStream && (
                  <div className="absolute inset-0 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center gap-3 z-20 p-4 text-center">
                    <div className="w-10 h-10 border-4 border-orange-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-xs text-amber-300 font-bold">
                      Đang kết nối luồng {activeChannel.name}...
                    </p>
                    <p className="text-[10px] text-slate-400">Vui lòng chờ trong giây lát</p>
                  </div>
                )}

                {/* Stream Error Overlay */}
                {streamError && (
                  <div
                    className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center gap-3 z-20 p-5 text-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="w-12 h-12 rounded-2xl bg-rose-600/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
                      <Signal className="w-6 h-6" />
                    </div>
                    <p className="text-sm font-bold text-white">Kênh đang không thể kết nối</p>
                    <p className="text-xs text-slate-400 max-w-md">{streamError}</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap justify-center">
                      {Capacitor.isNativePlatform() && (
                        <>
                          <button
                            onClick={() => {
                              if (activeChannel) {
                                playInNativeExoPlayer({
                                  url: activeChannel.url,
                                  drmKey: activeChannel.drmKey,
                                  title: `${activeChannel.name} (${activeChannel.group})`,
                                  userAgent: activeChannel.userAgent || 'Dalvik/2.1.0'
                                });
                              }
                            }}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-400/40 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg flex items-center gap-1.5"
                          >
                            <Play className="w-3.5 h-3.5 fill-white" />
                            <span>Mở ExoPlayer Native</span>
                          </button>
                          <button
                            onClick={() => {
                              if (activeChannel) {
                                playInExternalPlayer({
                                  url: activeChannel.url
                                });
                              }
                            }}
                            className="bg-purple-600 hover:bg-purple-500 text-white border border-purple-400/40 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg flex items-center gap-1.5"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>Mở bằng VLC / MX Player</span>
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => {
                          const ch = activeChannel;
                          setActiveChannel(null);
                          setTimeout(() => setActiveChannel(ch), 50);
                        }}
                        className="bg-orange-600 hover:bg-orange-500 text-white px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-lg"
                      >
                        Thử lại
                      </button>
                      <button
                        onClick={() => setShowSourceModal(true)}
                        className="bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        Đổi nguồn phát
                      </button>
                      <button
                        onClick={handleNextChannel}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-3.5 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer"
                      >
                        Kênh tiếp theo
                      </button>
                    </div>
                  </div>
                )}

                {/* Top Video Title Overlay */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={`absolute top-0 inset-x-0 p-3 sm:p-4 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-10 pointer-events-auto ${
                    showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <img
                      src={activeChannel.logo}
                      alt={activeChannel.name}
                      className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl object-contain bg-white/10 p-1 border border-white/20 shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=100&auto=format&fit=crop&q=60';
                      }}
                    />
                    <div className="min-w-0">
                      <h2 className="text-xs sm:text-sm font-bold text-white truncate drop-shadow">
                        {activeChannel.name}
                      </h2>
                      <p className="text-[10px] text-amber-300 font-medium truncate">
                        {activeChannel.group}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => toggleFavorite(activeChannel.url, e)}
                    className="p-2 rounded-xl bg-black/40 hover:bg-black/60 text-amber-400 transition-all cursor-pointer border border-white/10 shrink-0"
                    title={
                      favorites.includes(activeChannel.url)
                        ? 'Xóa khỏi yêu thích'
                        : 'Thêm vào yêu thích'
                    }
                  >
                    <Star
                      className={`w-4 h-4 ${
                        favorites.includes(activeChannel.url) ? 'fill-amber-400' : ''
                      }`}
                    />
                  </button>
                </div>

                {/* Bottom Player Overlay Controls Bar */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  className={`absolute bottom-0 inset-x-0 p-3 sm:p-4 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex items-center justify-between transition-opacity duration-300 z-10 pointer-events-auto ${
                    showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePrevChannel}
                      className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all cursor-pointer"
                      title="Kênh trước"
                    >
                      <SkipBack className="w-4 h-4" />
                    </button>

                    <button
                      onClick={togglePlay}
                      data-tv-livetv-play
                      className="w-9 h-9 rounded-xl bg-orange-600 hover:bg-orange-500 flex items-center justify-center text-white shadow-lg transition-all cursor-pointer"
                      title={isPlaying ? 'Tạm dừng' : 'Phát'}
                    >
                      {isPlaying ? (
                        <Pause className="w-4 h-4 fill-white" />
                      ) : (
                        <Play className="w-4 h-4 fill-white" />
                      )}
                    </button>

                    <button
                      onClick={handleNextChannel}
                      className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-all cursor-pointer"
                      title="Kênh tiếp"
                    >
                      <SkipForward className="w-4 h-4" />
                    </button>

                    <div
                      className="hidden sm:flex items-center gap-2 ml-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={toggleMute}
                        className="text-slate-200 hover:text-white cursor-pointer"
                        title="Bật/Tắt tiếng"
                      >
                        {isMuted || volume === 0 ? (
                          <VolumeX className="w-5 h-5 text-rose-400" />
                        ) : (
                          <Volume2 className="w-5 h-5 text-amber-400" />
                        )}
                      </button>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={isMuted ? 0 : volume}
                        onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                        className="w-16 sm:w-20 accent-orange-500 cursor-pointer h-1.5 bg-slate-700 rounded-lg"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {Capacitor.isNativePlatform() && (
                      <button
                        onClick={() => {
                          if (activeChannel) {
                            playInNativeExoPlayer({
                              url: activeChannel.url,
                              drmKey: activeChannel.drmKey,
                              title: `${activeChannel.name} (${activeChannel.group})`,
                              userAgent: activeChannel.userAgent || 'Dalvik/2.1.0'
                            });
                          }
                        }}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 rounded-xl transition-all cursor-pointer shadow-lg flex items-center gap-1.5 text-xs font-bold border border-emerald-400/30 shrink-0"
                        title="Mở ExoPlayer Native"
                      >
                        <Play className="w-3.5 h-3.5 fill-white" />
                        <span className="hidden sm:inline">ExoPlayer Native</span>
                      </button>
                    )}

                    <span className="bg-red-600 text-white text-[10px] font-black uppercase px-2 py-0.5 rounded shadow flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                      LIVE
                    </span>

                    {pipSupported && (
                      <button
                        onClick={togglePip}
                        className={`text-slate-200 hover:text-white bg-white/15 hover:bg-white/30 p-2 rounded-xl transition-all cursor-pointer shadow-lg flex items-center gap-1 text-xs font-bold ${
                          isPip ? 'text-orange-400 bg-orange-500/20' : ''
                        }`}
                        title={isPip ? 'Thoát Picture-in-Picture' : 'Hình trong hình / Thu nhỏ (PiP)'}
                        aria-label="Picture-in-Picture"
                      >
                        <PictureInPicture2 className="w-4 h-4" />
                      </button>
                    )}

                    <button
                      onClick={toggleFullscreen}
                      className="text-slate-200 hover:text-white bg-white/15 hover:bg-white/30 p-2 rounded-xl transition-all cursor-pointer shadow-lg flex items-center gap-1 text-xs font-bold"
                      title={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
                    >
                      {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-orange-600/20 border border-orange-500/30 flex items-center justify-center text-amber-400">
                  <Tv className="w-8 h-8" />
                </div>
                <p className="text-sm font-bold text-white">Chọn một kênh để bắt đầu phát sóng</p>
                <p className="text-xs text-slate-400">Danh sách kênh ở phía dưới hoặc bên phải</p>
              </div>
            )}
          </div>

          {/* Active Channel Info & Quick Actions Card */}
          {activeChannel && (
            <div className="p-3.5 sm:p-4 rounded-2xl bg-[#0c1427] border border-slate-800 shadow-xl space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <img
                    src={activeChannel.logo}
                    alt={activeChannel.name}
                    className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl object-contain bg-slate-950 p-1 border border-slate-700 shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src =
                        'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=100&auto=format&fit=crop&q=60';
                    }}
                  />
                  <div className="min-w-0">
                    <h3 className="text-sm sm:text-base font-bold text-white truncate">
                      {activeChannel.name}
                    </h3>
                    <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5 truncate">
                      <Signal className="w-3 h-3 text-emerald-400 animate-pulse shrink-0" />
                      <span className="truncate">{activeChannel.group}</span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={(e) => toggleFavorite(activeChannel.url, e)}
                    className={`p-2.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                      favorites.includes(activeChannel.url)
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                        : 'bg-slate-900 text-slate-300 border-slate-700 hover:text-white'
                    }`}
                  >
                    <Star
                      className={`w-4 h-4 ${
                        favorites.includes(activeChannel.url) ? 'fill-amber-400 text-amber-400' : ''
                      }`}
                    />
                    <span className="hidden sm:inline">
                      {favorites.includes(activeChannel.url) ? 'Đã thích' : 'Yêu thích'}
                    </span>
                  </button>

                  <button
                    onClick={() => setMobileTab('channels')}
                    className="lg:hidden bg-orange-600 text-white font-bold px-3 py-2.5 rounded-xl text-xs transition-all cursor-pointer shadow-md"
                  >
                    Đổi kênh
                  </button>
                </div>
              </div>

              {/* Stream Specs & DRM ClearKey Status Badges */}
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-slate-800/80 text-[10px]">
                {activeChannel.drmKey ? (
                  <span className="bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-md font-mono font-medium flex items-center gap-1">
                    <Key className="w-3 h-3 text-amber-400" />
                    {isLicenseServerUrl(activeChannel.drmKey)
                      ? 'ClearKey AutoKey Server'
                      : `DRM ClearKey: ${activeChannel.drmKey.substring(0, 16)}...`}
                  </span>
                ) : (
                  <span className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-md font-medium flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3 text-emerald-400" />
                    Luồng Chuẩn
                  </span>
                )}

                {activeChannel.url.includes('.mpd') ? (
                  <span className="bg-purple-500/15 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-md font-medium">
                    ⚡ Shaka Player (DASH .mpd)
                  </span>
                ) : (
                  <span className="bg-sky-500/15 text-sky-300 border border-sky-500/30 px-2 py-0.5 rounded-md font-medium">
                    📺 HLS.js (.m3u8)
                  </span>
                )}

                {activeChannel.userAgent && (
                  <span className="bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-md font-mono">
                    📱 UA: {activeChannel.userAgent}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Channel Explorer (List/Grid View) */}
        <div
          className={`space-y-3.5 lg:sticky lg:top-20 ${
            mobileTab === 'channels' ? 'block' : 'hidden lg:block'
          }`}
        >
          <div className="p-3.5 sm:p-4 rounded-2xl bg-[#0c1427] border border-slate-800 shadow-xl space-y-3">
            {/* Header with Search & Layout Toggle */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Tv className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-bold text-white">Danh Sách Kênh</h3>
                <span className="text-[10px] text-slate-400 bg-slate-900 px-2 py-0.5 rounded-md border border-slate-800">
                  {filteredChannels.length}
                </span>
              </div>

              {/* Grid / List Mode Toggle */}
              <div className="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-md text-xs transition-all cursor-pointer ${
                    viewMode === 'grid' ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                  title="Chế độ lưới"
                >
                  <Grid className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-1.5 rounded-md text-xs transition-all cursor-pointer ${
                    viewMode === 'list' ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'
                  }`}
                  title="Chế độ danh sách"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Channel Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Tìm kênh (VTV, K+, Thể Thao...)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl pl-9 pr-8 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 shadow-inner"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Category Groups Horizontal Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-none" data-tv-row data-tv-row-id="livetv-groups">
              {groups.map((grp) => {
                const isFav = grp === '⭐ Yêu thích';
                const isSelected = selectedGroup === grp;
                return (
                  <button
                    key={grp}
                    onClick={() => setSelectedGroup(grp)}
                    className={`text-xs px-3 py-1.5 rounded-xl font-medium transition-all shrink-0 cursor-pointer flex items-center gap-1 ${
                      isSelected
                        ? isFav
                          ? 'bg-amber-500 text-slate-950 font-black shadow-md border border-amber-300'
                          : 'bg-orange-600 text-white font-bold shadow-md border border-orange-400'
                        : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
                    }`}
                  >
                    <span>{grp}</span>
                    {isFav && favorites.length > 0 && (
                      <span className="text-[10px] bg-black/30 px-1.5 py-0.2 rounded-full font-bold">
                        {favorites.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Channel List or Grid Container */}
            {loading ? (
              <div className="py-12 text-center text-slate-400 text-xs animate-pulse flex flex-col items-center justify-center gap-2">
                <RefreshCw className="w-5 h-5 text-orange-500 animate-spin" />
                <span>Đang tải danh sách kênh...</span>
              </div>
            ) : filteredChannels.length > 0 ? (
              <div className="max-h-[460px] lg:max-h-[520px] overflow-y-auto pr-1 space-y-2" data-tv-row data-tv-row-id="livetv-channels">
                {viewMode === 'grid' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 gap-2">
                    {filteredChannels.map((ch, idx) => {
                      const isActive = activeChannel?.url === ch.url;
                      const isFav = favorites.includes(ch.url);

                      return (
                        <div
                          key={idx}
                          role="button"
                          tabIndex={0}
                          data-tv-card={`livetv-${idx}`}
                          data-tv-livetv-channel
                          aria-label={`Phát kênh ${ch.name}`}
                          onClick={() => selectChannelAndPlay(ch)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                              e.preventDefault();
                              selectChannelAndPlay(ch);
                            }
                          }}
                          className={`relative p-2.5 rounded-xl border transition-all text-left flex flex-col items-center justify-center text-center cursor-pointer group focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                            isActive
                              ? 'bg-gradient-to-b from-orange-900/40 to-slate-900 border-orange-500 shadow-lg shadow-orange-500/10'
                              : 'bg-slate-900/80 hover:bg-slate-800/90 border-slate-800/90'
                          }`}
                        >
                          <button
                            onClick={(e) => toggleFavorite(ch.url, e)}
                            className="absolute top-1.5 right-1.5 p-1 text-slate-500 hover:text-amber-400 z-10 cursor-pointer"
                          >
                            <Star
                              className={`w-3.5 h-3.5 ${
                                isFav ? 'fill-amber-400 text-amber-400' : ''
                              }`}
                            />
                          </button>

                          <img
                            src={ch.logo}
                            alt={ch.name}
                            className="w-12 h-12 rounded-lg object-contain bg-slate-950 p-1 border border-slate-800 my-1 group-hover:scale-105 transition-transform"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src =
                                'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=100&auto=format&fit=crop&q=60';
                            }}
                          />

                          <h4
                            className={`text-xs font-bold truncate w-full mt-1 ${
                              isActive ? 'text-amber-300' : 'text-slate-100'
                            }`}
                          >
                            {ch.name}
                          </h4>
                          <p className="text-[10px] text-slate-400 truncate w-full">{ch.group}</p>

                          {isActive && (
                            <span className="mt-1 bg-orange-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Play className="w-2.5 h-2.5 fill-white" /> Đang phát
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {filteredChannels.map((ch, idx) => {
                      const isActive = activeChannel?.url === ch.url;
                      const isFav = favorites.includes(ch.url);

                      return (
                        <div
                          key={idx}
                          role="button"
                          tabIndex={0}
                          data-tv-card={`livetv-list-${idx}`}
                          data-tv-livetv-channel
                          aria-label={`Phát kênh ${ch.name}`}
                          onClick={() => selectChannelAndPlay(ch)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                              e.preventDefault();
                              selectChannelAndPlay(ch);
                            }
                          }}
                          className={`w-full p-2.5 rounded-xl border transition-all text-left flex items-center justify-between gap-3 cursor-pointer focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                            isActive
                              ? 'bg-orange-600/20 border-orange-500 text-white shadow-md'
                              : 'bg-slate-900/80 hover:bg-slate-800/90 border-slate-800/90 text-slate-300'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <img
                              src={ch.logo}
                              alt={ch.name}
                              className="w-9 h-9 rounded-lg object-contain bg-slate-950 p-1 shrink-0 border border-slate-800"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src =
                                  'https://images.unsplash.com/photo-1593784991095-a205069470b6?w=100&auto=format&fit=crop&q=60';
                              }}
                            />
                            <div className="min-w-0">
                              <h4
                                className={`text-xs font-bold truncate ${
                                  isActive ? 'text-amber-300' : 'text-white'
                                }`}
                              >
                                {ch.name}
                              </h4>
                              <p className="text-[10px] text-slate-400 truncate">{ch.group}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={(e) => toggleFavorite(ch.url, e)}
                              className="p-1 text-slate-500 hover:text-amber-400 cursor-pointer"
                            >
                              <Star
                                className={`w-3.5 h-3.5 ${
                                  isFav ? 'fill-amber-400 text-amber-400' : ''
                                }`}
                              />
                            </button>
                            {isActive ? (
                              <span className="bg-orange-600 text-white p-1 rounded-md">
                                <Play className="w-3 h-3 fill-white" />
                              </span>
                            ) : (
                              <ChevronRight className="w-4 h-4 text-slate-600" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-10 text-center text-slate-400 text-xs bg-slate-900/40 rounded-xl border border-slate-800/80 space-y-1">
                <p className="font-semibold text-slate-300">Không tìm thấy kênh phù hợp</p>
                <p className="text-[11px] text-slate-500">Thử tìm cụm từ khác hoặc chọn lại nhóm kênh</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Source Selection Custom Modal / Sheet */}
      {showSourceModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div
            className="w-full max-w-lg bg-[#0d152a] border border-orange-900/50 rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-orange-600/20 border border-orange-500/40 flex items-center justify-center text-orange-400">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Chọn Nguồn Phát IPTV</h3>
                  <p className="text-[11px] text-slate-400">
                    Chuyển đổi danh sách kênh khi nguồn hiện tại gián đoạn
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowSourceModal(false)}
                className="p-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              {LIVE_SOURCES.map((src) => {
                const isSelected = selectedSource === src.id;
                return (
                  <div
                    key={src.id}
                    onClick={() => {
                      setSelectedSource(src.id);
                      setShowSourceModal(false);
                    }}
                    className={`p-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                      isSelected
                        ? 'bg-gradient-to-r from-orange-950/60 to-slate-900 border-orange-500 shadow-lg shadow-orange-500/10'
                        : 'bg-slate-900/80 hover:bg-slate-800/80 border-slate-800 text-slate-300'
                    }`}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-white">{src.name}</span>
                        <span className="text-[10px] font-bold bg-orange-500/20 text-amber-300 border border-orange-500/30 px-2 py-0.2 rounded-full">
                          {src.count}
                        </span>
                        <span className="text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.2 rounded-full">
                          {src.badge}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 leading-relaxed">{src.desc}</p>
                    </div>

                    <div className="shrink-0">
                      {isSelected ? (
                        <div className="w-7 h-7 rounded-full bg-orange-600 flex items-center justify-center text-white shadow">
                          <Check className="w-4 h-4 stroke-[3]" />
                        </div>
                      ) : (
                        <div className="w-7 h-7 rounded-full border border-slate-700 bg-slate-950" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => setShowSourceModal(false)}
              className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold py-3 rounded-2xl text-xs transition-all cursor-pointer border border-slate-700"
            >
              Đóng cửa sổ
            </button>
          </div>
        </div>
      )}

      {/* DRM ClearKey Channel Tester Modal */}
      <DrmChannelTesterModal
        isOpen={showDrmTesterModal}
        onClose={() => setShowDrmTesterModal(false)}
        onPlayCustomChannel={(customChannel) => {
          setChannels((prev) => [customChannel, ...prev.filter((c) => c.url !== customChannel.url)]);
          setActiveChannel(customChannel);
          setMobileTab('player');
        }}
      />

      {/* Cloudflare Worker Deployment & Dalvik UA Proxy Guide Modal */}
      <CloudflareWorkerModal
        isOpen={showCloudflareModal}
        onClose={() => setShowCloudflareModal(false)}
      />
    </div>
  );
};
