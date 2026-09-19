/**
 * tvRemote — spatial navigation cho remote TV (D-pad) trên WebView.
 * Chỉ hoạt động khi <html> có class `tv-mode` (xem tvDetect).
 * Player xử lý phím riêng (GauPlayer) nên hook toàn app sẽ nhường khi player mở.
 */

export type TvDirection = 'left' | 'right' | 'up' | 'down';
export type TvMediaAction = 'toggle' | 'back' | 'next' | 'prev' | 'rewind' | 'forward';
export const TV_MEDIA_EVENT = 'gau_tv_media';

export function isTvModeActive(): boolean {
  try {
    return (
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('tv-mode')
    );
  } catch {
    return false;
  }
}

export function isPlayerOpen(): boolean {
  try {
    return !!document.getElementById('gau-player-root');
  } catch {
    return false;
  }
}

function isEditable(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  // Dropdown/menu đang mở: để component tự xử lý phím
  if (el.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
  return false;
}

const TV_TEXT_INPUT_SEL =
  'input:not([type]),input[type="text"],input[type="search"],input[type="password"],' +
  'input[type="number"],input[type="email"],input[type="url"],input[type="tel"],textarea';

/** Ô nhập chữ (loại trừ nút/range/checkbox/select — mấy thứ này không bung IME). */
export function isTvTextInput(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  try {
    if (!el || !(el instanceof HTMLElement)) return false;
    if ((el as HTMLInputElement).disabled) return false;
    return (el as HTMLElement).matches?.(TV_TEXT_INPUT_SEL) ?? false;
  } catch {
    return false;
  }
}

/**
 * Khóa IME khi chỉ lướt qua (readonly): D-pad focus vào không bung bàn phím.
 * Chỉ lướt trên TV mới cần; desktop/mobile không đụng.
 */
export function armTvInputReadonly(el: HTMLElement): void {
  try {
    if (!isTvTextInput(el)) return;
    if (el.hasAttribute('data-tv-editing')) return;
    el.setAttribute('readonly', '');
  } catch {}
}

/**
 * Bấm OK vào ô đang khóa -> mở khóa + dời focus để WebView chắc chắn gọi IME.
 * Thứ tự blur trước, gắn cờ editing sau để handler focusout không khóa lại.
 */
export function enterTvEditMode(el: HTMLElement): boolean {
  try {
    if (!isTvTextInput(el)) return false;
    el.removeAttribute('readonly');
    try {
      (el as HTMLElement).blur();
    } catch {}
    el.setAttribute('data-tv-editing', '1');
    markProgrammaticFocus();
    const target = el;
    requestAnimationFrame(() => {
      try {
        target.focus({ preventScroll: true } as FocusOptions);
      } catch {
        try {
          target.focus();
        } catch {}
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Rời ô (blur) -> khóa lại, lần D-pad sau lướt qua không bung phím. */
export function exitTvEditMode(el: HTMLElement): void {
  try {
    el.removeAttribute('data-tv-editing');
    if (isTvTextInput(el)) el.setAttribute('readonly', '');
  } catch {}
}

const FOCUSABLE_SEL =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  try {
    // Chỉ đo rect (rẻ, browser batch được). KHÔNG gọi getComputedStyle mỗi phím:
    // style recalc trên hàng trăm nút là nguyên nhân lag D-pad ở home.
    const r = cachedRect(el);
    if (r.width <= 4 || r.height <= 4) return false;
    // KHÔNG lọc theo viewport: item dưới fold là target hợp lệ, bấm 1 phát là
    // focus nhảy tới + tvScrollIntoView cuộn theo. (Lọc viewport từng làm DPAD
    // xuống hàng chỉ cuộn chay mà không đổi focus.)
    return true;
  } catch {
    return false;
  }
}

/** Cache rect theo element, TTL ngắn để bấm dồn không đo lại cả trăm rect.
 *  Invalidate khi layout đổi (resize/nav/modal/scroll chương trình). */
const rectCache = new WeakMap<HTMLElement, { r: DOMRect; t: number }>();
const RECT_TTL_MS = 400;
let rectCacheVersion = 0;
export function invalidateTvRectCache(): void {
  rectCacheVersion += 1;
}
function cachedRect(el: HTMLElement): DOMRect {
  const now = Date.now();
  try {
    const hit = rectCache.get(el);
    if (hit && now - hit.t < RECT_TTL_MS) return hit.r;
  } catch {}
  const r = el.getBoundingClientRect();
  try {
    rectCache.set(el, { r, t: now });
  } catch {}
  return r;
}
void rectCacheVersion;

/** Invisible control = không tồn tại trong TV focus graph.
 *  Kiểm tra rẻ (không getComputedStyle): dựa vào marker DOM显式. */
export function isTvFocusable(el: HTMLElement): boolean {
  try {
    if (el.hasAttribute('data-tv-skip')) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    // Bottom-nav mobile không dùng trên TV
    if (el.closest?.('#mobile-bottom-nav') as Element | null) return false;
    // Player controls đang ẩn (data-controls=hidden): toàn bộ top/bottom bar vô hình
    try {
      const root = el.closest?.('#gau-player-root') as HTMLElement | null;
      if (root && root.getAttribute('data-controls') === 'hidden') {
        if (
          el.closest?.('.tv-player-top, .tv-player-bottom') as Element | null
        )
          return false;
      }
    } catch {}
    // Overlay loading resolving che controls chết phía dưới
    try {
      if (el.closest?.('[data-tv-hidden-pool]') as Element | null) return false;
    } catch {}
    return isVisible(el);
  } catch {
    return false;
  }
}

export function getFocusable(): HTMLElement[] {
  try {
    return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter(
      (el) => isTvFocusable(el),
    );
  } catch {
    return [];
  }
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Mốc thời gian focus được chuyển bằng code (D-pad/tự động), để hover-sync
 * phân biệt với mouseover THẬT từ chuột. Cuộn trang làm phần tử trôi xuống
 * dưới con trỏ đang đậu yên -> browser bắn mouseover giả -> phải bỏ qua,
 * không thì focus bị giật về chỗ cũ sau mỗi lần bấm.
 */
let lastProgFocus = 0;
export function markProgrammaticFocus(): void {
  try {
    lastProgFocus = Date.now();
  } catch {}
}
export function lastProgrammaticFocus(): number {
  return lastProgFocus;
}

/** Log điều hướng cuối (hiện trong panel ?tvdebug=1 để debug remote). */
let lastMoveInfo = '';
let lastMoveSeq = 0;
export function getLastTvMove(): string {
  return lastMoveInfo ? `#${lastMoveSeq} ${lastMoveInfo}` : '';
}
function setLastTvMove(s: string): void {
  try {
    lastMoveSeq += 1;
    lastMoveInfo = s;
  } catch {}
}
function describeEl(el: HTMLElement | null): string {
  if (!el) return '(none)';
  try {
    const id = el.id || el.getAttribute('data-tv-card') || '?';
    // Dùng rect cache (tránh thêm 2 GBCR uncached mỗi phím cho log debug)
    const r = cachedRect(el);
    return `${el.tagName}#${id} y=${Math.round(r.top)}..${Math.round(r.bottom)}`;
  } catch {
    return '(err)';
  }
}

/** Cuộn trang + hàng ngang để focus luôn nhìn thấy (không dùng scrollIntoView:
 *  block:'nearest' trên WebView TV lúc cuộn lúc không). Mỗi lần bấm = màn hình đi theo.
 *  Tween tay 200ms ease-out: mượt hơn instant (giật) mà không bò như smooth của browser.
 *  Bấm dồn thì tween cũ bị hủy, nối tiếp từ vị trí hiện tại. */
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
// Tween ngắn 110ms: đủ mượt 1 phát bấm, không bò. Bấm dồn thì instant luôn
// để tween không chồng tween (nguyên nhân khựng trên box yếu).
const TV_SCROLL_MS = 110;
// Ngưỡng bấm dồn: remote giữ nút bắn 100-150ms/phát -> <220ms là dồn.
const TV_RAPID_MS = 220;
let lastProgScrollAt = 0;
let scrollRetryTimer = 0;

function shouldInstantScroll(): boolean {
  try {
    const now = Date.now();
    const rapid = now - lastProgScrollAt < TV_RAPID_MS;
    lastProgScrollAt = now;
    return rapid;
  } catch {
    return false;
  }
}

function reduceMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

let winScrollRaf = 0;
function smoothWindowScrollBy(dy: number, instant = false) {
  try {
    cancelAnimationFrame(winScrollRaf);
    if (!dy) return;
    if (instant || reduceMotion()) {
      window.scrollBy(0, Math.round(dy));
      return;
    }
    const from = window.scrollY || window.pageYOffset || 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / TV_SCROLL_MS);
      window.scrollTo(0, Math.round(from + dy * easeOutCubic(p)));
      if (p < 1) winScrollRaf = requestAnimationFrame(step);
    };
    winScrollRaf = requestAnimationFrame(step);
  } catch {
    try {
      window.scrollBy(0, Math.round(dy));
    } catch {}
  }
}

const rowRafs = new WeakMap<HTMLElement, number>();
function smoothVertScrollTo(el: HTMLElement, to: number, instant = false) {
  try {
    const prev = rowRafs.get(el);
    if (prev) cancelAnimationFrame(prev);
    const from = el.scrollTop;
    const d = to - from;
    if (!d) return;
    if (instant || reduceMotion()) {
      el.scrollTop = to;
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / TV_SCROLL_MS);
      el.scrollTop = Math.round(from + d * easeOutCubic(p));
      if (p < 1) {
        rowRafs.set(el, requestAnimationFrame(step));
      }
    };
    rowRafs.set(el, requestAnimationFrame(step));
  } catch {
    try {
      el.scrollTop = to;
    } catch {}
  }
}
function smoothRowScrollTo(el: HTMLElement, to: number, instant = false) {
  try {
    const prev = rowRafs.get(el);
    if (prev) cancelAnimationFrame(prev);
    const from = el.scrollLeft;
    const d = to - from;
    if (!d) return;
    // Đi ngang từng card lệch ~200px nhưng bấm liên tục: animate liên tục
    // là giật. Lệch <60px hoặc đang bấm dồn thì instant luôn.
    if (Math.abs(d) < 60 || instant || reduceMotion()) {
      el.scrollLeft = to;
      return;
    }
    try {
      el.style.scrollBehavior = 'auto';
    } catch {}
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / TV_SCROLL_MS);
      el.scrollLeft = Math.round(from + d * easeOutCubic(p));
      if (p < 1) {
        rowRafs.set(el, requestAnimationFrame(step));
      } else {
        try {
          el.style.scrollBehavior = '';
        } catch {}
      }
    };
    rowRafs.set(el, requestAnimationFrame(step));
  } catch {
    try {
      el.scrollLeft = to;
    } catch {}
  }
}

export function tvScrollIntoView(el: HTMLElement, _depth = 0) {
  try {
    // Bấm mới hủy retry của lần trước (kẻo cuộn chồng)
    try {
      if (scrollRetryTimer) { window.clearTimeout(scrollRetryTimer); scrollRetryTimer = 0; }
    } catch {}
    // Navbar / bottom-nav fixed luôn hiện trên màn hình: focus đi trong đó thì
    // KHÔNG cuộn gì cả. Trước đây mỗi phát bấm giật trang lên vài px (topSafe)
    // làm hero banner phía dưới giật theo.
    try {
      let q: HTMLElement | null = el;
      while (q && q !== document.body && q !== document.documentElement) {
        if (q.id === 'qtb-navbar' || q.id === 'mobile-bottom-nav') return;
        q = q.parentElement;
      }
    } catch {}
    const instant = _depth === 0 ? shouldInstantScroll() : false;
    // Dùng rect cache: focus path vừa đo xong, tránh thêm 1 GBCR đồng bộ mỗi phím
    const r = cachedRect(el);
    const vh = window.innerHeight || 800;
    // Dọc: ưu tiên khung scroll trong GẦN NHẤT mà ĐỦ CHỖ chứa dy
    // (trang chi tiết fullpage, modal... cuộn bằng container riêng).
    // Khung gần mà chứa không đủ (lưới tập max-h-96) thì đi tiếp lên khung lớn
    // hơn, chứ không rớt về window (window đang bị khóa khi modal mở).
    // Mọi khung scroll dọc chứa el, từ gần ra xa (bỏ qua carousel ngang).
    const scrollers: HTMLElement[] = [];
    try {
      let p: HTMLElement | null = el.parentElement;
      while (p && p !== document.body && p !== document.documentElement) {
        if (p.scrollHeight > p.clientHeight + 8) {
          let oy = '';
          let ox = '';
          try {
            const cs = window.getComputedStyle(p);
            oy = cs.overflowY;
            ox = cs.overflowX;
          } catch {}
          if (oy === 'auto' || oy === 'scroll') {
            // BỎ QUA carousel ngang (hàng phim overflow-x-auto): scrollHeight
            // của nó có thể dư vài px do bo tròn, nhưng scrollTop gần như
            // không nhúc nhích -> cuộn dọc vào đây là mất dy (bug Netflix zone).
            const isHorizCarousel =
              (ox === 'auto' || ox === 'scroll') &&
              p.scrollWidth > p.clientWidth + 8;
            if (!isHorizCarousel) scrollers.push(p);
          }
        }
        p = p.parentElement;
      }
    } catch {}
    // Chừa chỗ navbar dính trên đầu / bottom-nav
    const topSafe = 140;
    const bottomSafe = 60;
    let dy = 0;
    if (r.top < topSafe) dy = r.top - topSafe;
    else if (r.bottom > vh - bottomSafe) dy = r.bottom - (vh - bottomSafe);
    if (dy !== 0) {
      // Chọn khung GẦN NHẤT mà còn đủ chỗ chứa dy theo đúng chiều.
      // VD trang chi tiết: lưới tập (max-h-96) chứa không đủ thì leo tiếp
      // lên khung fullpage, chứ rớt về window là đứng yên (window đang khóa).
      let picked: HTMLElement | null = null;
      try {
        for (const s of scrollers) {
          const max = s.scrollHeight - s.clientHeight;
          const avail = dy > 0 ? max - s.scrollTop : s.scrollTop;
          if (avail >= Math.abs(dy) - 4) {
            picked = s;
            break;
          }
        }
        if (!picked && scrollers.length) {
          // Không khung nào đủ chỗ: lấy khung chứa được NHIỀU NHẤT
          // (thay vì window đang khóa) để trang vẫn nhúc nhích theo focus.
          let bestCap = -1;
          for (const s of scrollers) {
            const max = s.scrollHeight - s.clientHeight;
            const avail = dy > 0 ? max - s.scrollTop : s.scrollTop;
            if (avail > bestCap) {
              bestCap = avail;
              picked = s;
            }
          }
          if (bestCap <= 0) picked = null;
        }
      } catch {
        picked = null;
      }
      if (picked) {
        setLastTvMove(`scroll inner ${picked.tagName}.${String(picked.className || '').slice(0, 30)} dy=${Math.round(dy)} -> ${describeEl(el)}`);
        smoothVertScrollTo(picked, picked.scrollTop + Math.round(dy), instant);
      } else {
        if (scrollers.length) {
          setLastTvMove(`scroll window (inners full) dy=${Math.round(dy)} -> ${describeEl(el)}`);
        } else {
          setLastTvMove(`scroll window dy=${Math.round(dy)} -> ${describeEl(el)}`);
        }
        smoothWindowScrollBy(dy, instant);
      }
      // Lưới an toàn: chỉ retry khi KHÔNG bấm dồn. Bấm dồn mà retry
      // là tự giật thêm 1 phát cuộn sau 320ms -> cảm giác lag gấp đôi.
      if (_depth === 0 && !instant) {
        const target = el;
        try {
          if (scrollRetryTimer) window.clearTimeout(scrollRetryTimer);
        } catch {}
        scrollRetryTimer = window.setTimeout(() => {
          scrollRetryTimer = 0;
          try {
            if (document.activeElement !== target) return;
            const r2 = target.getBoundingClientRect();
            const vh2 = window.innerHeight || 800;
            if (r2.bottom > vh2 - bottomSafe || r2.top < topSafe) {
              setLastTvMove(`RETRY scroll -> ${describeEl(target)}`);
              tvScrollIntoView(target, 1);
            }
          } catch {}
        }, 320);
      }
    }
    // Ngang kiểu Netflix: chỉ lia focus, còn trong khung nhìn thì KHÔNG cuộn.
    // Chạm mép mới cuộn tối thiểu để lọt vào (không căn giữa mỗi phát như trước).
    let p: HTMLElement | null = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        if (p.scrollWidth > p.clientWidth + 8) {
          const pr = cachedRect(p);
          const EDGE = 12;
          let to = -1;
          if (r.left < pr.left + EDGE) {
            to = Math.max(0, Math.round(p.scrollLeft + (r.left - pr.left) - EDGE));
          } else if (r.right > pr.right - EDGE) {
            to = Math.max(0, Math.round(p.scrollLeft + (r.right - pr.right) + EDGE));
          }
          if (to >= 0 && Math.abs(to - p.scrollLeft) > 2) {
            smoothRowScrollTo(p, to, instant);
          }
        }
      } catch {}
      p = p.parentElement;
    }
  } catch {}
}

