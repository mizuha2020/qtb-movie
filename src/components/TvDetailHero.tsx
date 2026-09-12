import React from 'react';
import { Play, Calendar, Clock, Tv, Bookmark, Check } from 'lucide-react';
import DOMPurify from 'dompurify';
import { getImageUrl } from '../services/movieApi';
import type { Movie } from '../types';

interface Props {
  data: Movie;
  backdropSrc: string;
  fallbackThumb: string;
  isInList: boolean;
  /** Null = phim mới ("Xem Phim Ngay"); có giá trị = "Xem tiếp Tập X" */
  resumeLabel: string | null;
  onPlay: () => void;
  onToggleList: () => void;
  saveRef: React.Ref<HTMLButtonElement>;
}


export const TvDetailHero: React.FC<Props> = ({
  data, backdropSrc, fallbackThumb, isInList, resumeLabel,
  onPlay, onToggleList, saveRef,
}) => {
  const cats: Array<{ name?: string }> = Array.isArray((data as any).category) ? (data as any).category : [];
  // Nếu không có backdrop ngang thật (backdropSrc trùng thumb dọc) thì dùng nền mờ
  // thay vì object-cover ảnh dọc -> tránh crop mất phần top.
  const hasRealBackdrop = Boolean(backdropSrc && fallbackThumb && backdropSrc !== fallbackThumb);
  return (
    <section id="detail-hero-tv" className="relative w-full shrink-0 bg-[#060a14] select-none flex flex-col justify-center overflow-visible">
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        {hasRealBackdrop ? (
          <img
            src={backdropSrc}
            alt=""
            className="w-full h-full object-cover object-[50%_20%]"
            loading="eager"
            referrerPolicy="no-referrer"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (fallbackThumb && img.src !== fallbackThumb) {
                img.src = fallbackThumb;
                return;
              }
              img.style.display = 'none';
            }}
          />
        ) : (
          <>
            <img
              src={fallbackThumb}
              alt=""
              className="w-full h-full object-cover scale-110 blur-[14px] opacity-50"
              loading="eager"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <div className="absolute inset-0 bg-[#060a14]/55" />
          </>
        )}
        <div className="absolute inset-0 bg-gradient-to-r from-[#060a14] via-[#060a14]/70 to-[#060a14]/5" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#060a14] via-[#060a14]/10 to-transparent" />
      </div>
      <div className="relative z-10 flex items-start gap-8 px-14 pt-8 pb-8 max-w-[1500px] w-full">
        <div className="shrink-0 w-[190px] aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl border border-white/15 bg-slate-900">
          <img src={data.poster_url ? getImageUrl(data.poster_url, (data as any).source) : getImageUrl(data.thumb_url, (data as any).source)} alt={data.name} className="w-full h-full object-cover" loading="eager" referrerPolicy="no-referrer" />
        </div>
        <div className="flex-1 min-w-0 space-y-3 pb-1 overflow-visible">
          <div className="space-y-1 overflow-visible">
            <h1 className="text-4xl font-black text-white tracking-tight leading-[1.35] line-clamp-2 break-words py-1 drop-shadow-2xl">{data.name}</h1>
            {data.origin_name && <p className="text-lg text-slate-300 font-medium line-clamp-1">{data.origin_name}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.quality && <span className="border border-sky-500/70 text-sky-300 bg-sky-500/10 text-[13px] font-bold px-2.5 py-0.5 rounded-lg">{data.quality}</span>}
            {data.lang && <span className="border border-slate-500/60 text-slate-200 bg-white/5 text-[13px] font-semibold px-2.5 py-0.5 rounded-lg">{data.lang}</span>}
            {data.episode_current && <span className="bg-amber-400/15 text-amber-300 border border-amber-400/40 text-[13px] font-bold px-2.5 py-0.5 rounded-lg">{data.episode_current}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300 font-medium">
            {data.year && <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4 text-slate-400" />{data.year}</span>}
            {data.time && <span className="flex items-center gap-1.5"><Clock className="w-4 h-4 text-sky-400" />{data.time}</span>}
            {data.type && <span className="flex items-center gap-1.5"><Tv className="w-4 h-4 text-slate-400" />{data.type === 'series' ? 'Phim Bộ' : data.type === 'single' ? 'Phim Lẻ' : 'TV Shows'}</span>}
            {cats.length > 0 && <span className="text-slate-400 line-clamp-1">{cats.map((c) => c.name).slice(0, 3).join(', ')}</span>}
          </div>
          {data.content && <div className="text-sm leading-relaxed text-slate-200/90 line-clamp-3 max-w-[640px]" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.content) }} />}
          <div className="flex items-center gap-3 pt-2">
            <button data-tv-detail-play data-tv-ep-first-target onClick={onPlay} className="flex items-center gap-2 bg-[#0a84ff] text-white pl-5 pr-7 py-3 rounded-2xl font-extrabold text-base shadow-[0_8px_30px_rgba(10,132,255,0.45)]">
              <Play className="w-4 h-4 fill-white" /><span>{resumeLabel ?? 'Xem Phim Ngay'}</span>
            </button>
            <button ref={saveRef} onClick={onToggleList} className="flex items-center gap-2 bg-white/[0.06] border border-white/15 text-white px-5 py-3 rounded-2xl font-bold text-sm">
              {isInList ? <><Check className="w-4 h-4 text-sky-300" /><span>Đã lưu</span></> : <><Bookmark className="w-4 h-4 text-sky-300" /><span>Lưu phim</span></>}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
