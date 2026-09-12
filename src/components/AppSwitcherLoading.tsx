import React, { useEffect, useState } from 'react';
import { ActiveApp } from '../types';
import appLogo from '../assets/images/app_logo.jpg';
import { motion, AnimatePresence } from 'motion/react';

interface AppSwitcherLoadingProps {
  targetApp: ActiveApp;
  onLoadingComplete: () => void;
}

export const AppSwitcherLoading: React.FC<AppSwitcherLoadingProps> = ({ targetApp, onLoadingComplete }) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let isReady = false;
    const handleReady = () => {
      isReady = true;
    };
    window.addEventListener('app-data-loaded', handleReady);

    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          return 100;
        }
        
        const nextRaw = prev + Math.floor(Math.random() * 20) + 10;
        const next = Math.min(100, nextRaw);
        
        // If we reach 100 but data is not ready, hang at 99%
        if (next >= 100 && !isReady) {
          return 99;
        }
        
        return Math.min(100, next);
      });
    }, 200);

    // Safety fallback: auto-complete after 8 seconds anyway
    const fallbackTimeout = setTimeout(() => {
      isReady = true;
    }, 8000);

    return () => {
      clearInterval(interval);
      clearTimeout(fallbackTimeout);
      window.removeEventListener('app-data-loaded', handleReady);
    };
  }, []);

  useEffect(() => {
    if (progress >= 100) {
      setTimeout(() => {
        onLoadingComplete();
      }, 400); // Give it a slight delay before transitioning
    }
  }, [progress, onLoadingComplete]);

  let themeClass = 'from-blue-900 to-slate-900';
  let title = 'Gấu Cinema';
  let message = 'Đang chuyển đến Rạp Phim...';
  let accentColor = 'bg-blue-500';

  if (targetApp === 'livetv') {
    themeClass = 'from-orange-900 to-slate-900';
    title = 'Gấu LiveTV';
    message = 'Đang kết nối các kênh trực tiếp...';
    accentColor = 'bg-orange-500';
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.5 } }}
        className={`fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gradient-to-br ${themeClass}`}
      >
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="flex flex-col items-center"
        >
          <div className="relative w-24 h-24 sm:w-32 sm:h-32 rounded-3xl overflow-hidden border-4 border-white/20 shadow-2xl mb-6">
            <img src={appLogo} alt="Gấu App Logo" className="w-full h-full object-cover" />
          </div>
          
          <h2 className="text-3xl sm:text-4xl font-black text-white mb-2 tracking-tight">
            {title}
          </h2>
          <p className="text-sm sm:text-base text-slate-300 font-medium mb-8">
            {message}
          </p>

          <div className="w-64 sm:w-80 h-2 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, progress)}%` }}
              className={`h-full ${accentColor} rounded-full`}
            />
          </div>
          <p className="mt-3 text-xs font-semibold text-slate-400">
            {Math.min(100, progress)}% Hoàn tất
          </p>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
