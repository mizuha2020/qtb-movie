import React from 'react';
import { Movie } from '../types';
import { Play, Info } from 'lucide-react';
import { getImageUrl } from '../services/movieApi';

interface TvStaticHeroProps {
  movie: Movie;
  onPlay: (movie: Movie) => void;
  onOpenDetail: (movie: Movie) => void;
}

/**
 * Banner tĩnh cho TV (kiểu Netflix TV):
 * - ĐÚNG 1 ảnh backdrop resize w780 (không /original, không w1280,
 *   không proxy, không preload ảnh kề) để box yếu decode nhẹ.
 * - Không rotate, không motion, không fetch thêm (xài data sẵn có).
 * - Bo góc, chữ + 2 nút dưới-trái. Focus D-pad ăn qua nút Xem ngay.
 */
function resizeTvBackdrop(url: string): string {
  if (!url) return url;
  // TMDB: /original hoặc /wXXX -> /w780 (đủ cho hero TV 540p, decode nhẹ ~5-15x so với original 4K)
  if (url.includes('image.tmdb.org')) {
    return url
      .replace('/original/', '/w780/')
      .replace(/\/w\d+\//, '/w780/');
  }
  return url;
}

export const TvStaticHero: React.FC<TvStaticHeroProps> = React.memo(({
  movie,
  onPlay,
  onOpenDetail,
}) => {
  const backdrop =
    movie.backdrops?.find((b) => b.primary)?.url ||
    movie.backdrop_url ||
    movie.thumb_url ||
    movie.poster_url ||
    '';
  const rawSrc = backdrop
    ? backdrop.startsWith('http')
      ? backdrop
      : getImageUrl(backdrop)
    : getImageUrl(movie.poster_url || movie.thumb_url);
  // TV box yếu: luôn downsize hero về w780, kể cả URL http nguyên gốc
  const src = resizeTvBackdrop(rawSrc);
  const logo =
    movie.logos?.find((l) => l.primary)?.url || (movie as any).logo_url || '';

  const desc = (movie.content || '')
    .replace(/<[^>]*>?/gm, '')
    .trim();

  return (
    <section
      id="qtb-hero-banner"
      aria-label={movie.name}
      className="w-full select-none"
      style={{ paddingTop: 84 }}
    >
      <div
        className="relative w-full overflow-hidden rounded-2xl bg-[#0d1427]"
        style={{ height: '52vh', minHeight: 360, maxHeight: 540 }}
      >
        <img
          src={src}
          alt=""
          aria-hidden
          loading="eager"
          decoding="async"
          width={1280}
          height={720}
          draggable={false}
          // @ts-expect-error fetchpriority cho browser mới, cũ bỏ qua
          fetchpriority="high"
          className="absolute inset-0 w-full h-full object-cover object-center"
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            const fb = resizeTvBackdrop(getImageUrl(movie.thumb_url || movie.poster_url));
            if (fb && img.src !== fb) img.src = fb;
          }}
        />
        {/* Scrim gọn: chỉ phủ trái + đáy để chữ đọc được */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 45%, transparent 70%), linear-gradient(to top, rgba(7,11,22,0.85) 0%, transparent 45%)',
          }}
        />

        <div
          className="absolute left-0 bottom-0 p-6 sm:p-10"
          style={{ maxWidth: '60%' }}
        >
          {logo ? (
            <img
              src={logo}
              alt={movie.name}
              loading="eager"
              decoding="async"
              draggable={false}
              className="w-auto object-contain object-left"
              style={{ maxHeight: 110, maxWidth: 420 }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <h1
              className="text-white font-black tracking-tight leading-none line-clamp-2"
              style={{ fontSize: 44, textShadow: '0 2px 12px rgba(0,0,0,0.9)' }}
            >
              {movie.name}
            </h1>
          )}

          <div
            className="flex items-center gap-2 mt-3 text-sm font-medium"
            style={{ color: '#e2e8f0', textShadow: '0 1px 8px rgba(0,0,0,0.9)' }}
          >
            {movie.year && <span>{movie.year}</span>}
            {movie.quality && (
              <span className="px-1.5 py-0.5 rounded bg-white/15 text-[11px]">
                {movie.quality}
              </span>
            )}
            {movie.episode_current && (
              <span style={{ color: '#7dd3fc' }}>{movie.episode_current}</span>
            )}
            {movie.lang && <span>{movie.lang}</span>}
          </div>

          {desc && (
            <p
              className="mt-2 text-sm leading-relaxed line-clamp-2"
              style={{ color: '#e2e8f0', textShadow: '0 1px 8px rgba(0,0,0,0.9)' }}
            >
              {desc}
            </p>
          )}

          <div className="flex items-center gap-3 mt-5">
            <button
              id="hero-play-btn"
              type="button"
              onClick={() => onPlay(movie)}
              className="flex items-center gap-2 bg-white text-black font-bold rounded-full cursor-pointer"
              style={{ padding: '10px 28px', fontSize: 15 }}
            >
              <Play className="w-5 h-5 fill-black" />
              <span>Xem ngay</span>
            </button>
            <button
              id="hero-detail-btn"
              type="button"
              onClick={() => onOpenDetail(movie)}
              className="flex items-center gap-2 font-semibold rounded-full cursor-pointer"
              style={{
                padding: '10px 24px',
                fontSize: 15,
                background: 'rgba(255,255,255,0.2)',
                color: '#fff',
              }}
            >
              <Info className="w-5 h-5" />
              <span>Chi tiết</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});
