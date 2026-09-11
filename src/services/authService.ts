import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
} from 'firebase/firestore';
import { db, isFirestoreQuotaExhausted, sanitizeData } from './firebase';
import { Account, UserProfile } from '../types';
import { sha256Hex } from '../utils/sha256';

const SESSION_ACCOUNT_KEY = 'qtb_logged_in_account_v1';
const SESSION_PROFILE_KEY = 'qtb_current_active_profile_v1';
const ACCOUNTS_CACHE_KEY = 'qtb_accounts_local_cache_v1';
const PASSWORD_SALT = 'qtb_cinema_secure_salt_2026';

function getLocalAccounts(): Account[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = localStorage.getItem(ACCOUNTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalAccounts(accounts: Account[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
  } catch {}
}

// Helper with timeout to prevent hanging on Firestore queries
function withTimeout<T>(promise: Promise<T>, timeoutMs = 4500, fallbackVal?: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve, reject) =>
      setTimeout(() => {
        if (fallbackVal !== undefined) {
          resolve(fallbackVal);
        } else {
          reject(new Error('Yêu cầu kết nối hết thời gian chờ.'));
        }
      }, timeoutMs)
    ),
  ]);
}

// Hash password SHA-256 (WebCrypto, fallback thuần JS khi mở qua IP LAN
// HTTP không phải secure context khiến crypto.subtle undefined)
export async function hashPassword(password: string): Promise<string> {
  return sha256Hex(password + PASSWORD_SALT);
}

// Check if string matches a 64-char hex SHA-256 hash
function isSha256Hash(str: string): boolean {
  return /^[a-f0-9]{64}$/i.test(str);
}

export const DEFAULT_AVATARS: string[] = [
  'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=200&auto=format&fit=crop&q=80',
];

