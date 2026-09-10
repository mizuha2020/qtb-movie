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

const FOCUSABLE_SEL =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
  try {
    const r = el.getBoundingClientRect();
    if (r.width <= 4 || r.height <= 4) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    // KHÔNG lọc theo viewport: item dưới fold là target hợp lệ, bấm 1 phát là
    // focus nhảy tới + tvScrollIntoView cuộn theo. (Lọc viewport từng làm DPAD
    // xuống hàng chỉ cuộn chay mà không đổi focus.)
    return true;
  } catch {
    return false;
  }
}

export function getFocusable(): HTMLElement[] {
  try {
    return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter(
      (el) => !el.hasAttribute('data-tv-skip') && isVisible(el),
    );
  } catch {
    return [];
  }
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Cuộn trang + hàng ngang để focus luôn nhìn thấy (không dùng scrollIntoView:
 *  block:'nearest' trên WebView TV lúc cuộn lúc không). Mỗi lần bấm = màn hình đi theo. */
export function tvScrollIntoView(el: HTMLElement) {
  try {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 800;
    // Dọc: cuộn window, chừa chỗ navbar dính trên đầu
    const topSafe = 140;
    const bottomSafe = 60;
    let dy = 0;
    if (r.top < topSafe) dy = r.top - topSafe;
    else if (r.bottom > vh - bottomSafe) dy = r.bottom - (vh - bottomSafe);
    if (dy !== 0) window.scrollBy(0, Math.round(dy));
    // Ngang: căn giữa item trong MỌI tổ tiên cuộn được (thường chỉ có hàng phim).
    // Ép instant: hàng có CSS scroll-behavior:smooth sẽ biến gán scrollLeft
    // thành cuộn từ từ, box yếu bò mãi không tới.
    const setInstantScrollLeft = (p: HTMLElement, target: number) => {
      try {
        const prev = p.style.scrollBehavior;
        p.style.scrollBehavior = 'auto';
        p.scrollLeft = target;
        p.style.scrollBehavior = prev;
      } catch {
        try {
          p.scrollLeft = target;
        } catch {}
      }
    };
    let p: HTMLElement | null = el.parentElement;
    let firstScrollable: HTMLElement | null = null;
    let firstTarget = 0;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        if (p.scrollWidth > p.clientWidth + 8) {
          const pr = p.getBoundingClientRect();
          const target = Math.max(
            0,
            Math.round(p.scrollLeft + (r.left - pr.left) - (pr.width - r.width) / 2),
          );
          if (!firstScrollable) {
            firstScrollable = p;
            firstTarget = target;
          }
          setInstantScrollLeft(p, target);
        }
      } catch {}
      p = p.parentElement;
    }
    // Máy chậm layout chưa kịp: kiểm tra lại sau 1 frame, chưa tới thì đẩy tiếp.
    if (firstScrollable) {
      const fp = firstScrollable;
      const ft = firstTarget;
      const fel = el;
      window.requestAnimationFrame(() => {
        try {
          if (Math.abs(fp.scrollLeft - ft) > 4) setInstantScrollLeft(fp, ft);
          else {
            const rr = fel.getBoundingClientRect();
            const pr2 = fp.getBoundingClientRect();
            if (rr.left < pr2.left - 4 || rr.right > pr2.right + 4) {
              setInstantScrollLeft(
                fp,
                Math.max(0, Math.round(fp.scrollLeft + (rr.left - pr2.left) - (pr2.width - rr.width) / 2)),
              );
            }
          }
        } catch {}
      });
    }
  } catch {}
}

/** Di chuyển focus tới phần tử gần nhất theo hướng. Trả về true nếu đã chuyển. */
export function focusNearest(dir: TvDirection): boolean {
  try {
    const active = document.activeElement as HTMLElement | null;
    const pool = getFocusable();
    if (!pool.length) return false;
    if (!active || active === document.body) {
      ensureTvFocus();
      return true;
    }
    const cr = active.getBoundingClientRect();
    const c = center(cr);
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of pool) {
      if (el === active) continue;
      const r = el.getBoundingClientRect();
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
      try {
        best.focus({ preventScroll: true } as FocusOptions);
      } catch {
        best.focus();
      }
      tvScrollIntoView(best);
      return true;
    }
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
    const priority = ['#hero-play-btn', '#brand-logo-btn', '[data-tv-autofocus]'];
    for (const sel of priority) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && isVisible(el)) {
        el.focus({ preventScroll: true } as FocusOptions);
        tvScrollIntoView(el);
        return true;
      }
    }
    const first = getFocusable()[0];
    if (first) {
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

  // Đang gõ chữ: chỉ cho phép Escape blur, còn lại để input xử lý
  if (isEditable(target)) {
    if (k === 'Escape') {
      try {
        (target as HTMLElement).blur();
      } catch {}
      return true;
    }
    return false;
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
    const dir: TvDirection =
      k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : 'down';
    // Fast-path O(1): đang đứng trên card mà đi ngang -> qua card kề trong cùng hàng,
    // khỏi đo rect cả trăm nút (đây là thao tác bấm nhiều nhất trên TV).
    const active = document.activeElement as HTMLElement | null;
    if (active?.hasAttribute?.('data-tv-card') && (dir === 'left' || dir === 'right')) {
      try {
        const row = active.parentElement?.parentElement as HTMLElement | null;
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