/**
 * Điều hướng dọc giữa các hàng phim (Netflix-style):
 * đang đứng trên card mà bấm lên/xuống -> nhảy tới card ở hàng phim
 * gần nhất phía trên/dưới, KHÔNG rớt vào navbar chỉ vì navbar thẳng cột.
 * Trả về true nếu đã chuyển focus.
 */
/** Cache hàng phim: đo rect theo HÀNG (~15 hàng) thay vì theo CARD (~300 card).
 *  Bấm lên/xuống chỉ chấm điểm card trong 1-2 hàng kề, giảm ~20 lần getBoundingClientRect. */
type TvRowEntry = { el: HTMLElement; top: number; bottom: number; cards: HTMLElement[] };
let tvRowCache: { rows: TvRowEntry[]; t: number } | null = null;
const TV_ROW_TTL_MS = 800;
function getTvRowCache(active: HTMLElement | null): TvRowEntry[] {
  const now = Date.now();
  try {
    if (tvRowCache && now - tvRowCache.t < TV_ROW_TTL_MS && tvRowCache.rows.length) {
      return tvRowCache.rows;
    }
  } catch {}
  let scrollY = 0;
  try {
    scrollY = window.scrollY || window.pageYOffset || 0;
  } catch {}
  const rows: TvRowEntry[] = [];
  try {
    const rowEls = Array.from(document.querySelectorAll<HTMLElement>('[data-tv-row]'));
    for (const rowEl of rowEls) {
      let r: DOMRect;
      try {
        r = cachedRect(rowEl);
      } catch {
        continue;
      }
      if (!r || r.width <= 4 || r.height <= 4) continue;
      let cards: HTMLElement[] = [];
      try {
        cards = Array.from(rowEl.querySelectorAll<HTMLElement>('[data-tv-card]')).filter(
          (c) => c !== active,
        );
      } catch {}
      if (!cards.length) continue;
      rows.push({ el: rowEl, top: r.top + scrollY, bottom: r.bottom + scrollY, cards });
    }
    rows.sort((a, b) => a.top - b.top);
    tvRowCache = { rows, t: now };
  } catch {}
  return rows;
}
export function invalidateTvRowCache(): void {
  tvRowCache = null;
}

