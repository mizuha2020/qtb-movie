// TV 10-foot detection — UA-first, hover chỉ là gợi ý phụ.
// Lý do rewrite: bản cũ gate theo `hover:hover` nên WebView trên TV box
// (báo hover được / cắm chuột) bị rớt khỏi tv-mode.

const TV_UA_RE =
  /googletv|smarttv|smart[ -]?tv|smartcast|appletv|appletv\+|hbbtv|pov_tv|netcast|web0s|tizen|roku|viera|bravia|aftt|aftm|aftb|firetv|leanback|ouya|nvidia shield|mi tv|mitv|android tv|tcl|hisense|vidaa|crkey|opera tv|opera-tv|shieldtv|tv box/i;

const TV_FORCE_KEY = 'gau_tv_mode'; // localStorage: '1' | '0'

function getUrlOverride(): boolean | null {
  try {
    const v = new URLSearchParams(window.location.search).get('tv');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {}
  return null;
}

function getStoredOverride(): boolean | null {
  try {
    const v = localStorage.getItem(TV_FORCE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {}
  return null;
}

export const TV_MODE_EVENT = 'gau_tv_mode_change';

export function setTvModeOverride(v: boolean | null) {
  try {
    if (v === null) localStorage.removeItem(TV_FORCE_KEY);
    else localStorage.setItem(TV_FORCE_KEY, v ? '1' : '0');
  } catch {}
  applyTvClass();
  try {
    window.dispatchEvent(new Event(TV_MODE_EVENT));
  } catch {}
}

export function isTvDevice(): boolean {
  if (typeof window === 'undefined') return false;

  // 1. Override thủ công luôn thắng (test ?tv=1, setting trong app).
  // ?tv=1/0 được persist vào localStorage để mở app/TV lần sau vẫn giữ.
  const urlOv = getUrlOverride();
  if (urlOv !== null) {
    try {
      localStorage.setItem(TV_FORCE_KEY, urlOv ? '1' : '0');
    } catch {}
    return urlOv;
  }
  const storedOv = getStoredOverride();
  if (storedOv !== null) return storedOv;

  // 2. UA là nguồn đáng tin nhất trên TV box / Google TV
  try {
    if (TV_UA_RE.test(navigator.userAgent)) return true;
  } catch {}

  // 3. Heuristic cho Android box UA trơn (Xiaomi Stick/Mecool chỉ báo
  // Chrome Linux/Android, không có chữ "tv") + TV cắm chuột/air-mouse.
  try {
    const w = window.innerWidth || 0;
    const canHover = window.matchMedia('(hover: hover)').matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia('(pointer: fine)').matches;
    if (w >= 1920 && !canHover) return true;
    if (w >= 1280 && !canHover && coarse) return true;
    // Box UA trơn: màn hình lớn + pointer thô + KHÔNG có pointer fine
    // (kể cả khi báo hover được do cắm chuột, thiếu fine vẫn coi là TV).
    if (w >= 1024 && coarse && !fine) return true;
    // TV không cảm ứng/không chuột (Chrome/WebView báo pointer:none,
    // hover:none): màn đủ lớn + không có fine pointer thì chắc chắn là TV.
    // (Case này trước đây miss nên cài lên TV thật vẫn chạy giao diện web.)
    if (w >= 960 && !canHover && !fine) return true;
    // Lưới cuối: thiết bị KHÔNG có màn cảm ứng + không có chuột fine +
    // màn rộng (WebView trên TV box thường báo hover/coarse kiểu desktop).
    // Desktop chuột thật luôn có fine -> loại; phone/tablet luôn có cảm ứng -> loại.
    let hasTouch = false;
    try {
      hasTouch =
        'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    } catch {}
    if (!hasTouch && !fine && w >= 800) return true;
    // APK native cài trên TV box không cảm ứng -> chắc chắn là TV.
    try {
      const cap = (window as any)?.Capacitor;
      if (cap?.isNativePlatform?.() && !hasTouch) return true;
    } catch {}
  } catch {}
  return false;
}

export interface TvDiagnosis {
  ua: string;
  w: number;
  h: number;
  dpr: number;
  canHover: boolean | null;
  coarse: boolean | null;
  fine: boolean | null;
  urlOv: boolean | null;
  storedOv: boolean | null;
  uaMatch: boolean;
  /** rule nào đã match: 'override-url' | 'override-stored' | 'ua' | 'r1' | 'r2' | 'r3' | 'r4' | null */
  matchedRule: string | null;
  result: boolean;
  tvClassApplied: boolean;
}

/** Chẩn đoán chi tiết vì sao TV vào/không vào tv-mode (dùng cho panel ?tvdebug=1). */
export function diagnoseTv(): TvDiagnosis {
  const d: TvDiagnosis = {
    ua: '',
    w: 0,
    h: 0,
    dpr: 1,
    canHover: null,
    coarse: null,
    fine: null,
    urlOv: null,
    storedOv: null,
    uaMatch: false,
    matchedRule: null,
    result: false,
    tvClassApplied: false,
  };
  try {
    d.ua = navigator.userAgent || '';
  } catch {}
  try {
    d.w = window.innerWidth || 0;
    d.h = window.innerHeight || 0;
    d.dpr = window.devicePixelRatio || 1;
  } catch {}
  try {
    d.canHover = window.matchMedia('(hover: hover)').matches;
    d.coarse = window.matchMedia('(pointer: coarse)').matches;
    d.fine = window.matchMedia('(pointer: fine)').matches;
  } catch {}
  d.urlOv = getUrlOverride();
  d.storedOv = getStoredOverride();
  try {
    d.uaMatch = TV_UA_RE.test(d.ua);
  } catch {}
  if (d.urlOv !== null) {
    d.matchedRule = 'override-url';
    d.result = d.urlOv;
  } else if (d.storedOv !== null) {
    d.matchedRule = 'override-stored';
    d.result = d.storedOv;
  } else if (d.uaMatch) {
    d.matchedRule = 'ua';
    d.result = true;
  } else {
    const w = d.w;
    const canHover = d.canHover === true;
    const coarse = d.coarse === true;
    const fine = d.fine === true;
    if (w >= 1920 && !canHover) {
      d.matchedRule = 'r1';
      d.result = true;
    } else if (w >= 1280 && !canHover && coarse) {
      d.matchedRule = 'r2';
      d.result = true;
    } else if (w >= 1024 && coarse && !fine) {
      d.matchedRule = 'r3';
      d.result = true;
    } else if (w >= 960 && !canHover && !fine) {
      d.matchedRule = 'r4';
      d.result = true;
    } else {
      let hasTouch = false;
      try {
        hasTouch =
          'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
      } catch {}
      if (!hasTouch && !fine && w >= 800) {
        d.matchedRule = 'r5-no-touch';
        d.result = true;
      } else {
        try {
          const cap = (window as any)?.Capacitor;
          if (cap?.isNativePlatform?.() && !hasTouch) {
            d.matchedRule = 'r6-native-tv';
            d.result = true;
          }
        } catch {}
      }
    }
  }
  try {
    d.tvClassApplied = document.documentElement.classList.contains('tv-mode');
  } catch {}
  return d;
}

export function applyTvClass() {
  if (typeof document === 'undefined') return false;
  const isTv = isTvDevice();
  document.documentElement.classList.toggle('tv-mode', isTv);
  try {
    if (isTv) document.documentElement.dataset.tv = '1';
    else delete document.documentElement.dataset.tv;
  } catch {}
  return isTv;
}
