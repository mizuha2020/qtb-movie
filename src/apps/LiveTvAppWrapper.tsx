import React, { useState } from 'react';
import { Account, UserProfile } from '../types';
import { LiveTvView } from '../components/LiveTvView';
import { LiveTvNavbar } from '../components/livetv/LiveTvNavbar';

interface LiveTvAppWrapperProps {
  currentAccount: Account | null;
  activeProfile: UserProfile | null;
  profiles: UserProfile[];
  onSelectProfile: (profile: UserProfile) => void;
  onSwitchApp: (app: 'cinema' | 'livetv' | 'youtube' | 'anime') => void;
  onSwitchProfileScreen: () => void;
  onOpenAdminDashboard?: () => void;
  onLogout?: () => void;
}

export const LiveTvAppWrapper: React.FC<LiveTvAppWrapperProps> = ({
  currentAccount,
  activeProfile,
  profiles,
  onSelectProfile,
  onSwitchApp,
  onSwitchProfileScreen,
  onOpenAdminDashboard,
  onLogout
}) => {
  const [resetKey, setResetKey] = useState(0);

  const handleLogoClick = () => {
    setResetKey(prev => prev + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#0a0602] text-white font-sans selection:bg-orange-600 selection:text-white">
      <LiveTvNavbar
        currentAccount={currentAccount}
        activeProfile={activeProfile}
        profiles={profiles}
        onSelectProfile={onSelectProfile}
        onSwitchApp={onSwitchApp}
        onSwitchProfileScreen={onSwitchProfileScreen}
        onOpenAdminDashboard={onOpenAdminDashboard}
        onLogout={onLogout}
        onLogoClick={handleLogoClick}
      />
      
      <main className="relative min-h-[calc(100vh-160px)] pb-24 md:pb-16 pt-20">
        <LiveTvView key={resetKey} currentAccount={currentAccount} />
      </main>
    </div>
  );
};
