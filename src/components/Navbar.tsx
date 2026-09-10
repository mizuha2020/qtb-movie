import React, { useEffect, useRef, useState } from 'react';
import { Account, NavTab, UserProfile, ApiSource } from '../types';
import { appConfigService } from '../services/appConfigService';
import {
  Search,
  ChevronDown,
  User,
  X,
  Check,
  Clock,
  Bookmark,
  Layers,
  Play,
  Info,
  Settings,
  LogOut,
  Shield,
  Lock,
  Database,
  Server,
  Sparkles,
  LayoutGrid,
  Tv,
  BookOpen,
  Download,
  HardDrive,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { movieApi, getImageUrl, API_SOURCES } from '../services/movieApi';
import { getFullApiUrl } from '../services/apiConfig';
import { Movie } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { TvPairApproveModal } from './TvPairApproveModal';
import appLogo from '../assets/images/app_logo.jpg';

interface NavbarProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  currentAccount: Account | null;
  activeProfile: UserProfile | null;
  profiles: UserProfile[];
  onSelectProfile: (profile: UserProfile) => void;
  onSwitchProfileScreen: () => void;
  onSelectMovie: (movie: Movie) => void;
  onPlayMovie?: (movie: Movie) => void;
  onSearchSubmit: (query: string) => void;
  onOpenAdminDashboard?: () => void;
  onLogout?: () => void;
  onSwitchApp: (app: 'cinema' | 'manga' | 'livetv') => void;
  onRefreshHome?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  onTabChange,
  currentAccount,
  activeProfile,
  profiles,
  onSelectProfile,
  onSwitchProfileScreen,
  onSelectMovie,
  onPlayMovie,
  onSearchSubmit,
  onOpenAdminDashboard,
  onLogout,
  onSwitchApp,
  onRefreshHome,
}) => {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Movie[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isPairModalOpen, setIsPairModalOpen] = useState(false);

  // Profile PIN prompt state
  const [pinPromptProfile, setPinPromptProfile] = useState<UserProfile | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const pinFormRef = useRef<HTMLFormElement>(null);

  // Remote TV: đủ 4 số là tự mở khóa
  useEffect(() => {
    if (!pinPromptProfile || enteredPin.length !== 4 || pinError) return;
    const t = setTimeout(() => {
      try {
        pinFormRef.current?.requestSubmit();
      } catch {}
    }, 350);
    return () => clearTimeout(t);
  }, [enteredPin, pinPromptProfile, pinError]);

  // App Config (real-time)
  const [appConfig, setAppConfig] = useState<Record<string, { enabled: boolean }>>({});

  const isNativeApp = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();

  useEffect(() => {
    const unsub = appConfigService.subscribe((cfg) => setAppConfig(cfg));
    return unsub;
  }, []);

  const handleProfileClickInDropdown = (p: UserProfile) => {
    if (p.id === activeProfile?.id) {
      setIsProfileMenuOpen(false);
      return;
    }
    if (p.pin) {
      setPinPromptProfile(p);
      setEnteredPin('');
      setPinError(false);
      setIsProfileMenuOpen(false);
    } else {
      onSelectProfile(p);
      setIsProfileMenuOpen(false);
    }
  };

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinPromptProfile && enteredPin === pinPromptProfile.pin) {
      onSelectProfile(pinPromptProfile);
      setPinPromptProfile(null);
      setEnteredPin('');
      setPinError(false);
    } else {
      setPinError(true);
    }
  };

  const searchInputRef = useRef<HTMLInputElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const mobileSearchOverlayRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuToggleRef = useRef<HTMLButtonElement>(null);

  // Background transition on scroll
  useEffect(() => {
    const handleScroll = () => {
      if (window.scrollY > 40) {
        setIsScrolled(true);
      } else {
        setIsScrolled(false);
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close menus on outside click or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setIsProfileMenuOpen(false);
      }
      if (appMenuRef.current && !appMenuRef.current.contains(e.target as Node)) {
        setIsAppMenuOpen(false);
      }
      if (
        mobileMenuRef.current &&
        !mobileMenuRef.current.contains(e.target as Node) &&
        mobileMenuToggleRef.current &&
        !mobileMenuToggleRef.current.contains(e.target as Node)
      ) {
        setIsMobileMenuOpen(false);
      }
      const isInsideDesktop = searchContainerRef.current?.contains(e.target as Node);
      const isInsideMobile = mobileSearchOverlayRef.current?.contains(e.target as Node);
      if (!isInsideDesktop && !isInsideMobile) {
        setIsSearchOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        setIsProfileMenuOpen(false);
        setIsAppMenuOpen(false);
        setIsMobileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Prevent body scroll ONLY when mobile menu or mobile search overlay is open (not on desktop PC)
  useEffect(() => {
    const isMobileScreen = typeof window !== 'undefined' && window.innerWidth < 640;
    const shouldLock = isMobileMenuOpen || (isSearchOpen && isMobileScreen);
    if (shouldLock) {
      document.body.style.overflow = 'hidden';
      document.body.style.height = '100vh';
    } else {
      document.body.style.overflow = '';
      document.body.style.height = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.height = '';
    };
  }, [isSearchOpen, isMobileMenuOpen]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await movieApi.search(searchQuery, 1, 6);
        setSearchResults(res.items || []);
      } catch (err) {
        void 0;
      } finally {
        setIsSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleCloseSearch = () => {
    setIsSearchOpen(false);
    if (typeof window !== 'undefined') {
      window.scrollTo({ left: 0, top: window.scrollY });
    }
  };

  const handleOpenSearch = () => {
    setIsSearchOpen(true);
  };

  useEffect(() => {
    if (isSearchOpen) {
      const timer = setTimeout(() => {
        searchInputRef.current?.focus();
        const mobInput = document.getElementById('navbar-search-input-mobile') as HTMLInputElement | null;
        mobInput?.focus();
      }, 80);
      return () => clearTimeout(timer);
    }
  }, [isSearchOpen]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      onSearchSubmit(searchQuery.trim());
      handleCloseSearch();
    }
  };

  // Primary navigation tabs (Always visible on desktop/tablet)
  const primaryNavItems: { label: string; tab: NavTab }[] = [
    { label: 'Trang Chủ', tab: 'home' },
    { label: 'Phim Bộ', tab: 'series' },
    { label: 'Phim Lẻ', tab: 'single' },
    { label: 'Hoạt Hình', tab: 'anime' },
    { label: 'TV Shows', tab: 'tv-shows' },
  ];

  // Secondary navigation tabs (Temporarily hide when search expands)
  const secondaryNavItems: { label: string; tab: NavTab }[] = [
    { label: 'Khám Phá / Lọc', tab: 'filter' },
    { label: 'Xem Chung', tab: 'xem-chung' },
    ...(isNativeApp ? [{ label: 'Đã Lưu', tab: 'offline' as NavTab }] : []),
  ];

  const allNavItems = [...primaryNavItems, ...secondaryNavItems];

  return (
    <header
      id="qtb-navbar"
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 pt-[max(12px,env(safe-area-inset-top))] ${
        isScrolled
          ? 'bg-[#0b1329]/95 backdrop-blur-md shadow-2xl shadow-black/80 border-b border-slate-800/60 pb-3'
          : 'bg-gradient-to-b from-[#070b16]/95 via-[#0b1329]/60 to-transparent pb-4 sm:pb-5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-3 sm:gap-6">
        {/* Left: Brand + Nav Links */}
        <div className="flex items-center gap-4 lg:gap-7 min-w-0 flex-1">
          {/* Gấu Brand */}
          <button
            id="brand-logo-btn"
            onClick={() => {
              if (activeTab === 'home') {
                onRefreshHome?.();
              } else {
                onTabChange('home');
              }
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className="flex items-center gap-2.5 cursor-pointer focus:outline-none group text-left shrink-0"
            title="Về đầu trang & Làm mới"
          >
            <div className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden border-2 border-blue-500/50 shadow-lg shadow-blue-500/20 group-hover:scale-110 group-hover:border-blue-400 transition-all duration-300">
              <img
                src={appLogo}
                alt="Gấu Cinema Logo"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-blue-600/10 to-transparent" />
            </div>
            <div className="flex flex-col">
              <span className="text-xl sm:text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-sky-300 to-indigo-400 transition-all drop-shadow-[0_2px_12px_rgba(59,130,246,0.5)]">
                Gấu
              </span>
              <span className="text-[9px] sm:text-[10px] uppercase font-black tracking-[0.2em] text-sky-400/90 -mt-1">
                CINEMA
              </span>
            </div>
          </button>

          {/* Desktop & Tablet Navigation */}
          <nav className="hidden md:flex items-center gap-2 lg:gap-4 text-sm font-medium overflow-hidden">
            {/* Primary items */}
            {primaryNavItems.map((item) => (
              <button
                key={item.tab}
                id={`nav-link-${item.tab}`}
                onClick={(e) => {
                  e.preventDefault();
                  onTabChange(item.tab);
                }}
                className={`cursor-pointer whitespace-nowrap px-2 py-1.5 rounded-lg text-xs lg:text-sm flex items-center gap-1.5 transition-[background-color,box-shadow,border-color,color,transform] duration-200 ease-out shrink-0 ${
                  activeTab === item.tab
                    ? 'text-sky-300 font-bold bg-blue-900/30 border border-blue-700/40 shadow-sm scale-[1.01]'
                    : 'text-slate-300 hover:text-white hover:bg-white/5'
                }`}
              >
                {item.label}
              </button>
            ))}

            {/* Secondary items: Smoothly hide when search expands to the left */}
            <AnimatePresence initial={false}>
              {!isSearchOpen && (
                <motion.div
                  key="secondary-nav-group"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  className="flex items-center gap-2 lg:gap-4 overflow-hidden whitespace-nowrap"
                >
                  {secondaryNavItems.map((item) => (
                    <button
                      key={item.tab}
                      id={`nav-link-${item.tab}`}
                      onClick={() => onTabChange(item.tab)}
                      className={`cursor-pointer whitespace-nowrap px-2 py-1.5 rounded-lg text-xs lg:text-sm flex items-center gap-1.5 transition-[background-color,box-shadow,border-color,color,transform] duration-200 ease-out ${
                        activeTab === item.tab
                          ? 'text-sky-300 font-bold bg-blue-900/30 border border-blue-700/40 shadow-sm scale-[1.01]'
                          : 'text-slate-300 hover:text-white hover:bg-white/5'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </nav>
        </div>

        {/* Right: Search Expanding Bar, Profile, Mobile Menu */}
        <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
          {/* Desktop/Tablet Expandable Search Bar */}
          <div ref={searchContainerRef} className="relative flex items-center justify-end">
            <AnimatePresence initial={false}>
              {isSearchOpen ? (
                <motion.div
                  key="search-input-active"
                  initial={{ width: 40, opacity: 0.4 }}
                  animate={{ width: 'clamp(220px, 32vw, 360px)', opacity: 1 }}
                  exit={{ width: 40, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                  className="hidden sm:flex items-center bg-[#131f37]/98 border border-blue-600/70 rounded-full px-3 py-1.5 shadow-2xl shadow-blue-950/60 backdrop-blur-md"
                >
                  <Search
                    className="w-4 h-4 text-sky-400 shrink-0 mr-1.5 cursor-pointer hover:text-sky-300"
                    onClick={() => searchInputRef.current?.focus()}
                  />
                  <input
                    ref={searchInputRef}
                    id="navbar-search-input"
                    type="text"
                    autoFocus
                    placeholder="Tìm tên phim, diễn viên..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    style={{ fontSize: '15px' }}
                    className="w-full bg-transparent border-none text-white text-sm focus:outline-none placeholder-slate-400 min-w-0"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      id="search-clear-btn"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSearchQuery('');
                        searchInputRef.current?.focus();
                      }}
                      className="text-slate-400 hover:text-white p-0.5 shrink-0 cursor-pointer"
                      title="Xóa từ khóa"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      id="search-close-btn"
                      onClick={handleCloseSearch}
                      className="text-slate-400 hover:text-white p-0.5 shrink-0 cursor-pointer"
                      title="Đóng tìm kiếm (Esc)"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </motion.div>
              ) : (
                <motion.button
                  key="search-btn-collapsed"
                  id="search-toggle-btn-desktop"
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.9, opacity: 0, position: 'absolute', right: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={handleOpenSearch}
                  className="hidden sm:flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/60 hover:bg-[#131f37] border border-slate-800/80 hover:border-blue-700/60 text-slate-300 hover:text-sky-300 cursor-pointer transition-all hover:scale-105"
                  title="Tìm kiếm phim"
                  aria-label="Tìm kiếm phim"
                >
                  <Search className="w-4 h-4" />
                </motion.button>
              )}
            </AnimatePresence>

            {/* Mobile Search Icon Trigger */}
            <button
              id="search-toggle-btn-mobile"
              onClick={handleOpenSearch}
              className="sm:hidden text-slate-300 hover:text-sky-300 cursor-pointer focus:outline-none p-1.5 rounded-full hover:bg-slate-800/60"
              aria-label="Tìm kiếm phim"
            >
              <Search className="w-5 h-5" />
            </button>

            {/* Quick Live Search Dropdown (Desktop/Tablet) - Safely aligned to avoid viewport cut-off */}
            {isSearchOpen && searchQuery && (
              <div
                id="search-live-results"
                onMouseDown={(e) => e.stopPropagation()}
                className="hidden sm:block absolute right-0 top-12 w-80 sm:w-96 max-w-[calc(100vw-2rem)] bg-[#0f172a] border border-blue-900/80 rounded-2xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200"
              >
                <div className="p-3 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 bg-[#0c1427]">
                  <span className="truncate pr-2">Kết quả cho: <strong className="text-white">"{searchQuery}"</strong></span>
                  {isSearching && <span className="text-sky-400 shrink-0 animate-pulse">Đang tìm...</span>}
                </div>

                <div className="max-h-96 overflow-y-auto divide-y divide-slate-800/60">
                  {searchResults.length > 0 ? (
                    searchResults.map((m, idx) => (
                      <div
                        key={`${m.slug || m._id || 'search'}-${idx}`}
                        id={`quick-search-item-${m.slug}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onSelectMovie(m);
                          handleCloseSearch();
                        }}
                        className="group flex items-center justify-between gap-3 p-3 hover:bg-[#1e293b]/90 cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="relative w-12 h-16 rounded-lg overflow-hidden bg-[#131f37] shrink-0 border border-slate-800">
                            <img
                              src={getImageUrl(m.poster_url || m.thumb_url)}
                              alt={m.name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src =
                                  'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=200&auto=format&fit=crop&q=80';
                              }}
                            />
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                              <Play className="w-5 h-5 text-white fill-white" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-semibold text-white truncate group-hover:text-sky-300 transition-colors">
                              {m.name}
                            </h4>
                            <p className="text-xs text-slate-400 truncate">{m.origin_name}</p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                {m.year || '2025'}
                              </span>
                              {m.episode_current && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-950/80 text-sky-300 border border-blue-800/60 font-medium">
                                  {m.episode_current}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            id={`quick-play-btn-${m.slug}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (onPlayMovie) onPlayMovie(m);
                              else onSelectMovie(m);
                              handleCloseSearch();
                            }}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition-all hover:scale-105 active:scale-95"
                            title="Vào xem ngay"
                          >
                            <Play className="w-3 h-3 fill-white" />
                            <span className="hidden lg:inline">Xem</span>
                          </button>
                          <button
                            id={`quick-info-btn-${m.slug}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onSelectMovie(m);
                              handleCloseSearch();
                            }}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                            title="Xem thông tin chi tiết"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : !isSearching ? (
                    <div className="p-6 text-center text-slate-400 text-sm">
                      Không tìm thấy phim phù hợp. Nhấn Enter để tìm kiếm toàn bộ.
                    </div>
                  ) : null}
                </div>

                <div
                  id="view-all-search-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSearchSubmit(searchQuery);
                    handleCloseSearch();
                  }}
                  className="p-3 bg-[#0b1329] hover:bg-[#131f37] text-center text-xs font-semibold text-sky-400 cursor-pointer transition-colors border-t border-slate-800"
                >
                  Xem tất cả kết quả tìm kiếm →
                </div>
              </div>
            )}
          </div>

          {/* App Switcher Menu */}
          <div ref={appMenuRef} className="relative">
            <button
              onClick={() => setIsAppMenuOpen(!isAppMenuOpen)}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/60 hover:bg-[#131f37] border border-slate-800/80 hover:border-blue-700/60 text-slate-300 hover:text-sky-300 cursor-pointer transition-all hover:scale-105 mr-1"
              title="Khám phá dịch vụ khác"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            
            {isAppMenuOpen && (
              <div className="absolute right-[-4rem] sm:right-0 top-12 w-[280px] sm:w-72 bg-[#0f172a] border border-blue-900/60 rounded-2xl shadow-2xl p-3 z-50 animate-in fade-in zoom-in-95 duration-200">
                <div className="text-xs font-bold text-slate-400 mb-2 px-2">HỆ SINH THÁI</div>
                <div className="space-y-1">
                  <button
                    onClick={() => {
                      if (appConfig.livetv?.enabled !== false) {
                        onSwitchApp('livetv');
                        setIsAppMenuOpen(false);
                      }
                    }}
                    disabled={appConfig.livetv?.enabled === false}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer group ${
                      appConfig.livetv?.enabled === false
                        ? 'opacity-40 cursor-not-allowed text-slate-500'
                        : 'text-slate-200 hover:bg-sky-900/30 hover:text-sky-300'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-sky-900/40 flex items-center justify-center group-hover:bg-sky-500/20 shrink-0">
                      <Tv className="w-4 h-4 text-sky-400" />
                    </div>
                    <div className="flex flex-col items-start">
                      <span>Gấu LiveTV</span>
                      <span className="text-[10px] text-slate-400 font-normal">
                        {appConfig.livetv?.enabled === false ? 'Đang bảo trì' : 'Kênh thể thao trực tiếp'}
                      </span>
                    </div>
                    {appConfig.livetv?.enabled === false && (
                      <span className="ml-auto text-[9px] font-bold text-red-400 bg-red-950 px-1.5 py-0.5 rounded-full">OFF</span>
                    )}
                  </button>

                  <button
                    onClick={() => {
                      if (appConfig.manga?.enabled !== false) {
                        onSwitchApp('manga');
                        setIsAppMenuOpen(false);
                      }
                    }}
                    disabled={appConfig.manga?.enabled === false}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer group ${
                      appConfig.manga?.enabled === false
                        ? 'opacity-40 cursor-not-allowed text-slate-500'
                        : 'text-slate-200 hover:bg-purple-900/30 hover:text-purple-300'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-purple-900/40 flex items-center justify-center group-hover:bg-purple-500/20 shrink-0">
                      <BookOpen className="w-4 h-4 text-purple-400" />
                    </div>
                    <div className="flex flex-col items-start">
                      <span>Gấu Manga</span>
                      <span className="text-[10px] text-slate-400 font-normal">
                        {appConfig.manga?.enabled === false ? 'Đang bảo trì' : 'Thế giới truyện tranh manga'}
                      </span>
                    </div>
                    {appConfig.manga?.enabled === false && (
                      <span className="ml-auto text-[9px] font-bold text-red-400 bg-red-950 px-1.5 py-0.5 rounded-full">OFF</span>
                    )}
                  </button>


                  </div>
              </div>
            )}
          </div>

          {/* User Profile Menu */}
          <div ref={profileMenuRef} className="relative">
            <button
              id="profile-dropdown-trigger"
              onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
              className="flex items-center gap-1.5 sm:gap-2 cursor-pointer focus:outline-none group p-1"
              aria-label="Tài khoản người dùng"
            >
              <div
                className="w-8 h-8 rounded-lg overflow-hidden border-2 transition-all shadow-md group-hover:scale-105"
                style={{ borderColor: activeProfile?.color || '#2563EB' }}
              >
                <img
                  src={
                    activeProfile?.avatar ||
                    'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80'
                  }
                  alt={activeProfile?.name || 'Profile'}
                  className="w-full h-full object-cover"
                />
              </div>
              <ChevronDown
                className={`w-3.5 h-3.5 text-slate-400 group-hover:text-white transition-transform ${
                  isProfileMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {/* Profile Dropdown Popup */}
            {isProfileMenuOpen && (
              <div
                id="profile-dropdown-menu"
                className="absolute right-0 top-12 w-64 bg-[#0f172a] border border-blue-900/60 rounded-2xl shadow-2xl p-3 z-50 animate-in fade-in zoom-in-95 duration-200"
              >
                {/* Account info */}
                {currentAccount && (
                  <div className="px-2 py-1.5 mb-2 bg-[#131f37] rounded-xl border border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Shield className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="text-xs font-bold text-white truncate">@{currentAccount.username}</span>
                    </div>
                    {currentAccount.role === 'admin' && (
                      <span className="text-[9px] bg-red-950 text-red-300 border border-red-800/80 px-1.5 py-0.2 rounded font-bold">
                        ADMIN
                      </span>
                    )}
                  </div>
                )}

                <div className="pb-3 mb-3 border-b border-slate-800">
                  <div className="text-xs text-sky-400 uppercase font-bold tracking-wider px-2 mb-2">
                    Chuyển hồ sơ ({profiles.length}/5)
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {profiles.map((p) => (
                      <button
                        key={p.id}
                        id={`switch-profile-${p.id}`}
                        onClick={() => handleProfileClickInDropdown(p)}
                        className={`w-full flex items-center justify-between p-2 rounded-xl text-left text-sm transition-colors cursor-pointer ${
                          activeProfile?.id === p.id
                            ? 'bg-blue-600/20 text-sky-300 font-semibold border border-blue-500/40'
                            : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <img
                            src={p.avatar}
                            alt={p.name}
                            className="w-7 h-7 rounded-md object-cover border shrink-0"
                            style={{ borderColor: p.color }}
                          />
                          <span className="truncate">{p.name}</span>
                          {p.isPrimary && (
                            <span className="text-[9px] bg-blue-900/60 text-blue-300 px-1 rounded font-bold shrink-0">
                              Chính
                            </span>
                          )}
                          {p.isKid && (
                            <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1 rounded shrink-0">
                              Kids
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          {p.pin && (
                            <Lock className="w-3.5 h-3.5 text-slate-400" />
                          )}
                          {activeProfile?.id === p.id && <Check className="w-4 h-4 text-sky-400" />}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  {currentAccount?.role === 'admin' && onOpenAdminDashboard && (
                    <button
                      id="navbar-admin-dashboard-btn"
                      onClick={() => {
                        onOpenAdminDashboard();
                        setIsProfileMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm font-bold text-indigo-300 hover:bg-indigo-950/80 hover:text-indigo-200 transition-colors cursor-pointer border border-indigo-900/60"
                    >
                      <Settings className="w-4 h-4 text-indigo-400" />
                      <span>Quản Trị Hệ Thống (Admin)</span>
                    </button>
                  )}

                  <button
                    id="change-profile-screen-btn"
                    onClick={() => {
                      onSwitchProfileScreen();
                      setIsProfileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
                  >
                    <User className="w-4 h-4 text-slate-400" />
                    <span>Màn hình chọn người xem</span>
                  </button>
                  <button
                    id="nav-to-history-btn"
                    onClick={() => {
                      onTabChange('history');
                      setIsProfileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
                  >
                    <Clock className="w-4 h-4 text-slate-400" />
                    <span>Lịch sử xem phim</span>
                  </button>
                  <button
                    id="nav-to-mylist-btn"
                    onClick={() => {
                      onTabChange('my-list');
                      setIsProfileMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
                  >
                    <Bookmark className="w-4 h-4 text-slate-400" />
                    <span>Danh sách yêu thích</span>
                  </button>

                  {isNativeApp && (
                    <button
                      id="nav-to-offline-btn"
                      onClick={() => {
                        onTabChange('offline');
                        setIsProfileMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-amber-300 hover:bg-amber-950/40 hover:text-amber-200 transition-colors cursor-pointer border border-amber-900/30"
                    >
                      <HardDrive className="w-4 h-4 text-amber-400" />
                      <span>Đã Lưu Offline (7 ngày)</span>
                    </button>
                  )}

                  {currentAccount && (
                    <button
                      id="nav-pair-tv-btn"
                      onClick={() => {
                        setIsPairModalOpen(true);
                        setIsProfileMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-sky-300 hover:bg-sky-950/40 hover:text-sky-200 transition-colors cursor-pointer border border-sky-900/40"
                    >
                      <Tv className="w-4 h-4 text-sky-400" />
                      <span>Ghép đôi TV (nhập mã)</span>
                    </button>
                  )}

                  {onLogout && (
                    <button
                      id="navbar-logout-btn"
                      onClick={() => {
                        onLogout();
                        setIsProfileMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-red-300 hover:bg-red-950/70 hover:text-red-200 transition-colors cursor-pointer border-t border-slate-800/80 mt-1"
                    >
                      <LogOut className="w-4 h-4 text-red-400" />
                      <span>Đăng xuất tài khoản</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            ref={mobileMenuToggleRef}
            id="mobile-menu-toggle"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden text-slate-300 hover:text-white p-1"
            aria-label="Mở menu"
          >
            <Layers className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Mobile Drawer Navigation */}
      {isMobileMenuOpen && (
        <div ref={mobileMenuRef} className="md:hidden bg-[#0b1329] border-b border-slate-800 px-4 py-4 space-y-3">
          <div className="space-y-1">
            {allNavItems.map((item) => (
              <button
                key={item.tab}
                onClick={() => {
                  onTabChange(item.tab);
                  setIsMobileMenuOpen(false);
                }}
                className={`block w-full text-left px-3 py-2 rounded-xl text-sm font-medium ${
                  activeTab === item.tab
                    ? 'bg-blue-600/30 text-sky-300 font-bold border border-blue-500/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mobile Fullscreen Search Overlay (Zero Overflow, Anti-Zoom) */}
      {isSearchOpen && (
        <div
          ref={mobileSearchOverlayRef}
          id="mobile-search-overlay"
          onMouseDown={(e) => e.stopPropagation()}
          className="sm:hidden fixed inset-0 z-50 bg-[#070b16]/98 backdrop-blur-xl flex flex-col animate-in fade-in duration-150"
        >
          {/* Mobile Search Header */}
          <div className="p-3 border-b border-blue-900/60 flex items-center gap-2 safe-pt bg-[#0b1329]">
            <div className="relative flex-1 flex items-center bg-[#131f37] border border-blue-700/60 rounded-xl px-3 py-2">
              <Search className="w-4 h-4 text-sky-400 shrink-0 mr-2" />
              <input
                id="navbar-search-input-mobile"
                type="text"
                autoFocus
                placeholder="Tìm tên phim, diễn viên..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                style={{ fontSize: '16px' }}
                className="w-full bg-transparent border-none text-white text-base focus:outline-none placeholder-slate-400"
              />
              {searchQuery && (
                <button
                  type="button"
                  id="mobile-search-clear-btn"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSearchQuery('');
                    const mobInput = document.getElementById('navbar-search-input-mobile') as HTMLInputElement | null;
                    mobInput?.focus();
                  }}
                  className="text-slate-400 hover:text-white p-1 shrink-0 cursor-pointer"
                  title="Xóa từ khóa"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              id="mobile-search-close-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleCloseSearch();
              }}
              className="text-xs font-semibold text-slate-300 hover:text-white px-2 py-2 cursor-pointer"
            >
              Hủy
            </button>
          </div>

          {/* Live search results on mobile */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 p-2">
            {searchResults.length > 0 ? (
              searchResults.map((m, idx) => (
                <div
                  key={`${m.slug || m._id || 'msearch'}-${idx}`}
                  onClick={() => {
                    onSelectMovie(m);
                    handleCloseSearch();
                  }}
                  className="flex items-center gap-3 p-2.5 rounded-xl active:bg-blue-600/20"
                >
                  <img
                    src={getImageUrl(m.poster_url || m.thumb_url)}
                    alt={m.name}
                    className="w-12 h-16 object-cover rounded-lg shrink-0 bg-[#131f37]"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src =
                        'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=200&auto=format&fit=crop&q=80';
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-white truncate">{m.name}</h4>
                    <p className="text-xs text-slate-400 truncate">{m.origin_name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-slate-400">{m.year || '2025'}</span>
                      {m.episode_current && (
                        <span className="text-[10px] text-sky-400 font-medium">
                          {m.episode_current}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            ) : isSearching ? (
              <div className="p-8 text-center text-slate-400 text-sm animate-pulse">
                Đang tìm kiếm...
              </div>
            ) : searchQuery ? (
              <div className="p-8 text-center text-slate-400 text-sm">
                Không tìm thấy kết quả phù hợp cho "{searchQuery}"
              </div>
            ) : (
              <div className="p-8 text-center text-slate-500 text-sm">
                Nhập tên phim để tìm kiếm nhanh
              </div>
            )}
          </div>
        </div>
      )}

      {/* Profile PIN Unlock Modal */}
      <AnimatePresence>
        {pinPromptProfile && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3.5 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-sm bg-[#0f172a] border border-blue-900/80 rounded-3xl p-5 sm:p-6 text-white text-center shadow-2xl"
            >
              <div
                className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-3 border-2 shadow-lg"
                style={{ borderColor: pinPromptProfile.color }}
              >
                <img
                  src={pinPromptProfile.avatar}
                  alt={pinPromptProfile.name}
                  className="w-full h-full object-cover"
                />
              </div>
              <h3 className="text-base sm:text-lg font-bold mb-1 text-sky-200">Nhập mã PIN</h3>
              <p className="text-xs text-slate-400 mb-4">
                Hồ sơ "{pinPromptProfile.name}" đã được khóa bảo vệ.
              </p>

              <form ref={pinFormRef} onSubmit={handlePinSubmit} className="space-y-4">
                <input
                  type="password"
                  maxLength={4}
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  enterKeyHint="go"
                  placeholder="••••"
                  value={enteredPin}
                  onChange={(e) => {
                    setEnteredPin(e.target.value.replace(/\D/g, ''));
                    setPinError(false);
                  }}
                  className="w-36 mx-auto text-center tracking-[0.8em] text-2xl bg-[#131f37] border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500 font-mono"
                />

                {pinError && (
                  <p className="text-xs text-red-400 font-semibold">
                    Mã PIN không đúng, vui lòng thử lại!
                  </p>
                )}

                <div className="flex items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPinPromptProfile(null);
                      setEnteredPin('');
                      setPinError(false);
                    }}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300 cursor-pointer"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-bold rounded-xl text-white shadow-md shadow-blue-600/30 cursor-pointer"
                  >
                    Mở khóa
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Ghép đôi TV: nhập mã đang hiện trên TV */}
      {isPairModalOpen && currentAccount && (
        <TvPairApproveModal account={currentAccount} onClose={() => setIsPairModalOpen(false)} />
      )}
    </header>
  );
};
