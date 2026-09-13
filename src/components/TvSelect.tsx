import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { markProgrammaticFocus } from '../utils/tvRemote';

export interface TvSelectOption {
  value: string;
  label: string;
}

interface TvSelectProps {
  label: string;
  value: string;
  options: TvSelectOption[];
  onChange: (v: string) => void;
  id?: string;
}

/**
 * Dropdown cho TV (thay <select> native):
 * - Focus + arrows: đi tiếp, KHÔNG đổi giá trị.
 * - OK: mở popup. D-pad chọn option trong popup. OK: chốt + đóng.
 * - Back/Esc: đóng, không đổi gì. Chỉ nút Áp dụng mới filter.
 */
export const TvSelect: React.FC<TvSelectProps> = ({
  label,
  value,
  options,
  onChange,
  id,
}) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) || options[0];

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) {
      requestAnimationFrame(() => {
        try {
          const b = btnRef.current;
          if (!b) return;
          markProgrammaticFocus();
          try {
            b.focus({ preventScroll: true } as FocusOptions);
          } catch {
            b.focus();
          }
        } catch {}
      });
    }
  };

  // Mở popup: focus option đang chọn (để browser tự cuộn vào tầm nhìn).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      try {
        const sel =
          panelRef.current?.querySelector<HTMLElement>(
            '[data-tv-selected="1"]',
          ) ||
          panelRef.current?.querySelector<HTMLElement>(
            'button[data-tv-option]',
          );
        if (sel) {
          markProgrammaticFocus();
          sel.focus();
        }
      } catch {}
    }, 60);
    return () => window.clearTimeout(t);
  }, [open]);

  // Back/Esc remote: đóng popup, không đổi giá trị (luồng back chung của app
  // cũng bắn gau_dialog_request_close khi thấy role=dialog).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const onReqClose = () => close();
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener(
      'gau_dialog_request_close',
      onReqClose as EventListener,
    );
    return () => {
      window.removeEventListener('keydown', onKey, {
        capture: true,
      } as unknown as EventListenerOptions);
      window.removeEventListener(
        'gau_dialog_request_close',
        onReqClose as EventListener,
      );
    };
  }, [open]);

  const choose = (v: string) => {
    if (v !== value) onChange(v);
    close();
  };

  return (
    <>
      <button
        id={id}
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-white focus:outline-none focus:border-blue-500 cursor-pointer transition-colors flex items-center justify-between gap-2"
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-[80] flex items-center justify-center p-6"
          onClick={() => close()}
        >
          <div className="absolute inset-0 bg-black/70" />
          <div
            ref={panelRef}
            role="listbox"
            aria-label={label}
            className="relative w-full max-w-md max-h-[70vh] overflow-y-auto bg-[#0f172a] border border-blue-900/60 rounded-2xl p-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="px-2 pt-1 pb-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              {label} — OK để chọn, Back để đóng
            </p>
            {options.map((o) => {
              const sel = o.value === value;
              return (
                <button
                  key={o.value || '_all'}
                  type="button"
                  role="option"
                  aria-selected={sel}
                  data-tv-option={o.value}
                  {...(sel ? ({ 'data-tv-selected': '1' } as const) : {})}
                  onClick={() => choose(o.value)}
                  className={`w-full text-left px-3 py-3 rounded-xl text-sm mb-1 transition-colors cursor-pointer flex items-center justify-between gap-2 focus:outline-none ${
                    sel
                      ? 'bg-blue-600 text-white font-bold'
                      : 'text-slate-200 bg-white/5 focus:bg-sky-600 focus:text-white'
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {sel && <Check className="w-4 h-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};
