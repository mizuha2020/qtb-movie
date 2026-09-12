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
    // Chỉ đo rect (rẻ, browser batch được). KHÔNG gọi getComputedStyle mỗi phím:
    // style recalc trên hàng trăm nút là nguyên nhân lag D-pad ở home.
    // Trường hợp opacity-0 còn rect (controls player ẩn...) không lọt vào pool
    // vì khi player mở, phím do GauPlayer xử lý riêng, không qua đây.
    const r = el.getBoundingClientRect();
    if (r.width <= 4 || r.height <= 4) return false;
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
    let tvMode = false;
    try {
      tvMode = document.documentElement.classList.contains('tv-mode');
    } catch {}
    return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SEL)).filter(
      (el) => {
        if (el.hasAttribute('data-tv-skip')) return false;
        // TV không dùng bottom-nav mobile: loại hẳn khỏi pool D-pad
        // (viewport TV 720p <768px khiến dock hiện dù đang tv-mode).
        if (tvMode && (el.closest?.('#mobile-bottom-nav') as Element | null)) return false;
        return isVisible(el);
      },
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
    const r = el.getBoundingClientRect();
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
const TV_SCROLL_MS = 150;
// Bấm dồn (<120ms/phát) thì cuộn instant thay vì tween mới chồng tween cũ —
// vừa đỡ khựng trên box yếu, vừa theo kịp tốc độ bấm remote.
let lastProgScrollAt = 0;
let scrollRetryTimer = 0;

function shouldInstantScroll(): boolean {
  try {
    const now = Date.now();
    const rapid = now - lastProgScrollAt < 120;
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
    // Lệch nhỏ thì khỏi animate (đỡ giật liên tục khi đi ngang từng card)
    if (Math.abs(d) < 10 || instant || reduceMotion()) {
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
    const r = el.getBoundingClientRect();
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
      // Lưới an toàn: tween có thể bị hủy (bấm dồn) hoặc RAF rớt frame ->
      // sau 320ms mà target vẫn ngoài màn hình thì cuộn lại 1 lần duy nhất.
      if (_depth === 0) {
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
    // Ngang: căn giữa item trong MỌI tổ tiên cuộn được (thường chỉ có hàng phim)
    let p: HTMLElement | null = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        if (p.scrollWidth > p.clientWidth + 8) {
          const pr = p.getBoundingClientRect();
          smoothRowScrollTo(
            p,
            Math.max(0, Math.round(p.scrollLeft + (r.left - pr.left) - (pr.width - r.width) / 2)),
            instant,
          );
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
function focusCardRowVertical(active: HTMLElement, dir: 'up' | 'down'): boolean {
  try {
    const cr = active.getBoundingClientRect();
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
    let cards: HTMLElement[];
    try {
      cards = Array.from(
        document.querySelectorAll<HTMLElement>('[data-tv-card]'),
      ).filter((el) => el !== active && isVisible(el));
    } catch {
      return false;
    }
    if (!cards.length) return false;
    type Cand = { el: HTMLElement; r: DOMRect; edge: number };
    const cands: Cand[] = [];
    for (const el of cards) {
      let r: DOMRect;
      try {
        r = el.getBoundingClientRect();
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
    const cr = active.getBoundingClientRect();
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
        r = el.getBoundingClientRect();
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
    let pool = getFocusable();
    if (!pool.length) return false;
    if (!active || active === document.body) {
      ensureTvFocus();
      return true;
    }
    // Player fullscreen đang mở: NHỐT focus trong player. Bấm loạn D-pad cũng
    // không lọt ra navbar/modal nền (bug: Enter kích hoạt nút nền dù player che).
    try {
      const playerRoot = document.getElementById('gau-player-root');
      if (playerRoot) {
        if (playerRoot.contains(active)) {
          pool = pool.filter((el) => playerRoot.contains(el));
          if (!pool.length) return true; // không có gì đi được -> nuốt phím
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
        const poolIn = pool.filter((el) => dlg.contains(el));
        if (poolIn.length) {
          const cr0 = active.getBoundingClientRect();
          const c0 = center(cr0);
          let bestD: HTMLElement | null = null;
          let bestScoreD = Infinity;
          for (const el of poolIn) {
            if (el === active) continue;
            const r = el.getBoundingClientRect();
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
