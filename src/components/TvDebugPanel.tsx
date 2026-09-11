import React, { useEffect, useState } from 'react';
import { diagnoseTv, setTvModeOverride, type TvDiagnosis } from '../utils/tvDetect';
import { getLastTvMove } from '../utils/tvRemote';

/** Panel chẩn đoán TV: chỉ hiện khi URL có ?tvdebug=1. Chụp màn hình gửi dev. */
export const TvDebugPanel: React.FC = () => {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return new URLSearchParams(window.location.search).get('tvdebug') === '1';
    } catch {
      return false;
    }
  });
  const [diag, setDiag] = useState<TvDiagnosis | null>(null);
  const [focusId, setFocusId] = useState<string>('');
  const [moveInfo, setMoveInfo] = useState<string>('');
  const [min, setMin] = useState(false);

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      try {
        setDiag(diagnoseTv());
        const a = document.activeElement as HTMLElement | null;
        setFocusId(
          a
            ? `${a.tagName}#${a.id || a.getAttribute('data-tv-card') || '?'} y=${Math.round(a.getBoundingClientRect?.().top ?? -1)}`
            : '(none)',
        );
        setMoveInfo(getLastTvMove());
      } catch {}
    };
    refresh();
    const t = window.setInterval(refresh, 800);
    window.addEventListener('focusin', refresh as any);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focusin', refresh as any);
    };
  }, [open ]);

  if (!open) return null;

  const row = (k: string, v: string, good?: boolean) => (
    <div style={{ display: 'flex', gap: 6 }}>
      <span style={{ color: '#7dd3fc', minWidth: 92 }}>{k}:</span>
      <span style={{ color: good === undefined ? '#fff' : good ? '#6ee7b7' : '#fca5a5', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        left: 8,
        bottom: 8,
        zIndex: 9999,
        background: 'rgba(2,6,23,0.92)',
        border: '1px solid #1d4ed8',
        borderRadius: 10,
        padding: min ? 6 : 10,
        fontSize: 12,
        fontFamily: 'monospace',
        maxWidth: '92vw',
        maxHeight: '60vh',
        overflow: 'auto',
        color: '#fff',
      }}
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button onClick={() => { setTvModeOverride(true); }} style={btnStyle}>BẬT TV</button>
        <button onClick={() => { setTvModeOverride(false); }} style={btnStyle}>TẮT TV</button>
        <button onClick={() => setMin(!min)} style={btnStyle}>{min ? 'Mở rộng' : 'Thu gọn'}</button>
        <button onClick={() => setOpen(false)} style={btnStyle}>Ẩn</button>
      </div>
      {!min && diag && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {row('tv-mode', diag.result ? 'BẬT' : 'TẮT', diag.result)}
          {row('rule', diag.matchedRule || '(none)', !!diag.matchedRule)}
          {row('class', diag.tvClassApplied ? 'có' : 'không', diag.tvClassApplied)}
          {row('w×h', `${diag.w}×${diag.h} dpr=${diag.dpr}`)}
          {row('hover', String(diag.canHover))}
          {row('coarse', String(diag.coarse))}
          {row('fine', String(diag.fine))}
          {row('url', diag.urlOv === null ? '(none)' : diag.urlOv ? 'tv=1' : 'tv=0')}
          {row('stored', diag.storedOv === null ? '(none)' : diag.storedOv ? '1' : '0')}
          {row('uaMatch', String(diag.uaMatch), undefined)}
          {row('focus', focusId)}
          <div style={{ color: '#fbbf24', wordBreak: 'break-all', marginTop: 4 }}>move: {moveInfo || '(chưa bấm)'}</div>
          <div style={{ color: '#94a3b8', wordBreak: 'break-all', marginTop: 4 }}>UA: {diag.ua}</div>
        </div>
      )}
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  background: '#1d4ed8',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