export const authService = {
  // Ensure default Admin Account exists without overwriting custom password
  async bootstrapAdminAccount(forceReset = false): Promise<Account> {
    const hashedDefaultPass = await hashPassword('Admin@2026!');
    const fallbackAdmin: Account = {
      id: 'admin',
      username: 'admin',
      password: hashedDefaultPass,
      role: 'admin',
      displayName: 'Quản trị viên (Admin)',
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (isFirestoreQuotaExhausted()) {
      const locals = getLocalAccounts();
      const existing = locals.find((a) => a.username === 'admin');
      if (existing) return existing;
      setLocalAccounts([fallbackAdmin, ...locals]);
      return fallbackAdmin;
    }

    const adminDocRef = doc(db, 'accounts', 'admin');

    // Chỉ được tạo mới khi CHẮC CHẮN doc chưa tồn tại (đọc thành công + !exists)
    // hoặc khi forceReset. Nếu đọc lỗi (mất mạng, timeout) thì TUYỆT ĐỐI không
    // ghi đè — nếu không password/displayName admin sẽ bị reset về mặc định.
    let readOk = false;
    try {
      if (!forceReset) {
        const snap = await getDoc(adminDocRef);
        readOk = true;
        if (snap.exists()) {
          const acc = snap.data() as Account;
          const locals = getLocalAccounts();
          if (!locals.some((a) => a.username === 'admin')) {
            setLocalAccounts([acc, ...locals]);
          }
          return acc;
        }
      } else {
        readOk = true;
      }
    } catch (e) {
      readOk = false;
    }

    if (!readOk) {
      // Đọc thất bại: trả về cache local hoặc fallback trong bộ nhớ, KHÔNG setDoc
      const locals = getLocalAccounts();
      const existing = locals.find((a) => a.username === 'admin');
      if (existing) return existing;
      return fallbackAdmin;
    }

    const adminAccount: Account = fallbackAdmin;

    try {
      await setDoc(adminDocRef, sanitizeData(adminAccount), { merge: true });
      // Only set primary profile if no profiles exist
      const profilesCol = collection(db, 'accounts', 'admin', 'profiles');
      const profilesSnap = await getDocs(profilesCol).catch(() => null);
      if (!profilesSnap || profilesSnap.empty) {
        const primaryProfileRef = doc(db, 'accounts', 'admin', 'profiles', 'admin_primary');
        const primaryProfile: UserProfile = {
          id: 'admin_primary',
          name: 'Quản trị viên',
          avatar: DEFAULT_AVATARS[0],
          color: '#2563EB',
          isPrimary: true,
          createdAt: Date.now(),
        };
        await setDoc(primaryProfileRef, sanitizeData(primaryProfile), { merge: true }).catch(() => {});
      }
    } catch (e) {
      void 0;
    }

    const locals = getLocalAccounts();
    setLocalAccounts([adminAccount, ...locals.filter((a) => a.username !== 'admin')]);
    return adminAccount;
  },

  // Log in
  async login(usernameInput: string, passwordInput: string): Promise<Account> {
    const trimmedUser = usernameInput.trim().toLowerCase();
    const trimmedPass = passwordInput.trim();

    if (!trimmedUser || !trimmedPass) {
      throw new Error('Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.');
    }

    const hashedInput = await hashPassword(trimmedPass);
    const accountRef = doc(db, 'accounts', trimmedUser);

    try {
      let acc: Account | null = null;
      let targetDocRef = accountRef;

      if (!isFirestoreQuotaExhausted()) {
        // Fetch account with 4.5s timeout
        const snap = await withTimeout(getDoc(accountRef), 4500).catch((e) => {
          void 0;
          return null;
        });

        if (snap && snap.exists()) {
          acc = snap.data() as Account;
        } else {
          // Query by username field as secondary lookup
          try {
            const q = query(collection(db, 'accounts'), where('username', '==', trimmedUser));
            const querySnap = await withTimeout(getDocs(q), 3500);
            if (querySnap && !querySnap.empty) {
              acc = querySnap.docs[0].data() as Account;
              targetDocRef = doc(db, 'accounts', querySnap.docs[0].id);
            }
          } catch {
            // Ignore query error
          }
        }
      }

      // Check local cache if not found in Firestore or quota exceeded
      if (!acc) {
        const locals = getLocalAccounts();
        const found = locals.find((a) => a.username.toLowerCase() === trimmedUser);
        if (found) acc = found;
      }

      // Special handling for admin if not found yet
      if (!acc && trimmedUser === 'admin') {
        const bootstrapped = await this.bootstrapAdminAccount(false);
        acc = bootstrapped;
      }

      if (!acc) {
        throw new Error('Tài khoản không tồn tại. Vui lòng liên hệ Quản trị viên để được cấp tài khoản.');
      }

      // Validate password
      const storedPass = String(acc.password || '').trim();

      const isPasswordValid = storedPass === hashedInput;

      if (!isPasswordValid) {
        throw new Error('Mật khẩu không chính xác!');
      }

      // Upgrade plaintext password to SHA-256 hash if needed
      if (!isSha256Hash(storedPass) && !isFirestoreQuotaExhausted()) {
        updateDoc(targetDocRef, {
          password: hashedInput,
          updatedAt: Date.now(),
        }).catch((err) => void 0);
        acc.password = hashedInput;
      }

      if (acc.status === 'blocked') {
        throw new Error('Tài khoản đã bị tạm khóa bởi Quản trị viên.');
      }

      this.saveSessionAccount(acc);
      return acc;
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('Mật khẩu') ||
          err.message.includes('Tài khoản') ||
          err.message.includes('tạm khóa') ||
          err.message.includes('đầy đủ'))
      ) {
        throw err;
      }
      void 0;
      throw new Error(err.message || 'Không thể đăng nhập. Vui lòng kiểm tra lại mật khẩu hoặc kết nối mạng.');
    }
  },

  // Save session in localStorage
  saveSessionAccount(account: Account): void {
    try {
      localStorage.setItem(SESSION_ACCOUNT_KEY, JSON.stringify(account));
    } catch (e) {
      void 0;
    }
  },

  getSessionAccount(): Account | null {
    try {
      const stored = localStorage.getItem(SESSION_ACCOUNT_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && parsed.id && parsed.username) {
          return parsed as Account;
        } else {
          localStorage.removeItem(SESSION_ACCOUNT_KEY);
        }
      }
    } catch (e) {
      void 0;
      try {
        localStorage.removeItem(SESSION_ACCOUNT_KEY);
      } catch {}
    }
    return null;
  },

  logout(): void {
    try {
      localStorage.removeItem(SESSION_ACCOUNT_KEY);
      localStorage.removeItem(SESSION_PROFILE_KEY);
    } catch (e) {
      void 0;
    }
  },

  // Admin: Get all Accounts
  async getAllAccounts(): Promise<Account[]> {
    const local = getLocalAccounts();
    if (isFirestoreQuotaExhausted()) {
      if (!local.some((a) => a.username === 'admin')) {
        const adminAcc = await this.bootstrapAdminAccount(false);
        return [adminAcc, ...local];
      }
      return local;
    }

    const colRef = collection(db, 'accounts');
    try {
      const snap = await withTimeout(getDocs(colRef), 4000);
      const accounts: Account[] = [];
      for (const d of snap.docs) {
        const data = d.data() as Account;
        try {
          const profilesSnap = await getDocs(collection(db, 'accounts', d.id, 'profiles'));
          data.profilesCount = profilesSnap.size;
        } catch {
          data.profilesCount = 1;
        }
        accounts.push({ ...data, id: d.id });
      }

      // Ensure admin exists in list
      if (!accounts.some((a) => a.username === 'admin')) {
        const adminAcc = await this.bootstrapAdminAccount(false);
        accounts.unshift(adminAcc);
      }

      setLocalAccounts(accounts);
      return accounts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (err) {
      void 0;
      return local;
    }
  },

  // Admin: Create new user account (with hashed password & default primary profile)
  async createAccount(username: string, password: string, displayName: string): Promise<Account> {
    const trimmedUser = username.trim().toLowerCase();
    if (!trimmedUser || trimmedUser.length < 2) {
      throw new Error('Tên đăng nhập phải có ít nhất 2 ký tự.');
    }
    if (!password || password.length < 4) {
      throw new Error('Mật khẩu phải có ít nhất 4 ký tự.');
    }

    const locals = getLocalAccounts();
    if (locals.some((a) => a.username.toLowerCase() === trimmedUser)) {
      throw new Error(`Tên đăng nhập "${trimmedUser}" đã tồn tại! Vui lòng chọn tên khác.`);
    }

    const hashedPassword = await hashPassword(password.trim());
    const newAccount: Account = {
      id: trimmedUser,
      username: trimmedUser,
      password: hashedPassword,
      role: 'user',
      displayName: displayName.trim() || trimmedUser,
      status: 'active',
      createdAt: Date.now(),
    };

    // Save locally first
    setLocalAccounts([newAccount, ...locals]);

    if (isFirestoreQuotaExhausted()) {
      return newAccount;
    }

    const accountRef = doc(db, 'accounts', trimmedUser);
    try {
      const existing = await withTimeout(getDoc(accountRef), 3500).catch(() => null);
      if (existing && existing.exists()) {
        throw new Error(`Tên đăng nhập "${trimmedUser}" đã tồn tại! Vui lòng chọn tên khác.`);
      }

      await setDoc(accountRef, sanitizeData(newAccount));

      // Create Default Primary Profile matching the username
      const primaryProfileId = `prof_${trimmedUser}_primary`;
      const primaryProfileRef = doc(db, 'accounts', trimmedUser, 'profiles', primaryProfileId);
      const primaryProfile: UserProfile = {
        id: primaryProfileId,
        name: displayName.trim() || trimmedUser,
        avatar: DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)],
        color: '#2563EB',
        isPrimary: true,
        createdAt: Date.now(),
      };
      await setDoc(primaryProfileRef, sanitizeData(primaryProfile)).catch(() => {});

      return newAccount;
    } catch (err: any) {
      if (err.message && (err.message.includes('tồn tại') || err.message.includes('ký tự'))) {
        throw err;
      }
      void 0;
      return newAccount;
    }
  },

  // Admin: Update Account (hash password if updated)
  async updateAccount(
    accountId: string,
    updates: Partial<Pick<Account, 'password' | 'displayName' | 'status'>>
  ): Promise<void> {
    const sanitizedUpdates: any = {
      ...updates,
      updatedAt: Date.now(),
    };
    if (updates.password && updates.password.trim()) {
      sanitizedUpdates.password = await hashPassword(updates.password.trim());
    }

    // Update local accounts cache
    const locals = getLocalAccounts();
    const updatedLocals = locals.map((a) => (a.id === accountId ? { ...a, ...sanitizedUpdates } : a));
    setLocalAccounts(updatedLocals);

    // If updating current active session account, update localStorage
    const currentSession = this.getSessionAccount();
    if (currentSession && currentSession.id === accountId) {
      this.saveSessionAccount({
        ...currentSession,
        ...sanitizedUpdates,
      });
    }

    if (isFirestoreQuotaExhausted()) return;

    const accountRef = doc(db, 'accounts', accountId);
    try {
      await setDoc(accountRef, sanitizeData(sanitizedUpdates), { merge: true });
    } catch (err) {
      void 0;
    }
  },

  // Admin: Delete Account (Cannot delete admin)
  async deleteAccount(accountId: string): Promise<void> {
    if (accountId === 'admin') {
      throw new Error('Không thể xóa tài khoản Quản trị viên gốc!');
    }

    // Update local accounts cache
    const locals = getLocalAccounts();
    setLocalAccounts(locals.filter((a) => a.id !== accountId));

    if (isFirestoreQuotaExhausted()) return;

    const accountRef = doc(db, 'accounts', accountId);
    try {
      const profilesSnap = await getDocs(collection(db, 'accounts', accountId, 'profiles')).catch(() => null);
      if (profilesSnap) {
        for (const pDoc of profilesSnap.docs) {
          await deleteDoc(pDoc.ref).catch(() => {});
        }
      }
      await deleteDoc(accountRef);
    } catch (err) {
      void 0;
    }
  },
};
