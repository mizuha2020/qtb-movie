// TV 10-foot detection — UA-first, hover chỉ là gợi ý phụ.
// Lý do rewrite: bản cũ gate theo `hover:hover` nên WebView trên TV box
// (báo hover được / cắm chuột) bị rớt khỏi tv-mode.

const TV_UA_RE =
  /googletv|smarttv|smart-tv|smartcast|appletv|appletv\+|hbbtv|pov_tv|netcast|web0s|tizen|roku|viera|bravia|aftt|aftm|aftb|firetv|leanback|ouya|nvidia shield|mi tv|mitv|android tv|vidaa|crkey|opera tv|opera-tv|shieldtv|tv box/i;

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
  } catch {}
  return false;
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
