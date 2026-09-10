import React, { useRef, useState } from 'react';
import { authService } from '../services/authService';
import { Account } from '../types';
import { Lock, User, KeyRound, ShieldAlert, Sparkles, ShieldCheck, Eye, EyeOff, Smartphone } from 'lucide-react';
import { motion } from 'motion/react';
import { TvPairCodePanel } from './TvPairCodePanel';
import { useTvMode } from '../hooks/useTvMode';
import appLogo from '../assets/images/app_logo.jpg';

interface LoginScreenProps {
  onLoginSuccess: (account: Account) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isTv = useTvMode();
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setErrorMessage('Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const account = await authService.login(username, password);
      onLoginSuccess(account);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Đăng nhập thất bại. Vui lòng kiểm tra lại thông tin.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      id="qtb-login-screen"
      className="min-h-screen w-full bg-[#070b16] overflow-y-auto overflow-x-hidden p-4 sm:p-6 flex flex-col items-center justify-center relative safe-pt safe-pb select-none"
      style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
    >
      {/* Background Ambience Glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 sm:w-[500px] sm:h-[500px] bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md my-auto flex flex-col items-center justify-center py-6 relative z-10">
        {/* Brand Header */}
        <motion.div
          initial={{ opacity: 1, y: 0 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col items-center mb-6 sm:mb-8 text-center"
        >
          <div className="relative w-20 h-20 sm:w-24 sm:h-24 mb-3 sm:mb-4 rounded-3xl overflow-hidden border-2 border-blue-500/30 shadow-2xl shadow-blue-500/20 bg-[#0f172a]">
            <img
              src={appLogo}
              alt="Gấu Cinema Logo"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-blue-600/20 to-transparent" />
          </div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-3xl sm:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-sky-300 to-indigo-400 tracking-tight drop-shadow-[0_2px_14px_rgba(59,130,246,0.6)]">
              Gấu
            </span>
            <span className="text-xs sm:text-sm uppercase font-extrabold tracking-widest px-2.5 py-0.5 rounded-md bg-blue-950/90 text-sky-300 border border-blue-800/80 shadow-lg">
              CINEMA HD
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-400 font-medium max-w-[280px]">
            Rạp Chiếu Phim Cá Nhân & Gia Đình • Riêng Tư & Bảo Mật
          </p>
        </motion.div>

        {/* Login Card */}
        <motion.div
          initial={{ opacity: 1, scale: 1, y: 0 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full bg-[#0f172a] border border-blue-900/60 rounded-3xl p-6 sm:p-8 text-white shadow-2xl relative"
        >
          <div className="flex items-center justify-between pb-4 mb-6 border-b border-slate-800">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Đăng Nhập</h1>
              <p className="text-xs text-slate-400 mt-0.5">Sử dụng tài khoản được cấp để truy cập</p>
            </div>
            <div className="w-10 h-10 rounded-2xl bg-blue-950/80 border border-blue-800/60 flex items-center justify-center text-sky-400">
              <Lock className="w-5 h-5" />
            </div>
          </div>

          {/* Error Alert */}
          {errorMessage && (
            <div className="mb-5 p-3.5 rounded-2xl bg-red-950/80 border border-red-800/80 flex items-start gap-3 text-red-200 text-xs shadow-lg animate-in fade-in duration-200">
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <span className="font-semibold block">{errorMessage}</span>
              </div>
            </div>
          )}

          {mode === 'code' ? (
            <TvPairCodePanel onPaired={onLoginSuccess} onBackToPassword={() => setMode('password')} />
          ) : (
          <>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div>
              <label htmlFor="login-username-input" className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
                Tên đăng nhập
              </label>
              <div className="relative flex items-center">
                <div className="absolute left-3 text-slate-400 pointer-events-none z-10">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="login-username-input"
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="username"
                  autoFocus={mode === 'password'}
                  enterKeyHint="next"
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    // Remote TV: Enter ở ô username -> nhảy xuống ô mật khẩu, khỏi submit nhầm
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      passwordRef.current?.focus();
                    }
                  }}
                  style={{ fontSize: '16px' }}
                  className="w-full bg-[#131f37] border border-slate-700/80 hover:border-slate-600 focus:border-blue-500 rounded-2xl pl-10 pr-4 py-3 text-white text-base placeholder-slate-500 focus:outline-none transition-colors"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="login-password-input" className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
                Mật khẩu
              </label>
              <div className="relative flex items-center">
                <div className="absolute left-3 text-slate-400 pointer-events-none z-10">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  id="login-password-input"
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ fontSize: '16px' }}
                  className="w-full bg-[#131f37] border border-slate-700/80 hover:border-slate-600 focus:border-blue-500 rounded-2xl pl-10 pr-11 py-3 text-white text-base placeholder-slate-500 focus:outline-none transition-colors"
                />
                <button
                  type="button"
                  id="login-password-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  title={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  className="absolute right-3 text-slate-400 hover:text-white p-1 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              id="login-submit-btn"
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 py-3.5 px-6 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-blue-600/30 active:scale-[0.98] transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Đang xác thực tài khoản...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Vào Xem Phim</span>
                </>
              )}
            </button>
          </form>

          {/* Đăng nhập bằng điện thoại: khỏi gõ mật khẩu bằng remote TV */}
          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-800" />
            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">hoặc</span>
            <div className="flex-1 h-px bg-slate-800" />
          </div>
          <button
            type="button"
            id="login-pair-btn"
            onClick={() => setMode('code')}
            className="mt-4 w-full py-3.5 px-6 rounded-2xl bg-sky-950/60 hover:bg-sky-900/60 border border-sky-800/60 text-sky-200 font-bold text-sm tracking-wide transition-all cursor-pointer flex items-center justify-center gap-2"
          >
            <Smartphone className="w-4 h-4" />
            <span>{isTv ? 'Đăng nhập bằng điện thoại (khỏi gõ)' : 'Đăng nhập bằng mã trên TV'}</span>
          </button>
          </>
          )}

          {/* Private Policy Note */}
          <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
            <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/60">
              <ShieldCheck className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>Hệ thống chỉ cho phép đăng nhập, không mở đăng ký tự do.</span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
};

