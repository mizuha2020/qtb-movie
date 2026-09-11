import { Capacitor } from '@capacitor/core';

export const isNativeApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    // 1. Capacitor core platform check
    if (Capacitor.isNativePlatform()) return true;
    const platform = Capacitor.getPlatform();
    if (platform === 'android' || platform === 'ios') return true;

    // 2. Window Capacitor bridge check
    const capObj = (window as any).Capacitor;
    if (capObj?.isNative) return true;
    if (capObj?.getPlatform && typeof capObj.getPlatform === 'function') {
      const p = capObj.getPlatform();
      if (p === 'android' || p === 'ios') return true;
    }

    const origin = window.location.origin || '';
    const protocol = window.location.protocol || '';
    const hostname = window.location.hostname || '';
    const port = window.location.port || '';

    // 3. Native app protocol schemes
    if (
      origin.startsWith('capacitor://') ||
      origin.startsWith('ionic://') ||
      protocol === 'file:'
    ) {
      return true;
    }

    // 4. Capacitor Android default scheme (https://localhost or http://localhost with no dev port)
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // In Android Capacitor APK, androidScheme is 'https' and port is empty (standard 443)
      if (protocol === 'https:' || port === '' || port === '80' || port === '443') {
        return true;
      }
      // Check user agent for Android WebView
      const ua = navigator.userAgent || '';
      if (/Android/i.test(ua) && (/wv/i.test(ua) || /Version\/4\.0/i.test(ua) || /Mobile/i.test(ua))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
};

export const CLOUD_BACKEND_URL = 'https://quocthubay-movie.ai.studio';

// --- Tự chữa backend chết (APK bake VITE_API_URL cũ mà không ai hay) ---
// Thứ tự ưu tiên: custom (người dùng chỉ định) > session đã verify kỳ này >
// verified đã lưu (kỳ trước chữa khỏi) > env baked-in > cloud mặc định.
const VERIFIED_KEY = 'qtb_verified_backend_url';
const VERIFIED_TTL_MS = 24 * 60 * 60 * 1000;
let sessionBackendOverride: string | null = null;
let verifyPromise: Promise<string> | null = null;

function readPersistedVerified(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = localStorage.getItem(VERIFIED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { url?: string; at?: number };
    const url = (parsed?.url || '').trim().replace(/\/$/, '');
    if (!url.startsWith('http') || !parsed?.at || Date.now() - parsed.at > VERIFIED_TTL_MS) return null;
    return url;
  } catch {
    return null;
  }
}

function persistVerified(url: string) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(VERIFIED_KEY, JSON.stringify({ url: url.replace(/\/$/, ''), at: Date.now() }));
  } catch {
    // ignore
  }
}