/**
 * Điều hướng dọc theo CHỈ SỐ CỘT (thay vì đo tâm hình học):
 * card focus đang nở rộng (160->320px) làm tâm X lệch ~80px nên scorer cũ
 * đoán nhầm cột (1->2->1...). Đi theo index trong hàng thì đứng yên cột nào
 * cũng trúng cột đó, không cần đo rect hàng trăm card.
 */
function focusCardRowIndexVertical(active: HTMLElement, dir: 'up' | 'down'): boolean {
  try {
    const activeRow = active.closest?.('[data-tv-row]') as HTMLElement | null;
    if (!activeRow) return false;
    let allRows: HTMLElement[];
    try {
      allRows = Array.from(document.querySelectorAll<HTMLElement>('[data-tv-row]'));
    } catch {
      return false;
    }
    if (allRows.length < 2) return false;
    const selfIdx = allRows.indexOf(activeRow);
    if (selfIdx < 0) return false;
    let cards: HTMLElement[];
    try {
      cards = Array.from(activeRow.querySelectorAll<HTMLElement>('[data-tv-card]'));
    } catch {
      return false;
    }
    const col = cards.indexOf(active);
    if (col < 0) return false;
    const step = dir === 'up' ? -1 : 1;
    // Thứ tự DOM = thứ tự dọc (các hàng xếp chồng), hàng ẩn thì bỏ qua
    for (let k = selfIdx + step; k >= 0 && k < allRows.length; k += step) {
      const row = allRows[k];
      let rr: DOMRect | null = null;
      try {
        rr = cachedRect(row);
      } catch {
        continue;
      }
      if (!rr || rr.width <= 4 || rr.height <= 4) continue;
      let tcards: HTMLElement[];
      try {
        tcards = Array.from(row.querySelectorAll<HTMLElement>('[data-tv-card]'));
      } catch {
        continue;
      }
      if (!tcards.length) continue;
      const j = Math.min(col, tcards.length - 1);
      // Ưu tiên đúng cột, lệch dần 2 bên nếu card đó ẩn (giới hạn 12 thử)
      const order: number[] = [j];
      for (let d = 1; d < tcards.length && order.length < 12; d++) {
        if (j - d >= 0) order.push(j - d);
        if (j + d < tcards.length) order.push(j + d);
      }
      let target: HTMLElement | null = null;
      for (const idx of order) {
        try {
          if (isVisible(tcards[idx])) {
            target = tcards[idx];
            break;
          }
        } catch {
          continue;
        }
      }
      if (!target) continue;
      markProgrammaticFocus();
      setLastTvMove(`rowidx-${dir} col=${col} from ${describeEl(active)} to ${describeEl(target)}`);
      try {
        target.focus({ preventScroll: true } as FocusOptions);
      } catch {
        target.focus();
      }
      tvScrollIntoView(target);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function focusCardRowVertical(active: HTMLElement, dir: 'up' | 'down'): boolean {
  try {
    // Đi theo cột trước (chuẩn + rẻ); rớt mới dùng scorer hình học cũ
    // (cho lưới không có [data-tv-row] như trang filter).
    if (focusCardRowIndexVertical(active, dir)) return true;
    const cr = cachedRect(active);
    if (!cr || cr.width <= 4 || cr.height <= 4) return false;
    const cx = cr.left + cr.width / 2;
    // Tọa độ dọc theo DOCUMENT (không phụ thuộc vị trí cuộn hiện tại):
    // bấm dồn giữa lúc trang đang tween thì rect viewport thay đổi liên tục,
    // còn document-Y thì ổn định -> không bao giờ nhảy nhầm list xa.
    let scrollY = 0;
    try {
      scrollY = window.scrollY || window.pageYOffset || 0;
    } catch {}
    const activeDocTop = cr.top + scrollY;
    const activeDocBottom = cr.bottom + scrollY;
    // Fast-path: chỉ xét card trong 1-2 hàng kề (cache theo hàng).
    // Fallback full-scan khi trang không có [data-tv-row] (detail/modal).
    let cards: HTMLElement[];
    try {
      const rows = getTvRowCache(active);
      // Hàng chứa active (để biết vị trí), fallback theo tọa độ gần nhất
      let activeIdx = rows.findIndex((rw) => {
        try {
          return rw.el.contains(active);
        } catch {
          return false;
        }
      });
      if (activeIdx < 0) {
        let bestD = Infinity;
        rows.forEach((rw, i) => {
          const d = dir === 'up'
            ? Math.abs(activeDocTop - rw.bottom)
            : Math.abs(rw.top - activeDocBottom);
          if (d < bestD) {
            bestD = d;
            activeIdx = i;
          }
        });
      }
      if (rows.length && activeIdx >= 0) {
        const picked: HTMLElement[] = [];
        if (dir === 'up') {
          for (let i = activeIdx - 1; i >= 0 && picked.length < 48; i--) {
            if (rows[i].bottom < activeDocTop - 4) {
              picked.push(...rows[i].cards);
              break; // chỉ lấy đúng 1 hàng gần nhất
            }
          }
        } else {
          for (let i = activeIdx + 1; i < rows.length && picked.length < 48; i++) {
            if (rows[i].top > activeDocBottom + 4) {
              picked.push(...rows[i].cards);
              break;
            }
          }
        }
        cards = picked.filter((el) => el !== active && isVisible(el));
        // Hết hàng kề (đang ở hàng đầu/cuối) -> để caller fallback intermediate/generic
        if (!cards.length) return false;
      } else {
        cards = Array.from(
          document.querySelectorAll<HTMLElement>('[data-tv-card]'),
        ).filter((el) => el !== active && isVisible(el));
      }
    } catch {
      return false;
    }
    if (!cards.length) return false;
    type Cand = { el: HTMLElement; r: DOMRect; edge: number };
    const cands: Cand[] = [];
    for (const el of cards) {
      let r: DOMRect;
      try {
        r = cachedRect(el);
      } catch {
        continue;
      }
      if (!r || r.width <= 4 || r.height <= 4) continue;
      if (dir === 'up') {
        // Card phải nằm hẳn phía trên (trừ hao 4px lệch layout)
        const docBottom = r.bottom + scrollY;
        if (docBottom > activeDocTop - 4) continue;
        cands.push({ el, r, edge: docBottom });
      } else {
        const docTop = r.top + scrollY;
        if (docTop < activeDocBottom + 4) continue;
        cands.push({ el, r, edge: docTop });
      }
    }
    if (!cands.length) return false;
    // Hàng gần nhất: bottom lớn nhất (up) / top nhỏ nhất (down).
    // Gom các card cùng dải hàng (dung sai 100px do card cao ~300px).
    const ROW_BAND = 100;
    const rowEdge =
      dir === 'up'
        ? Math.max(...cands.map((c) => c.edge))
        : Math.min(...cands.map((c) => c.edge));
    const row = cands.filter((c) => Math.abs(c.edge - rowEdge) <= ROW_BAND);
    if (!row.length) return false;
    // Trong cùng hàng: chọn card gần nhất theo trục X (cùng cột),
    // chênh dọc chỉ tính nhẹ để ổn định.
    let best: Cand | null = null;
    let bestScore = Infinity;
    for (const c of row) {
      const px = c.r.left + c.r.width / 2;
      const dx = Math.abs(px - cx);
      const dy =
        dir === 'up' ? activeDocTop - c.edge : c.edge - activeDocBottom;
      const score = dx + Math.max(0, dy) * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) return false;
    markProgrammaticFocus();
    setLastTvMove(`row-${dir} from ${describeEl(active)} to ${describeEl(best.el)} (row=${row.length})`);
    try {
      best.el.focus({ preventScroll: true } as FocusOptions);
    } catch {
      best.el.focus();
    }
    tvScrollIntoView(best.el);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bước trung gian khi bấm lên từ hàng phim đầu tiên (hết card phía trên):
 * ưu tiên mọi nút trung gian (hero / carousel giữa navbar và hàng phim)
 * trước khi cho rớt về navbar. Trả về true nếu đã chuyển.
 */
function focusIntermediateAbove(active: HTMLElement): boolean {
  try {
    const cr = cachedRect(active);
    if (!cr || cr.width <= 4 || cr.height <= 4) return false;
    const cx = cr.left + cr.width / 2;
    let pool: HTMLElement[];
    try {
      pool = getFocusable().filter(
        (el) =>
          el !== active &&
          !(el.closest?.('#qtb-navbar') as Element | null) &&
          !(el.closest?.('#mobile-bottom-nav') as Element | null),
      );
    } catch {
      return false;
    }
    if (!pool.length) return false;
    let best: HTMLElement | null = null;
    let bestRect: DOMRect | null = null;
    let bestScore = Infinity;
    for (const el of pool) {
      let r: DOMRect;
      try {
        r = cachedRect(el);
      } catch {
        continue;
      }
      if (!r || r.width <= 4 || r.height <= 4) continue;
      // Phải nằm hẳn phía trên anchor
      if (r.bottom > cr.top - 4) continue;
      const px = r.left + r.width / 2;
      const dx = Math.abs(px - cx);
      const dy = cr.top - r.bottom;
      // Ưu tiên gần theo chiều dọc, lệch cột ít bị phạt hơn generic (0.8 vs 2.2)
      const score = dy + dx * 0.8;
      if (score < bestScore) {
        bestScore = score;
        best = el;
        bestRect = r;
      }
    }
    if (!best) return false;
    markProgrammaticFocus();
    try {
      best.focus({ preventScroll: true } as FocusOptions);
    } catch {
      best.focus();
    }
    tvScrollIntoView(best);
    void bestRect;
    return true;
  } catch {
    return false;
  }
}

/** Di chuyển focus tới phần tử gần nhất theo hướng. Trả về true nếu đã chuyển. */
export function focusNearest(dir: TvDirection): boolean {
  try {
    const active = document.activeElement as HTMLElement | null;
    // TV perf: pool focusable (full DOM scan ~300 els) chỉ tính khi fallback
    // thật sự cần. Fast-path (explicit/data-tv, player, modal, row-index)
    // chạy trước với 0 QSA toàn trang.
    let pool: HTMLElement[] | null = null;
    const getPool = (): HTMLElement[] => (pool ??= getFocusable());
    if (!active || active === document.body) {
      ensureTvFocus();
      return true;
    }
    // Giữ semantics cũ (trang không có gì focus được -> false) với đúng
    // 1 querySelector rẻ, không scan + đo rect toàn trang.
    try {
      if (!document.querySelector(FOCUSABLE_SEL)) return false;
    } catch {}
    // Player fullscreen đang mở: NHỐT focus trong player. Bấm loạn D-pad cũng
    // không lọt ra navbar/modal nền (bug: Enter kích hoạt nút nền dù player che).
    try {
      const playerRoot = document.getElementById('gau-player-root');
      if (playerRoot) {
        if (playerRoot.contains(active)) {
          const inPool = getPool().filter((el) => playerRoot.contains(el));
          if (!inPool.length) return true; // không có gì đi được -> nuốt phím
          pool = inPool;
        } else {
          // Focus lọt ra ngoài bằng đường nào đó -> kéo về nút trong player
          const back =
            playerRoot.querySelector<HTMLElement>('[data-tv-skip-segment]') ||
            playerRoot.querySelector<HTMLElement>('[data-tv-play]') ||
            playerRoot.querySelector<HTMLElement>('button:not([disabled])');
          if (back) {
            markProgrammaticFocus();
            setLastTvMove(`pull-into-player from ${describeEl(active)} to ${describeEl(back)}`);
            try {
              back.focus({ preventScroll: true } as FocusOptions);
            } catch {
              back.focus();
            }
            return true;
          }
          return true; // player mở mà không có nút nào -> nuốt phím
        }
      }
    } catch {}
    // Điều hướng khai báo theo markup: data-tv-up/right/down/left="selector"
    // (kế thừa qua closest nên đặt ở container cũng ăn). Ưu tiên trước mọi
    // scoring hình học — dùng cho layout lưới form (trang filter) nơi scorer
    // đoán sai (chip phải -> rớt xuống lưới phim thay vì nút Áp dụng...).
    // Target chưa sẵn sàng thì bỏ qua để scorer chung xử lý (không nuốt phím).
    try {
      const attr =
        dir === 'left'
          ? 'data-tv-left'
          : dir === 'right'
          ? 'data-tv-right'
          : dir === 'up'
          ? 'data-tv-up'
          : 'data-tv-down';
      const scoped = active.closest?.(`[${attr}]`) as HTMLElement | null;
      const sel = scoped?.getAttribute?.(attr) || '';
      if (sel) {
        const t = document.querySelector<HTMLElement>(sel);
        if (t && t !== active) {
          const r = cachedRect(t);
          if (r.width > 4 && r.height > 4) {
            markProgrammaticFocus();
            setLastTvMove(
              `explicit-${dir} from ${describeEl(active)} to ${describeEl(t)}`,
            );
            try {
              t.focus({ preventScroll: true } as FocusOptions);
            } catch {
              t.focus();
            }
            tvScrollIntoView(t);
            return true;
          }
        }
      }
    } catch {}
    // Modal fullscreen đang mở (detail/player-overlay...) mà focus còn kẹt
    // ở nền phía sau: lôi focus vào trong modal, không cho đi lang thang.
    try {
      const overlays = Array.from(
        document.querySelectorAll<HTMLElement>(
          '#movie-detail-fullpage, [role="dialog"]',
        ),
      ).filter((m) => {
        try {
          if (!isVisible(m)) return false;
          const cs = window.getComputedStyle(m);
          // Chỉ tính overlay phủ màn hình / fixed (modal thật)
          if (cs.position !== 'fixed') return false;
          const r = m.getBoundingClientRect();
          return r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6;
        } catch {
          return false;
        }
      });
      const top = overlays[overlays.length - 1] || null;
      if (top && !top.contains(active)) {
        const first = Array.from(
          top.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).find((el) => {
          try {
            return isVisible(el);
          } catch {
            return false;
          }
        });
        if (first) {
          markProgrammaticFocus();
          setLastTvMove(`pull-into-modal from ${describeEl(active)} to ${describeEl(first)}`);
          try {
            first.focus({ preventScroll: true } as FocusOptions);
          } catch {
            first.focus();
          }
          tvScrollIntoView(first);
          return true;
        }
        return true; // modal mở mà không có gì focus được -> nuốt phím
      }
    } catch {}
    // Đang đứng trong dialog/modal: bẫy focus trong cùng dialog,
    // không cho D-pad xuyên ra nền.
    // Ngoại lệ trang chi tiết TV: hero -> D-pad xuống phải về TẬP 1 của shelf
    // (xử lý trước trap generic để không rơi vào tập giữa theo vị trí X cũ).
    try {
      const inDetail = !!active.closest?.('#movie-detail-fullpage');
      const inHero = !!(
        active.closest?.('#detail-hero-tv') ||
        active.hasAttribute?.('data-tv-ep-first-target')
      );
      if (inDetail && inHero && dir === 'down') {
        const firstEp = document.querySelector<HTMLElement>(
          '#detail-episodes-tv [data-tv-ep-first]',
        );
        if (firstEp) {
          markProgrammaticFocus();
          setLastTvMove(`detail-down-to-first-ep from ${describeEl(active)} to ${describeEl(firstEp)}`);
          try {
            firstEp.focus({ preventScroll: true } as FocusOptions);
          } catch {
            firstEp.focus();
          }
          tvScrollIntoView(firstEp);
          return true;
        }
      }
    } catch {}
    try {
      const dlg = active.closest?.('[role="dialog"]') as HTMLElement | null;
      if (dlg) {
        const poolIn = getPool().filter((el) => dlg.contains(el));
        if (poolIn.length) {
          const cr0 = cachedRect(active);
          const c0 = center(cr0);
          let bestD: HTMLElement | null = null;
          let bestScoreD = Infinity;
          for (const el of poolIn) {
            if (el === active) continue;
            const r = cachedRect(el);
            const p = center(r);
            const dx = p.x - c0.x;
            const dy = p.y - c0.y;
            if (dir === 'left' && dx >= -8) continue;
            if (dir === 'right' && dx <= 8) continue;
            if (dir === 'up' && dy >= -8) continue;
            if (dir === 'down' && dy <= 8) continue;
            const score = Math.abs(dir === 'left' || dir === 'right' ? dx : dy) +
              Math.abs(dir === 'left' || dir === 'right' ? dy : dx) * 2.2;
            if (score < bestScoreD) {
              bestScoreD = score;
              bestD = el;
            }
          }
          if (bestD) {
            markProgrammaticFocus();
            setLastTvMove(`dialog-${dir} from ${describeEl(active)} to ${describeEl(bestD)}`);
            try {
              bestD.focus({ preventScroll: true } as FocusOptions);
            } catch {
              bestD.focus();
            }
            tvScrollIntoView(bestD);
            return true;
          }
          return true; // hết hướng trong dialog -> nuốt phím, không xuyên nền
        }
      }
    } catch {}
    // Đang đứng trên card phim (hoặc nút </> trong hàng) mà đi dọc ->
    // ưu tiên hàng phim trên/dưới trước khi xét navbar/hero
    // (tránh bấm lên từ giữa/cuối trang rớt vào navbar).
    if (dir === 'up' || dir === 'down') {
      let inRow = !!active.hasAttribute?.('data-tv-card');
      if (!inRow) {
        try {
          inRow = !!active.closest?.('[class*="group/row"]');
        } catch {
          inRow = false;
        }
      }
      if (inRow) {
        if (focusCardRowVertical(active, dir)) return true;
        // Hết card phía trên (đang ở hàng đầu): bấm lên phải ghé hero/
        // carousel trung gian trước, chỉ khi không còn gì mới về navbar.
        if (dir === 'up' && focusIntermediateAbove(active)) return true;
        // Hết hàng phía dưới thì fallback generic bình thường.
      }
    }
    const cr = cachedRect(active);
    const c = center(cr);
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    const fallbackPool = getPool();
    if (!fallbackPool.length) return false;
    for (const el of fallbackPool) {
      if (el === active) continue;
      const r = cachedRect(el);
      const p = center(r);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      let primary = 0;
      let secondary = 0;
      if (dir === 'left' && dx >= -8) continue;
      if (dir === 'right' && dx <= 8) continue;
      if (dir === 'up' && dy >= -8) continue;
      if (dir === 'down' && dy <= 8) continue;
      if (dir === 'left' || dir === 'right') {
        primary = Math.abs(dx);
        secondary = Math.abs(dy);
        // Ưu tiên phần tử cùng hàng (overlap theo trục dọc)
        const overlapY = Math.max(0, Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top));
        if (overlapY > Math.min(cr.height, r.height) * 0.3) secondary *= 0.4;
      } else {
        primary = Math.abs(dy);
        secondary = Math.abs(dx);
        const overlapX = Math.max(0, Math.min(cr.right, r.right) - Math.max(cr.left, r.left));
        if (overlapX > Math.min(cr.width, r.width) * 0.3) secondary *= 0.4;
      }
      const score = primary + secondary * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      markProgrammaticFocus();
      setLastTvMove(`generic-${dir} from ${describeEl(active)} to ${describeEl(best)}`);
      try {
        best.focus({ preventScroll: true } as FocusOptions);
      } catch {
        best.focus();
      }
      tvScrollIntoView(best);
      return true;
    }
    setLastTvMove(`NO-TARGET ${dir} from ${describeEl(active)}`);
    return false;
  } catch {
    return false;
  }
}

/** Khi vào màn hình TV mà chưa có focus (body) thì focus nút chính đầu tiên. */
export function ensureTvFocus(): boolean {
  try {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && isVisible(active)) return false;
    // Player đang mở mà focus rớt ra body: kéo về trong player, không về nền
    try {
      const playerRoot = document.getElementById('gau-player-root');
      if (playerRoot) {
        const back =
          playerRoot.querySelector<HTMLElement>('[data-tv-skip-segment]') ||
          playerRoot.querySelector<HTMLElement>('[data-tv-play]') ||
          playerRoot.querySelector<HTMLElement>('button:not([disabled])');
        if (back && isVisible(back)) {
          markProgrammaticFocus();
          back.focus({ preventScroll: true } as FocusOptions);
          return true;
        }
        return false;
      }
    } catch {}
    const priority = ['#hero-play-btn', '#brand-logo-btn', '[data-tv-autofocus]'];
    for (const sel of priority) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && isVisible(el)) {
        markProgrammaticFocus();
        el.focus({ preventScroll: true } as FocusOptions);
        tvScrollIntoView(el);
        return true;
      }
    }
    const first = getFocusable()[0];
    if (first) {
      markProgrammaticFocus();
      first.focus({ preventScroll: true } as FocusOptions);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function dispatchTvMedia(action: TvMediaAction) {
  try {
    window.dispatchEvent(new CustomEvent<TvMediaAction>(TV_MEDIA_EVENT, { detail: action }));
  } catch {}
}

/**
 * Xử lý phím toàn app. Trả về true nếu đã consume (caller nên preventDefault).
 * Player mở -> nhường cho GauPlayer (return false).
 */
export function handleTvKey(e: KeyboardEvent): boolean {
  if (!isTvModeActive()) return false;
  if (e.defaultPrevented) return false;
  if (isPlayerOpen()) return false;

  const target = e.target as HTMLElement | null;
  const k = e.key;

  // TV: ô chữ đang KHÓA (readonly, chỉ lướt qua) thì đối xử như nút thường:
  // arrows đi tiếp (không kẹt vào caret), OK mới mở bàn phím. Tránh WebView
  // tự bung IME mỗi lần D-pad lướt ngang qua ô input.
  if (isTvTextInput(target) && !target.hasAttribute('data-tv-editing')) {
    if (k === 'Enter' || k === 'NumpadEnter' || k === ' ') {
      return enterTvEditMode(target);
    }
    if (k === 'Escape') {
      try {
        (target as HTMLElement).blur();
      } catch {}
      return true;
    }
    // Còn lại (arrows...) rớt xuống điều hướng D-pad chung bên dưới.
  } else if (isEditable(target)) {
    // Đang gõ chữ (đã OK vào ô): chỉ cho phép Escape blur, còn lại để input xử lý
    if (k === 'Escape') {
      try {
        (target as HTMLElement).blur();
      } catch {}
      return true;
    }
    return false;
  }
  // Nút Back của remote TV: Escape (web giả lập TV/Android TV/box hay gửi) /
  // GoBack / BrowserBack / Tizen 10009 / LG 461 — NGOÀI player (trong player
  // thì guard isPlayerOpen() ở trên đã nhường GauPlayer tự xử lý). Bắn event
  // để App quyết: scroll về đầu trang home hoặc mở popup thoát.
  if (
    k === 'Escape' ||
    k === 'GoBack' ||
    k === 'BrowserBack' ||
    (e as any).keyCode === 10009 ||
    (e as any).keyCode === 461
  ) {
    // Dialog xác nhận app đang mở (Confirm/Custom — trừ #movie-detail-fullpage
    // vì nó có luồng Back riêng): Back chỉ đóng dialog, không chạy luồng điều hướng.
    try {
      if (document.querySelector('[role="dialog"]:not(#movie-detail-fullpage)')) {
        window.dispatchEvent(new Event('gau_dialog_request_close'));
        return true;
      }
    } catch {}
    try {
      window.dispatchEvent(new Event('gau_tv_back'));
    } catch {}
    return true;
  }

  // Media keys (một số remote gửi thẳng media key thay vì arrow)
  if (
    k === 'MediaPlayPause' ||
    k === 'Play' ||
    k === 'Pause' ||
    (e as any).keyCode === 179
  ) {
    dispatchTvMedia('toggle');
    return true;
  }
  if (k === 'MediaTrackNext') {
    dispatchTvMedia('next');
    return true;
  }
  if (k === 'MediaTrackPrevious') {
    dispatchTvMedia('prev');
    return true;
  }
  if (k === 'MediaRewind') {
    dispatchTvMedia('rewind');
    return true;
  }
  if (k === 'MediaFastForward') {
    dispatchTvMedia('forward');
    return true;
  }

  // D-pad di chuyển
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
    try {
      setLastTvMove(
        `key ${k} target=${describeEl(document.activeElement as HTMLElement | null)} tv=${isTvModeActive()} player=${isPlayerOpen()} prevented=${e.defaultPrevented}`,
      );
    } catch {}
    const dir: TvDirection =
      k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : 'down';
    // Fast-path O(1): đang đứng trên card mà đi ngang -> qua card kề trong cùng hàng,
    // khỏi đo rect cả trăm nút (đây là thao tác bấm nhiều nhất trên TV).
    const active = document.activeElement as HTMLElement | null;
    if (active?.hasAttribute?.('data-tv-card') && (dir === 'left' || dir === 'right')) {
      try {
        // Ưu tiên container đánh dấu data-tv-row (đúng với cả Top10 lồng sâu),
        // rớt lại parent.parent cho MovieRow cũ.
        const row =
          (active.closest?.('[data-tv-row]') as HTMLElement | null) ??
          (active.parentElement?.parentElement as HTMLElement | null);
        const cards = row
          ? (Array.from(row.querySelectorAll('[data-tv-card]')) as HTMLElement[]).filter(
              (c) => c.offsetParent !== null || c.getClientRects().length > 0,
            )
          : [];
        const i = cards.indexOf(active);
        // Hết hàng thì vòng lại đầu/cuối (kiểu Netflix, không bao giờ kẹt)
        let next = cards[i + (dir === 'right' ? 1 : -1)];
        if (!next && cards.length > 1) {
          next = dir === 'right' ? cards[0] : cards[cards.length - 1];
        }
        if (next) {
          try {
            next.focus({ preventScroll: true } as FocusOptions);
          } catch {
            next.focus();
          }
          tvScrollIntoView(next);
          return true;
        }
      } catch {}
    }
    return focusNearest(dir);
  }

  // OK remote trên card dạng div[tabindex]: browser không tự click -> click tay
  if (k === 'Enter' || k === 'NumpadEnter' || k === ' ') {
    const active = document.activeElement as HTMLElement | null;
    if (active && active.tagName !== 'BUTTON' && active.tagName !== 'A' && active.tagName !== 'INPUT') {
      try {
        (active as HTMLElement).click();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
  return false;
}
