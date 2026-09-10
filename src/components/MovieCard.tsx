import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Movie } from '../types';
import { Play, Plus, Check, ChevronDown, ThumbsUp } from 'lucide-react';
import { getImageUrl } from '../services/movieApi';
import { useTvMode } from '../hooks/useTvMode';

interface MovieCardProps {
  movie: Movie;
  rank?: number;
  isTop10?: boolean;
  onPlay?: (movie: Movie) => void;
  onOpenDetail?: (movie: Movie) => void;
  onToggleMyList: (movie: Movie) => void;
  isInMyList: boolean | ((slug: string) => boolean);
}

export const MovieCard: React.FC<MovieCardProps> = React.memo(({
  movie,
  rank,
  isTop10 = false,
  onPlay,
  onOpenDetail,
  onToggleMyList,
  isInMyList,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [liked, setLiked] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [hoverPos, setHoverPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const isTv = useTvMode();

  const inList = typeof isInMyList === 'function' ? isInMyList(movie.slug) : Boolean(isInMyList);

  const handleOpenDetail = () => {
    if (onOpenDetail) {
      onOpenDetail(movie);
    }
  };

  const handlePlay = () => {
    if (onPlay) {
      onPlay(movie);
    }
  };

  const imgUrl = getImageUrl(movie.poster_url || movie.thumb_url);

  const matchPercentage = Math.floor(92 + (((movie.year || 2024) * 7 + (movie.name.length * 3)) % 8));

  const updatePosition = useCallback(() => {
    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      setHoverPos({
        top: rect.top - 48,
        left: rect.left - 16,
        width: rect.width + 32,
      });
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    updatePosition();
    setIsHovered(true);
  }, [updatePosition]);

  useEffect(() => {
    if (isHovered) {
      const onScroll = () => updatePosition();
      const onResize = () => updatePosition();
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      return () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
      };
    }
  }, [isHovered, updatePosition]);

  return (
    <div
      ref={cardRef}
      id={`movie-card-${movie.slug || movie._id}`}
      tabIndex={0}
      data-tv-card={movie.slug || movie._id}
      className={`relative group shrink-0 select-none focus:outline-none focus:ring-4 focus:ring-blue-500 focus:z-10 ${isTv ? 'w-44 focus:ring-[6px]' : 'transition-all duration-300 focus:scale-105'} ${
        isTv ? '' : isTop10 ? 'w-44 sm:w-56 h-64 sm:h-80' : 'w-36 sm:w-48 md:w-52'
      }`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setIsHovered(false)}
      // TV: không popup hover (vừa lag vừa kẹt focus qua nút ẩn -> tốn 2 lần bấm DPAD)
      onFocus={() => { if (!isTv) { updatePosition(); setIsHovered(true); } }}
      onBlur={() => setIsHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === ' ') {
          e.preventDefault();
          handleOpenDetail();
        }
        // Trái/Phải/Trên/Dưới do spatial-nav toàn app (tvRemote) xử lý,
        // không xử lý cục bộ để tránh double-focus với bản loop 3x.
      }}
    >
      {!isTv && isTop10 && rank !== undefined && (
        <div className="absolute left-0 bottom-0 top-0 w-20 sm:w-28 flex items-center justify-start pointer-events-none z-10">
          <span
            className="text-7xl sm:text-9xl font-black italic tracking-tighter text-[#070b16] select-none"
            style={{
              WebkitTextStroke: '3px #2563EB',
              textShadow: '0 0 24px rgba(37,99,235,0.5)',
            }}
          >
            {rank}
          </span>
        </div>
      )}

      <div
        className={`relative w-full h-full rounded-xl overflow-hidden bg-[#0f172a] border border-slate-800/90 shadow-md transition-all duration-300 group-hover:shadow-[0_0_25px_rgba(37,99,235,0.3)] group-hover:border-blue-500/60 ${
          !isTv && isTop10 ? 'ml-16 sm:ml-20 w-[calc(100%-4rem)] sm:w-[calc(100%-5rem)]' : 'aspect-[2/3]'
        }`}
        onClick={handleOpenDetail}
      >
        <img
          src={imgUrl}
          alt={movie.name}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 group-focus:scale-105"
          loading="lazy"
          decoding="async"
          onError={(e) => {
            (e.target as HTMLImageElement).src =
              'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400&auto=format&fit=crop&q=80';
          }}
        />

        <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none gap-1">
          <div className="flex items-center gap-1">
            {movie.episode_current && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-blue-600 text-white shadow-md">
                {movie.episode_current}
              </span>
            )}
            {movie.sourceLabel && (
              <span
                className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded shadow-sm ${
                  movie.source === 'kkphim'
                    ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-700/80'
                    : movie.source === 'ophim'
                    ? 'bg-sky-950/90 text-sky-300 border border-sky-700/80'
                    : 'bg-amber-950/90 text-amber-300 border border-amber-700/80'
                }`}
              >
                {movie.sourceLabel}
              </span>
            )}
          </div>
          {movie.quality && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-slate-950/80 backdrop-blur-xs text-sky-200 border border-blue-900/60">
              {movie.quality}
            </span>
          )}
        </div>

        <div className="absolute inset-0 bg-gradient-to-t from-[#0b1329] via-[#0b1329]/30 to-transparent opacity-95 group-hover:opacity-70 transition-opacity" />

        <div className="absolute bottom-0 left-0 right-0 p-2.5">
          <h3 className="text-xs sm:text-sm font-bold text-white line-clamp-1 group-hover:text-sky-300 transition-colors">
            {movie.name}
          </h3>
          <div className="flex items-center justify-between text-[11px] text-slate-400 mt-0.5">
            <span className="truncate">{movie.origin_name || movie.year}</span>
            {movie.lang && <span className="text-[10px] text-sky-300/80 shrink-0 ml-1">{movie.lang}</span>}
          </div>
        </div>
      </div>

      {!isTv && isHovered && hoverPos && (
        <div
          className="hidden md:block fixed bg-[#0f172a] rounded-xl shadow-2xl border border-blue-900/80 p-3 z-50 animate-in fade-in zoom-in-95 duration-200"
          style={{
            top: hoverPos.top,
            left: hoverPos.left,
            width: hoverPos.width,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <button
                id={`card-play-btn-${movie.slug}`}
                onClick={handlePlay}
                className="w-8 h-8 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-transform hover:scale-110 shadow-lg shadow-blue-600/30"
                title="Xem ngay"
              >
                <Play className="w-4 h-4 fill-white ml-0.5" />
              </button>
              <button
                id={`card-add-list-btn-${movie.slug}`}
                onClick={() => onToggleMyList(movie)}
                className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all ${
                  inList
                    ? 'bg-emerald-600 border-emerald-500 text-white shadow'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:border-slate-500'
                }`}
                title={inList ? 'Xóa khỏi danh sách' : 'Thêm vào danh sách'}
              >
                {inList ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
              </button>
              <button
                id={`card-like-btn-${movie.slug}`}
                onClick={() => setLiked(!liked)}
                className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all ${
                  liked
                    ? 'bg-sky-600 border-sky-500 text-white shadow'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:border-slate-500'
                }`}
                title="Yêu thích"
              >
                <ThumbsUp className="w-4 h-4" />
              </button>
            </div>

            <button
              id={`card-info-btn-${movie.slug}`}
              onClick={handleOpenDetail}
              className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 flex items-center justify-center transition-transform hover:scale-110"
              title="Thông tin chi tiết"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-cyan-400 font-bold">{matchPercentage}% Phù hợp</span>
              <span className="text-slate-400">{movie.year || '2025'}</span>
              <span className="px-1 py-0.2 rounded bg-slate-800 text-[10px] text-sky-200 border border-slate-700">
                {movie.quality || 'HD'}
              </span>
            </div>

            <h4 className="text-xs font-bold text-white line-clamp-1">{movie.name}</h4>

            {movie.episode_current && (
              <p className="text-[11px] text-sky-400 font-medium">{movie.episode_current}</p>
            )}

            {movie.category && movie.category.length > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400 overflow-hidden text-ellipsis whitespace-nowrap pt-1">
                {movie.category.slice(0, 3).map((c, i) => (
                  <span key={c.slug || i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-600">•</span>}
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
