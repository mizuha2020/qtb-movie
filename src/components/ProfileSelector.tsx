import React, { useEffect, useState, useRef } from 'react';
import { Account, CustomAvatar, UserProfile } from '../types';
import { DEFAULT_AVATARS } from '../services/authService';
import { firestoreStorage } from '../services/firestoreStorage';
import {
  Plus,
  Edit2,
  Lock,
  User,
  Trash2,
  LogOut,
  Settings,
  X,
  PlusCircle,
  Sparkles,
  Check,
  Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import appLogo from '../assets/images/app_logo.jpg';

interface ProfileSelectorProps {
  currentAccount: Account;
  profiles: UserProfile[];
  onSelectProfile: (profile: UserProfile) => void;
  onUpdateProfiles: (updated: UserProfile[]) => void;
  onAddProfile: (profile: Omit<UserProfile, 'id' | 'createdAt'>) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onLogout: () => void;
  onOpenAdminDashboard?: () => void;
  onShowToast?: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void;
}

const COLOR_PRESETS = ['#2563EB', '#38BDF8', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

export const ProfileSelector: React.FC<ProfileSelectorProps> = ({
  currentAccount,
  profiles,
  onSelectProfile,
  onUpdateProfiles,
  onAddProfile,
  onDeleteProfile,
  onLogout,
  onOpenAdminDashboard,
  onShowToast,
}) => {
  const [isManaging, setIsManaging] = useState(false);
  const [editingProfile, setEditingProfile] = useState<UserProfile | null>(null);
  const [pinPromptProfile, setPinPromptProfile] = useState<UserProfile | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState(false);
  const pinFormRef = useRef<HTMLFormElement>(null);

  // Remote TV: đủ 4 số là tự mở khóa, khỏi phải tìm nút submit
  useEffect(() => {
    if (!pinPromptProfile || enteredPin.length !== 4 || pinError) return;
    const t = setTimeout(() => {
      try {
        pinFormRef.current?.requestSubmit();
      } catch {}
    }, 350);
    return () => clearTimeout(t);
  }, [enteredPin, pinPromptProfile, pinError]);

  // Transition state when user selects a profile
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add profile modal
  const [isAddProfileOpen, setIsAddProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileAvatar, setNewProfileAvatar] = useState(DEFAULT_AVATARS[0]);
  const [newProfileColor, setNewProfileColor] = useState(COLOR_PRESETS[0]);
  const [newProfilePin, setNewProfilePin] = useState('');
  const [newProfileIsKid, setNewProfileIsKid] = useState(false);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Custom avatars from Firestore
  const [customAvatars, setCustomAvatars] = useState<CustomAvatar[]>([]);

  useEffect(() => {
    firestoreStorage.getCustomAvatars().then((res) => {
      setCustomAvatars(res);
    });
    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  // TV remote: mở màn hình là focus ngay thẻ profile đầu để D-pad đi được liền
  useEffect(() => {
    let isTv = false;
    try {
      isTv = document.documentElement.classList.contains('tv-mode');
    } catch {}
    if (!isTv) return;
    const t = window.setTimeout(() => {
      try {
        const first = document.querySelector<HTMLElement>(
          '#qtb-profile-selector [data-tv-card]',
        );
        first?.focus({ preventScroll: true } as FocusOptions);
      } catch {}
    }, 350);
    return () => window.clearTimeout(t);
  }, []);

  const allAvatars = [
    ...DEFAULT_AVATARS,
    ...customAvatars.map((c) => c.url).filter((u) => !DEFAULT_AVATARS.includes(u)),
  ];

  const triggerProfileTransition = (profile: UserProfile) => {
    if (isTransitioning) return;
    setSelectedProfileId(profile.id);
    setIsTransitioning(true);

    transitionTimeoutRef.current = setTimeout(() => {
      onSelectProfile(profile);
    }, 420);
  };

  const handleProfileClick = (profile: UserProfile) => {
    if (isTransitioning) return;

    if (isManaging) {
      setEditingProfile(profile);
    } else if (profile.pin) {
      setPinPromptProfile(profile);
      setEnteredPin('');
      setPinError(false);
    } else {
      triggerProfileTransition(profile);
    }
  };

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinPromptProfile || !pinPromptProfile.pin) return;
    // Constant-time comparison to prevent timing attacks
    const a = enteredPin;
    const b = pinPromptProfile.pin;
    if (a.length !== b.length) {
      setPinError(true);
      return;
    }
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    if (mismatch === 0) {
      const target = pinPromptProfile;
      setPinPromptProfile(null);
      triggerProfileTransition(target);
    } else {
      setPinError(true);
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProfile) return;

    const updated = profiles.map((p) => (p.id === editingProfile.id ? editingProfile : p));
    onUpdateProfiles(updated);
    setEditingProfile(null);
  };

  const handleCreateProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) {
      setCreateError('Vui lòng nhập tên hồ sơ');
      return;
    }
    setCreateError(null);
    setIsCreatingProfile(true);
    try {
      await onAddProfile({
        name: newProfileName.trim(),
        avatar: newProfileAvatar,
        color: newProfileColor,
        isKid: newProfileIsKid,
        pin: newProfilePin ? newProfilePin.trim() : undefined,
      });
      setIsAddProfileOpen(false);
      setNewProfileName('');
      setNewProfilePin('');
      setNewProfileIsKid(false);
    } catch (err: any) {
      setCreateError(err?.message || 'Không thể tạo hồ sơ mới');
    } finally {
      setIsCreatingProfile(false);
    }
  };

  const handleDeleteProfileClick = async (profile: UserProfile) => {
    if (profile.isPrimary) {
      onShowToast?.('Không thể xóa hồ sơ chính mặc định của tài khoản.', 'error');
      return;
    }
    if (!window.confirm(`Bạn có chắc chắn muốn xóa hồ sơ "${profile.name}"? Danh sách xem và lịch sử của hồ sơ này sẽ bị xóa vĩnh viễn.`)) {
      return;
    }
    try {
      await onDeleteProfile(profile.id);
      setEditingProfile(null);
    } catch (err: any) {
      onShowToast?.(err?.message || 'Không thể xóa hồ sơ', 'error');
    }
  };

  const canAddProfile = profiles.length < 5;
  const activeSelectedProfile = profiles.find((p) => p.id === selectedProfileId);

  // Animation variants
  const gridContainerVariants: any = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: {
        staggerChildren: 0.06,
        delayChildren: 0.05,
      },
    },
  };

  const cardVariants: any = {
    hidden: { opacity: 0, y: 20, scale: 0.94 },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        type: 'spring',
        stiffness: 350,
        damping: 24,
      },
    },
  };

  return (
    <div
      id="qtb-profile-selector"
      className="relative min-h-screen w-full bg-[#070b16] overflow-y-auto overflow-x-hidden p-3.5 sm:p-6 md:p-8 flex flex-col justify-between safe-pt safe-pb"
      style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
    >
      <div className="min-h-full flex flex-col justify-between max-w-5xl mx-auto py-2 space-y-6 w-full">
        {/* Top Bar: Brand + User Info & Logout / Admin */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full flex items-center justify-between gap-2 pt-1 pb-2 shrink-0"
        >
          {/* Brand */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg overflow-hidden border border-blue-500/30 bg-[#0f172a]">
              <img
                src={appLogo}
                alt="Gấu Cinema Logo"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
            <div className="flex flex-col">
              <span className="text-lg sm:text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-sky-300 to-blue-500 tracking-tight leading-none">
                Gấu
              </span>
              <span className="text-[7px] sm:text-[8px] uppercase font-bold tracking-widest text-sky-400/80">
                Cinema HD
              </span>
            </div>
          </div>

          {/* User Badge & Actions */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="flex items-center gap-1 text-[11px] sm:text-xs text-slate-300 bg-[#0f172a] px-2 sm:px-3 py-1 sm:py-1.5 rounded-xl border border-slate-800 max-w-[130px] sm:max-w-[200px] truncate">
              <User className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-sky-400 shrink-0" />
              <span className="truncate">@{currentAccount.username}</span>
            </div>

            {currentAccount.role === 'admin' && onOpenAdminDashboard && (
              <button
                id="goto-admin-portal-btn"
                onClick={onOpenAdminDashboard}
                disabled={isTransitioning}
                className="flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl bg-indigo-950/90 hover:bg-indigo-900 border border-indigo-700/80 text-indigo-200 text-[11px] sm:text-xs font-bold transition-transform active:scale-95 cursor-pointer shadow-md shrink-0 disabled:opacity-50"
              >
                <Settings className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="hidden xs:inline">Admin</span>
              </button>
            )}

            <button
              id="profile-logout-btn"
              onClick={onLogout}
              disabled={isTransitioning}
              className="flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl bg-slate-800/80 hover:bg-red-950/80 hover:text-red-300 hover:border-red-800 border border-slate-700 text-slate-300 text-[11px] sm:text-xs font-semibold transition-colors cursor-pointer shrink-0 disabled:opacity-50"
              title="Đăng xuất khỏi tài khoản"
            >
              <LogOut className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
              <span className="hidden sm:inline">Đăng xuất</span>
            </button>
          </div>
        </motion.div>

        {/* Main Center Profiles Grid */}
        <div className="w-full max-w-4xl mx-auto flex flex-col items-center text-center my-auto py-2 sm:py-4">
          <AnimatePresence mode="wait">
            {isTransitioning && activeSelectedProfile ? (
              <motion.div
                key="greeting-transition"
                initial={{ opacity: 0, y: -10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="mb-4 sm:mb-6"
              >
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-sky-300 text-xs font-semibold mb-2">
                  <Sparkles className="w-3.5 h-3.5 text-sky-400 animate-pulse" />
                  <span>Đang chuyển sang hồ sơ người xem</span>
                </div>
                <h1 className="text-2xl sm:text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-sky-100 to-sky-400 tracking-tight">
                  Chào mừng, {activeSelectedProfile.name}!
                </h1>
                <p className="text-xs sm:text-sm text-slate-400 mt-1.5 flex items-center justify-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                  <span>Đang mở không gian rạp chiếu phim của bạn...</span>
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={isManaging ? 'managing-heading' : 'selection-heading'}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2 }}
                className="mb-1.5 sm:mb-2"
              >
                <h1 className="text-2xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight mb-1.5 sm:mb-2">
                  {isManaging ? 'Quản lý hồ sơ người xem' : 'Ai đang xem?'}
                </h1>
                <p className="text-[11px] sm:text-sm text-slate-400 mb-6 sm:mb-8 max-w-lg px-2 leading-relaxed">
                  {isManaging
                    ? 'Nhấp vào hồ sơ để đổi tên, ảnh đại diện, đổi mã PIN hoặc xóa hồ sơ phụ.'
                    : `Tài khoản @${currentAccount.username} (${profiles.length}/5 hồ sơ). Dữ liệu lịch sử và danh sách xem hoàn toàn riêng biệt.`}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Profiles Grid with Stagger & Smooth Transitions */}
          <motion.div
            variants={gridContainerVariants}
            initial="hidden"
            animate="show"
            className="grid grid-cols-2 sm:grid-cols-3 md:flex md:flex-wrap items-center justify-center gap-4 sm:gap-6 md:gap-8 mb-8 sm:mb-10 max-w-3xl w-full px-2"
          >
            {profiles.map((profile) => {
              const isThisSelected = selectedProfileId === profile.id;
              const isOtherDimmed = isTransitioning && !isThisSelected;

              return (
                <motion.div
                  key={profile.id}
                  id={`profile-card-${profile.id}`}
                  tabIndex={isTransitioning ? -1 : 0}
                  role="button"
                  aria-label={`Chọn hồ sơ ${profile.name}`}
                  data-tv-card={`profile-${profile.id}`}
                  variants={cardVariants}
                  whileHover={
                    !isTransitioning && !isManaging
                      ? { scale: 1.08, y: -6 }
                      : !isTransitioning
                      ? { scale: 1.04, y: -3 }
                      : undefined
                  }
                  whileTap={!isTransitioning ? { scale: 0.94 } : undefined}
                  onClick={() => handleProfileClick(profile)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                      e.preventDefault();
                      handleProfileClick(profile);
                    }
                  }}
                  animate={{
                    opacity: isOtherDimmed ? 0.2 : 1,
                    scale: isThisSelected ? 1.12 : isOtherDimmed ? 0.92 : 1,
                    filter: isOtherDimmed ? 'blur(1px)' : 'blur(0px)',
                  }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  className={`group flex flex-col items-center cursor-pointer select-none relative ${
                    isTransitioning && !isThisSelected ? 'pointer-events-none' : ''
                  }`}
                >
                  <div
                    className={`relative w-20 h-20 sm:w-28 sm:h-28 md:w-32 md:h-32 rounded-2xl sm:rounded-3xl overflow-hidden border-2 transition-all duration-300 ${
                      isThisSelected
                        ? 'shadow-[0_0_35px_rgba(56,189,248,0.7)] ring-4 ring-sky-400'
                        : 'group-hover:shadow-[0_0_30px_rgba(59,130,246,0.5)]'
                    }`}
                  >
                    <img
                      src={profile.avatar}
                      alt={profile.name}
                      className={`w-full h-full object-cover transition-transform duration-300 ${
                        isThisSelected ? 'scale-105' : 'group-hover:scale-105'
                      }`}
                    />

                    {/* Color Badge Border */}
                    <div
                      className="absolute inset-0 border-2 rounded-2xl sm:rounded-3xl pointer-events-none"
                      style={{ borderColor: profile.color || '#2563EB' }}
                    />

                    {/* Selecting Active Ripple / Pulsing Aura */}
                    <AnimatePresence>
                      {isThisSelected && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0 }}
                          className="absolute inset-0 bg-sky-500/20 flex items-center justify-center backdrop-blur-[1px]"
                        >
                          <motion.div
                            animate={{ scale: [1, 1.15, 1], opacity: [0.8, 1, 0.8] }}
                            transition={{ repeat: Infinity, duration: 1.2 }}
                            className="p-2 rounded-full bg-sky-500/80 text-white shadow-lg"
                          >
                            <Check className="w-5 h-5 sm:w-6 sm:h-6 stroke-[3]" />
                          </motion.div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Managing Edit Icon Overlay */}
                    <AnimatePresence>
                      {isManaging && !isTransitioning && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="absolute inset-0 bg-slate-950/80 flex flex-col items-center justify-center gap-1 backdrop-blur-xs"
                        >
                          <Edit2 className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
                          <span className="text-[9px] sm:text-[10px] text-sky-200 font-bold uppercase tracking-wider">
                            {profile.isPrimary ? 'Hồ sơ chính' : 'Sửa'}
                          </span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* PIN Locked Icon */}
                    {profile.pin && !isManaging && !isThisSelected && (
                      <div className="absolute bottom-1.5 right-1.5 sm:bottom-2 sm:right-2 bg-slate-950/80 p-1 sm:p-1.5 rounded-md sm:rounded-lg border border-slate-700">
                        <Lock className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-slate-300" />
                      </div>
                    )}

                    {/* Primary Profile Badge */}
                    {profile.isPrimary && !isManaging && !isThisSelected && (
                      <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 bg-blue-600 text-white font-black text-[8px] sm:text-[9px] px-1.5 sm:px-2 py-0.5 rounded shadow-md uppercase tracking-wider">
                        CHÍNH
                      </div>
                    )}

                    {/* Kid Badge */}
                    {profile.isKid && !profile.isPrimary && !isManaging && !isThisSelected && (
                      <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 bg-indigo-600 text-white font-bold text-[8px] sm:text-[9px] px-1.5 py-0.5 rounded shadow">
                        KIDS
                      </div>
                    )}
                  </div>

                  <span
                    className={`text-xs sm:text-sm md:text-base font-semibold mt-2 sm:mt-3 transition-colors max-w-[100px] sm:max-w-[120px] truncate ${
                      isThisSelected
                        ? 'text-sky-300 font-bold'
                        : 'text-slate-300 group-hover:text-sky-300'
                    }`}
                  >
                    {profile.name}
                  </span>
                </motion.div>
              );
            })}

            {/* Add Profile Button (if profiles < 5) */}
            {canAddProfile && (
              <motion.div
                id="add-new-profile-card-btn"
                tabIndex={isTransitioning ? -1 : 0}
                role="button"
                aria-label="Thêm hồ sơ mới"
                data-tv-card="profile-add-new"
                variants={cardVariants}
                whileHover={!isTransitioning ? { scale: 1.08, y: -6 } : undefined}
                whileTap={!isTransitioning ? { scale: 0.94 } : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).click();
                  }
                }}
                animate={{
                  opacity: isTransitioning ? 0.2 : 1,
                  filter: isTransitioning ? 'blur(1px)' : 'blur(0px)',
                }}
                onClick={() => {
                  if (isTransitioning) return;
                  setNewProfileName('');
                  setNewProfileAvatar(allAvatars[profiles.length % allAvatars.length]);
                  setNewProfileColor(COLOR_PRESETS[profiles.length % COLOR_PRESETS.length]);
                  setNewProfilePin('');
                  setNewProfileIsKid(false);
                  setCreateError(null);
                  setIsAddProfileOpen(true);
                }}
                className={`group flex flex-col items-center cursor-pointer select-none ${
                  isTransitioning ? 'pointer-events-none' : ''
                }`}
              >
                <div className="relative w-20 h-20 sm:w-28 sm:h-28 md:w-32 md:h-32 rounded-2xl sm:rounded-3xl border-2 border-dashed border-slate-700 hover:border-sky-400 bg-slate-900/40 hover:bg-slate-800/60 flex flex-col items-center justify-center transition-all duration-300 group-hover:shadow-[0_0_20px_rgba(56,189,248,0.3)]">
                  <Plus className="w-6 h-6 sm:w-8 sm:h-8 text-slate-400 group-hover:text-sky-300 transition-colors" />
                  <span className="text-[9px] sm:text-[10px] text-slate-400 group-hover:text-slate-200 mt-0.5 font-semibold">
                    ({profiles.length}/5)
                  </span>
                </div>
                <span className="text-xs sm:text-sm md:text-base font-medium text-slate-400 group-hover:text-sky-300 mt-2 sm:mt-3 transition-colors">
                  Thêm hồ sơ
                </span>
              </motion.div>
            )}
          </motion.div>

          {/* Manage Profiles Toggle Button */}
          <motion.button
            id="manage-profiles-toggle-btn"
            whileHover={!isTransitioning ? { scale: 1.04 } : undefined}
            whileTap={!isTransitioning ? { scale: 0.96 } : undefined}
            animate={{
              opacity: isTransitioning ? 0 : 1,
              pointerEvents: isTransitioning ? 'none' : 'auto',
            }}
            transition={{ duration: 0.2 }}
            onClick={() => setIsManaging(!isManaging)}
            className={`px-6 sm:px-8 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-bold tracking-wider uppercase transition-all duration-200 cursor-pointer ${
              isManaging
                ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/40'
                : 'border border-slate-700 text-slate-300 hover:text-white hover:border-sky-400 hover:bg-slate-800/60'
            }`}
          >
            {isManaging ? 'Hoàn tất quản lý' : 'Quản lý hồ sơ'}
          </motion.button>
        </div>

        {/* Footer Info */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-[10px] sm:text-[11px] text-slate-500 text-center pb-2 shrink-0"
        >
          Bảo mật dữ liệu đám mây Firebase • Tối đa 5 hồ sơ / tài khoản
        </motion.div>
      </div>

      {/* --- MODAL 1: ADD NEW PROFILE --- */}
      <AnimatePresence>
        {isAddProfileOpen && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3.5 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="w-full max-w-md bg-[#0f172a] border border-blue-900/80 rounded-3xl p-5 sm:p-6 text-white shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
                <h2 className="text-base sm:text-lg font-bold text-sky-200 flex items-center gap-2">
                  <PlusCircle className="w-5 h-5 text-sky-400 shrink-0" />
                  <span>Thêm Hồ Sơ Mới ({profiles.length + 1}/5)</span>
                </h2>
                <button
                  onClick={() => setIsAddProfileOpen(false)}
                  className="text-slate-400 hover:text-white p-1 cursor-pointer transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {createError && (
                <div className="mb-4 p-3 rounded-xl bg-red-950/80 border border-red-800 text-red-200 text-xs">
                  {createError}
                </div>
              )}

              <form onSubmit={handleCreateProfileSubmit} className="space-y-4">
                {/* Profile Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Tên người xem:
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ví dụ: Anh Quân, Bé Na..."
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    className="w-full bg-[#131f37] border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Avatar Selector */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-slate-300">
                      Chọn ảnh đại diện:
                    </label>
                    <span className="text-[10px] text-sky-400">
                      {customAvatars.length > 0
                        ? `${customAvatars.length} avatar Admin`
                        : 'Avatar có sẵn'}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-2.5 max-h-44 overflow-y-auto p-1 bg-[#131f37]/50 rounded-2xl border border-slate-800">
                    {allAvatars.map((av, idx) => (
                      <button
                        type="button"
                        key={idx}
                        onClick={() => setNewProfileAvatar(av)}
                        className={`relative aspect-square rounded-2xl overflow-hidden border-2 cursor-pointer transition-transform ${
                          newProfileAvatar === av
                            ? 'border-sky-400 scale-105 shadow-md shadow-blue-500/40 ring-2 ring-sky-400'
                            : 'border-transparent opacity-70 hover:opacity-100'
                        }`}
                      >
                        <img src={av} alt="Avatar" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Color Theme Selector */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-2">
                    Màu viền nhận diện:
                  </label>
                  <div className="flex items-center gap-2.5">
                    {COLOR_PRESETS.map((col) => (
                      <button
                        type="button"
                        key={col}
                        onClick={() => setNewProfileColor(col)}
                        className={`w-7 h-7 rounded-full transition-transform cursor-pointer ${
                          newProfileColor === col
                            ? 'scale-125 ring-2 ring-white shadow-md'
                            : 'opacity-70 hover:opacity-100'
                        }`}
                        style={{ backgroundColor: col }}
                      />
                    ))}
                  </div>
                </div>

                {/* PIN Code */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Mã PIN khóa bảo vệ (4 số - Tùy chọn):
                  </label>
                  <input
                    type="password"
                    maxLength={4}
                    placeholder="Để trống nếu không cài mã PIN"
                    value={newProfilePin}
                    onChange={(e) => setNewProfilePin(e.target.value.replace(/\D/g, ''))}
                    className="w-full bg-[#131f37] border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-mono tracking-widest"
                  />
                </div>

                {/* Kids Mode */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="new-kid-checkbox"
                    checked={newProfileIsKid}
                    onChange={(e) => setNewProfileIsKid(e.target.checked)}
                    className="w-4 h-4 rounded text-blue-600 accent-blue-600"
                  />
                  <label htmlFor="new-kid-checkbox" className="text-xs text-slate-300 cursor-pointer">
                    Hồ sơ dành riêng cho Trẻ em (Kids Mode)
                  </label>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setIsAddProfileOpen(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300 cursor-pointer transition-colors"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={isCreatingProfile}
                    className="px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-xs font-bold rounded-xl text-white shadow-lg shadow-blue-600/30 cursor-pointer disabled:opacity-50 transition-all"
                  >
                    {isCreatingProfile ? 'Đang tạo...' : 'Tạo Hồ Sơ'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODAL 2: EDIT PROFILE --- */}
      <AnimatePresence>
        {editingProfile && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3.5 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="w-full max-w-md bg-[#0f172a] border border-blue-900/80 rounded-3xl p-5 sm:p-6 text-white shadow-2xl max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
                <h2 className="text-base sm:text-lg font-bold text-sky-200">
                  Chỉnh sửa hồ sơ {editingProfile.isPrimary && '(Hồ sơ chính)'}
                </h2>
                <button
                  onClick={() => setEditingProfile(null)}
                  className="text-slate-400 hover:text-white p-1 cursor-pointer transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSaveEdit} className="space-y-4">
                {/* Profile Name */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Tên hiển thị:
                  </label>
                  <input
                    type="text"
                    required
                    value={editingProfile.name}
                    onChange={(e) =>
                      setEditingProfile({ ...editingProfile, name: e.target.value })
                    }
                    className="w-full bg-[#131f37] border border-slate-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </div>

                {/* Avatar Selector */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-2">
                    Chọn ảnh đại diện:
                  </label>
                  <div className="grid grid-cols-4 gap-2.5 max-h-44 overflow-y-auto p-1 bg-[#131f37]/50 rounded-2xl border border-slate-800">
                    {allAvatars.map((av, idx) => (
                      <button
                        type="button"
                        key={idx}
                        onClick={() => setEditingProfile({ ...editingProfile, avatar: av })}
                        className={`relative aspect-square rounded-2xl overflow-hidden border-2 cursor-pointer transition-transform ${
                          editingProfile.avatar === av
                            ? 'border-sky-400 scale-105 shadow-md shadow-blue-500/40 ring-2 ring-sky-400'
                            : 'border-transparent opacity-70 hover:opacity-100'
                        }`}
                      >
                        <img src={av} alt="Avatar" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Color Theme Selector */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-2">
                    Màu viền chủ đề:
                  </label>
                  <div className="flex items-center gap-2.5">
                    {COLOR_PRESETS.map((col) => (
                      <button
                        type="button"
                        key={col}
                        onClick={() => setEditingProfile({ ...editingProfile, color: col })}
                        className={`w-7 h-7 rounded-full transition-transform cursor-pointer ${
                          editingProfile.color === col
                            ? 'scale-125 ring-2 ring-white'
                            : 'opacity-70 hover:opacity-100'
                        }`}
                        style={{ backgroundColor: col }}
                      />
                    ))}
                  </div>
                </div>

                {/* PIN Code Setup */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Mã PIN bảo vệ (4 số - Tùy chọn):
                  </label>
                  <input
                    type="password"
                    maxLength={4}
                    placeholder="Để trống nếu không đặt mã PIN"
                    value={editingProfile.pin || ''}
                    onChange={(e) =>
                      setEditingProfile({
                        ...editingProfile,
                        pin: e.target.value.replace(/\D/g, ''),
                      })
                    }
                    className="w-full bg-[#131f37] border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-blue-500 font-mono tracking-widest"
                  />
                </div>

                {/* Is Kid Profile */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="kid-checkbox"
                    checked={!!editingProfile.isKid}
                    onChange={(e) =>
                      setEditingProfile({ ...editingProfile, isKid: e.target.checked })
                    }
                    className="w-4 h-4 rounded text-blue-600 accent-blue-600"
                  />
                  <label htmlFor="kid-checkbox" className="text-xs text-slate-300 cursor-pointer">
                    Hồ sơ dành cho trẻ em (Kids mode)
                  </label>
                </div>

                {/* Action Buttons & Delete */}
                <div className="flex items-center justify-between pt-4 border-t border-slate-800">
                  {!editingProfile.isPrimary ? (
                    <button
                      type="button"
                      onClick={() => handleDeleteProfileClick(editingProfile)}
                      className="px-3 py-2 bg-red-950/80 hover:bg-red-900 border border-red-800/80 text-xs font-bold rounded-xl text-red-300 flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Xóa hồ sơ</span>
                    </button>
                  ) : (
                    <span className="text-[10px] sm:text-[11px] text-slate-500 italic">
                      * Hồ sơ chính không thể xóa
                    </span>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingProfile(null)}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300 cursor-pointer transition-colors"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-xs font-bold rounded-xl text-white shadow-md shadow-blue-600/30 cursor-pointer transition-all"
                    >
                      Lưu thay đổi
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- MODAL 3: PIN PROMPT --- */}
      <AnimatePresence>
        {pinPromptProfile && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3.5 sm:p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="w-full max-w-sm bg-[#0f172a] border border-blue-900/80 rounded-3xl p-5 sm:p-6 text-white text-center shadow-2xl"
            >
              <div
                className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-3 border-2 shadow-lg"
                style={{ borderColor: pinPromptProfile.color }}
              >
                <img src={pinPromptProfile.avatar} alt={pinPromptProfile.name} className="w-full h-full object-cover" />
              </div>
              <h3 className="text-base sm:text-lg font-bold mb-1 text-sky-200">Nhập mã PIN</h3>
              <p className="text-xs text-slate-400 mb-4">Hồ sơ "{pinPromptProfile.name}" đã được khóa bảo vệ.</p>

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
                  <p className="text-xs text-red-400 font-semibold">Mã PIN không đúng, vui lòng thử lại!</p>
                )}

                <div className="flex items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setPinPromptProfile(null)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-xl text-slate-300 cursor-pointer transition-colors"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-xs font-bold rounded-xl text-white shadow-md shadow-blue-600/30 cursor-pointer transition-all"
                  >
                    Mở khóa
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