async function checkBackendHealth(base: string, ms = 6000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const r = await fetch(`${base.replace(/\/$/, '')}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && (j as any).status === 'ok');
  } catch {
    return false;
  }
}

/**
 * Kiểm tra backend đang dùng còn sống không; chết thì đổi sang cloud cho kỳ này
 * (và lưu lại để lần sau dùng ngay từ đầu, khỏi chờ fetch rớt mới biết).
 * Web (relative URL) thì no-op. Luôn resolve, không bao giờ throw.
 */
export function verifyBackendUrl(): Promise<string> {
  if (typeof window === 'undefined' || !isNativeApp()) {
    return Promise.resolve(getApiBaseUrl());
  }
  // Đã có backend tin cậy (session/lưu 24h) -> dùng NGAY, verify lại nền
  // (không chặn phát phim / đổi tập).
  const trusted = sessionBackendOverride || readPersistedVerified();
  if (trusted) {
    if (!verifyPromise) {
      verifyPromise = (async () => {
        if (await checkBackendHealth(trusted, 4000)) {
          sessionBackendOverride = trusted;
          persistVerified(trusted);
          return trusted;
        }
        if (trusted !== CLOUD_BACKEND_URL && (await checkBackendHealth(CLOUD_BACKEND_URL, 4000))) {
          console.info(`[backend] ${trusted} unreachable, fallback to ${CLOUD_BACKEND_URL}`);
          sessionBackendOverride = CLOUD_BACKEND_URL;
          persistVerified(CLOUD_BACKEND_URL);
          return CLOUD_BACKEND_URL;
        }
        return trusted;
      })();
      verifyPromise.catch(() => {});
    }
    return Promise.resolve(trusted);
  }
  if (!verifyPromise) {
    // Chưa có gì tin cậy: race current vs cloud (4s) thay vì nối tiếp 6s+6s
    verifyPromise = (async () => {
      const current = getApiBaseUrl();
      const [okCur, okCloud] = await Promise.all([
        checkBackendHealth(current, 4000),
        current !== CLOUD_BACKEND_URL
          ? checkBackendHealth(CLOUD_BACKEND_URL, 4000)
          : Promise.resolve(false),
      ]);
      const win = okCur ? current : okCloud ? CLOUD_BACKEND_URL : current;
      if (win !== current) {
        console.info(`[backend] ${current} unreachable, fallback to ${win}`);
      }
      sessionBackendOverride = win;
      persistVerified(win);
      return win;
    })();
    verifyPromise.catch(() => {});
  }
  return verifyPromise;
}

export const getApiBaseUrl = (): string => {
  // 1. Check custom user/admin saved backend URL in localStorage
  if (typeof window !== 'undefined') {
    try {
      const customUrl = localStorage.getItem('qtb_custom_backend_url');
      if (customUrl && customUrl.trim().startsWith('http')) {
        return customUrl.trim().replace(/\/$/, '');
      }
    } catch {}
  }

  // 1b. Session override / verified URL từ lần verify trước (xem verifyBackendUrl)
  if (sessionBackendOverride && sessionBackendOverride.startsWith('http')) {
    return sessionBackendOverride;
  }
  const persisted = readPersistedVerified();
  if (persisted) {
    return persisted;
  }

  // 2. ONLY for native mobile app (Capacitor Android APK), use absolute backend URL
  if (isNativeApp()) {
    const envUrl = (import.meta as any).env?.VITE_API_URL || (import.meta as any).env?.VITE_APP_URL;
    // Guard: ignore Vite placeholder values baked at build time (e.g. "MY_APP_URL")
    // otherwise APK calls "MY_APP_URL/api/..." -> fetch fails, web still works via relative URL.
    if (envUrl && typeof envUrl === 'string' && envUrl.trim().startsWith('http') && !envUrl.includes('MY_')) {
      return envUrl.trim().replace(/\/$/, '');
    }
    return CLOUD_BACKEND_URL;
  }

  // 3. For ALL web browsers (Preview, Published link, AI Studio iframe, local dev):
  // MUST return empty string so relative URLs like `/api/proxy/...` are used directly
  // on the current host origin without cross-origin redirects.
  return '';
};

export const API_BASE_URL = getApiBaseUrl();

export const getFullApiUrl = (path: string): string => {
  if (!path) return '';
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('blob:') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = getApiBaseUrl();
  // Guard stale bundle where base is a placeholder (e.g. "MY_APP_URL")
  if (base && !base.startsWith('http') && !base.startsWith('/')) {
    if (isNativeApp()) {
      return `${CLOUD_BACKEND_URL}${cleanPath}`;
    }
    return cleanPath;
  }
  if (!base) {
    // Crucial safeguard for APK: Never return relative path if running in native app
    if (isNativeApp()) {
      return `${CLOUD_BACKEND_URL}${cleanPath}`;
    }
    return cleanPath;
  }
  return `${base}${cleanPath}`;
};

/**
 * Safely fetch JSON from backend or external URL with timeout and content-type validation.
 * Prevents "Unexpected token '<'" when receiving HTML error/redirect pages.
 */
export async function safeFetchJson<T = any>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    // If upstream returns HTML (e.g. 302 cookie check or error page), reject safely
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      return null;
    }
    const data = await res.json();
    return data as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

