import { useEffect } from 'react';
import { applyTvClass } from '../utils/tvDetect';
import {
  ensureTvFocus,
  handleTvKey,
  isTvModeActive,
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
