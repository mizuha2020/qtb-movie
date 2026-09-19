import { useEffect } from 'react';
import { applyTvClass } from '../utils/tvDetect';
import {
  armTvInputReadonly,
  ensureTvFocus,
  exitTvEditMode,
  handleTvKey,
  isTvModeActive,
  isTvTextInput,
  lastProgrammaticFocus,
} from '../utils/tvRemote';

/** Gắn điều hướng D-pad remote TV cho toàn app (chỉ kích hoạt ở tv-mode). */
export function useTvRemoteNav() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      try {
        if (handleTvKey(e)) e.preventDefault();
      } catch {}
    };
    // capture để chạy trước handler video (tránh seek khi đang đi menu)
    // nhưng GauPlayer tự guard theo focus nên không xung đột.
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as any);
  }, []);

  // Chuột bay (air-mouse): lia trỏ tới đâu thì vòng focus TV theo tới đó,
  // để remote ở chế độ chuột vẫn dùng được (trỏ đã bị CSS ẩn đi).
  // CHỈ nhận mouseover sau 1 mousemove thật (<350ms): cuộn trang làm phần tử
  // trôi xuống dưới con trỏ đang đậu yên cũng bắn mouseover giả -> phải bỏ qua,
  // không thì mỗi lần bấm D-pad focus bị giật ngược về chỗ cũ.
  useEffect(() => {
    let last = 0;
    let lastMove = 0;
    const onMove = () => {
      try {
        lastMove = Date.now();
      } catch {}
    };
    const onHover = (e: MouseEvent) => {
      try {
        if (!isTvModeActive()) return;
        const now = Date.now();
        if (now - last < 60) return;
        // Vừa chuyển focus bằng code (D-pad/tự động) -> bỏ qua hover dội lại
        if (now - lastProgrammaticFocus() < 500) return;
        // Không có chuyển động chuột thật gần đó -> mouseover giả do cuộn trang
        if (now - lastMove > 350) return;
        last = now;
        const t = e.target as HTMLElement | null;
        const focusable = t?.closest?.(
          '[data-tv-card], button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) as HTMLElement | null;
        if (
          focusable &&
          document.activeElement !== focusable &&
          !focusable.hasAttribute('data-tv-skip')
        ) {
          try {
            focusable.focus({ preventScroll: true } as FocusOptions);
          } catch {
            focusable.focus();
          }
        }
      } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseover', onHover);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseover', onHover);
    };
  }, []);

  // Prefetch debounce: focus giữ yên 200ms trên card mới gọi detail (tránh
  // spam API khi lia D-pad 1→2→3→4→5). + preload chunk detail/player lúc idle
  // để lần mở đầu không vừa tải chunk vừa fetch API vừa decode ảnh.
  useEffect(() => {
    let timer = 0;
    let lastSlug = '';
    let chunksPreloaded = false;
    const preloadChunks = () => {
      if (chunksPreloaded) return;
      chunksPreloaded = true;
      try {
        import('../components/MovieDetailModal').catch(() => {});
        import('../components/GauPlayer').catch(() => {});
      } catch {}
    };
    try {
      const idle = (window as any).requestIdleCallback as
        | ((cb: () => void, opts?: any) => number)
        | undefined;
      if (typeof idle === 'function') idle(() => preloadChunks(), { timeout: 4000 });
      else window.setTimeout(preloadChunks, 2500);
    } catch {
      try { window.setTimeout(preloadChunks, 2500); } catch {}
    }
    const onFocusIn = (e: FocusEvent) => {
      try {
        if (!isTvModeActive()) return;
        preloadChunks();
        const t = e.target as HTMLElement | null;
        const card = t?.closest?.('[data-tv-card]') as HTMLElement | null;
        // Card focus nở ngang sang phải (overlay): đánh dấu card kế bên đang bị
        // đè để hạ z-index (không vẽ đè viền trắng của card focus).
        // NOTE: card nằm trong slot neo (MovieRow) / slot flex (Top10) nên phải
        // đi lên 2 cấp: card -> slot -> hàng, rồi tìm slot kế tiếp.
        try {
          document.querySelectorAll?.('.tv-under-expand')?.forEach((el) => {
            if (el !== card) el.classList.remove('tv-under-expand');
          });
          if (card) {
            const slot = card.parentElement as HTMLElement | null;
            const nextSlot = slot?.nextElementSibling as HTMLElement | null;
            const victim = nextSlot?.matches?.('[data-tv-card]')
              ? nextSlot
              : (nextSlot?.querySelector?.('[data-tv-card]') as HTMLElement | null);
            if (victim && victim !== card) victim.classList.add('tv-under-expand');
          }
        } catch {}
        const slug = card?.getAttribute?.('data-tv-card') || '';
        if (!slug || slug === lastSlug) return;
        lastSlug = slug;
        if (timer) window.clearTimeout(timer);
        const current = slug;
        timer = window.setTimeout(() => {
          // Vẫn đang đứng yên trên card đó mới fetch (debounce)
          try {
            const ae = document.activeElement as HTMLElement | null;
            const still = ae?.closest?.('[data-tv-card]')?.getAttribute?.('data-tv-card');
            if (still !== current) return;
            import('../services/movieApi').then((m) => {
              try { m.movieApi.getMovieDetail(current).catch(() => {}); } catch {}
            }).catch(() => {});
          } catch {}
        }, 200);
      } catch {}
    };
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('focusin', onFocusIn);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // TV IME gate: ô chữ mặc định readonly (lướt D-pad không bung phím),
  // bấm OK mới mở khóa (xử lý trong handleTvKey). Rời ô thì khóa lại.
  useEffect(() => {
    const armAll = (root?: ParentNode | null) => {
      try {
        if (!isTvModeActive() || !root) return;
        const scope: ParentNode = root;
        const els = scope.querySelectorAll?.('input,textarea');
        els?.forEach?.((el) => armTvInputReadonly(el as HTMLElement));
      } catch {}
    };
    try {
      armAll(document);
    } catch {}
    const onFocusIn = (e: FocusEvent) => {
      try {
        if (!isTvModeActive()) return;
        const t = e.target as HTMLElement | null;
        // Lưới cuối: ô nào lọt lưới (render sau observer...) mà bị focus
        // khi chưa editing -> khóa ngay.
        if (t && isTvTextInput(t) && !t.hasAttribute('data-tv-editing')) {
          armTvInputReadonly(t);
        }
      } catch {}
    };
    const onFocusOut = (e: FocusEvent) => {
      try {
        const t = e.target as HTMLElement | null;
        if (t && t.hasAttribute?.('data-tv-editing')) exitTvEditMode(t);
      } catch {}
    };
    let mo: MutationObserver | null = null;
    try {
      mo = new MutationObserver((muts) => {
        try {
          if (!isTvModeActive()) return;
          for (const m of muts) {
            m.addedNodes?.forEach?.((n) => {
              try {
                if (!(n instanceof HTMLElement)) return;
                if (isTvTextInput(n)) armTvInputReadonly(n);
                n.querySelectorAll?.('input,textarea')?.forEach?.((el) =>
                  armTvInputReadonly(el as HTMLElement),
                );
              } catch {}
            });
          }
        } catch {}
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true });
      }
    } catch {}
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('focusout', onFocusOut);
      try {
        mo?.disconnect();
      } catch {}
    };
  }, []);

  // Khi bật tv-mode mà chưa có focus (mở app bằng remote) -> tự focus nút chính
  useEffect(() => {
    let t: number | null = null;
    const sync = () => {
      try {
        if (isTvModeActive()) {
          if (t) window.clearTimeout(t);
          t = window.setTimeout(() => ensureTvFocus(), 350);
        }
      } catch {}
    };
    sync();
    const onResize = () => applyTvClass();
    window.addEventListener('resize', onResize);
    // Đổi tab trong SPA -> focus lại nội dung mới
    const onNav = () => sync();
    window.addEventListener('popstate', onNav);
    window.addEventListener('gau_navigate_cinema_tab' as any, onNav as any);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('gau_navigate_cinema_tab' as any, onNav as any);
      if (t) window.clearTimeout(t);
    };
  }, []);
}
