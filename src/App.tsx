import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Account,
  EpisodeServer,
  Movie,
  MovieEpisode,
  MyListItem,
  NavTab,
  UserProfile,
  WatchHistoryItem,
  ActiveApp,
  RoomListItem,
} from "./types";
import { authService } from "./services/authService";
import { firestoreStorage } from "./services/firestoreStorage";
import { movieApi } from "./services/movieApi";
import { presenceService } from "./services/presenceService";
import { appConfigService } from "./services/appConfigService";
import { verifyBackendUrl } from "./services/apiConfig";
import { useTabScroll } from "./hooks/useTabScroll";
import { LoginScreen } from "./components/LoginScreen";
import { AdminDashboard } from "./components/AdminDashboard";
import { Navbar } from "./components/Navbar";
import { HeroBanner } from "./components/HeroBanner";
import { Top10Carousel } from "./components/Top10Carousel";
import { Theater3DCarousel } from "./components/Theater3DCarousel";
import { CinematicCarousel } from "./components/CinematicCarousel";
import { MovieRow } from "./components/MovieRow";
import { ForYouRow } from "./components/ForYouRow";
import { MovieDetailModal } from "./components/MovieDetailModal";
import { GauPlayer } from "./components/GauPlayer";
import { ProfileSelector } from "./components/ProfileSelector";
import { FilterSection } from "./components/FilterSection";
import { MyListView } from "./components/MyListView";
import { HistoryView } from "./components/HistoryView";
import { OfflineSavedView } from "./components/OfflineSavedView";
import { MangaAppWrapper } from "./apps/MangaAppWrapper";
import { LiveTvAppWrapper } from "./apps/LiveTvAppWrapper";
import { AppSwitcherLoading } from "./components/AppSwitcherLoading";
import { ProfileSwitchLoader } from "./components/ProfileSwitchLoader";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { NotificationTickerBanner } from "./components/NotificationTickerBanner";
import { WatchTogetherRoom } from "./components/watch-together/WatchTogetherRoom";
import { JoinRoomModal } from "./components/watch-together/JoinRoomModal";
import {
  CustomDialog,
  ConfirmDialog,
  ToastContainer,
} from "./components/CustomDialog";
import { watchTogetherService } from "./services/watchTogetherService";
import { offlineMovieService } from "./services/offlineMovieService";
import {
  followMovieService,
  FollowedMovie,
} from "./services/followMovieService";
import { FollowedRow } from "./components/FollowedRow";
import { Capacitor } from "@capacitor/core";
import { applyTvClass } from "./utils/tvDetect";
import { useTvRemoteNav } from "./hooks/useTvRemote";
import { useTvMode } from "./hooks/useTvMode";
import { App as CapApp } from "@capacitor/app";
import { appNavigate, appGoBack } from "./routerNav";
import { RouteSync } from "./components/RouteSync";
import { TvDebugPanel } from "./components/TvDebugPanel";
import {
  buildTabUrl,
  buildPhimUrl,
  buildXemUrl,
  parseLocation,
  type ParsedRoute,
} from "./routes";
import {
  Sparkles,
  Flame,
  Film,
  Tv,
  Smile,
  Heart,
  Sword,
  Clapperboard,
  ShieldCheck,
  Info,
  Lock,
  AlertTriangle,
  Users,
  Loader2,
} from "lucide-react";

