import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

interface CustomDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message: string;
  type?: 'info' | 'success' | 'error' | 'warning';
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  showCancel?: boolean;
}

export const CustomDialog: React.FC<CustomDialogProps> = ({
  isOpen,
  onClose,
  title,
  message,
  type = 'info',
  confirmText = 'OK',
  cancelText = 'Hủy',
  onConfirm,
  showCancel = false,
}) => {
  const confirmBtnRef = React.useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      // TV remote/màn hình: popup mở là focus ngay nút chính để D-pad/OK chọn được
      const t = window.setTimeout(() => {
        try {
          confirmBtnRef.current?.focus({ preventScroll: true } as FocusOptions);
        } catch {
          confirmBtnRef.current?.focus();
        }
      }, 80);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      window.addEventListener('keydown', onKey);
      return () => {
        document.body.style.overflow = '';
        window.clearTimeout(t);
        window.removeEventListener('keydown', onKey);
      };
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const icons = {
    info: <Info className="w-6 h-6 text-sky-400" />,
    success: <CheckCircle className="w-6 h-6 text-emerald-400" />,
    error: <AlertCircle className="w-6 h-6 text-red-400" />,
    warning: <AlertCircle className="w-6 h-6 text-amber-400" />,
  };

  const titleColors = {
    info: 'text-sky-400',
    success: 'text-emerald-400',
    error: 'text-red-400',
    warning: 'text-amber-400',
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative bg-[#0f172a] rounded-2xl shadow-2xl border border-slate-700/50 w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between p-5 border-b border-slate-700/50">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-${type === 'error' ? 'red' : type === 'success' ? 'emerald' : type === 'warning' ? 'amber' : 'sky'}-600/20`}>
              {icons[type]}
            </div>
            {title && <h3 className={`text-lg font-bold text-white ${titleColors[type]}`}>{title}</h3>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-700/50 text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5">
          <p className="text-sm text-slate-300 whitespace-pre-wrap">{message}</p>
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-700/50">
          {showCancel && (
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-700/50 hover:bg-slate-700 text-slate-300 font-medium text-sm transition-colors"
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            onClick={() => { onConfirm?.(); onClose(); }}
            className={`px-4 py-2 rounded-xl font-medium text-sm transition-colors ${
              type === 'error' || type === 'warning'
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : type === 'success'
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-sky-600 hover:bg-sky-500 text-white'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  type = 'danger',
}) => {
  // Mặc định focus nút "Ở lại" (an toàn): tránh remote bấm OK nhầm thành Thoát/Đăng xuất
  const cancelBtnRef = React.useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      const t = window.setTimeout(() => {
        try {
          cancelBtnRef.current?.focus({ preventScroll: true } as FocusOptions);
        } catch {
          cancelBtnRef.current?.focus();
        }
      }, 80);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      window.addEventListener('keydown', onKey);
      return () => {
        document.body.style.overflow = '';
        window.clearTimeout(t);
        window.removeEventListener('keydown', onKey);
      };
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const btnColors = {
    danger: 'bg-red-600 hover:bg-red-500',
    warning: 'bg-amber-600 hover:bg-amber-500',
    info: 'bg-sky-600 hover:bg-sky-500',
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="relative bg-[#0f172a] rounded-2xl shadow-2xl border border-slate-700/50 w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="p-5 text-center space-y-3">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <p className="text-sm text-slate-400">{message}</p>
        </div>
        <div className="flex border-t border-slate-700/50">
          <button
            ref={cancelBtnRef}
            onClick={onClose}
            className="flex-1 py-3 text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-700/30 transition-colors"
          >
            {cancelText}
          </button>
          <div className="w-px bg-slate-700/50" />
          <button
            onClick={() => { onConfirm(); onClose(); }}
            className={`flex-1 py-3 text-sm font-bold text-white transition-colors ${btnColors[type]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'error' | 'warning';
}

export const Toast: React.FC<ToastProps> = ({ message, type = 'info' }) => {
  const icons = {
    info: <Info className="w-4 h-4" />,
    success: <CheckCircle className="w-4 h-4" />,
    error: <AlertCircle className="w-4 h-4" />,
    warning: <AlertCircle className="w-4 h-4" />,
  };

  const colors = {
    info: 'bg-sky-600 border-sky-500',
    success: 'bg-emerald-600 border-emerald-500',
    error: 'bg-red-600 border-red-500',
    warning: 'bg-amber-600 border-amber-500',
  };

  return (
    <div className={`fixed bottom-6 right-6 z-[200] flex items-center gap-2 px-4 py-3 rounded-xl border text-white text-sm font-medium animate-in slide-in-from-right duration-300 ${colors[type]}`}>
      {icons[type]}
      <span>{message}</span>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Array<{ id: number; message: string; type?: 'info' | 'success' | 'error' | 'warning' }>;
  onRemove: (id: number) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => {
  return (
    <div className="fixed bottom-6 right-6 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto animate-in slide-in-from-right duration-300 ${
            toast.type === 'success' ? 'bg-emerald-600' :
            toast.type === 'error' ? 'bg-red-600' :
            toast.type === 'warning' ? 'bg-amber-600' : 'bg-sky-600'
          }`}
        >
          <Toast message={toast.message} type={toast.type} />
        </div>
      ))}
    </div>
  );
};