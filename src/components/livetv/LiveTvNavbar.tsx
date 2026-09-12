import React, { useState, useEffect, useRef } from 'react';
import { UserProfile, Account } from '../../types';
import { Tv, User, ChevronDown, Check, Home, LayoutGrid, Shield, LogOut, Lock, Clapperboard, HardDrive } from 'lucide-react';
import appLogo from '../../assets/images/app_logo.jpg';
import { motion, AnimatePresence } from 'motion/react';
import { appConfigService } from '../../services/appConfigService';
import { Capacitor } from '@capacitor/core';

interface LiveTvNavbarProps {
  currentAccount?: Account | null;
  activeProfile: UserProfile | null;
  profiles: UserProfile[];
  onSelectProfile: (profile: UserProfile) => void;
  onSwitchApp: (app: 'cinema' | 'livetv') => void;
  onSwitchProfileScreen?: () => void;
  onLogout?: () => void;
  onLogoClick?: () => void;
}

export const LiveTvNavbar: React.FC<LiveTvNavbarProps> = ({
  currentAccount,
  activeProfile,
  profiles,
  onSelectProfile,
  onSwitchApp,
  onSwitchProfileScreen,
  onLogout,
  onLogoClick
}) => {
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [appConfig, setAppConfig] = useState<Record<string, { enabled: boolean }>>({});
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const isNativeApp = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();

  useEffect(() => {
    const unsub = appConfigService.subscribe((cfg) => setAppConfig(cfg));
    return unsub;
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setIsProfileMenuOpen(false);
      if (appMenuRef.current && !appMenuRef.current.contains(e.target as Node)) setIsAppMenuOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsProfileMenuOpen(false); setIsAppMenuOpen(false); }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('mousedown', handleClickOutside); window.removeEventListener('keydown', handleKeyDown); };
  }, []);

  // Profile PIN prompt state
  const [pinPromptProfile, setPinPromptProfile] = useState<UserProfile | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState(false);

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
  
  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 transition-all duration-300 bg-[#0f0904]/95 backdrop-blur-md border-b border-orange-900/40 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          
          {/* Brand */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                onLogoClick?.();
              }}
              className="flex items-center gap-2.5 cursor-pointer focus:outline-none group text-left shrink-0"
              title="Về đầu trang & Làm mới"
            >
              <div className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl overflow-hidden border-2 border-orange-500/50 shadow-lg shadow-orange-500/20 group-hover:scale-110 group-hover:border-orange-400 transition-all duration-300">
                <img src={appLogo} alt="Gấu LiveTV Logo" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-orange-600/20 to-transparent" />
              </div>
              <div className="flex flex-col">
                <span className="text-xl sm:text-2xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-300 to-yellow-400 drop-shadow-[0_2px_12px_rgba(249,115,22,0.5)] leading-none">
                  Gấu
                </span>
                <span className="text-[9px] sm:text-[10px] uppercase font-black tracking-[0.2em] text-orange-400/90 mt-0.5">
                  LIVETV
                </span>
              </div>
            </button>
          </div>

          {/* Right Nav */}
          <div className="flex items-center gap-3">
            {/* App Switcher */}
            <div className="relative" ref={appMenuRef}>
              <button
                onClick={() => setIsAppMenuOpen(!isAppMenuOpen)}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/60 hover:bg-[#1f1308] border border-slate-800/80 hover:border-orange-500/60 text-slate-300 hover:text-orange-300 cursor-pointer transition-all hover:scale-105"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              {isAppMenuOpen && (
                <div className="absolute right-[-2rem] sm:right-0 top-12 w-64 bg-[#140b05] border border-orange-900/60 rounded-2xl shadow-2xl p-3 z-50 animate-in fade-in zoom-in-95">
                  <div className="text-xs font-bold text-slate-400 mb-2 px-2">HỆ SINH THÁI</div>
                  <div className="space-y-1">
                    <button onClick={() => { onSwitchApp('cinema'); setIsAppMenuOpen(false); }} className="w-full flex items-center gap-3 p-2.5 rounded-xl text-sm font-medium text-slate-200 hover:bg-blue-900/30 hover:text-blue-300 transition-colors">
                      <div className="w-8 h-8 rounded-lg bg-blue-900/40 flex items-center justify-center"><Home className="w-4 h-4 text-blue-400"/></div>
                      <div className="flex flex-col items-start"><span>Gấu Cinema HD</span><span className="text-[10px] text-slate-400">Xem phim thả ga</span></div>
                    </button>

                  </div>
                </div>
              )}
            </div>

            {/* User Profile Menu */}
            <div className="relative" ref={profileMenuRef}>
              <button onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)} className="flex items-center gap-1.5 cursor-pointer focus:outline-none group p-1" id="livetv-profile-dropdown-trigger">
                <div className="w-8 h-8 rounded-lg overflow-hidden border-2 border-orange-500 shadow-md group-hover:scale-105 transition-transform" style={{ borderColor: activeProfile?.color || '#f97316' }}>
                  <img src={activeProfile?.avatar} alt="Profile" className="w-full h-full object-cover" />
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 group-hover:text-white transition-transform ${isProfileMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {isProfileMenuOpen && (
                <div className="absolute right-0 top-12 w-64 bg-[#140b05] border border-orange-900/60 rounded-2xl shadow-2xl p-3 z-50 animate-in fade-in zoom-in-95">
                  {currentAccount && (
                    <div className="px-2 py-1.5 mb-2 bg-[#1f1308] rounded-xl border border-orange-900/40 flex items-center justify-between">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Shield className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                        <span className="text-xs font-bold text-white truncate">@{currentAccount.username}</span>
                      </div>
                      {currentAccount.role === 'admin' && (
                        <span className="text-[9px] bg-red-950 text-red-300 border border-red-800/80 px-1.5 py-0.2 rounded font-bold">
                          ADMIN
                        </span>
                      )}
                    </div>
                  )}

                  <div className="pb-3 mb-3 border-b border-orange-900/40">
                    <div className="text-xs text-orange-400 uppercase font-bold tracking-wider px-2 mb-2">
                      Chuyển hồ sơ ({profiles.length}/5)
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {profiles.map(p => (
                        <button
                          key={p.id}
                          onClick={() => handleProfileClickInDropdown(p)}
                          className={`w-full flex items-center justify-between p-2 rounded-xl text-left text-sm transition-colors cursor-pointer ${
                            activeProfile?.id === p.id
                              ? 'bg-orange-600/20 text-orange-300 font-semibold border border-orange-500/40'
                              : 'text-slate-300 hover:bg-orange-900/20 hover:text-white'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <img src={p.avatar} alt={p.name} className="w-7 h-7 rounded-md object-cover border shrink-0" style={{ borderColor: p.color }} />
                            <span className="truncate">{p.name}</span>
                            {p.isPrimary && <span className="text-[9px] bg-orange-900/60 text-orange-300 px-1 rounded font-bold shrink-0">Chính</span>}
                            {p.isKid && <span className="text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 px-1 rounded shrink-0">Kids</span>}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0 ml-1">
                            {p.pin && <Lock className="w-3.5 h-3.5 text-slate-400" />}
                            {activeProfile?.id === p.id && <Check className="w-4 h-4 text-orange-400" />}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    {onSwitchProfileScreen && (
                      <button
                        onClick={() => {
                          onSwitchProfileScreen();
                          setIsProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-slate-300 hover:bg-orange-900/20 hover:text-white transition-colors cursor-pointer"
                      >
                        <User className="w-4 h-4 text-slate-400" />
                        <span>Màn hình chọn người xem</span>
                      </button>
                    )}

                    {isNativeApp && (
                      <button
                        onClick={() => {
                          onSwitchApp('cinema');
                          setIsProfileMenuOpen(false);
                          try { localStorage.setItem('gau_active_tab', 'offline'); } catch {}
                          window.dispatchEvent(new CustomEvent('gau_navigate_cinema_tab', { detail: 'offline' }));
                        }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-amber-300 hover:bg-amber-950/30 hover:text-amber-200 transition-colors cursor-pointer border border-amber-900/30"
                      >
                        <HardDrive className="w-4 h-4 text-amber-400" />
                        <span>Đã Lưu Offline (7 ngày)</span>
                      </button>
                    )}

                    {onLogout && (
                      <button
                        onClick={() => {
                          onLogout();
                          setIsProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-xl text-sm text-red-300 hover:bg-red-950/70 hover:text-red-200 transition-colors cursor-pointer border-t border-orange-900/40 mt-1"
                      >
                        <LogOut className="w-4 h-4 text-red-400" />
                        <span>Đăng xuất tài khoản</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* PIN Prompt Modal */}
      {pinPromptProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-[#140b05] border border-orange-900/80 rounded-3xl p-6 w-full max-w-sm shadow-2xl text-center">
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-4 border-2 border-orange-500 shadow-lg">
              <img src={pinPromptProfile.avatar} alt={pinPromptProfile.name} className="w-full h-full object-cover" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">Nhập mã PIN của {pinPromptProfile.name}</h3>
            <p className="text-xs text-slate-400 mb-6">Hồ sơ này được bảo vệ bằng mã PIN 4 chữ số.</p>

            <form onSubmit={handlePinSubmit} className="space-y-4">
              <input
                type="password"
                maxLength={4}
                value={enteredPin}
                onChange={(e) => setEnteredPin(e.target.value)}
                placeholder="••••"
                autoFocus
                className="w-full bg-slate-900 border border-orange-800/60 rounded-xl px-4 py-3 text-center text-2xl tracking-widest text-white focus:outline-none focus:border-orange-500"
              />
              {pinError && <p className="text-xs text-red-400 font-medium">Mã PIN không chính xác. Vui lòng thử lại.</p>}
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setPinPromptProfile(null)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold py-2.5 rounded-xl text-sm transition-colors cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-orange-600 hover:bg-orange-500 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors cursor-pointer shadow-lg shadow-orange-600/30"
                >
                  Xác nhận
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