export default function App() {
  // Apply TV 10-foot class on mount + điều hướng remote D-pad
  useTvRemoteNav();
  // TV box yếu: render hàng nhẹ (MovieRow native) thay carousel 3D/Swiper
  const isTvView = useTvMode();
  useEffect(() => {
    try {
      applyTvClass();
      const onResize = () => applyTvClass();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    } catch {}
  }, []);
  // Gatekeeper state...
  const [currentAccount, setCurrentAccount] = useState<Account | null>(() =>
    authService.getSessionAccount(),
  );
  const [showAdminDashboard, setShowAdminDashboard] = useState<boolean>(false);

  // App Switcher State
  const [activeApp, setActiveApp] = useState<ActiveApp>(() => {
    try {
      const savedApp = localStorage.getItem("gau_active_app");
      if (
        savedApp === "cinema" ||
        savedApp === "manga" ||
        savedApp === "livetv"
      ) {
        return savedApp as ActiveApp;
      }
    } catch (e) {
      void 0;
    }
    return "cinema";
  });
  const [isSwitchingApp, setIsSwitchingApp] = useState<boolean>(false);
  const [targetApp, setTargetApp] = useState<ActiveApp | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("gau_active_app", activeApp);
    } catch (e) {
      void 0;
    }
  }, [activeApp]);

  const handleSwitchApp = (app: ActiveApp) => {
    if (app === activeApp) return;
    setTargetApp(app);
    setActiveApp(app); // Mount target immediately to fetch data in background
    setIsSwitchingApp(true);

    if (app === "cinema") {
      setTimeout(() => {
        window.dispatchEvent(new Event("app-data-loaded"));
      }, 100);
    }
  };

  const handleSwitchAppRef = useRef(handleSwitchApp);
  handleSwitchAppRef.current = handleSwitchApp;

  const handleSwitchAppComplete = () => {
    setTargetApp(null);
    setIsSwitchingApp(false);
  };

  // App Config State (real-time from RTDB)
  const [appConfig, setAppConfig] = useState<
    Record<string, { enabled: boolean }>
  >({});

  useEffect(() => {
    const unsub = appConfigService.subscribe((cfg) => {
      setAppConfig(cfg);
    });
    return unsub;
  }, []);

  // Auto-redirect when active app is disabled by admin
  const maintenanceTimerRef = React.useRef<ReturnType<
    typeof setInterval
  > | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState<string | null>(
    null,
  );
  const [maintenanceCountdown, setMaintenanceCountdown] = useState<number>(0);

  useEffect(() => {
    if (!appConfig || activeApp === "cinema" || showAdminDashboard) {
      setMaintenanceMessage(null);
      setMaintenanceCountdown(0);
      if (maintenanceTimerRef.current) {
        clearInterval(maintenanceTimerRef.current);
        maintenanceTimerRef.current = null;
      }
      return;
    }

    const appState = appConfig[activeApp];
    if (appState && !appState.enabled) {
      const label =
        activeApp === "manga"
          ? "Gấu Manga"
          : activeApp === "livetv"
          ? "Gấu LiveTV"
          : activeApp;
      setMaintenanceMessage(
        `${label} đang được bảo trì. Bạn sẽ được chuyển về Cinema sau 5 phút.`,
      );
      setMaintenanceCountdown(300);

      const startTime = Date.now();
      maintenanceTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = 300 - elapsed;
        if (remaining <= 0) {
          if (maintenanceTimerRef.current)
            clearInterval(maintenanceTimerRef.current);
          maintenanceTimerRef.current = null;
          setMaintenanceMessage(null);
          setMaintenanceCountdown(0);
          handleSwitchAppRef.current("cinema");
        } else {
          setMaintenanceCountdown(remaining);
        }
      }, 1000);

      return () => {
        if (maintenanceTimerRef.current) {
          clearInterval(maintenanceTimerRef.current);
          maintenanceTimerRef.current = null;
        }
      };
    } else {
      setMaintenanceMessage(null);
      setMaintenanceCountdown(0);
      if (maintenanceTimerRef.current) {
        clearInterval(maintenanceTimerRef.current);
        maintenanceTimerRef.current = null;
      }
    }
  }, [appConfig, activeApp, showAdminDashboard]);

  // Profiles State per logged-in account
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<UserProfile | null>(null);
  const [showProfileSelector, setShowProfileSelector] = useState<boolean>(true);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState<boolean>(false);

  // Quick Profile Switcher Loader state
  const [profileSwitchSrc, setProfileSwitchSrc] = useState<UserProfile | null>(null);
  const [profileSwitchTarget, setProfileSwitchTarget] = useState<UserProfile | null>(null);
  const [isProfileSwitchLoaderOpen, setIsProfileSwitchLoaderOpen] = useState(false);
  const [isProfileDataReady, setIsProfileDataReady] = useState(false);

  // App Navigation Tab (URL-first: deep-link /series... mở đúng tab ngay, không flash)
  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    try {
      const r = parseLocation(window.location.pathname, window.location.search);
      if (r.kind === "tab") {
        const validTabs: NavTab[] = [
          "home",
          "series",
          "single",
          "cinema",
          "anime",
          "tv-shows",
          "manga",
          "filter",
          "my-list",
          "history",
          "offline",
          "tv-live",
          "youtube",
          "xem-chung",
        ];
        const isNative = (() => {
          try {
            return Capacitor.isNativePlatform();
          } catch {
            return false;
          }
        })();
        if (!isNative && r.tab === "offline") return "home";
        if (validTabs.includes(r.tab)) return r.tab;
      }
    } catch {}
    try {
      const savedTab = localStorage.getItem("gau_active_tab");
      const validTabs: NavTab[] = [
        "home",
        "series",
        "single",
        "cinema",
        "anime",
        "tv-shows",
        "manga",
        "filter",
        "my-list",
        "history",
        "offline",
        "tv-live",
        "xem-chung",
      ];
      // Nếu web mà saved là offline thì fallback về home (web không hỗ trợ)
      const isNative = (() => {
        try {
          return Capacitor.isNativePlatform();
        } catch {
          return false;
        }
      })();
      if (!isNative && savedTab === "offline") return "home";
      if (savedTab && validTabs.includes(savedTab as NavTab)) {
        return savedTab as NavTab;
      }
    } catch (e) {
      void 0;
    }
    return "home";
  });

  useEffect(() => {
    try {
      localStorage.setItem("gau_active_tab", activeTab);
    } catch (e) {
      void 0;
    }
  }, [activeTab]);

  // Filter/search state (URL-first: /browse?q=... mở đúng bộ lọc ngay)
  const readInitialFilter = (key: "keyword" | "genre" | "country"): string => {
    try {
      const r = parseLocation(window.location.pathname, window.location.search);
      if (r.kind === "tab" && r.tab === "filter") return r.filter[key];
    } catch {}
    return "";
  };
  const [searchKeyword, setSearchKeyword] = useState<string>(() =>
    readInitialFilter("keyword"),
  );
  const [filterCountry, setFilterCountry] = useState<string>(() =>
    readInitialFilter("country"),
  );
  const [filterGenre, setFilterGenre] = useState<string>(() =>
    readInitialFilter("genre"),
  );

  // Auto scroll to top when entering home tab
  useTabScroll(activeTab);

  // Movie collections for Home
  const [movieCollections, setMovieCollections] = useState<
    Record<string, Movie[]>
  >({
    newUpdated: [],
    topHotAll: [],
    topSeries: [],
    topSingle: [],
    theaterList: [],
    seriesList: [],
    singleList: [],
    animeList: [],
    actionList: [],
    romanceList: [],
    horrorList: [],
    sciFiList: [],
    koreanList: [],
    netflixTop10Movies: [],
    netflixTop10TV: [],
  });
  const [isLoadingHome, setIsLoadingHome] = useState<boolean>(true);
  // Mọi đợt fetch home đã xong (kể cả lỗi) -> hàng nào vẫn rỗng thì ẩn hẳn,
  // không vẽ skeleton nữa
  const [homeSettled, setHomeSettled] = useState<boolean>(false);
  const [heroTmdbMovies, setHeroTmdbMovies] = useState<Movie[]>([]);

  const setMovieCollection = (key: string, value: Movie[]) => {
    setMovieCollections((prev) => ({ ...prev, [key]: value }));
  };

  // Active Modals & Player State
  const [selectedMovieForDetail, setSelectedMovieForDetail] =
    useState<Movie | null>(null);
  // URL để quay về khi đóng overlay (deep-link vào thẳng thì về tab, đi trong app thì về chỗ cũ)
  const detailReturnRef = useRef<string>("/");
  const playerReturnRef = useRef<string>("/");
  // Entry hiện tại có phải deep-link/reload (không phải do app push) không.
  // Đóng overlay đi trong app thì đi LÙI 1 entry (-1, đúng thứ tự home->detail->
  // player); chỉ deep-link mới về URL dự phòng (kẻo -1 văng khỏi app).
  const deepLinkEntryRef = useRef<boolean | null>(null);
  if (deepLinkEntryRef.current === null) {
    try {
      const r0 = parseLocation(window.location.pathname, window.location.search);
      deepLinkEntryRef.current = r0.kind === "detail" || r0.kind === "player";
    } catch {
      deepLinkEntryRef.current = false;
    }
  }
  // Chống resolve deep-link cũ đè resolve mới khi fetch chồng nhau
  const routeReqRef = useRef(0);
  // Ref trỏ tới các handler điều hướng (effect back-button khai báo trước handler nên gọi qua ref để tránh TDZ)
  const navActionsRef = useRef<{
    closePlayer: () => void;
    closeDetailModal: () => void;
    goHome: () => void;
  }>({ closePlayer: () => {}, closeDetailModal: () => {}, goHome: () => {} });
  const [showExitConfirmModal, setShowExitConfirmModal] =
    useState<boolean>(false);

  const handleExitApp = () => {
    try {
      if (
        typeof window !== "undefined" &&
        (window as any)?.Capacitor?.isNativePlatform?.()
      ) {
        CapApp.exitApp();
      } else {
        window.close();
      }
    } catch (e) {
      void 0;
    }
  };

  // Player State
  const [playingMovie, setPlayingMovie] = useState<Movie | null>(null);
  const [playingEpisode, setPlayingEpisode] = useState<MovieEpisode | null>(
    null,
  );
  const [playingServer, setPlayingServer] = useState<EpisodeServer | null>(
    null,
  );
  const [allServers, setAllServers] = useState<EpisodeServer[]>([]);
  const [initialResumeTime, setInitialResumeTime] = useState<number>(0);
  const videoTimeRef = useRef(0);
  const videoDurationRef = useRef(0);
  // Mirror để handler stable (handleSelectEpisode) vẫn biết phim đang phát mà sync URL
  const playingMovieRef = useRef<Movie | null>(null);

  // Watch Together State
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [activeRoomData, setActiveRoomData] = useState<any>(null);
  const [activeRoomsForFilm, setActiveRoomsForFilm] = useState<RoomListItem[]>(
    [],
  );
  const [allActiveRooms, setAllActiveRooms] = useState<RoomListItem[]>([]);
  const [joinRoomTarget, setJoinRoomTarget] = useState<RoomListItem | null>(
    null,
  );

  // User Profile Data (My List & History scoped to activeProfile)
  const [myList, setMyList] = useState<MyListItem[]>([]);
  const [watchHistory, setWatchHistory] = useState<WatchHistoryItem[]>([]);
  const [followedMovies, setFollowedMovies] = useState<FollowedMovie[]>([]);
  const [isCheckingFollow, setIsCheckingFollow] = useState(false);
  const [toasts, setToasts] = useState<
    Array<{
      id: number;
      message: string;
      type?: "info" | "success" | "error" | "warning";
    }>
  >([]);
  const toastIdRef = useRef(0);

  // Show Toast Helper
  const showToast = (
    msg: string,
    type: "info" | "success" | "error" | "warning" = "info",
  ) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message: msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  };

  // Dialog State
  const [dialog, setDialog] = useState<{
    isOpen: boolean;
    title?: string;
    message: string;
    type?: "info" | "success" | "error" | "warning";
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    showCancel?: boolean;
  } | null>(null);

  const showDialog = (options: {
    title?: string;
    message: string;
    type?: "info" | "success" | "error" | "warning";
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    showCancel?: boolean;
  }) => {
    setDialog({
      isOpen: true,
      ...options,
    });
  };

  const closeDialog = () => {
    setDialog(null);
  };

  // Bootstrap admin on initial start
  useEffect(() => {
    authService.bootstrapAdminAccount().catch((err) => {
      void 0;
    });
    // Native app: kiểm tra backend còn sống, chết thì tự đổi sang cloud (tránh APK bake URL cũ)
    verifyBackendUrl().catch(() => {});
  }, []);

  // Load profiles whenever currentAccount changes
  const loadAccountProfiles = useCallback(async (account: Account) => {
    setIsLoadingProfiles(true);
    try {
      const profs = await firestoreStorage.getProfiles(account.id);
      setProfiles(profs);

      const savedActiveId = firestoreStorage.getActiveProfileId(account.id);
      const found = profs.find((p) => p.id === savedActiveId);
      if (found) {
        if (found.pin) {
          // Profile is protected by PIN -> Require PIN verification on profile selector screen
          setActiveProfile(null);
          setShowProfileSelector(true);
        } else {
          setActiveProfile(found);
          setShowProfileSelector(false);
        }
      } else {
        setActiveProfile(null);
        setShowProfileSelector(true);
      }
    } catch (e) {
      void 0;
    } finally {
      setIsLoadingProfiles(false);
    }
  }, []);

  useEffect(() => {
    if (currentAccount) {
      loadAccountProfiles(currentAccount);
    } else {
      setProfiles([]);
      setActiveProfile(null);
      setShowProfileSelector(true);
      setShowAdminDashboard(false);
    }
  }, [currentAccount, loadAccountProfiles]);

  // Load My List and History when active profile changes
  const refreshProfileData = useCallback(async () => {
    if (!currentAccount || !activeProfile) {
      setMyList([]);
      setWatchHistory([]);
      return;
    }
    try {
      const [list, history] = await Promise.all([
        firestoreStorage.getMyList(currentAccount.id, activeProfile.id),
        firestoreStorage.getHistory(currentAccount.id, activeProfile.id),
      ]);
      setMyList(list);
      setWatchHistory(history);
    } catch (e) {
      void 0;
    }
  }, [currentAccount, activeProfile]);

  useEffect(() => {
    refreshProfileData();
  }, [refreshProfileData]);

  // Offline auto-cleanup: khi đổi profile/account thì xóa hết hạn 7 ngày
  useEffect(() => {
    if (!currentAccount || !activeProfile) return;
    try {
      if (!Capacitor.isNativePlatform()) return;
    } catch {
      return;
    }
    const expired = offlineMovieService.cleanupExpired(
      currentAccount.id,
      activeProfile.id,
    );
    if (expired > 0) {
      showToast(
        `Đã tự động xóa ${expired} phim hết hạn 7 ngày trong Đã lưu`,
        "info",
      );
    }
  }, [currentAccount?.id, activeProfile?.id]);

  // Follow: load + subscribe + check tập mới
  const refreshFollowed = useCallback(() => {
    if (!currentAccount || !activeProfile) {
      setFollowedMovies([]);
      return;
    }
    setFollowedMovies(
      followMovieService.getAll(currentAccount.id, activeProfile.id),
    );
  }, [currentAccount?.id, activeProfile?.id]);

  useEffect(() => {
    refreshFollowed();
  }, [refreshFollowed]);
  useEffect(() => {
    if (!currentAccount || !activeProfile) return;
    const unsub = followMovieService.subscribe(
      currentAccount.id,
      activeProfile.id,
      setFollowedMovies,
    );
    return unsub;
  }, [currentAccount?.id, activeProfile?.id]);

  // Navigate to cinema tab from sub-apps (manga/livetv profile menu)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as NavTab;
      if (
        detail &&
        ["history", "my-list", "offline", "home", "filter"].includes(detail)
      ) {
        setActiveTab(detail);
        window.history.pushState({ tab: detail }, "", "");
      }
    };
    window.addEventListener(
      "gau_navigate_cinema_tab",
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        "gau_navigate_cinema_tab",
        handler as EventListener,
      );
  }, []);

  // Auto check tập mới khi vào app và mỗi 30 phút (chỉ khi có theo dõi,
  // không check lúc đang xem phim để khỏi tranh băng thông với video)
  const handleCheckFollowUpdates = useCallback(async () => {
    if (!currentAccount || !activeProfile || isCheckingFollow) return;
    if (playingMovie) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const list = followMovieService.getAll(currentAccount.id, activeProfile.id);
    if (list.length === 0) return;
    // tránh spam: chỉ check nếu lần cuối >30p
    const newestCheck = Math.max(...list.map((m) => m.lastCheckedAt || 0));
    if (
      Date.now() - newestCheck < 30 * 60 * 1000 &&
      list.some((m) => !m.hasNewEpisode)
    )
      return;
    setIsCheckingFollow(true);
    try {
      const count = await followMovieService.checkForUpdates(
        currentAccount.id,
        activeProfile.id,
        (newItems) => {
          if (newItems.length > 0)
            showToast(`Có ${newItems.length} phim vừa ra tập mới!`, "success");
        },
      );
      if (count > 0) refreshFollowed();
    } finally {
      setIsCheckingFollow(false);
    }
  }, [currentAccount?.id, activeProfile?.id, isCheckingFollow, playingMovie]);

  useEffect(() => {
    handleCheckFollowUpdates();
    const id = setInterval(handleCheckFollowUpdates, 30 * 60 * 1000);
    // App quay lại foreground thì check 1 phát (thay vì poll mù)
    const onVis = () => {
      if (document.visibilityState === 'visible') handleCheckFollowUpdates();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [handleCheckFollowUpdates]);

  // Khi xem xong 1 phim có theo dõi thì đánh dấu đã xem (clear badge)
  const handleFollowSeen = useCallback(
    (slug: string, episodeName?: string) => {
      if (!currentAccount || !activeProfile) return;
      followMovieService.markSeen(
        currentAccount.id,
        activeProfile.id,
        slug,
        episodeName,
      );
    },
    [currentAccount, activeProfile],
  );

  // Watch Together - Subscribe to active room data
  useEffect(() => {
    if (!activeRoomId) {
      setActiveRoomData(null);
      return;
    }
    const unsub = watchTogetherService.subscribeRoom(activeRoomId, (room) => {
      if (!room || room.status === "closed") {
        const wasHost = room?.hostId === currentAccount?.id;
        setActiveRoomId(null);
        if (!wasHost) {
          showToast("Chủ phòng đã kết thúc xem chung.", "info");
          setActiveTab("xem-chung");
        }
        watchTogetherService
          .leaveRoom(currentAccount?.id || "")
          .catch(() => {});
      } else {
        setActiveRoomData(room);
      }
    });
    return () => unsub();
  }, [activeRoomId, currentAccount?.id]);

  // Watch Together - Subscribe to rooms for current film in detail
  useEffect(() => {
    if (!selectedMovieForDetail) {
      setActiveRoomsForFilm([]);
      return;
    }
    const unsub = watchTogetherService.subscribeActiveRooms(
      selectedMovieForDetail.slug,
      setActiveRoomsForFilm,
    );
    return () => unsub();
  }, [selectedMovieForDetail]);

  // Watch Together - Subscribe to ALL active rooms (for tab)
  useEffect(() => {
    const unsub =
      watchTogetherService.subscribeAllActiveRooms(setAllActiveRooms);
    return () => unsub();
  }, []);

  // Watch Together - Create room handler
  const handleCreateRoom = useCallback(
    async (
      filmId: string,
      filmName: string,
      filmThumb: string,
      episode: string,
      episodeSlug: string,
      serverName: string,
      linkM3u8: string,
      password: string,
      visibility: any,
    ) => {
      if (!currentAccount || !activeProfile) return;
      try {
        const roomId = await watchTogetherService.createRoom({
          filmId,
          filmName,
          filmThumb,
          episode,
          episodeSlug,
          serverName,
          linkM3u8,
          hostId: currentAccount.id,
          hostName: activeProfile.name || currentAccount.displayName,
          password,
          visibility,
        });
        setSelectedMovieForDetail(null);
        setActiveRoomId(roomId);
        showToast("Đã tạo phòng xem chung thành công!");
        // Phòng không có route riêng: đưa URL về tab xem-chung (replace, khỏi rác history)
        appNavigate(buildTabUrl("xem-chung"), { replace: true });
      } catch (err: any) {
        showToast(err.message, "error");
      }
    },
    [currentAccount, activeProfile],
  );

  // Watch Together - Join room handler
  const handleJoinRoom = useCallback(
    async (roomId: string, password: string) => {
      if (!currentAccount || !activeProfile) return;
      try {
        await watchTogetherService.joinRoom({
          roomId,
          userId: currentAccount.id,
          userName: activeProfile.name || currentAccount.displayName,
          userAvatar: activeProfile.avatar,
          password,
        });
        setSelectedMovieForDetail(null);
        setActiveRoomId(roomId);
        showToast("Đã tham gia phòng xem chung!", "success");
        appNavigate(buildTabUrl("xem-chung"), { replace: true });
      } catch (err: any) {
        const msg = err.message || "Mật khẩu sai. Vui lòng thử lại.";
        if (msg.includes("Yêu cầu vào lại đã được gửi")) {
          // Auto-request sent, enter room to show waiting screen
          setSelectedMovieForDetail(null);
          setActiveRoomId(roomId);
          showToast("Yêu cầu đã được gửi, vui lòng chờ host duyệt");
        } else {
          showToast(msg, "error");
        }
      }
    },
    [currentAccount, activeProfile],
  );

  // Watch Together - Leave room handler
  const handleLeaveRoom = useCallback(async () => {
    if (currentAccount) {
      await watchTogetherService.leaveRoom(currentAccount.id).catch(() => {});
    }
    setActiveRoomId(null);
    setActiveRoomData(null);
    // Trả URL về tab nếu đang kẹt ở URL detail/player cũ
    try {
      const r = parseLocation(window.location.pathname, window.location.search);
      if (r.kind === "detail" || r.kind === "player") {
        appNavigate(buildTabUrl("xem-chung"), { replace: true });
      }
    } catch {}
  }, [currentAccount]);

  // Watch Together - End room handler
  const handleEndRoom = useCallback(async () => {
    if (currentAccount) {
      await watchTogetherService.endRoom(currentAccount.id).catch(() => {});
    }
    setActiveRoomId(null);
    setActiveRoomData(null);
    try {
      const r = parseLocation(window.location.pathname, window.location.search);
      if (r.kind === "detail" || r.kind === "player") {
        appNavigate(buildTabUrl("xem-chung"), { replace: true });
      }
    } catch {}
  }, [currentAccount]);

  // Fetch Home collections with Progressive 2-Stage Loading for maximum speed
  const fetchHomeData = useCallback(async () => {
    setIsLoadingHome(true);
    setHomeSettled(false);
    try {
      // Stage 1 (Above the fold): Tải song song những mục hiển thị ngay trên màn hình đầu
      const [newRes, trendingAllRes, netflixTop10Res] = await Promise.all([
        movieApi.getNewUpdated(1, 30).catch(() => null),
        movieApi.getTrending(12).catch(() => null),
        movieApi.getNetflixTop10VN().catch(() => null),
      ]);

      const trendingItems = trendingAllRes?.items || [];
      const newItems = newRes?.items || [];

      if (netflixTop10Res?.movies?.length) {
        setMovieCollection("netflixTop10Movies", netflixTop10Res.movies);
      } else if (trendingItems.length) {
        setMovieCollection("netflixTop10Movies", trendingItems.slice(0, 10));
      }

      if (netflixTop10Res?.tvShows?.length) {
        setMovieCollection("netflixTop10TV", netflixTop10Res.tvShows);
      } else if (newItems.length) {
        setMovieCollection("netflixTop10TV", newItems.slice(0, 10));
      }

      if (trendingItems.length) {
        setMovieCollection("topHotAll", trendingItems);
      } else if (newRes?.items?.length) {
        setMovieCollection("topHotAll", newRes.items.slice(0, 10));
      }

      if (newRes?.items?.length) {
        const hotSlugs = new Set(trendingItems.map((m: any) => m.slug));
        const filteredNew = newRes.items.filter((m: any) => !hotSlugs.has(m.slug));
        setMovieCollection("newUpdated", filteredNew.length > 0 ? filteredNew : newRes.items);
      }

      // Màn hình đầu đã sẵn sàng -> Tắt ngay loading để người dùng tương tác tức thì
      setIsLoadingHome(false);

      // Stage 2 (dưới fold): chia 3 đợt theo thứ tự hiển thị để box yếu
      // đỡ nghẽn mạng + hàng hiện dần từ trên xuống (D-pad đi tới đâu có tới đó)
      const takeItems = (r: PromiseSettledResult<any>): any[] =>
        r.status === "fulfilled" && r.value?.items?.length ? r.value.items : [];
      const [topSeriesRes, topSingleRes, animeRes, koreanRes] =
        await Promise.allSettled([
          movieApi.getTrending(10, "series"),
          movieApi.getTrending(10, "single"),
          movieApi.getAnime(1, 16),
          movieApi.getByCountry("han-quoc", 1, 16),
        ]);
      const topSeriesItems = takeItems(topSeriesRes);
      if (topSeriesItems.length) setMovieCollection("topSeries", topSeriesItems);
      const topSingleItems = takeItems(topSingleRes);
      if (topSingleItems.length) setMovieCollection("topSingle", topSingleItems);
      const animeItems = takeItems(animeRes);
      if (animeItems.length) setMovieCollection("animeList", animeItems);
      const koreanItems = takeItems(koreanRes);
      if (koreanItems.length) setMovieCollection("koreanList", koreanItems);

      // (newUpdated đã load ở stage 1, khỏi fetch lại để đỡ 1 request)
      const [seriesRes, singleRes, theaterRes] = await Promise.allSettled([
        movieApi.getSeries(1, 24),
        movieApi.getSingleMovies(1, 24),
        movieApi.getTheaterMovies(1, 10),
      ]);
      const seriesItems = takeItems(seriesRes);
      if (seriesItems.length) {
        setMovieCollection(
          "seriesList",
          seriesItems.length > 10 ? seriesItems.slice(10) : seriesItems,
        );
      }
      const singleItems = takeItems(singleRes);
      if (singleItems.length) {
        setMovieCollection(
          "singleList",
          singleItems.length > 10 ? singleItems.slice(10) : singleItems,
        );
      }
      const theaterItems = takeItems(theaterRes);
      if (theaterItems.length) setMovieCollection("theaterList", theaterItems);

      const [actionRes, romanceRes, horrorRes, sciFiRes] =
        await Promise.allSettled([
          movieApi.getByGenre("hanh-dong", 1, 16),
          movieApi.getByGenre("tinh-cam", 1, 16),
          movieApi.getByGenre("kinh-di", 1, 16),
          movieApi.getByGenre("vien-tuong", 1, 16),
        ]);
      const actionItems = takeItems(actionRes);
      if (actionItems.length) setMovieCollection("actionList", actionItems);
      const romanceItems = takeItems(romanceRes);
      if (romanceItems.length) setMovieCollection("romanceList", romanceItems);
      const horrorItems = takeItems(horrorRes);
      if (horrorItems.length) setMovieCollection("horrorList", horrorItems);
      const sciFiItems = takeItems(sciFiRes);
      if (sciFiItems.length) setMovieCollection("sciFiList", sciFiItems);
    } catch (e) {
      void 0;
    } finally {
      setIsLoadingHome(false);
      setHomeSettled(true);
    }
  }, []);

  useEffect(() => {
    fetchHomeData();
  }, [fetchHomeData]);

  // Hero Banner: lấy từ TMDB Popular (en-US, region VN) đã validate tồn tại trong API phim hiện tại + subscribe RTDB realtime
  useEffect(() => {
    movieApi.getTmdbHeroPopular().then((items) => {
      if (items && items.length) setHeroTmdbMovies(items);
    }).catch(() => {});

    const unsubscribe = movieApi.subscribeTmdbHeroPopular((items) => {
      if (items && items.length) {
        setHeroTmdbMovies(items);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Netflix Top 10: Subscribe RTDB realtime để luôn cập nhật dữ liệu mới nhất
  useEffect(() => {
    const unsubscribe = movieApi.subscribeNetflixTop10((res) => {
      if (res?.movies?.length) {
        setMovieCollection("netflixTop10Movies", res.movies);
      }
      if (res?.tvShows?.length) {
        setMovieCollection("netflixTop10TV", res.tvShows);
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Auth Handlers
  const handleLoginSuccess = (account: Account) => {
    setCurrentAccount(account);
    setShowAdminDashboard(false);
    showToast(`Chào mừng @${account.username} đến với Gấu Cinema!`);
  };

  // TẠM THỜI cho test TV: ?autologin=username:password tự đăng nhập 1 lần
  // (khỏi gõ phím bằng remote). Đọc + nuốt param NGAY trong render đầu
  // (trước khi router/effect con kịp viết lại URL), cất vào sessionStorage
  // để reload giữa chừng vẫn thử tiếp. XÓA trước khi release.
  const [pendingAutoLogin] = useState<{ u: string; p: string } | null>(() => {
    const consume = (value: string | null) => {
      if (!value) return null;
      const sep = value.indexOf(':');
      if (sep <= 0) return null;
      try {
        const u = decodeURIComponent(value.slice(0, sep)).trim();
        const p = decodeURIComponent(value.slice(sep + 1)).trim();
        if (!u || !p) return null;
        return { u, p };
      } catch {
        return null;
      }
    };
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('autologin');
      let creds = consume(raw);
      if (raw) {
        params.delete('autologin');
        try {
          window.history.replaceState(
            null,
            '',
            window.location.pathname + (params.toString() ? `?${params.toString()}` : ''),
          );
        } catch {}
      }
      if (creds) {
        try {
          sessionStorage.setItem('gau_pending_autologin', JSON.stringify(creds));
        } catch {}
      } else {
        try {
          const saved = sessionStorage.getItem('gau_pending_autologin');
          if (saved) {
            const obj = JSON.parse(saved) as any;
            if (obj && typeof obj.u === 'string' && typeof obj.p === 'string' && obj.u && obj.p) {
              creds = { u: obj.u, p: obj.p };
            }
          }
        } catch {}
      }
      return creds;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!pendingAutoLogin) return;
    if (authService.getSessionAccount()) {
      try {
        sessionStorage.removeItem('gau_pending_autologin');
      } catch {}
      return;
    }
    let cancelled = false;
    showToast(`Đang tự động đăng nhập @${pendingAutoLogin.u}...`);
    authService
      .login(pendingAutoLogin.u, pendingAutoLogin.p)
      .then((account) => {
        if (cancelled) return;
        try {
          sessionStorage.removeItem('gau_pending_autologin');
        } catch {}
        handleLoginSuccess(account);
      })
      .catch((err: any) => {
        if (cancelled) return;
        try {
          sessionStorage.removeItem('gau_pending_autologin');
        } catch {}
        showToast(
          `Tự động đăng nhập thất bại: ${err?.message || 'lỗi không rõ'}`,
          'error',
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoLogin]);

  const handleLogout = () => {
    if (currentAccount) {
      firestoreStorage.clearActiveProfileId(currentAccount.id);
    }
    authService.logout();
    setCurrentAccount(null);
    setActiveProfile(null);
    setShowProfileSelector(true);
    setShowAdminDashboard(false);
    setPlayingMovie(null);
    showToast("Đã đăng xuất khỏi tài khoản.");
  };

  // TV: session lưu localStorage nên restart app vẫn giữ login (nhớ lâu).
  // Remote dễ bấm nhầm Đăng xuất -> hỏi confirm trước khi xóa session.
  const [showLogoutConfirm, setShowLogoutConfirm] = useState<boolean>(false);
  const handleLogoutRequest = () => {
    try {
      if (document.documentElement.classList.contains("tv-mode")) {
        setShowLogoutConfirm(true);
        return;
      }
    } catch {}
    handleLogout();
  };

  // Profile management handlers
  const handleSelectProfile = async (profile: UserProfile) => {
    if (!currentAccount) return;

    try {
      const [list, history] = await Promise.all([
        firestoreStorage.getMyList(currentAccount.id, profile.id),
        firestoreStorage.getHistory(currentAccount.id, profile.id),
      ]);
      setMyList(list);
      setWatchHistory(history);
    } catch (err) {
      console.error(err);
    }

    setActiveProfile(profile);
    firestoreStorage.setActiveProfileId(currentAccount.id, profile.id);
    setShowProfileSelector(false);
  };

  const handleQuickSwitchProfile = async (profile: UserProfile) => {
    if (!currentAccount) return;

    // Check if we are selecting a profile or switching
    setProfileSwitchSrc(activeProfile); // activeProfile might be null (first login)
    setProfileSwitchTarget(profile);
    setIsProfileDataReady(false);
    setIsProfileSwitchLoaderOpen(true);

    try {
      // Pre-fetch Profile B data in the background (real preparation/fetching!)
      const [list, history] = await Promise.all([
        firestoreStorage.getMyList(currentAccount.id, profile.id),
        firestoreStorage.getHistory(currentAccount.id, profile.id),
      ]);
      setMyList(list);
      setWatchHistory(history);
      setIsProfileDataReady(true);
    } catch (err) {
      // Graceful fallback on error so the transition still succeeds
      setIsProfileDataReady(true);
    }
  };

  const handleProfileSwitchLoaderComplete = () => {
    if (profileSwitchTarget && currentAccount) {
      setActiveProfile(profileSwitchTarget);
      firestoreStorage.setActiveProfileId(currentAccount.id, profileSwitchTarget.id);
      setShowProfileSelector(false);
    }
    setIsProfileSwitchLoaderOpen(false);
    setProfileSwitchSrc(null);
    setProfileSwitchTarget(null);
  };

  const handleUpdateProfiles = async (updated: UserProfile[]) => {
    if (!currentAccount) return;
    setProfiles(updated);
    // Persist each updated profile in Firestore (parallel)
    await Promise.all(
      updated.map((p) => firestoreStorage.updateProfile(currentAccount.id, p)),
    );
    if (activeProfile) {
      const activeUpdated = updated.find((p) => p.id === activeProfile.id);
      if (activeUpdated) setActiveProfile(activeUpdated);
    }
    showToast("Đã cập nhật hồ sơ người xem");
  };

  const handleAddProfile = async (
    newProf: Omit<UserProfile, "id" | "createdAt">,
  ) => {
    if (!currentAccount) return;
    const created = await firestoreStorage.addProfile(
      currentAccount.id,
      newProf,
    );
    setProfiles((prev) => [...prev, created]);
    showToast(`Đã tạo thành công hồ sơ "${created.name}"`);
  };

  const handleDeleteProfile = async (profileId: string) => {
    if (!currentAccount) return;
    await firestoreStorage.deleteProfile(currentAccount.id, profileId);
    setProfiles((prev) => prev.filter((p) => p.id !== profileId));
    if (activeProfile?.id === profileId) {
      const remaining = profiles.filter((p) => p.id !== profileId);
      setActiveProfile(remaining[0] || null);
    }
    showToast("Đã xóa hồ sơ người xem");
  };

  // Toggle My List
  const handleToggleMyList = async (movie: Movie) => {
    if (!currentAccount || !activeProfile) return;
    const added = await firestoreStorage.toggleMyList(
      currentAccount.id,
      activeProfile.id,
      {
        movieSlug: movie.slug,
        movieName: movie.name,
        movieOriginName: movie.origin_name,
        movieThumb: movie.thumb_url,
        moviePoster: movie.poster_url,
        year: movie.year,
        quality: movie.quality,
        lang: movie.lang,
        episode_current: movie.episode_current,
      },
    );
    await refreshProfileData();
    showToast(
      added
        ? `Đã thêm "${movie.name}" vào Danh sách của ${activeProfile.name}`
        : `Đã xóa "${movie.name}" khỏi Danh sách`,
    );
  };

  const isInMyList = (slug: string) => {
    return myList.some((item) => item.movieSlug === slug);
  };

  // Prevent background scroll ONLY when modal dialog or player overlay is open
  useEffect(() => {
    const shouldLock = Boolean(playingMovie || selectedMovieForDetail);
    if (shouldLock) {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
    } else {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    }
    return () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    };
  }, [playingMovie, selectedMovieForDetail]);

  // Online presence & browsing activity tracking
  useEffect(() => {
    if (!currentAccount || playingMovie || showProfileSelector) return;

    presenceService.startSession({
      accountId: currentAccount.id || currentAccount.username,
      accountDisplayName: currentAccount.displayName || currentAccount.username,
      profileId: activeProfile?.id || "default",
      profileName:
        activeProfile?.name || currentAccount.displayName || "Người xem",
      profileAvatar: activeProfile?.avatar || "",
      type: "browsing",
      itemTitle: showAdminDashboard
        ? "Đang quản trị"
        : "Đang xem danh mục Phim",
      itemSubtitle: showAdminDashboard
        ? "Trang quản trị"
        : `Mục: ${activeTab.toUpperCase()}`,
    });

    return () => {
      presenceService.stopSession();
    };
  }, [
    currentAccount,
    activeProfile,
    activeTab,
    playingMovie,
    showProfileSelector,
    showAdminDashboard,
  ]);

  // Unified History/Back Button Manager
  // Tab/detail/player đã có router (RouteSync) lo theo URL; handler này chỉ giữ
  // các overlay cùng-URL (admin, profiles) + stack riêng của manga.
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      // Manga overlay (detail/reader) is handled by MangaView; skip global handler to avoid exit popup
      if (
        e.state &&
        (e.state.mangaView === "detail" || e.state.mangaView === "reader")
      ) {
        return;
      }
      // When popping from manga detail/reader to previous state, let MangaView clear its state; don't show exit
      const curMangaView = (window.history.state as any)?.mangaView;
      if (curMangaView === "detail" || curMangaView === "reader") {
        return;
      }
      if (showAdminDashboard) {
        if (
          e.state &&
          (e.state.overlay === "admin" ||
            e.state.overlay === "admin_user_detail")
        ) {
          // Keep admin dashboard open when navigating internal admin subviews
          return;
        }
        setShowAdminDashboard(false);
      } else if (showProfileSelector && currentAccount && activeProfile) {
        setShowProfileSelector(false);
      } else if (!e.state) {
        // Don't show exit when in manga/livetv app; MangaView handles its own back stack
        if (activeApp !== "cinema") {
          return;
        }
        if (activeTab === "home") {
          setShowExitConfirmModal(true);
        } else {
          setActiveTab("home");
        }
      }
    };
    window.addEventListener("popstate", handlePopState);

    // Capacitor Back Button for Android (Safe check for native platform)
    let backUnsub: (() => void) | undefined;
    try {
      if (
        typeof window !== "undefined" &&
        (window as any)?.Capacitor?.isNativePlatform?.()
      ) {
        CapApp.addListener("backButton", () => {
          // Manga reader/detail has its own history stack; back should close it, not show exit popup
          const curState: any = window.history.state;
          if (
            curState &&
            (curState.mangaView === "detail" || curState.mangaView === "reader")
          ) {
            window.history.back();
            return;
          }
          // When not in cinema app, don't show cinema exit popup; manga/livetv handle their own back
          if (activeApp !== "cinema") {
            // If manga has no overlay, let browser handle or do nothing; avoid showing cinema exit
            if (!curState || !curState.mangaView) return;
          }
          if (showExitConfirmModal) {
            setShowExitConfirmModal(false);
          } else if (showLogoutConfirm) {
            setShowLogoutConfirm(false);
          } else if (playingMovie || selectedMovieForDetail) {
            // Player/detail đóng theo URL thật (deep-link được) thay vì history.back() mù
            if (playingMovie) {
              // TV kiểu Netflix: player tự quyết (menu mở -> đóng menu;
              // hiện -> ẩn controls; ẩn -> thoát) qua event này
              try {
                if (document.documentElement.classList.contains("tv-mode")) {
                  window.dispatchEvent(new Event("gau_tv_back_player"));
                  return;
                }
              } catch {}
              navActionsRef.current.closePlayer();
            }
            else navActionsRef.current.closeDetailModal();
          } else if (
            showAdminDashboard ||
            (showProfileSelector && currentAccount && activeProfile)
          ) {
            window.history.back();
          } else if (activeTab !== "home") {
            navActionsRef.current.goHome();
          } else {
            setShowExitConfirmModal(true);
          }
        })
          .then((l) => {
            backUnsub = () => l.remove();
          })
          .catch(() => {});
      }
    } catch {
      // Ignore on web browser
    }

    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (backUnsub) backUnsub();
    };
  }, [
    showExitConfirmModal,
    showLogoutConfirm,
    playingMovie,
    selectedMovieForDetail,
    showAdminDashboard,
    showProfileSelector,
    currentAccount,
    activeProfile,
    activeTab,
    activeApp,
  ]);

  // Wrapper for state changes (URL-first: mỗi tab là 1 deep-link)
  const handleTabChange = (tab: NavTab) => {
    if (tab === activeTab) return;
    // Chặn tab offline trên Web
    try {
      if (tab === "offline" && !Capacitor.isNativePlatform()) {
        showToast("Tính năng Đã lưu Offline chỉ có trên App APK", "warning");
        return;
      }
    } catch {}

    setActiveTab(tab);
    if (tab !== "filter") {
      setSearchKeyword("");
      setFilterCountry("");
      setFilterGenre("");
    }
    appNavigate(buildTabUrl(tab));
  };

  const openAdminDashboard = () => {
    window.history.pushState({ overlay: "admin" }, "", "");
    setShowAdminDashboard(true);
  };

  const closeAdminDashboard = () => {
    if (window.history.state && window.history.state.overlay === "admin") {
      window.history.back();
    } else {
      setShowAdminDashboard(false);
    }
  };

  const openProfileSelector = () => {
    window.history.pushState({ overlay: "profiles" }, "", "");
    setShowProfileSelector(true);
  };

  const openDetailModal = (movie: Movie) => {
    if (!selectedMovieForDetail) {
      // Nhớ chỗ đang đứng để nút Đóng/X quay về (đi trong app); deep-link vào thẳng thì ref đã là tab
      detailReturnRef.current =
        window.location.pathname + window.location.search;
    }
    // Mở trong app = push entry mới -> nút Đóng đi lùi (-1) đúng thứ tự
    deepLinkEntryRef.current = false;
    setSelectedMovieForDetail(movie);
    appNavigate(buildPhimUrl(movie.slug));
  };

  const closeDetailModal = () => {
    if (!selectedMovieForDetail) return; // đã đóng rồi (tránh lùi 2 entry)
    const r = parseLocation(window.location.pathname, window.location.search);
    setSelectedMovieForDetail(null);
    if (r.kind !== "detail") return; // không ở URL detail thì chỉ clear state (tránh yank URL lạ)
    if (deepLinkEntryRef.current) {
      // Deep-link/reload: không có entry trước của app -> về URL dự phòng
      deepLinkEntryRef.current = false;
      appNavigate(detailReturnRef.current || "/", { replace: true });
      return;
    }
    // Đi trong app: lùi 1 entry để đúng thứ tự mở (player/detail trước đó tự hiện lại qua route)
    appGoBack();
  };

  // Shell mở player ngay kiểu Netflix: tập/server giả trong lúc chờ source nền.
  // Route /watch/:slug (không tập) sẽ kích applyLocationRoute tự resolve tập thật.
  const RESOLVING_EPISODE_SLUG = "__resolving__";
  const resolvingEpisode: MovieEpisode = {
    name: "",
    slug: "__resolving__",
    filename: "",
    link_embed: "",
    link_m3u8: "",
  };
  const resolvingServer: EpisodeServer = { server_name: "", server_data: [resolvingEpisode] };

  // Lõi mở player (set state + ghi lịch sử), KHÔNG đụng URL — wrapper mới điều hướng
  const applyPlayerOpen = (
    movie: Movie,
    episode: MovieEpisode,
    server: EpisodeServer,
    servers: EpisodeServer[],
    resumeTime: number,
    skipHistory = false,
  ) => {
    videoTimeRef.current = resumeTime;
    videoDurationRef.current = 0;
    setPlayingMovie(movie);
    playingMovieRef.current = movie;
    setPlayingEpisode(episode);
    setPlayingServer(server);
    setAllServers(servers);
    setInitialResumeTime(resumeTime);

    // Ghi nhận ngay khi bắt đầu xem để mục "Xem tiếp" / "Lịch sử" xuất hiện lập tức.
    // Shell chờ source (skipHistory) thì bỏ qua, kẻo rác bản ghi 0 tiến độ.
    if (currentAccount && activeProfile && !skipHistory) {
      firestoreStorage
        .saveWatchProgress(currentAccount.id, activeProfile.id, {
          id: `${movie.slug}_${episode.slug}`,
          movieSlug: movie.slug,
          movieName: movie.name,
          movieOriginName: movie.origin_name,
          movieThumb: movie.thumb_url,
          moviePoster: movie.poster_url,
          episodeName: episode.name,
          episodeSlug: episode.slug,
          serverName: server.server_name,
          linkM3u8: episode.link_m3u8,
          currentTime: resumeTime,
          duration: 0,
          progressPercent: 0,
        })
        .then(() => refreshProfileData());
    }
  };

  const openPlayerWithHistory = (
    movie: Movie,
    episode: MovieEpisode,
    server: EpisodeServer,
    servers: EpisodeServer[],
    resumeTime: number,
    resolving = false,
  ) => {
    applyPlayerOpen(movie, episode, server, servers, resumeTime, resolving);
    // Giữ detail ở dưới player để player zoom trên nền detail (đúng rule iOS: mở zoom vào, đóng thu nhỏ)
    // Đóng player sẽ quay về detail (nếu đang mở) hoặc tab.
    playerReturnRef.current = selectedMovieForDetail
      ? buildPhimUrl(selectedMovieForDetail.slug)
      : buildTabUrl(activeTab);
    // Mở trong app = push entry mới -> nút Đóng đi lùi (-1) đúng thứ tự
    deepLinkEntryRef.current = false;
    // Shell chờ source: điều hướng /watch/:slug (không tập) để route tự resolve
    // tập thật nền; tập thật có thì đi thẳng URL đầy đủ như cũ.
    appNavigate(
      resolving
        ? buildXemUrl(movie.slug)
        : buildXemUrl(movie.slug, episode.slug, server.server_name),
    );
  };

  // Snapshot tiến độ lần cuối khi thoát player (bản cũ nằm ở popstate)
  const saveFinalProgress = () => {
    if (
      currentAccount &&
      activeProfile &&
      playingMovie &&
      playingEpisode &&
      playingServer &&
      videoTimeRef.current > 0
    ) {
      firestoreStorage
        .saveWatchProgress(currentAccount.id, activeProfile.id, {
          id: `${playingMovie.slug}_${playingEpisode.slug}`,
          movieSlug: playingMovie.slug,
          movieName: playingMovie.name,
          movieOriginName: playingMovie.origin_name,
          movieThumb: playingMovie.thumb_url,
          moviePoster: playingMovie.poster_url,
          episodeName: playingEpisode.name,
          episodeSlug: playingEpisode.slug,
          serverName: playingServer.server_name,
          linkM3u8: playingEpisode.link_m3u8,
          currentTime: videoTimeRef.current,
          duration: videoDurationRef.current || 0,
          progressPercent:
            videoDurationRef.current > 0
              ? Math.round(
                  (videoTimeRef.current / videoDurationRef.current) * 100,
                )
              : 0,
        })
        .then(() => refreshProfileData());
    } else {
      refreshProfileData();
    }
  };

  const closePlayer = () => {
    if (!playingMovieRef.current) return; // đã đóng rồi (tránh lùi 2 entry)
    const r = parseLocation(window.location.pathname, window.location.search);
    saveFinalProgress();
    setPlayingMovie(null);
    playingMovieRef.current = null;
    // Hủy các lần resolve route đang bay (tránh fetch về sau mở lại player đã đóng)
    routeReqRef.current++;
    if (r.kind !== "player") return; // không ở URL player thì chỉ clear state
    if (deepLinkEntryRef.current) {
      // Deep-link/reload: không có entry trước của app -> về URL dự phòng
      deepLinkEntryRef.current = false;
      appNavigate(playerReturnRef.current || "/", { replace: true });
      return;
    }
    // Đi trong app: lùi 1 entry để đúng thứ tự mở (detail trước đó tự hiện lại qua route)
    appGoBack();
  };

  // Đăng ký vào ref cho effect back-button (khai báo trước handler)
  navActionsRef.current = {
    closePlayer,
    closeDetailModal,
    goHome: () => handleTabChange("home"),
  };

  // Start Playing a Movie directly.
  // Mở player NGAY kiểu Netflix (shell + poster), source resolve nền qua route
  // /watch/:slug — không đợi getMovieDetail xong mới mở.
  const handlePlayMovie = async (movie: Movie) => {
    let resumeSeconds = 0;
    if (currentAccount && activeProfile) {
      const matchHist = watchHistory.find((h) => h.movieSlug === movie.slug);
      if (matchHist && matchHist.currentTime > 10) {
        resumeSeconds = matchHist.currentTime;
      }
    }

    const servers: EpisodeServer[] = movie.episodes || [];

    // Đã có sẵn tập (từ detail/modal): mở thẳng như cũ, tức thì
    if (
      servers.length > 0 &&
      servers[0].server_data &&
      servers[0].server_data.length > 0
    ) {
      const defaultServer = servers[0];
      const defaultEpisode = defaultServer.server_data[0];

      openPlayerWithHistory(
        movie,
        defaultEpisode,
        defaultServer,
        servers,
        resumeSeconds,
      );
      return;
    }

    // Chưa có source: mở shell ngay, route /watch/:slug tự fetch + resolve nền
    openPlayerWithHistory(
      movie,
      resolvingEpisode,
      resolvingServer,
      [],
      resumeSeconds,
      true,
    );
  };

  // Play a specific episode
  const handlePlayEpisode = (
    movie: Movie,
    episode: MovieEpisode,
    server: EpisodeServer,
  ) => {
    let resumeTime = 0;
    if (activeProfile) {
      const match = watchHistory.find(
        (h) => h.movieSlug === movie.slug && h.episodeSlug === episode.slug,
      );
      if (match && match.currentTime > 10) {
        resumeTime = match.currentTime;
      }
    }
    openPlayerWithHistory(
      movie,
      episode,
      server,
      movie.episodes || [server],
      resumeTime,
    );
  };

  // Resume from History View
  const handleResumeHistoryItem = async (item: WatchHistoryItem) => {
    try {
      const detail = await movieApi.getMovieDetail(item.movieSlug);
      const servers = detail.episodes || [];
      const srv =
        servers.find((s) => s.server_name === item.serverName) || servers[0];
      if (srv) {
        const ep =
          srv.server_data.find((e) => e.slug === item.episodeSlug) ||
          srv.server_data[0];
        if (ep) {
          openPlayerWithHistory(
            detail.movie,
            ep,
            srv,
            servers,
            item.currentTime,
          );
        }
      }
    } catch (e) {
      void 0;
      handlePlaySlug(item.movieSlug);
    }
  };

  const handlePlaySlug = async (slug: string) => {
    try {
      const detail = await movieApi.getMovieDetail(slug);
      handlePlayMovie(detail.movie);
    } catch (e) {
      void 0;
    }
  };

  const handleOpenDetailSlug = async (
    slug: string,
    name: string,
    thumb: string,
  ) => {
    try {
      const detail = await movieApi.getMovieDetail(slug);
      openDetailModal(detail.movie);
    } catch (e) {
      openDetailModal({
        name,
        slug,
        origin_name: "",
        poster_url: thumb,
        thumb_url: thumb,
      });
    }
  };

  // Select episode inside the player (memoized so re-renders don't retrigger the player's load effect)
  // Đổi tập trong player cũng đổi URL (replace để khỏi ngập history)
  const handleSelectEpisode = useCallback(
    (ep: MovieEpisode, srv: EpisodeServer, resumeTime?: number) => {
      setPlayingEpisode(ep);
      setPlayingServer(srv);
      setInitialResumeTime(resumeTime ?? 0);
      const m = playingMovieRef.current;
      if (m) appNavigate(buildXemUrl(m.slug, ep.slug, srv.server_name), { replace: true });
    },
    [],
  );

  // Lightweight live-time forwarder so the exit save uses the real final time
  const handlePlayerTimeUpdate = useCallback((t: number, d: number) => {
    videoTimeRef.current = t;
    if (d > 0) videoDurationRef.current = d;
  }, []);

  // Save Progress Callback from Player to Firestore
  const handleSaveProgress = useCallback(
    async (currentTime: number, duration: number) => {
      videoTimeRef.current = currentTime;
      videoDurationRef.current = duration;
      if (
        !currentAccount ||
        !activeProfile ||
        !playingMovie ||
        !playingEpisode ||
        !playingServer
      )
        return;
      if (duration <= 0) return;

      const progressPercent = Math.min(100, (currentTime / duration) * 100);
      await firestoreStorage.saveWatchProgress(
        currentAccount.id,
        activeProfile.id,
        {
          id: `${playingMovie.slug}_${playingEpisode.slug}`,
          movieSlug: playingMovie.slug,
          movieName: playingMovie.name,
          movieOriginName: playingMovie.origin_name,
          movieThumb: playingMovie.thumb_url,
          moviePoster: playingMovie.poster_url,
          episodeName: playingEpisode.name,
          episodeSlug: playingEpisode.slug,
          serverName: playingServer.server_name,
          linkM3u8: playingEpisode.link_m3u8,
          currentTime,
          duration,
          progressPercent,
        },
      );
      // Refresh the "Continue Watching" / History lists live so they appear
      // while the user is still watching, not only after closing the player.
      const history = await firestoreStorage.getHistory(
        currentAccount.id,
        activeProfile.id,
      );
      setWatchHistory(history);
    },
    [
      currentAccount,
      activeProfile,
      playingMovie,
      playingEpisode,
      playingServer,
    ],
  );

  // Search Submit Handler (URL-first: /browse?q=... chia sẻ được)
  const handleSearchSubmit = (keyword: string) => {
    setSearchKeyword(keyword);
    setFilterCountry("");
    setFilterGenre("");
    if (selectedMovieForDetail) {
      setSelectedMovieForDetail(null);
    }
    if (activeTab !== "filter") {
      setActiveTab("filter");
    } else {
      // Already in filter tab, just scroll to top
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    appNavigate(buildTabUrl("filter", { keyword, genre: "", country: "" }));
  };

  const handleSelectCountry = (countrySlug: string) => {
    setFilterCountry(countrySlug);
    setFilterGenre("");
    setSearchKeyword("");
    if (selectedMovieForDetail) {
      setSelectedMovieForDetail(null);
    }
    if (activeTab !== "filter") {
      setActiveTab("filter");
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    appNavigate(buildTabUrl("filter", { keyword: "", genre: "", country: countrySlug }));
  };

  const handleSelectGenre = (genreSlug: string) => {
    setFilterGenre(genreSlug);
    setFilterCountry("");
    setSearchKeyword("");
    if (selectedMovieForDetail) {
      setSelectedMovieForDetail(null);
    }
    if (activeTab !== "filter") {
      setActiveTab("filter");
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    appNavigate(buildTabUrl("filter", { keyword: "", genre: genreSlug, country: "" }));
  };

  // ---- URL <-> state (react-router): state là nguồn sự thật, URL phản chiếu ----
  // Route mà state hiện tại hàm ý — RouteSync so với URL, lệch thì áp URL vào state.
  const expectedRoute: ParsedRoute = useMemo(() => {
    if (playingMovie) {
      return {
        kind: "player",
        slug: playingMovie.slug,
        episodeSlug: playingEpisode?.slug,
        serverName: playingServer?.server_name,
      };
    }
    if (selectedMovieForDetail) {
      return { kind: "detail", slug: selectedMovieForDetail.slug };
    }
    if (activeTab === "filter") {
      return {
        kind: "tab",
        tab: activeTab,
        filter: { keyword: searchKeyword, genre: filterGenre, country: filterCountry },
      };
    }
    return { kind: "tab", tab: activeTab, filter: { keyword: "", genre: "", country: "" } };
  }, [
    playingMovie,
    playingEpisode,
    playingServer,
    selectedMovieForDetail,
    activeTab,
    searchKeyword,
    filterGenre,
    filterCountry,
  ]);

  // Áp URL -> state (back/forward/truy cập trực tiếp). Fetch chồng nhau thì cái sau thắng.
  const applyLocationRoute = useCallback(
    (route: ParsedRoute) => {
      const reqId = ++routeReqRef.current;
      const alive = () => routeReqRef.current === reqId;
      if (route.kind === "unknown") {
        appNavigate("/", { replace: true });
        return;
      }
      if (route.kind === "tab") {
        if (playingMovie) {
          saveFinalProgress();
          setPlayingMovie(null);
          playingMovieRef.current = null;
        }
        if (selectedMovieForDetail) setSelectedMovieForDetail(null);
        if (route.tab === "filter") {
          setSearchKeyword(route.filter.keyword);
          setFilterGenre(route.filter.genre);
          setFilterCountry(route.filter.country);
        }
        setActiveTab(route.tab);
        return;
      }
      if (route.kind === "detail") {
        if (playingMovie) {
          saveFinalProgress();
          setPlayingMovie(null);
          playingMovieRef.current = null;
        }
        if (selectedMovieForDetail?.slug === route.slug) return;
        detailReturnRef.current = buildTabUrl(activeTab);
        void (async () => {
          try {
            const d = await movieApi.getMovieDetail(route.slug);
            if (!alive()) return;
            if (d?.movie) {
              setSelectedMovieForDetail(d.movie);
            } else {
              showToast("Không tìm thấy phim", "error");
              appNavigate("/", { replace: true });
            }
          } catch {
            if (!alive()) return;
            showToast("Không tải được thông tin phim", "error");
            appNavigate("/", { replace: true });
          }
        })();
        return;
      }
      // route.kind === 'player'
      const samePlayer =
        playingMovie?.slug === route.slug &&
        (playingEpisode?.slug || undefined) === (route.episodeSlug || undefined) &&
        (route.serverName
          ? playingServer?.server_name === route.serverName
          : true);
      if (samePlayer) return;
      if (selectedMovieForDetail && selectedMovieForDetail.slug !== route.slug) {
        setSelectedMovieForDetail(null);
      }
      playerReturnRef.current =
        selectedMovieForDetail && selectedMovieForDetail.slug === route.slug
          ? buildPhimUrl(route.slug)
          : buildTabUrl(activeTab);
      void (async () => {
        try {
          const d = await movieApi.getMovieDetail(route.slug);
          if (!alive()) return;
          const movie = d?.movie;
          const servers: EpisodeServer[] = d?.episodes || [];
          if (!movie || servers.length === 0) {
            showToast("Phim chưa có nguồn phát", "warning");
            appNavigate(buildPhimUrl(route.slug), { replace: true });
            return;
          }
          const server =
            (route.serverName &&
              servers.find((s) => s.server_name === route.serverName)) ||
            servers[0];
          const eps = server.server_data || [];
          let episode = (route.episodeSlug && eps.find((e) => e.slug === route.episodeSlug)) || null;
          let resume = 0;
          if (!episode) {
            episode = eps[0];
            if (currentAccount && activeProfile) {
              const m = watchHistory.find((h) => h.movieSlug === movie.slug);
              if (m && m.currentTime > 10) resume = m.currentTime;
            }
          } else if (activeProfile) {
            const m = watchHistory.find(
              (h) => h.movieSlug === movie.slug && h.episodeSlug === episode.slug,
            );
            if (m && m.currentTime > 10) resume = m.currentTime;
          }
          if (!episode) {
            appNavigate(buildPhimUrl(route.slug), { replace: true });
            return;
          }
          applyPlayerOpen(movie, episode, server, servers, resume);
          appNavigate(buildXemUrl(movie.slug, episode.slug, server.server_name), {
            replace: true,
          });
        } catch {
          if (!alive()) return;
          showToast("Không tải được phim", "error");
          appNavigate("/", { replace: true });
        }
      })();
    },
    [
      playingMovie,
      playingEpisode,
      playingServer,
      selectedMovieForDetail,
      activeTab,
      currentAccount,
      activeProfile,
      watchHistory,
      applyPlayerOpen,
      saveFinalProgress,
    ],
  );

  // 1. GATEKEEPER: Not Logged In -> Show LoginScreen Only
  if (!currentAccount) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  // 2. ADMIN DASHBOARD SCREEN
  if (showAdminDashboard && currentAccount.role === "admin") {
    return (
      <AdminDashboard
        currentAccount={currentAccount}
        onBackToCinema={closeAdminDashboard}
        onShowToast={showToast}
      />
    );
  }

  let appContent = null;

  const {
    newUpdated,
    topHotAll,
    topSeries,
    topSingle,
    theaterList,
    seriesList,
    singleList,
    animeList,
    actionList,
    romanceList,
    horrorList,
    sciFiList,
    koreanList,
    netflixTop10Movies,
    netflixTop10TV,
  } = movieCollections;

  if (activeApp === "manga") {
    appContent = (
      <MangaAppWrapper
        currentAccount={currentAccount}
        activeProfile={activeProfile}
        profiles={profiles}
        onSelectProfile={handleQuickSwitchProfile}
        onSwitchApp={handleSwitchApp}
        onSwitchProfileScreen={() => setShowProfileSelector(true)}
        onOpenAdminDashboard={
          currentAccount.role === "admin" ? openAdminDashboard : undefined
        }
        onLogout={handleLogoutRequest}
      />
    );
  } else if (activeApp === "livetv") {
    appContent = (
      <LiveTvAppWrapper
        currentAccount={currentAccount}
        activeProfile={activeProfile}
        profiles={profiles}
        onSelectProfile={handleQuickSwitchProfile}
        onSwitchApp={handleSwitchApp}
        onSwitchProfileScreen={() => setShowProfileSelector(true)}
        onOpenAdminDashboard={
          currentAccount.role === "admin" ? openAdminDashboard : undefined
        }
        onLogout={handleLogoutRequest}
      />
    );
  } else {
    appContent = (
      <div className="min-h-screen bg-[#070b16] text-white font-sans selection:bg-blue-600 selection:text-white">
        {/* 1. Who's Watching Profile Selector Screen */}
        <AnimatePresence mode="wait">
          {showProfileSelector && (
            <motion.div
              key="profile-selector-view"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="w-full"
            >
              <ProfileSelector
                currentAccount={currentAccount}
                profiles={profiles}
                onSelectProfile={handleSelectProfile}
                onUpdateProfiles={handleUpdateProfiles}
                onAddProfile={handleAddProfile}
                onDeleteProfile={handleDeleteProfile}
                onLogout={handleLogoutRequest}
                onOpenAdminDashboard={
                  currentAccount.role === "admin"
                    ? openAdminDashboard
                    : undefined
                }
                onShowToast={showToast}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* 2. Fullscreen HLS Video Player - GauPlayer minimal style */}
        <AnimatePresence mode="wait">
          {playingMovie && playingEpisode && playingServer && (
            <GauPlayer
              key={`player-${playingMovie.slug}-${playingEpisode.slug}`}
              movie={playingMovie}
              currentEpisode={playingEpisode}
              currentServer={playingServer}
              allServers={allServers}
              initialTime={initialResumeTime}
              onBack={closePlayer}
              onSelectEpisode={handleSelectEpisode}
              onSaveProgress={handleSaveProgress}
              onTimeUpdate={handlePlayerTimeUpdate}
              currentAccount={currentAccount}
              activeProfile={activeProfile}
              isResolvingSource={playingEpisode.slug === RESOLVING_EPISODE_SLUG}
            />
          )}
        </AnimatePresence>

        {/* 3. Main Navigation Header */}
        {!playingMovie && !showProfileSelector && (
          <Navbar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            currentAccount={currentAccount}
            activeProfile={activeProfile}
            profiles={profiles}
            onSelectProfile={handleQuickSwitchProfile}
            onSwitchProfileScreen={openProfileSelector}
            onSelectMovie={(movie) => openDetailModal(movie)}
            onPlayMovie={handlePlayMovie}
            onSearchSubmit={handleSearchSubmit}
            onOpenAdminDashboard={
              currentAccount.role === "admin" ? openAdminDashboard : undefined
            }
            onLogout={handleLogoutRequest}
            onSwitchApp={handleSwitchApp}
            onRefreshHome={fetchHomeData}
          />
        )}

        {/* 4. Tab Views Content - transition mượt như gấu manga, chống flash */}
        {!showProfileSelector && !playingMovie && (
          <main className="relative min-h-[calc(100vh-160px)] pb-24 md:pb-16">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`tab-${activeTab}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                style={{ willChange: "opacity" }}
              >
                {/* HOME TAB */}
                {activeTab === "home" && (
                  <>
                    {/* Featured Cinematic Hero Banner - TMDB Popular (en-US, region VN) đã validate có trong API phim hiện tại */}
                    <HeroBanner
                      movies={(() => {
                        // Luôn đảm bảo 10 phim: TMDB hero + bù local nếu thiếu (tránh lúc 8 lúc 10 do validate rớt)
                        if (heroTmdbMovies && heroTmdbMovies.length > 0) {
                          if (heroTmdbMovies.length >= 10) return heroTmdbMovies.slice(0, 10);
                          const merged = [...newUpdated, ...topHotAll, ...theaterList];
                          const uniq = Array.from(new Map(merged.map((m) => [m.slug, m])).values());
                          const filler = uniq.filter((m) => !heroTmdbMovies.some((h) => h.slug === m.slug));
                          return [...heroTmdbMovies, ...filler].slice(0, 10);
                        }
                        // Fallback trong lúc chờ TMDB hero load hoặc khi TMDB lỗi: dùng logic cũ (ưu tiên có TMDB)
                        const merged = [...newUpdated, ...topHotAll, ...theaterList, ...topSeries, ...topSingle];
                        const uniq = Array.from(new Map(merged.map((m) => [m.slug, m])).values());
                        const withTmdb = uniq.filter((m: any) => m?.tmdb?.id && String(m.tmdb.id).trim() && /^\d+$/.test(String(m.tmdb.id).trim()));
                        const withoutTmdb = uniq.filter((m: any) => !m?.tmdb?.id || !/^\d+$/.test(String(m?.tmdb?.id || '').trim()));
                        const ordered = [...withTmdb, ...withoutTmdb];
                        const result = ordered.slice(0, 10);
                        if (result.length < 10 && newUpdated.length > result.length) {
                          const extra = newUpdated.filter((m) => !result.some((r) => r.slug === m.slug)).slice(0, 10 - result.length);
                          return [...result, ...extra].slice(0, 10);
                        }
                        return result.length >= 1 ? result : newUpdated.slice(0, 10);
                      })()}
                      onPlay={handlePlayMovie}
                      onOpenDetail={(m) => openDetailModal(m)}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />

                    {/* Followed - Báo tập mới */}
                    {followedMovies.length > 0 && (
                      <FollowedRow
                        items={followedMovies}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onPlay={(m) => {
                          handlePlayMovie(m);
                          handleFollowSeen(m.slug);
                        }}
                        onClearNew={(slug) => handleFollowSeen(slug)}
                        onUnfollow={(slug) => {
                          followMovieService.unfollow(
                            currentAccount!.id,
                            activeProfile!.id,
                            slug,
                          );
                          showToast("Đã bỏ theo dõi", "info");
                        }}
                      />
                    )}

                    {/* Continue Watching Row - Chính xác hơn */}
                    {(() => {
                      const filtered = [...watchHistory]
                        .filter((h) => {
                          // ẩn phim đã xem xong >92% hoặc mới bấm nhầm <2%
                          if (h.progressPercent >= 92) return false;
                          if (h.progressPercent < 2 && h.currentTime < 15)
                            return false;
                          return true;
                        })
                        .sort((a, b) => b.updatedAt - a.updatedAt)
                        .slice(0, 6);
                      if (filtered.length === 0) return null;
                      const fmt = (s: number) => {
                        if (!s || s < 0) return "00:00";
                        const h = Math.floor(s / 3600),
                          m = Math.floor((s % 3600) / 60);
                        const sec = Math.floor(s % 60);
                        if (h > 0)
                          return `${h}:${String(m).padStart(2, "0")}:${String(
                            sec,
                          ).padStart(2, "0")}`;
                        return `${String(m).padStart(2, "0")}:${String(
                          sec,
                        ).padStart(2, "0")}`;
                      };
                      return (
                        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-2 mb-4">
                          <div className="flex items-center justify-between mb-3">
                            <h2 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
                              <Sparkles className="w-5 h-5 text-sky-400" />
                              <span>Tiếp Tục Xem ({activeProfile?.name})</span>
                              <span className="text-[11px] font-bold text-slate-400 bg-slate-800 px-2 py-0.5 rounded-full border border-slate-700">
                                {filtered.length}
                              </span>
                            </h2>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleTabChange("history")}
                                className="text-xs text-slate-400 hover:text-white cursor-pointer"
                              >
                                Xem tất cả →
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 overflow-x-auto pb-3 scrollbar-none">
                            {filtered.map((item, idx) => {
                              const remaining = Math.max(
                                0,
                                (item.duration || 0) - (item.currentTime || 0),
                              );
                              const pct = Math.round(item.progressPercent || 0);
                              return (
                                <div
                                  key={`${item.movieSlug}-${idx}`}
                                  tabIndex={0}
                                  data-tv-card={`history-${item.movieSlug}`}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === "NumpadEnter" || e.key === " ") {
                                      e.preventDefault();
                                      handleResumeHistoryItem(item);
                                      handleFollowSeen(item.movieSlug, item.episodeName);
                                    }
                                  }}
                                  onClick={() => {
                                    handleResumeHistoryItem(item);
                                    handleFollowSeen(
                                      item.movieSlug,
                                      item.episodeName,
                                    );
                                  }}
                                  className="group relative w-64 shrink-0 bg-[#0f172a] rounded-2xl overflow-hidden border border-blue-900/50 hover:border-blue-500/80 transition-all cursor-pointer shadow-md hover:scale-105 focus:outline-none focus:ring-4 focus:ring-blue-500"
                                >
                                  <div className="relative aspect-video w-full">
                                    <img
                                      src={item.movieThumb || item.moviePoster}
                                      alt={item.movieName}
                                      className="w-full h-full object-cover"
                                    />
                                    <div className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                      <span className="bg-blue-600 text-white p-2.5 rounded-full shadow-xl shadow-blue-600/40">
                                        ▶
                                      </span>
                                    </div>
                                    <div className="absolute top-2 left-2 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded border border-white/20">
                                      {item.episodeName.startsWith("Tập")
                                        ? item.episodeName
                                        : `Tập ${item.episodeName}`}{" "}
                                      • {pct}%
                                    </div>
                                    {remaining > 0 && (
                                      <div className="absolute top-2 right-2 bg-blue-600/90 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                                        Còn {fmt(remaining)}
                                      </div>
                                    )}
                                    <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-slate-800">
                                      <div
                                        className="h-full bg-gradient-to-r from-blue-500 to-cyan-400"
                                        style={{
                                          width: `${Math.min(100, pct)}%`,
                                        }}
                                      />
                                    </div>
                                  </div>
                                  <div className="p-3">
                                    <h4 className="font-semibold text-xs text-white truncate">
                                      {item.movieName}
                                    </h4>
                                    <p className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1">
                                      {item.serverName} •{" "}
                                      {fmt(item.currentTime)} /{" "}
                                      {fmt(item.duration)}{" "}
                                      <span className="text-sky-400 font-semibold">
                                        {pct}%
                                      </span>
                                    </p>
                                    <p className="text-[10px] text-slate-500">
                                      {new Date(item.updatedAt).toLocaleString(
                                        "vi-VN",
                                      )}
                                    </p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {/* "Dành Riêng Cho Bạn" Personalized Recommendation Row */}
                    <ForYouRow
                      watchHistory={watchHistory}
                      activeProfileName={activeProfile?.name}
                      onOpenDetail={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />

                    {/* Dedicated Netflix & Chill Zone */}
                    {(netflixTop10Movies?.length > 0 || netflixTop10TV?.length > 0) && (
                      <div className="relative my-8 p-4 sm:p-6 sm:pb-8 rounded-3xl bg-gradient-to-r from-[#140204]/90 via-[#0a0a0d] to-[#120005]/95 border border-red-900/40 shadow-[0_0_50px_rgba(229,9,20,0.15)] overflow-hidden">
                        {/* Ambient Glow Background Accent */}
                        <div className="absolute top-0 left-1/4 w-96 h-48 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />
                        
                        {/* Section Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 relative z-10 border-b border-red-900/30 pb-4 px-2">
                          <div className="flex items-center gap-3">
                            <img
                              src="https://occ.a.nflxso.net/dnmt/api/v6/iL4oJVDYZ8KLSrJ6eG2OwtghbfQ/AAAAAWiPHORowsUPy4Ef8HnCO9JXGoNeHRyWtWY4xZAfUtau5iCnG2Ko_-8QuKVa8P6wtpfnyGopi4LoAha-VghVRE_N6kRqhwpLQCpga5tzrlTEHRGHgzpa9PYmEEEgQyuEdhsyq9vmhmPR.svg"
                              alt="Netflix"
                              className="h-8 sm:h-10 w-auto object-contain drop-shadow-[0_2px_10px_rgba(229,9,20,0.5)]"
                              referrerPolicy="no-referrer"
                            />
                            <div>
                              <div className="flex items-center gap-2">
                                <h2 className="text-2xl sm:text-3xl font-black text-white tracking-wide">
                                  Netflix & Chill
                                </h2>
                                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-600/20 text-red-500 border border-red-500/30 flex items-center gap-1">
                                  <Flame className="w-3.5 h-3.5 fill-red-500 text-red-500" /> TOP 10 VN
                                </span>
                              </div>
                              <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
                                Cập nhật tự động những bộ phim đang làm mưa làm gió trên Netflix Việt Nam
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* 2 Top 10 Carousels */}
                        <div className="space-y-6 relative z-10">
                          {netflixTop10Movies && netflixTop10Movies.length > 0 && (
                            <Top10Carousel
                              title="Top 10 phim tại Việt Nam hôm nay"
                              movies={netflixTop10Movies}
                              onOpenDetail={(m) => openDetailModal(m)}
                              onPlay={handlePlayMovie}
                              accentColor="#E50914"
                            />
                          )}

                          {netflixTop10TV && netflixTop10TV.length > 0 && (
                            <Top10Carousel
                              title="Top 10 series tại Việt Nam hôm nay"
                              movies={netflixTop10TV}
                              onOpenDetail={(m) => openDetailModal(m)}
                              onPlay={handlePlayMovie}
                              accentColor="#E50914"
                            />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Categorized Rows */}
                    <div className="space-y-4">
                      {isTvView ? (
                        <MovieRow
                          title="Top Phim Hot Nhất Hôm Nay"
                          movies={topHotAll}
                          pending={!homeSettled}
                          onOpenDetail={(m) => openDetailModal(m)}
                          onSelectMovie={(m) => openDetailModal(m)}
                          onPlay={handlePlayMovie}
                          onPlayMovie={handlePlayMovie}
                          onToggleMyList={handleToggleMyList}
                          isInMyList={isInMyList}
                        />
                      ) : (
                        <Theater3DCarousel
                          title="Top Phim Hot Nhất Hôm Nay"
                          movies={topHotAll}
                          onOpenDetail={(m) => openDetailModal(m)}
                          onPlay={handlePlayMovie}
                        />
                      )}

                      <Top10Carousel
                        title="Top 10 Phim Bộ Hôm Nay"
                        movies={topSeries}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                      />

                      <MovieRow
                        title="Anime & Hoạt Hình"
                        icon={<Smile className="w-5 h-5 text-emerald-400" />}
                        movies={animeList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Điện Ảnh Hàn Quốc"
                        icon={
                          <Clapperboard className="w-5 h-5 text-blue-400" />
                        }
                        movies={koreanList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Hành Động Đỉnh Cao"
                        icon={<Sword className="w-5 h-5 text-red-400" />}
                        movies={actionList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <Top10Carousel
                        title="Top 10 Phim Lẻ Hôm Nay"
                        movies={topSingle}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                      />

                      <MovieRow
                        title="Phim Mới Cập Nhật"
                        icon={<Flame className="w-5 h-5 text-amber-400" />}
                        movies={newUpdated}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Phim Bộ Hot"
                        icon={<Tv className="w-5 h-5 text-sky-400" />}
                        movies={seriesList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Phim Lẻ Đặc Sắc"
                        icon={<Film className="w-5 h-5 text-indigo-400" />}
                        movies={singleList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Tình Cảm & Lãng Mạn"
                        icon={<Heart className="w-5 h-5 text-pink-400" />}
                        movies={romanceList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Kinh Dị & Bí Ẩn"
                        icon={<Flame className="w-5 h-5 text-purple-400" />}
                        movies={horrorList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      <MovieRow
                        title="Viễn Tưởng & Phiêu Lưu"
                        icon={<Sparkles className="w-5 h-5 text-cyan-400" />}
                        movies={sciFiList}
                        pending={!homeSettled}
                        onOpenDetail={(m) => openDetailModal(m)}
                        onSelectMovie={(m) => openDetailModal(m)}
                        onPlay={handlePlayMovie}
                        onPlayMovie={handlePlayMovie}
                        onToggleMyList={handleToggleMyList}
                        isInMyList={isInMyList}
                      />

                      {isTvView ? (
                        <MovieRow
                          title="Mãn Nhãn Phim Chiếu Rạp"
                          movies={theaterList}
                          pending={!homeSettled}
                          onOpenDetail={(m) => openDetailModal(m)}
                          onSelectMovie={(m) => openDetailModal(m)}
                          onPlay={handlePlayMovie}
                          onPlayMovie={handlePlayMovie}
                          onToggleMyList={handleToggleMyList}
                          isInMyList={isInMyList}
                        />
                      ) : (
                        <CinematicCarousel
                          title="Mãn Nhãn Phim Chiếu Rạp"
                          movies={theaterList}
                          onOpenDetail={(m) => openDetailModal(m)}
                          onPlay={handlePlayMovie}
                        />
                      )}
                    </div>
                  </>
                )}

                {/* SERIES TAB */}
                {activeTab === "series" && (
                  <div className="pt-20">
                    <FilterSection
                      key="tab-series"
                      fixedType="series"
                      onOpenDetail={(m) => openDetailModal(m)}
                      onSelectMovie={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onPlayMovie={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />
                  </div>
                )}

                {/* SINGLE MOVIES TAB */}
                {activeTab === "single" && (
                  <div className="pt-20">
                    <FilterSection
                      key="tab-single"
                      fixedType="single"
                      onOpenDetail={(m) => openDetailModal(m)}
                      onSelectMovie={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onPlayMovie={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />
                  </div>
                )}

                {/* ANIME TAB */}
                {activeTab === "anime" && (
                  <div className="pt-20">
                    <FilterSection
                      key="tab-anime"
                      fixedType="anime"
                      onOpenDetail={(m) => openDetailModal(m)}
                      onSelectMovie={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onPlayMovie={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />
                  </div>
                )}

                {/* TV SHOWS TAB */}
                {activeTab === "tv-shows" && (
                  <div className="pt-20">
                    <FilterSection
                      key="tab-tv-shows"
                      fixedType="tv-shows"
                      onOpenDetail={(m) => openDetailModal(m)}
                      onSelectMovie={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onPlayMovie={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />
                  </div>
                )}

                {/* FILTER & EXPLORE TAB */}
                {activeTab === "filter" && (
                  <div className="pt-20">
                    <FilterSection
                      key={`filter-${filterCountry}-${filterGenre}-${searchKeyword}`}
                      initialKeyword={searchKeyword}
                      initialCountry={filterCountry}
                      initialGenre={filterGenre}
                      onOpenDetail={(m) => openDetailModal(m)}
                      onSelectMovie={(m) => openDetailModal(m)}
                      onPlay={handlePlayMovie}
                      onPlayMovie={handlePlayMovie}
                      onToggleMyList={handleToggleMyList}
                      isInMyList={isInMyList}
                    />
                  </div>
                )}

                {/* WATCH TOGETHER TAB */}
                {activeTab === "xem-chung" && (
                  <div className="pt-20 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16">
                    <div className="flex items-center gap-3 mb-6">
                      <Users className="w-6 h-6 text-emerald-400" />
                      <h1 className="text-2xl font-bold text-white">
                        Phòng đang xem chung
                      </h1>
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-600/20 text-emerald-400 text-xs font-bold">
                        {allActiveRooms.length}
                      </span>
                    </div>

                    {allActiveRooms.length === 0 ? (
                      <div className="text-center py-20">
                        <Users className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                        <p className="text-slate-400 text-sm">
                          Chưa có phòng xem chung nào đang hoạt động.
                        </p>
                        <p className="text-slate-500 text-xs mt-1">
                          Hãy tạo phòng từ trang chi tiết phim!
                        </p>
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {allActiveRooms.map((room) => (
                          <div
                            key={room.roomId}
                            className="p-4 rounded-2xl bg-[#0f172a] border border-slate-700/40 hover:border-emerald-500/30 transition-all cursor-pointer group"
                            onClick={() => {
                              if (activeRoomId) {
                                showToast(
                                  "Bạn đang ở trong một phòng khác. Vui lòng rời phòng trước.",
                                  "warning",
                                );
                                return;
                              }
                              if (room.visibility === "public") {
                                handleJoinRoom(room.roomId, "");
                              } else {
                                setJoinRoomTarget(room);
                              }
                            }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div className="min-w-0 flex-1">
                                <h3 className="text-sm font-bold text-white truncate group-hover:text-emerald-300 transition-colors">
                                  {room.filmName}
                                </h3>
                                <p className="text-xs text-sky-400 mt-0.5">
                                  {room.episode}
                                </p>
                              </div>
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-700/50 text-slate-400 shrink-0 ml-2">
                                {room.visibility === "private"
                                  ? "🔒 Private"
                                  : "🌐 Public"}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-xs text-slate-400">
                              <span className="flex items-center gap-1">
                                <Users className="w-3 h-3" />
                                {room.viewersCount} đang xem
                              </span>
                              <span>Host: {room.hostName}</span>
                            </div>
                            <div className="mt-3 flex items-center justify-between">
                              <span className="text-[10px] text-slate-500">
                                {new Date(room.createdAt).toLocaleTimeString(
                                  "vi-VN",
                                  { hour: "2-digit", minute: "2-digit" },
                                )}
                              </span>
                              <button
                                disabled={!!activeRoomId}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                  activeRoomId
                                    ? "bg-slate-700/30 text-slate-500 cursor-not-allowed"
                                    : "bg-emerald-600 hover:bg-emerald-500 text-white"
                                }`}
                              >
                                Vào phòng
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* MY LIST TAB */}
                {activeTab === "my-list" && (
                  <div className="pt-20">
                    <MyListView
                      myList={myList}
                      profileName={activeProfile?.name || "Bạn"}
                      onSelectMovieSlug={(slug, name, thumb) =>
                        handleOpenDetailSlug(slug, name, thumb)
                      }
                      onPlayMovieSlug={(slug) => handlePlaySlug(slug)}
                      onRemoveItem={async (slug) => {
                        if (!currentAccount || !activeProfile) return;
                        await firestoreStorage.toggleMyList(
                          currentAccount.id,
                          activeProfile.id,
                          {
                            movieSlug: slug,
                            movieName: "",
                            movieThumb: "",
                          },
                        );
                        await refreshProfileData();
                        showToast("Đã xóa khỏi danh sách yêu thích");
                      }}
                      onExploreClick={() => handleTabChange("filter")}
                    />
                  </div>
                )}

                {/* WATCH HISTORY TAB */}
                {activeTab === "history" && (
                  <div className="pt-20">
                    <HistoryView
                      history={watchHistory}
                      profileName={activeProfile?.name || "Bạn"}
                      onResumeItem={handleResumeHistoryItem}
                      onRemoveItem={async (slug) => {
                        if (!currentAccount || !activeProfile) return;
                        await firestoreStorage.removeHistoryItem(
                          currentAccount.id,
                          activeProfile.id,
                          slug,
                        );
                        await refreshProfileData();
                        showToast("Đã xóa khỏi lịch sử xem");
                      }}
                      onClearAll={async () => {
                        if (!currentAccount || !activeProfile) return;
                        await Promise.all(
                          watchHistory.map((item) =>
                            firestoreStorage.removeHistoryItem(
                              currentAccount.id,
                              activeProfile.id,
                              item.movieSlug,
                            ),
                          ),
                        );
                        await refreshProfileData();
                        showToast("Đã dọn sạch lịch sử xem của hồ sơ");
                      }}
                      onExploreClick={() => handleTabChange("home")}
                    />
                  </div>
                )}

                {/* OFFLINE SAVED TAB - ONLY ON NATIVE APP */}
                {activeTab === "offline" && (
                  <div className="pt-2">
                    <OfflineSavedView
                      currentAccount={currentAccount}
                      activeProfile={activeProfile}
                      onPlayMovie={handlePlayMovie}
                      onOpenDetail={(m) => openDetailModal(m)}
                      onShowToast={showToast}
                    />
                  </div>
                )}

                {/* LIVE TV & SPORTS TAB (Now handled by Sub-App, but keep fallback) */}
                {activeTab === "tv-live" && (
                  <div className="pt-20 text-center text-slate-400">
                    Vui lòng sử dụng tính năng App Switcher để chuyển sang Gấu
                    LiveTV
                  </div>
                )}

                {/* MANGA READER TAB (Now handled by Sub-App, but keep fallback) */}
                {activeTab === "manga" && (
                  <div className="pt-20 text-center text-slate-400">
                    Vui lòng sử dụng tính năng App Switcher để chuyển sang Gấu
                    Manga
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        )}

        {/* 5. Movie Detail Modal */}
        <AnimatePresence mode="wait">
          {selectedMovieForDetail && !activeRoomId && (
            <MovieDetailModal
              key={`detail-${selectedMovieForDetail.slug}`}
              movie={selectedMovieForDetail}
              onClose={closeDetailModal}
              onPlayMovie={handlePlayMovie}
              onPlayEpisode={handlePlayEpisode}
              onToggleMyList={handleToggleMyList}
              isInMyList={isInMyList}
              onSelectRelatedMovie={(m) => openDetailModal(m)}
              onSearchSubmit={handleSearchSubmit}
              onSelectGenre={handleSelectGenre}
              onSelectCountry={handleSelectCountry}
              currentAccount={currentAccount}
              activeProfile={activeProfile}
              activeRooms={activeRoomsForFilm}
              userActiveRoomId={activeRoomId}
              onCreateRoom={handleCreateRoom}
              onJoinRoom={handleJoinRoom}
              onShowToast={showToast}
            />
          )}
        </AnimatePresence>

        {/* 5b. Watch Together Room */}
        {activeRoomId && !activeRoomData && currentAccount && (
          <div className="fixed inset-0 z-[80] bg-[#060a14] flex items-center justify-center">
            <div className="text-center space-y-3">
              <Loader2 className="w-8 h-8 text-sky-400 animate-spin mx-auto" />
              <p className="text-sm text-slate-300">Đang vào phòng...</p>
            </div>
          </div>
        )}
        {activeRoomId && activeRoomData && currentAccount && activeProfile && (
          <WatchTogetherRoom
            room={activeRoomData}
            currentUserId={currentAccount.id}
            currentUserName={activeProfile.name || currentAccount.displayName}
            currentUserAvatar={activeProfile.avatar}
            onLeave={handleLeaveRoom}
            onEndRoom={handleEndRoom}
            onRoomClosed={() => {
              handleLeaveRoom();
              setActiveTab("xem-chung");
            }}
          />
        )}

        {/* Join Room Modal (from Xem Chung tab) */}
        {joinRoomTarget && (
          <JoinRoomModal
            isOpen={!!joinRoomTarget}
            roomId={joinRoomTarget.roomId}
            hostName={joinRoomTarget.hostName}
            episode={joinRoomTarget.episode}
            viewersCount={joinRoomTarget.viewersCount}
            onClose={() => setJoinRoomTarget(null)}
            onSubmit={async (password) => {
              await handleJoinRoom(joinRoomTarget.roomId, password);
              setJoinRoomTarget(null);
            }}
          />
        )}

        {/* 6. Comprehensive Footer */}
        {!showProfileSelector && !playingMovie && (
          <footer className="border-t border-slate-800/80 bg-[#070b16] py-8 px-4 sm:px-6 lg:px-8 text-xs text-slate-500">
            <div className="max-w-7xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pb-6 border-b border-slate-900">
                <div className="flex items-center gap-3">
                  <span className="text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-300 to-cyan-400">
                    Gấu Cinema HD
                  </span>
                  <span className="text-slate-600">|</span>
                  <span className="text-slate-300 font-semibold">
                    Rạp Phim Cá Nhân Gia Đình
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <div className="flex items-center gap-1.5 text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-3 py-1 rounded-full text-[11px] font-medium">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>100% Phi Thương Mại & Không Quảng Cáo</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sky-400 bg-sky-950/40 border border-sky-800/40 px-3 py-1 rounded-full text-[11px] font-medium">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Bảo Mật Riêng Biệt 5 Hồ Sơ</span>
                  </div>
                </div>
              </div>

              {/* Quick Navigation Directory */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1 text-slate-400">
                <div className="space-y-1.5">
                  <p className="text-slate-200 font-semibold uppercase text-[11px] tracking-wider">
                    Khám Phá
                  </p>
                  <p
                    onClick={() => handleTabChange("home")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Trang Chủ
                  </p>
                  <p
                    onClick={() => handleTabChange("series")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Phim Bộ
                  </p>
                  <p
                    onClick={() => handleTabChange("single")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Phim Lẻ
                  </p>
                  <p
                    onClick={() => handleTabChange("anime")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Anime & Hoạt Hình
                  </p>
                </div>
                <div className="space-y-1.5">
                  <p className="text-slate-200 font-semibold uppercase text-[11px] tracking-wider">
                    Hồ Sơ Của Bạn
                  </p>
                  <p
                    onClick={() => setShowProfileSelector(true)}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    5 Hồ Sơ Người Xem
                  </p>
                  <p
                    onClick={() => handleTabChange("my-list")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Danh Sách Đã Lưu
                  </p>
                  <p
                    onClick={() => handleTabChange("history")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Lịch Sử & Tiến Độ Xem
                  </p>
                  <p
                    onClick={() => handleTabChange("filter")}
                    className="hover:text-sky-300 cursor-pointer transition-colors"
                  >
                    Tìm Kiếm Nâng Cao
                  </p>
                </div>
                <div className="space-y-1.5">
                  <p className="text-slate-200 font-semibold uppercase text-[11px] tracking-wider">
                    Công Nghệ
                  </p>
                  <p className="text-slate-400">Stream HLS .m3u8 Full HD</p>
                  <p className="text-slate-400">
                    Tự động chuyển tập thông minh
                  </p>
                  <p className="text-slate-400">Đồng bộ Firebase Cloud</p>
                  <p className="text-slate-400">Tối ưu iPhone / iPad / PC</p>
                </div>
                <div className="space-y-1.5">
                  <p className="text-slate-200 font-semibold uppercase text-[11px] tracking-wider">
                    Bản Quyền & Nguồn
                  </p>
                  <p className="text-slate-400">
                    Dữ liệu nguồn mở (Public APIs)
                  </p>
                  <p className="text-slate-400">
                    Không lưu trữ video trên máy chủ
                  </p>
                  <p className="text-slate-400">Không thu phí người dùng</p>
                  <p className="text-slate-400">Bảo vệ bản quyền gốc</p>
                </div>
              </div>

              {/* Formal Disclaimer Box */}
              <div className="p-4 rounded-2xl bg-[#0c1427] border border-blue-900/50 space-y-2.5 text-slate-400 text-[11px] leading-relaxed">
                <div className="flex items-center gap-2 text-sky-300 font-bold uppercase tracking-wider text-xs">
                  <Info className="w-4 h-4 text-sky-400 shrink-0" />
                  <span>Tuyên Bố Miễn Trừ Trách Nhiệm & Mục Đích Sử Dụng</span>
                </div>
                <p>
                  <strong className="text-slate-200">
                    1. Dự án cá nhân phi thương mại:
                  </strong>{" "}
                  Website này là một sản phẩm nghiên cứu, học tập công nghệ và
                  phục vụ nhu cầu giải trí cá nhân/gia đình (Non-commercial
                  Personal Project). Trang web hoàn toàn <strong>KHÔNG</strong>{" "}
                  kinh doanh, <strong>KHÔNG</strong> buôn bán,{" "}
                  <strong>KHÔNG</strong> thu bất kỳ khoản phí nào và{" "}
                  <strong>KHÔNG</strong> chèn bất kỳ hình thức quảng cáo thương
                  mại kiếm tiền nào.
                </p>
                <p>
                  <strong className="text-slate-200">
                    2. Không lưu trữ tệp tin đa phương tiện:
                  </strong>{" "}
                  Hệ thống hoàn toàn không lưu trữ, không tải lên và không tự ý
                  phân phối bất kỳ tệp tin video/phim bản quyền nào trên máy chủ
                  riêng. Toàn bộ hình ảnh, thông tin mô tả và luồng phát được
                  nhúng tự động theo thời gian thực từ các giao diện lập trình
                  mở công khai trên Internet. Mọi bản quyền tác giả, nhãn hiệu
                  và quyền phát hành thuộc về các nhà sản xuất và chủ sở hữu tác
                  quyền hợp pháp tương ứng.
                </p>
              </div>

              {/* Bottom Copyright Note */}
              <div className="pt-2 border-t border-slate-900/90 flex flex-col sm:flex-row items-center justify-between gap-2 text-slate-500 text-[11px]">
                <p>
                  © 2026 Gấu Cinema • Dự án cá nhân phi lợi nhuận • Trải nghiệm
                  điện ảnh gia đình chất lượng cao.
                </p>
                <p className="text-slate-600">
                  Private Personal & Educational Use Only
                </p>
              </div>
            </div>
          </footer>
        )}

        {/* 7. Mobile Bottom Dock Navigation (iOS & Android) */}
        {!showProfileSelector && !playingMovie && (
          <MobileBottomNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            activeProfile={activeProfile}
            profiles={profiles}
            onSelectProfile={handleQuickSwitchProfile}
            onSwitchProfileScreen={openProfileSelector}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <RouteSync expected={expectedRoute} onRoute={applyLocationRoute} activeApp={activeApp} />
      <NotificationTickerBanner currentAccount={currentAccount} />
      {/* Maintenance Warning Banner */}
      {maintenanceMessage && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-gradient-to-r from-red-600 via-orange-500 to-red-600 text-white px-4 py-2.5 flex items-center justify-between shadow-lg animate-pulse">
          <div className="flex items-center gap-2 text-xs sm:text-sm font-bold">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{maintenanceMessage}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono bg-white/20 px-2 py-0.5 rounded">
              {Math.floor(maintenanceCountdown / 60)}:
              {String(maintenanceCountdown % 60).padStart(2, "0")}
            </span>
            <button
              onClick={() => handleSwitchApp("cinema")}
              className="text-xs font-bold bg-white/20 hover:bg-white/30 px-3 py-1 rounded-lg transition-colors cursor-pointer"
            >
              Về Cinema ngay
            </button>
          </div>
        </div>
      )}
      {appContent}
      {isSwitchingApp && targetApp && (
        <AppSwitcherLoading
          targetApp={targetApp}
          onLoadingComplete={handleSwitchAppComplete}
        />
      )}
      <ProfileSwitchLoader
        isOpen={isProfileSwitchLoaderOpen}
        profileA={profileSwitchSrc}
        profileB={profileSwitchTarget}
        isDataReady={isProfileDataReady}
        onComplete={handleProfileSwitchLoaderComplete}
      />
      {dialog && (
        <CustomDialog
          isOpen={dialog.isOpen}
          onClose={closeDialog}
          title={dialog.title}
          message={dialog.message}
          type={dialog.type}
          confirmText={dialog.confirmText}
          cancelText={dialog.cancelText}
          onConfirm={dialog.onConfirm}
          showCancel={dialog.showCancel}
        />
      )}
      <ConfirmDialog
        isOpen={showExitConfirmModal}
        onClose={() => setShowExitConfirmModal(false)}
        onConfirm={handleExitApp}
        title="Thoát ứng dụng"
        message="Bạn có chắc chắn muốn thoát ứng dụng không?"
        confirmText="Thoát"
        cancelText="Ở lại"
        type="danger"
      />
      <ConfirmDialog
        isOpen={showLogoutConfirm}
        onClose={() => setShowLogoutConfirm(false)}
        onConfirm={handleLogout}
        title="Đăng xuất"
        message="Đăng xuất sẽ phải đăng nhập lại (gõ mật khẩu hoặc ghép đôi). Bạn chắc chứ?"
        confirmText="Đăng xuất"
        cancelText="Ở lại"
        type="warning"
      />
      <ToastContainer toasts={toasts} onRemove={() => {}} />
      <TvDebugPanel />
    </>
  );
}
