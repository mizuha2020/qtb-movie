import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  onSnapshot,
} from 'firebase/firestore';
import { db, handleFirestoreError, isFirestoreQuotaExhausted, OperationType, sanitizeData } from './firebase';
import { AdminNotification, CustomAvatar, MyListItem, UserProfile, WatchHistoryItem, YouTubeVideo } from '../types';
import { DEFAULT_AVATARS } from './authService';

const ACTIVE_PROFILE_KEY = 'qtb_active_profile_id_v2';
const PROFILES_CACHE_PREFIX = 'qtb_profiles_cache_v2_';

function getLocalJson<T>(key: string, fallback: T): T {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function setLocalJson<T>(key: string, val: T): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function getLocalProfilesCache(accountId: string): UserProfile[] | null {
  try {
    const raw = localStorage.getItem(`${PROFILES_CACHE_PREFIX}${accountId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    void 0;
  }
  return null;
}

function saveLocalProfilesCache(accountId: string, profiles: UserProfile[]): void {
  try {
    localStorage.setItem(`${PROFILES_CACHE_PREFIX}${accountId}`, JSON.stringify(profiles));
  } catch (e) {
    void 0;
  }
}

export const firestoreStorage = {
  // --- PROFILES MANAGEMENT (Max 5 per account) ---

  async getProfiles(accountId: string): Promise<UserProfile[]> {
    if (!accountId) return [];
    
    const cached = getLocalProfilesCache(accountId);

    if (isFirestoreQuotaExhausted()) {
      if (cached && cached.length > 0) return cached;
      const fallbackProf: UserProfile = {
        id: accountId === 'admin' ? 'admin_primary' : `prof_${accountId}_primary`,
        name: accountId === 'admin' ? 'Quản trị viên' : accountId,
        avatar: DEFAULT_AVATARS[0],
        color: '#2563EB',
        isPrimary: true,
        createdAt: Date.now(),
      };
      saveLocalProfilesCache(accountId, [fallbackProf]);
      return [fallbackProf];
    }

    const profilesCol = collection(db, 'accounts', accountId, 'profiles');
    try {
      const snap = await getDocs(profilesCol);
      if (!snap.empty) {
        const profiles = snap.docs.map((d) => d.data() as UserProfile);
        profiles.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        saveLocalProfilesCache(accountId, profiles);
        return profiles;
      }

      // If Firestore returns empty but local cache exists, return cached
      if (cached && cached.length > 0) {
        return cached;
      }

      // Otherwise, create default primary profile once
      const primaryId = accountId === 'admin' ? 'admin_primary' : `prof_${accountId}_primary`;
      const primaryProf: UserProfile = {
        id: primaryId,
        name: accountId === 'admin' ? 'Quản trị viên' : accountId,
        avatar: DEFAULT_AVATARS[0],
        color: '#2563EB',
        isPrimary: true,
        createdAt: Date.now(),
      };
      await setDoc(doc(db, 'accounts', accountId, 'profiles', primaryId), sanitizeData(primaryProf)).catch(() => {});
      const newProfiles = [primaryProf];
      saveLocalProfilesCache(accountId, newProfiles);
      return newProfiles;
    } catch (e) {
      void 0;
      if (cached && cached.length > 0) {
        return cached;
      }
      const fallbackProf: UserProfile = {
        id: accountId === 'admin' ? 'admin_primary' : `prof_${accountId}_primary`,
        name: accountId === 'admin' ? 'Quản trị viên' : accountId,
        avatar: DEFAULT_AVATARS[0],
        color: '#2563EB',
        isPrimary: true,
        createdAt: Date.now(),
      };
      return [fallbackProf];
    }
  },

  async addProfile(accountId: string, newProf: Omit<UserProfile, 'id' | 'createdAt'>): Promise<UserProfile> {
    const current = await this.getProfiles(accountId);
    if (current.length >= 5) {
      throw new Error('Tài khoản đã đạt giới hạn tối đa 5 hồ sơ người xem.');
    }

    const profileId = `prof_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const fullProfile: UserProfile = {
      ...newProf,
      id: profileId,
      isPrimary: false,
      createdAt: Date.now(),
    };

    const updatedList = [...current, fullProfile];
    saveLocalProfilesCache(accountId, updatedList);

    if (isFirestoreQuotaExhausted()) {
      return fullProfile;
    }

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId);
    try {
      await setDoc(docRef, sanitizeData(fullProfile));
      return fullProfile;
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `accounts/${accountId}/profiles/${profileId}`);
      return fullProfile;
    }
  },

  async updateProfile(accountId: string, profile: UserProfile): Promise<void> {
    const current = getLocalProfilesCache(accountId) || [];
    const updatedList = current.map((p) => (p.id === profile.id ? profile : p));
    saveLocalProfilesCache(accountId, updatedList);

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profile.id);
    try {
      await setDoc(docRef, sanitizeData(profile), { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `accounts/${accountId}/profiles/${profile.id}`);
    }
  },

  async deleteProfile(accountId: string, profileId: string): Promise<void> {
    const current = getLocalProfilesCache(accountId) || [];
    const target = current.find((p) => p.id === profileId);
    if (target?.isPrimary) {
      throw new Error('Không thể xóa hồ sơ chính mặc định của tài khoản.');
    }

    const updatedList = current.filter((p) => p.id !== profileId);
    saveLocalProfilesCache(accountId, updatedList);

    if (isFirestoreQuotaExhausted()) return;

    const profileRef = doc(db, 'accounts', accountId, 'profiles', profileId);
    try {
      const snap = await getDoc(profileRef);
      if (snap.exists()) {
        const data = snap.data() as UserProfile;
        if (data.isPrimary) {
          throw new Error('Không thể xóa hồ sơ chính mặc định của tài khoản.');
        }
      }
      await deleteDoc(profileRef);
    } catch (e: any) {
      if (e.message && e.message.includes('hồ sơ chính')) {
        throw e;
      }
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}/profiles/${profileId}`);
    }
  },

  getActiveProfileId(accountId: string): string | null {
    try {
      return localStorage.getItem(`${ACTIVE_PROFILE_KEY}_${accountId}`);
    } catch {
      return null;
    }
  },

  setActiveProfileId(accountId: string, profileId: string): void {
    try {
      localStorage.setItem(`${ACTIVE_PROFILE_KEY}_${accountId}`, profileId);
    } catch (e) {
      void 0;
    }
  },

  clearActiveProfileId(accountId: string): void {
    try {
      localStorage.removeItem(`${ACTIVE_PROFILE_KEY}_${accountId}`);
    } catch (e) {
      void 0;
    }
  },

  // --- WATCH HISTORY (Per Profile) ---

  async getHistory(accountId: string, profileId: string): Promise<WatchHistoryItem[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_history_${accountId}_${profileId}`;
    const local = getLocalJson<WatchHistoryItem[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) {
      return local;
    }

    const historyCol = collection(db, 'accounts', accountId, 'profiles', profileId, 'history');
    try {
      const snap = await getDocs(historyCol);
      if (!snap.empty) {
        const items = snap.docs.map((d) => d.data() as WatchHistoryItem);
        const sorted = items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/history`);
      return local;
    }
  },

  async saveWatchProgress(
    accountId: string,
    profileId: string,
    item: Omit<WatchHistoryItem, 'updatedAt'>
  ): Promise<void> {
    if (!accountId || !profileId) return;
    const cacheKey = `qtb_history_${accountId}_${profileId}`;
    const fullItem: WatchHistoryItem = {
      ...item,
      updatedAt: Date.now(),
    };

    // Update local cache immediately
    const local = getLocalJson<WatchHistoryItem[]>(cacheKey, []);
    const updated = [fullItem, ...local.filter((h) => h.movieSlug !== item.movieSlug)].slice(0, 30);
    setLocalJson(cacheKey, updated);

    if (isFirestoreQuotaExhausted()) return;

    const historyDocId = item.movieSlug;
    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'history', historyDocId);
    try {
      await setDoc(docRef, sanitizeData(fullItem), { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/history/${historyDocId}`);
    }
  },

  async removeHistoryItem(accountId: string, profileId: string, movieSlug: string): Promise<void> {
    if (!accountId || !profileId) return;
    const cacheKey = `qtb_history_${accountId}_${profileId}`;
    const local = getLocalJson<WatchHistoryItem[]>(cacheKey, []);
    setLocalJson(cacheKey, local.filter((h) => h.movieSlug !== movieSlug));

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'history', movieSlug);
    try {
      await deleteDoc(docRef);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}/profiles/${profileId}/history/${movieSlug}`);
    }
  },

  // --- MY LIST / WATCHLIST (Per Profile) ---

  async getMyList(accountId: string, profileId: string): Promise<MyListItem[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_mylist_${accountId}_${profileId}`;
    const local = getLocalJson<MyListItem[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) {
      return local;
    }

    const listCol = collection(db, 'accounts', accountId, 'profiles', profileId, 'myList');
    try {
      const snap = await getDocs(listCol);
      if (!snap.empty) {
        const items = snap.docs.map((d) => d.data() as MyListItem);
        const sorted = items.sort((a, b) => b.addedAt - a.addedAt);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/myList`);
      return local;
    }
  },

  async toggleMyList(
    accountId: string,
    profileId: string,
    item: Omit<MyListItem, 'addedAt'>
  ): Promise<boolean> {
    if (!accountId || !profileId) return false;
    const cacheKey = `qtb_mylist_${accountId}_${profileId}`;
    const local = getLocalJson<MyListItem[]>(cacheKey, []);
    const existsLocally = local.some((m) => m.movieSlug === item.movieSlug);

    let isAdded = false;
    if (existsLocally) {
      setLocalJson(cacheKey, local.filter((m) => m.movieSlug !== item.movieSlug));
      isAdded = false;
    } else {
      const fullItem: MyListItem = {
        ...item,
        addedAt: Date.now(),
      };
      setLocalJson(cacheKey, [fullItem, ...local]);
      isAdded = true;
    }

    if (isFirestoreQuotaExhausted()) return isAdded;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'myList', item.movieSlug);
    try {
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        await deleteDoc(docRef);
        return false;
      } else {
        const fullItem: MyListItem = {
          ...item,
          addedAt: Date.now(),
        };
        await setDoc(docRef, sanitizeData(fullItem));
        return true;
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/myList/${item.movieSlug}`);
      return isAdded;
    }
  },

  // --- CUSTOM AVATARS GALLERY (Managed by Admin) ---

  async getCustomAvatars(): Promise<CustomAvatar[]> {
    const cacheKey = 'qtb_custom_avatars_cache';
    const local = getLocalJson<CustomAvatar[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) {
      return local;
    }

    const avatarsCol = collection(db, 'customAvatars');
    try {
      const snap = await getDocs(avatarsCol);
      if (!snap.empty) {
        const list = snap.docs.map((d) => d.data() as CustomAvatar);
        const sorted = list.sort((a, b) => b.createdAt - a.createdAt);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, 'customAvatars');
      return local;
    }
  },

  async addCustomAvatar(url: string, name: string, addedBy: string): Promise<CustomAvatar> {
    const avatarId = `av_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const cacheKey = 'qtb_custom_avatars_cache';
    const newAvatar: CustomAvatar = {
      id: avatarId,
      url,
      name: name.trim() || 'Avatar mới',
      addedBy,
      createdAt: Date.now(),
    };

    const local = getLocalJson<CustomAvatar[]>(cacheKey, []);
    setLocalJson(cacheKey, [newAvatar, ...local]);

    if (isFirestoreQuotaExhausted()) return newAvatar;

    const docRef = doc(db, 'customAvatars', avatarId);
    try {
      await setDoc(docRef, sanitizeData(newAvatar));
      return newAvatar;
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `customAvatars/${avatarId}`);
      return newAvatar;
    }
  },

  async deleteCustomAvatar(avatarId: string): Promise<void> {
    const cacheKey = 'qtb_custom_avatars_cache';
    const local = getLocalJson<CustomAvatar[]>(cacheKey, []);
    setLocalJson(cacheKey, local.filter((a) => a.id !== avatarId));

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'customAvatars', avatarId);
    try {
      await deleteDoc(docRef);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `customAvatars/${avatarId}`);
    }
  },

  // --- GLOBAL TV HIDDEN CHANNELS (Admin Managed) ---

  async getHiddenChannels(): Promise<string[]> {
    const cacheKey = 'qtb_tv_hidden_channels';
    const local = getLocalJson<string[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    try {
      const docRef = doc(db, 'global', 'tv_config');
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        const list = (data.hiddenUrls as string[]) || [];
        setLocalJson(cacheKey, list);
        return list;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.GET, 'global/tv_config');
      return local;
    }
  },

  async saveHiddenChannels(hiddenUrls: string[]): Promise<void> {
    const cacheKey = 'qtb_tv_hidden_channels';
    setLocalJson(cacheKey, hiddenUrls);

    if (isFirestoreQuotaExhausted()) return;

    try {
      const docRef = doc(db, 'global', 'tv_config');
      await setDoc(docRef, sanitizeData({ hiddenUrls, updatedAt: Date.now() }));
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'global/tv_config');
    }
  },

  // --- MANGA SAVED & HISTORY (Per Profile) ---

  async getSavedManga(accountId: string, profileId: string): Promise<MangaItem[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_saved_manga_${accountId}_${profileId}`;
    const local = getLocalJson<MangaItem[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'accounts', accountId, 'profiles', profileId, 'savedManga');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const list = snap.docs.map((d) => d.data() as MangaItem);
        setLocalJson(cacheKey, list);
        return list;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/savedManga`);
      return local;
    }
  },

  async toggleSavedManga(accountId: string, profileId: string, manga: MangaItem): Promise<boolean> {
    if (!accountId || !profileId) return false;
    const cacheKey = `qtb_saved_manga_${accountId}_${profileId}`;
    const local = getLocalJson<MangaItem[]>(cacheKey, []);
    const exists = local.some((m) => m.id === manga.id);

    let isAdded = false;
    if (exists) {
      setLocalJson(cacheKey, local.filter((m) => m.id !== manga.id));
      isAdded = false;
    } else {
      setLocalJson(cacheKey, [manga, ...local]);
      isAdded = true;
    }

    if (isFirestoreQuotaExhausted()) return isAdded;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'savedManga', manga.id);
    try {
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        await deleteDoc(docRef);
        return false;
      } else {
        await setDoc(docRef, sanitizeData(manga));
        return true;
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/savedManga/${manga.id}`);
      return isAdded;
    }
  },

  async getMangaHistory(accountId: string, profileId: string): Promise<MangaHistoryItem[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_manga_hist_${accountId}_${profileId}`;
    const local = getLocalJson<MangaHistoryItem[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'accounts', accountId, 'profiles', profileId, 'mangaHistory');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const items = snap.docs.map((d) => d.data() as MangaHistoryItem);
        const sorted = items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/mangaHistory`);
      return local;
    }
  },

  async saveMangaProgress(accountId: string, profileId: string, item: MangaHistoryItem): Promise<void> {
    if (!accountId || !profileId) return;
    const cacheKey = `qtb_manga_hist_${accountId}_${profileId}`;
    const local = getLocalJson<MangaHistoryItem[]>(cacheKey, []);
    const updated = [item, ...local.filter((h) => h.mangaId !== item.mangaId)].slice(0, 50);
    setLocalJson(cacheKey, updated);

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'mangaHistory', item.mangaId);
    try {
      await setDoc(docRef, sanitizeData(item), { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/mangaHistory/${item.mangaId}`);
    }
  },

  async removeMangaHistoryItem(accountId: string, profileId: string, mangaId: string): Promise<void> {
    if (!accountId || !profileId) return;
    const cacheKey = `qtb_manga_hist_${accountId}_${profileId}`;
    const local = getLocalJson<MangaHistoryItem[]>(cacheKey, []);
    setLocalJson(cacheKey, local.filter((h) => h.mangaId !== mangaId));

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'mangaHistory', mangaId);
    try {
      await deleteDoc(docRef);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}/profiles/${profileId}/mangaHistory/${mangaId}`);
    }
  },

  // --- YOUTUBE FAVORITES & HISTORY & SUBSCRIPTIONS (Per Profile) ---

  async getYoutubeFavorites(accountId: string, profileId: string): Promise<YouTubeVideo[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_yt_fav_${accountId}_${profileId}`;
    const local = getLocalJson<YouTubeVideo[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'accounts', accountId, 'profiles', profileId, 'youtubeFavorites');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const items = snap.docs.map((d) => d.data() as YouTubeVideo & { addedAt?: number });
        const sorted = items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/youtubeFavorites`);
      return local;
    }
  },

  async toggleYoutubeFavorite(accountId: string, profileId: string, video: YouTubeVideo): Promise<boolean> {
    if (!accountId || !profileId || !video.id) return false;
    const cacheKey = `qtb_yt_fav_${accountId}_${profileId}`;
    const local = getLocalJson<YouTubeVideo[]>(cacheKey, []);
    const exists = local.some((v) => v.id === video.id);

    let isAdded = false;
    if (exists) {
      setLocalJson(cacheKey, local.filter((v) => v.id !== video.id));
      isAdded = false;
    } else {
      const itemToSave = {
        ...video,
        addedAt: Date.now(),
      };
      setLocalJson(cacheKey, [itemToSave, ...local]);
      isAdded = true;
    }

    if (isFirestoreQuotaExhausted()) return isAdded;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'youtubeFavorites', video.id);
    try {
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        await deleteDoc(docRef);
        return false;
      } else {
        const itemToSave = {
          ...video,
          addedAt: Date.now(),
        };
        await setDoc(docRef, sanitizeData(itemToSave));
        return true;
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/youtubeFavorites/${video.id}`);
      return isAdded;
    }
  },

  async getYoutubeHistory(accountId: string, profileId: string): Promise<YouTubeVideo[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_yt_hist_${accountId}_${profileId}`;
    const local = getLocalJson<YouTubeVideo[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'accounts', accountId, 'profiles', profileId, 'youtubeHistory');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const items = snap.docs.map((d) => d.data() as YouTubeVideo & { updatedAt?: number });
        const sorted = items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/youtubeHistory`);
      return local;
    }
  },

  async saveYoutubeHistory(accountId: string, profileId: string, video: YouTubeVideo): Promise<void> {
    if (!accountId || !profileId || !video.id) return;
    const cacheKey = `qtb_yt_hist_${accountId}_${profileId}`;
    const itemToSave = {
      ...video,
      updatedAt: Date.now(),
    };
    const local = getLocalJson<YouTubeVideo[]>(cacheKey, []);
    const updated = [itemToSave, ...local.filter((v) => v.id !== video.id)].slice(0, 50);
    setLocalJson(cacheKey, updated);

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'youtubeHistory', video.id);
    try {
      await setDoc(docRef, sanitizeData(itemToSave), { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/youtubeHistory/${video.id}`);
    }
  },

  async removeYoutubeHistoryItem(accountId: string, profileId: string, videoId: string): Promise<void> {
    if (!accountId || !profileId || !videoId) return;
    const cacheKey = `qtb_yt_hist_${accountId}_${profileId}`;
    const local = getLocalJson<YouTubeVideo[]>(cacheKey, []);
    setLocalJson(cacheKey, local.filter((v) => v.id !== videoId));

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'youtubeHistory', videoId);
    try {
      await deleteDoc(docRef);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `accounts/${accountId}/profiles/${profileId}/youtubeHistory/${videoId}`);
    }
  },

  async getYoutubeSubscriptions(accountId: string, profileId: string): Promise<string[]> {
    if (!accountId || !profileId) return [];
    const cacheKey = `qtb_yt_subs_${accountId}_${profileId}`;
    const local = getLocalJson<string[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'accounts', accountId, 'profiles', profileId, 'youtubeSubscriptions');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const subs = snap.docs.map((d) => (d.data().channelId as string) || d.id);
        setLocalJson(cacheKey, subs);
        return subs;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, `accounts/${accountId}/profiles/${profileId}/youtubeSubscriptions`);
      return local;
    }
  },

  async toggleYoutubeSubscription(
    accountId: string,
    profileId: string,
    channelId: string,
    channelTitle?: string,
    avatarUrl?: string
  ): Promise<boolean> {
    if (!accountId || !profileId || !channelId) return false;
    const cacheKey = `qtb_yt_subs_${accountId}_${profileId}`;
    const local = getLocalJson<string[]>(cacheKey, []);
    const exists = local.includes(channelId);

    let isSubscribed = false;
    if (exists) {
      setLocalJson(cacheKey, local.filter((id) => id !== channelId));
      isSubscribed = false;
    } else {
      setLocalJson(cacheKey, [...local, channelId]);
      isSubscribed = true;
    }

    if (isFirestoreQuotaExhausted()) return isSubscribed;

    const docId = channelId.replace(/[\/\.#$\[\]]/g, '_');
    const docRef = doc(db, 'accounts', accountId, 'profiles', profileId, 'youtubeSubscriptions', docId);
    try {
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        await deleteDoc(docRef);
        return false;
      } else {
        await setDoc(
          docRef,
          sanitizeData({
            channelId,
            channelTitle: channelTitle || '',
            channelAvatar: avatarUrl || '',
            subscribedAt: Date.now(),
          })
        );
        return true;
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `accounts/${accountId}/profiles/${profileId}/youtubeSubscriptions/${docId}`);
      return isSubscribed;
    }
  },

  // --- ADMIN SYSTEM TICKER NOTIFICATIONS ---

  async getNotifications(): Promise<AdminNotification[]> {
    const cacheKey = 'qtb_notifications_cache';
    const local = getLocalJson<AdminNotification[]>(cacheKey, []);

    if (isFirestoreQuotaExhausted()) return local;

    const colRef = collection(db, 'notifications');
    try {
      const snap = await getDocs(colRef);
      if (!snap.empty) {
        const list = snap.docs.map((d) => d.data() as AdminNotification);
        const sorted = list.sort((a, b) => b.createdAt - a.createdAt);
        setLocalJson(cacheKey, sorted);
        return sorted;
      }
      return local;
    } catch (e) {
      handleFirestoreError(e, OperationType.LIST, 'notifications');
      return local;
    }
  },

  async addNotification(data: Omit<AdminNotification, 'id' | 'createdAt'>): Promise<AdminNotification> {
    const id = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const cacheKey = 'qtb_notifications_cache';
    const newNotif: AdminNotification = {
      ...data,
      id,
      createdAt: Date.now(),
    };

    const local = getLocalJson<AdminNotification[]>(cacheKey, []);
    setLocalJson(cacheKey, [newNotif, ...local]);

    if (isFirestoreQuotaExhausted()) return newNotif;

    const docRef = doc(db, 'notifications', id);
    try {
      await setDoc(docRef, sanitizeData(newNotif));
      return newNotif;
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `notifications/${id}`);
      return newNotif;
    }
  },

  async updateNotification(id: string, updates: Partial<AdminNotification>): Promise<void> {
    const cacheKey = 'qtb_notifications_cache';
    const local = getLocalJson<AdminNotification[]>(cacheKey, []);
    setLocalJson(
      cacheKey,
      local.map((n) => (n.id === id ? { ...n, ...updates } : n))
    );

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'notifications', id);
    try {
      await updateDoc(docRef, sanitizeData(updates));
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `notifications/${id}`);
    }
  },

  async deleteNotification(id: string): Promise<void> {
    const cacheKey = 'qtb_notifications_cache';
    const local = getLocalJson<AdminNotification[]>(cacheKey, []);
    setLocalJson(cacheKey, local.filter((n) => n.id !== id));

    if (isFirestoreQuotaExhausted()) return;

    const docRef = doc(db, 'notifications', id);
    try {
      await deleteDoc(docRef);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `notifications/${id}`);
    }
  },

  subscribeNotifications(onUpdate: (notifications: AdminNotification[]) => void): () => void {
    if (isFirestoreQuotaExhausted()) {
      onUpdate([]);
      return () => {};
    }
    const colRef = collection(db, 'notifications');
    try {
      const unsubscribe = onSnapshot(
        colRef,
        (snap) => {
          const list = snap.docs.map((d) => d.data() as AdminNotification);
          list.sort((a, b) => b.createdAt - a.createdAt);
          onUpdate(list);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, 'notifications');
        }
      );
      return unsubscribe;
    } catch (e) {
      void 0;
      return () => {};
    }
  },
};
