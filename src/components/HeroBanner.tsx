import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Movie } from '../types';
import { Play, Info, Plus, Check, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';
import { getImageUrl, getTmdbAssets } from '../services/movieApi';
import { useTvMode } from '../hooks/useTvMode';
import { motion, AnimatePresence } from 'motion/react';

const HERO_LIMIT = 10;

interface HeroBannerProps {
  movies: Movie[];
  onPlay?: (movie: Movie) => void;
  onPlayMovie?: (movie: Movie) => void;
  onOpenDetail?: (movie: Movie) => void;
  onSelectMovie?: (movie: Movie) => void;
  onToggleMyList: (movie: Movie) => void;
  isInMyList: boolean | ((slug: string) => boolean);
}

export const HeroBanner: React.FC<HeroBannerProps> = ({
  movies,
  onPlay,
  onPlayMovie,
  onOpenDetail,
  onSelectMovie,
  onToggleMyList,
  isInMyList,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [tmdbBackdropMap, setTmdbBackdropMap] = useState<Record<string, string>>({});
  const [tmdbLogoMap, setTmdbLogoMap] = useState<Record<string, string>>({});
  // Backdrop hero: TV box yếu decode 4K/w1280 rất nặng -> dùng w780
  // (đủ nét ở khoảng cách 3m, nhẹ hơn w1280 ~3 lần). Desktop giữ w1280.
  const isTvHero = useTvMode();
  const heroImgSize = isTvHero ? '/w780' : '/w1280';

  const heroMovies = useMemo(() => (movies || []).slice(0, HERO_LIMIT), [movies]);

  const handlePlay = onPlay || onPlayMovie || (() => {});
  const handleOpenDetail = onOpenDetail || onSelectMovie || (() => {});

  const resetInterval = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    // TV box yếu: tắt auto-rotate hero (đỡ animate + đỡ fetch ảnh liên tục)
    if (isTvHero) return;
    if (!heroMovies || heroMovies.length <= 1) return;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % heroMovies.length);
    }, 9000);
  }, [heroMovies, isTvHero]);

  // Auto rotate featured hero movie every 9 seconds if not interacted
  useEffect(() => {
    resetInterval();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [resetInterval]);

  // Keep currentIndex within bounds when heroMovies length changes
  useEffect(() => {
    if (currentIndex >= heroMovies.length && heroMovies.length > 0) {
      setCurrentIndex(0);
    }
  }, [heroMovies.length, currentIndex]);

  const getHeroSrc = useCallback((movie: Movie) => {
    if (!movie) return '';
    const primaryCandidate = movie.backdrops?.find(b => b.primary)?.url;
    if (primaryCandidate) {
      return primaryCandidate.includes('image.tmdb.org')
        ? (primaryCandidate.includes('/original') ? primaryCandidate.replace('/original', heroImgSize) : primaryCandidate.replace(/\/w\d+/, heroImgSize))
        : primaryCandidate;
    }
    if (movie.backdrop_url) {
      return movie.backdrop_url.includes('image.tmdb.org')
        ? (movie.backdrop_url.includes('/original') ? movie.backdrop_url.replace('/original', heroImgSize) : movie.backdrop_url.replace(/\/w\d+/, heroImgSize))
        : movie.backdrop_url;
    }
    const tmdbFetched = tmdbBackdropMap[movie.slug];
    if (tmdbFetched) return tmdbFetched;
    if ((movie as any).backdropUrl && String((movie as any).backdropUrl).includes('image.tmdb.org')) {
      return String((movie as any).backdropUrl);
    }
    if (movie.poster_url && movie.poster_url.includes('image.tmdb.org')) {
      return movie.poster_url.replace(/\/w\d+/, heroImgSize);
    }
    return movie.thumb_url || movie.poster_url || '';
  }, [tmdbBackdropMap, heroImgSize]);

  // Pre-load next & prev slide images in memory for seamless zero-flicker transitions
  useEffect(() => {
    if (!heroMovies.length) return;
    // TV box RAM yếu: bỏ preload slide kề + logo để đỡ spike network/RAM lúc mở app
    if (isTvHero) return;
    const nextIdx = (currentIndex + 1) % heroMovies.length;
    const prevIdx = (currentIndex - 1 + heroMovies.length) % heroMovies.length;
    [nextIdx, prevIdx].forEach((idx) => {
      const m = heroMovies[idx];
      if (!m) return;
      const src = getHeroSrc(m);
      if (src) {
        const img = new Image();
        img.src = src;
      }
      const logo = m.logos?.find((l) => l.primary)?.url || m.logo_url || tmdbLogoMap[m.slug];
      if (logo) {
        const imgLogo = new Image();
        imgLogo.src = logo;
      }
    });
  }, [currentIndex, heroMovies, getHeroSrc, tmdbLogoMap]);

  // Fetch TMDB backdrop + logo if missing from batch payload
  useEffect(() => {
    let cancelled = false;
    if (!heroMovies.length) return;
    heroMovies.forEach(async (m) => {
      const hasBackdrop = Boolean(m.backdrops?.find(b => b.primary)?.url || m.backdrop_url);
      const hasLogo = Boolean(m.logos?.find(l => l.primary)?.url || m.logo_url);
      if (hasBackdrop && hasLogo) return;

      const tmdbId = (m as any)?.tmdb?.id ? String((m as any).tmdb.id).trim() : '';
      if (!tmdbId || !/^\d+$/.test(tmdbId)) return;
      const needBackdrop = !hasBackdrop && !tmdbBackdropMap[m.slug];
      const needLogo = !hasLogo && !tmdbLogoMap[m.slug];
      if (!needBackdrop && !needLogo) return;
      try {
        const assets = await getTmdbAssets(tmdbId, (m as any)?.tmdb?.type);
        if (cancelled) return;
        if (assets.backdropUrl && needBackdrop) {
          setTmdbBackdropMap((prev) => ({ ...prev, [m.slug]: assets.backdropUrl! }));
        }
        if (assets.logoUrl && needLogo) {
          setTmdbLogoMap((prev) => ({ ...prev, [m.slug]: assets.logoUrl! }));
        }
      } catch {}
    });
    return () => { cancelled = true; };
  }, [heroMovies, tmdbBackdropMap, tmdbLogoMap]);

  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const touchEndXRef = useRef<number | null>(null);
  const touchEndYRef = useRef<number | null>(null);

  if (!heroMovies || heroMovies.length === 0) {
    return (
      <div className="relative w-full h-[75vh] md:h-screen md:min-h-[100vh] md:max-h-none min-h-[540px] max-h-[780px] bg-[#070b16] overflow-hidden flex items-end p-6 sm:p-12 lg:p-16 select-none">
        {/* Subtle Ambient Shimmer Overlay */}
        <div className="absolute inset-0 z-0 bg-gradient-to-r from-[#0d1427] via-[#152243]/40 to-[#0d1427] animate-pulse" />
        <div className="absolute inset-0 z-10 bg-gradient-to-t from-[#070b16] via-[#070b16]/70 to-transparent pointer-events-none" />
        <div className="absolute inset-0 z-10 bg-gradient-to-r from-[#070b16] via-[#070b16]/80 to-transparent pointer-events-none" />

        {/* Content Skeleton */}
        <div className="relative z-20 space-y-4 max-w-2xl w-full animate-pulse">
          {/* Badge / Pill Placeholders */}
          <div className="flex items-center gap-3">
            <div className="h-6 w-28 bg-red-600/30 border border-red-500/20 rounded-full" />
            <div className="h-6 w-24 bg-slate-800/60 rounded-full hidden sm:block" />
            <div className="h-6 w-16 bg-slate-800/40 rounded-full" />
          </div>

          {/* Title / Logo Box */}
          <div className="py-1">
            <div className="h-12 sm:h-16 md:h-20 w-3/4 max-w-md bg-slate-800/80 rounded-2xl shadow-inner" />
          </div>

          {/* Meta Info Row */}
          <div className="flex items-center gap-3 text-sm">
            <div className="h-4 w-12 bg-amber-500/25 rounded" />
            <div className="h-4 w-10 bg-slate-800/80 rounded" />
            <div className="h-4 w-14 bg-slate-800/80 rounded" />
            <div className="h-4 w-32 bg-slate-800/60 rounded hidden sm:block" />
          </div>

          {/* Synopsis Paragraph Lines */}
          <div className="space-y-2 max-w-xl py-1">
            <div className="h-3.5 w-full bg-slate-800/70 rounded-full" />
            <div className="h-3.5 w-11/12 bg-slate-800/60 rounded-full" />
            <div className="h-3.5 w-3/4 bg-slate-800/40 rounded-full hidden sm:block" />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 sm:gap-4 pt-3">
            <div className="h-12 w-36 sm:w-40 bg-gradient-to-r from-red-600/60 to-red-700/60 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-red-950/30">
              <div className="w-5 h-5 bg-white/40 rounded-full" />
              <div className="h-4 w-16 bg-white/40 rounded" />
            </div>
            <div className="h-12 w-32 sm:w-36 bg-slate-800/80 border border-slate-700/50 rounded-xl flex items-center justify-center gap-2">
              <div className="w-5 h-5 bg-slate-400/40 rounded-full" />
              <div className="h-4 w-16 bg-slate-400/40 rounded" />
            </div>
            <div className="h-12 w-12 bg-slate-800/80 border border-slate-700/50 rounded-xl hidden sm:flex items-center justify-center">
              <div className="w-5 h-5 bg-slate-400/40 rounded-full" />
            </div>
          </div>
        </div>

        {/* Carousel Indicators Skeleton */}
        <div className="absolute right-6 sm:right-12 bottom-12 z-20 hidden md:flex items-center gap-2">
          <div className="h-2 w-8 bg-red-600/60 rounded-full" />
          <div className="h-2 w-2 bg-slate-800 rounded-full" />
          <div className="h-2 w-2 bg-slate-800 rounded-full" />
          <div className="h-2 w-2 bg-slate-800 rounded-full" />
          <div className="h-2 w-2 bg-slate-800 rounded-full" />
        </div>
      </div>
    );
  }

  const currentMovie = heroMovies[currentIndex] || heroMovies[0];
  const inList =
    typeof isInMyList === 'function'
      ? currentMovie
        ? isInMyList(currentMovie.slug)
        : false
      : Boolean(isInMyList);

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev === 0 ? heroMovies.length - 1 : prev - 1));
    resetInterval();
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev + 1) % heroMovies.length);
    resetInterval();
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length > 1) return;
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
    touchEndXRef.current = e.touches[0].clientX;
    touchEndYRef.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length > 1) return;
    touchEndXRef.current = e.touches[0].clientX;
    touchEndYRef.current = e.touches[0].clientY;
  };

  const handleTouchEnd = () => {
    if (touchStartXRef.current === null || touchEndXRef.current === null) return;

    const deltaX = touchStartXRef.current - touchEndXRef.current;
    const deltaY = touchStartYRef.current !== null && touchEndYRef.current !== null
      ? Math.abs(touchStartYRef.current - touchEndYRef.current)
      : 0;

    const minSwipeDistance = 35;

    if (Math.abs(deltaX) > minSwipeDistance && Math.abs(deltaX) > deltaY * 1.1) {
      if (deltaX > 0) {
        handleNext();
      } else {
        handlePrev();
      }
    }

    touchStartXRef.current = null;
    touchStartYRef.current = null;
    touchEndXRef.current = null;
    touchEndYRef.current = null;
  };

  const currentLogo = currentMovie.logos?.find((l) => l.primary)?.url || currentMovie.logo_url || tmdbLogoMap[currentMovie.slug];
  const palette = currentMovie.color_palette;
  const ambientGlow = palette?.ambientGlow || 'rgba(37, 99, 235, 0.25)';

  return (
    <div
      id="qtb-hero-banner"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{ touchAction: 'pan-y' }}
      className="relative w-full h-[75vh] md:h-screen md:min-h-[100vh] md:max-h-none min-h-[540px] max-h-[780px] bg-[#070b16] overflow-hidden select-none touch-pan-y"
    >
      {/* Dynamic Ambient Backlight Glow from Extracted Color Palette */}
      <div
        className="absolute inset-0 z-0 pointer-events-none transition-colors duration-1000 opacity-60"
        style={{
          background: `radial-gradient(circle at 20% 70%, ${ambientGlow} 0%, transparent 60%)`,
        }}
      />

      {/* Background Image with Dynamic Fade Transitions (TV: ảnh tĩnh, không animate) */}
      {isTvHero ? (
        <div className="absolute inset-0 w-full h-full">
          {(() => {
            const heroSrc = getHeroSrc(currentMovie);
            const fallbackThumb = getImageUrl(currentMovie.thumb_url || currentMovie.poster_url, (currentMovie as any).source);
            return (
              <img
                src={heroSrc || fallbackThumb}
                alt={currentMovie.name}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                className="w-full h-full object-cover object-center sm:object-top"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (fallbackThumb && img.src !== fallbackThumb) {
                    img.src = fallbackThumb;
                    return;
                  }
                  if (img.src !== 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1200&auto=format&fit=crop&q=80') {
                    img.src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1200&auto=format&fit=crop&q=80';
                  }
                }}
              />
            );
          })()}
        </div>
      ) : (
      <AnimatePresence mode="wait">
        <motion.div
          key={currentMovie.slug || currentIndex}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          className="absolute inset-0 w-full h-full"
        >
          {(() => {
            const heroSrc = getHeroSrc(currentMovie);
            const fallbackThumb = getImageUrl(currentMovie.thumb_url || currentMovie.poster_url, (currentMovie as any).source);
            return (
              <img
                src={heroSrc || fallbackThumb}
                alt={currentMovie.name}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                className="w-full h-full object-cover object-center sm:object-top"
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (fallbackThumb && img.src !== fallbackThumb) {
                    img.src = fallbackThumb;
                    return;
                  }
                  if (img.src !== 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1200&auto=format&fit=crop&q=80') {
                    img.src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=1200&auto=format&fit=crop&q=80';
                  }
                }}
              />
            );
          })()}
        </motion.div>
      </AnimatePresence>
      )}

      {/* Light scrim for text readability - much lighter than before (was 80%/60%) */}
      {/* Only covers text area (left + bottom), right/top stays fully clear */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/15 via-35% to-transparent z-[5] pointer-events-none" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#070b16]/70 via-[#070b16]/20 via-25% to-transparent z-[5] pointer-events-none" />

      {/* Content Container */}
      <div className="relative max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex flex-col justify-end pb-12 sm:pb-24 z-10">
        <div className="max-w-2xl space-y-3 sm:space-y-4">
          {/* Badges / Category pill */}
          <div className="flex items-center flex-wrap gap-2 text-xs font-semibold">
            <span
              className="flex items-center gap-1 text-white px-2.5 py-0.5 rounded-full font-bold tracking-wide text-[11px] uppercase shadow-lg"
              style={{
                backgroundColor: palette?.primary || '#2563eb',
                boxShadow: `0 4px 14px ${palette?.ambientGlow || 'rgba(37,99,235,0.4)'}`,
              }}
            >
              <Sparkles className="w-3 h-3 text-sky-200" /> Gấu NỔI BẬT
            </span>
            {currentMovie.quality && (
              <span className="bg-slate-900/90 text-sky-200 border border-slate-700/80 px-2 py-0.5 rounded-md backdrop-blur-sm">
                {currentMovie.quality}
              </span>
            )}
            {currentMovie.lang && (
              <span className="bg-slate-900/90 text-slate-200 border border-slate-700/80 px-2 py-0.5 rounded-md backdrop-blur-sm">
                {currentMovie.lang}
              </span>
            )}
            {currentMovie.year && (
              <span className="text-slate-300 font-normal">{currentMovie.year}</span>
            )}
            {currentMovie.episode_current && (
              <span className="text-sky-400 font-semibold">{currentMovie.episode_current}</span>
            )}
          </div>

          {/* Title - ưu tiên logo TMDB PNG với drop shadow tương phản cao */}
          {currentLogo ? (
            <div className="py-1">
              <img
                src={currentLogo}
                alt={currentMovie.name}
                className="max-h-16 sm:max-h-20 md:max-h-28 lg:max-h-32 max-w-[80%] sm:max-w-[520px] w-auto object-contain object-left select-none drop-shadow-[0_8px_24px_rgba(0,0,0,0.95)] filter brightness-110"
                loading="eager"
                decoding="async"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          ) : (
            <h1
              className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-white tracking-tight leading-tight drop-shadow-[0_4px_20px_rgba(0,0,0,0.95)] line-clamp-2"
              style={{ textShadow: '0 2px 12px rgba(0,0,0,0.9), 0 4px 32px rgba(0,0,0,0.7)' }}
            >
              {currentMovie.name}
            </h1>
          )}

          {/* Origin Name */}
          {currentMovie.origin_name && (
            <p
              className="text-xs sm:text-base text-slate-300/90 font-medium tracking-wide drop-shadow line-clamp-1"
              style={{ textShadow: '0 1px 8px rgba(0,0,0,0.9), 0 2px 16px rgba(0,0,0,0.6)' }}
            >
              {currentMovie.origin_name}
            </p>
          )}

          {/* Description */}
          <p
            className="text-xs sm:text-sm text-slate-200/95 leading-relaxed line-clamp-2 sm:line-clamp-3 max-w-xl drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]"
            style={{ textShadow: '0 1px 10px rgba(0,0,0,0.9), 0 2px 20px rgba(0,0,0,0.6)' }}
          >
            {currentMovie.content
              ? currentMovie.content.replace(/<[^>]*>?/gm, '')
              : `Khám phá câu chuyện lôi cuốn trong siêu phẩm "${currentMovie.name}". Trải nghiệm trọn vẹn trên Gấu Cinema với chất lượng hình ảnh sắc nét, âm thanh sống động.`}
          </p>

          {/* Action Buttons */}
          <div className="flex items-center flex-wrap gap-2.5 sm:gap-3 pt-1 sm:pt-2">
            <button
              id="hero-play-btn"
              onClick={() => {
                const backdropUrl = getHeroSrc(currentMovie);
                const logoUrl = currentMovie.logos?.find((l) => l.primary)?.url || currentMovie.logo_url || tmdbLogoMap[currentMovie.slug];
                const enrichedMovie: Movie = {
                  ...currentMovie,
                  backdrop_url: (backdropUrl && backdropUrl.includes('image.tmdb.org')) ? backdropUrl : currentMovie.backdrop_url,
                  backdrops: currentMovie.backdrops && currentMovie.backdrops.length > 0
                    ? currentMovie.backdrops
                    : (backdropUrl && backdropUrl.includes('image.tmdb.org') ? [{ url: backdropUrl, primary: true }] : currentMovie.backdrops),
                  logo_url: logoUrl || currentMovie.logo_url,
                };
                handlePlay(enrichedMovie);
              }}
              className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white px-5 py-2 sm:px-8 sm:py-3 rounded-xl font-bold text-xs sm:text-base transition-all duration-200 shadow-xl shadow-blue-600/30 hover:scale-105 active:scale-95 cursor-pointer"
            >
              <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-white" />
              <span>Xem Ngay</span>
            </button>

            <button
              id="hero-detail-btn"
              onClick={() => {
                const backdropUrl = getHeroSrc(currentMovie);
                const logoUrl = currentMovie.logos?.find((l) => l.primary)?.url || currentMovie.logo_url || tmdbLogoMap[currentMovie.slug];
                const enrichedMovie: Movie = {
                  ...currentMovie,
                  backdrop_url: (backdropUrl && backdropUrl.includes('image.tmdb.org')) ? backdropUrl : currentMovie.backdrop_url,
                  backdrops: currentMovie.backdrops && currentMovie.backdrops.length > 0
                    ? currentMovie.backdrops
                    : (backdropUrl && backdropUrl.includes('image.tmdb.org') ? [{ url: backdropUrl, primary: true }] : currentMovie.backdrops),
                  logo_url: logoUrl || currentMovie.logo_url,
                };
                handleOpenDetail(enrichedMovie);
              }}
              className="flex items-center gap-1.5 sm:gap-2 bg-slate-900/85 hover:bg-slate-800 text-slate-200 hover:text-white px-4 py-2 sm:px-7 sm:py-3 rounded-xl font-semibold text-xs sm:text-base backdrop-blur-md transition-all duration-200 border border-slate-700/80 shadow-lg hover:scale-105 active:scale-95 cursor-pointer"
            >
              <Info className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
              <span>Thông Tin</span>
            </button>

            <button
              id="hero-add-list-btn"
              onClick={() => onToggleMyList(currentMovie)}
              className={`p-2 sm:p-3 rounded-full border transition-all duration-200 cursor-pointer ${
                inList
                  ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/30'
                  : 'bg-slate-900/85 border-slate-700/80 text-slate-300 hover:text-white hover:border-slate-500 backdrop-blur-md'
              }`}
              title={inList ? 'Đã thêm vào danh sách' : 'Thêm vào danh sách của tôi'}
            >
              {inList ? <Check className="w-4 h-4 sm:w-5 sm:h-5" /> : <Plus className="w-4 h-4 sm:w-5 sm:h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Indicators & Next/Prev Controls (Desktop & Tablet) */}
      <div className="absolute right-4 sm:right-8 bottom-4 sm:bottom-24 z-20 hidden sm:flex items-center gap-3">
        {/* Pagination Dots - 10 films */}
        <div className="flex items-center gap-1.5 mr-2 flex-nowrap shrink-0">
          {heroMovies.map((_, idx) => {
            const isActive = idx === currentIndex;
            return (
              <button
                key={idx}
                type="button"
                data-dot="true"
                data-tv-skip
                onClick={() => { setCurrentIndex(idx); resetInterval(); }}
                className="hero-dot no-tv-min-h group relative flex items-center justify-center py-2 px-0.5 cursor-pointer bg-transparent border-0 outline-none !min-h-0 !h-auto transition-transform hover:scale-110 active:scale-95 shrink-0"
                aria-label={`Chuyển đến phim ${idx + 1}`}
                aria-current={isActive ? 'true' : undefined}
              >
                <span
                  className={`block rounded-full transition-all duration-300 pointer-events-none ${
                    isActive
                      ? 'w-7 sm:w-8 bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.7)]'
                      : 'w-2 sm:w-2.5 bg-slate-500/60 group-hover:bg-slate-300'
                  }`}
                  style={{ height: '5px', minHeight: '5px', maxHeight: '5px' }}
                />
              </button>
            );
          })}
        </div>

        {/* Prev / Next buttons */}
        <button
          id="hero-prev-btn"
          type="button"
          onClick={handlePrev}
          className="w-9 h-9 !min-h-[36px] !max-h-[36px] rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 flex items-center justify-center border border-slate-700 transition-colors backdrop-blur-md cursor-pointer no-tv-min-h shrink-0"
          aria-label="Phim trước"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          id="hero-next-btn"
          type="button"
          onClick={handleNext}
          className="w-9 h-9 !min-h-[36px] !max-h-[36px] rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 flex items-center justify-center border border-slate-700 transition-colors backdrop-blur-md cursor-pointer no-tv-min-h shrink-0"
          aria-label="Phim kế tiếp"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Mobile Pagination Dots (visible on <sm) */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex sm:hidden items-center gap-1 bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 shadow-lg">
        {heroMovies.map((_, idx) => {
          const isActive = idx === currentIndex;
          return (
              <button
                key={idx}
                type="button"
                data-dot="true"
                data-tv-skip
                onClick={() => { setCurrentIndex(idx); resetInterval(); }}
                className="hero-dot no-tv-min-h group relative flex items-center justify-center py-1 px-0.5 cursor-pointer bg-transparent border-0 outline-none !min-h-0 !h-auto shrink-0"
              aria-label={`Chuyển đến phim ${idx + 1}`}
              aria-current={isActive ? 'true' : undefined}
            >
              <span
                className={`block rounded-full transition-all duration-300 pointer-events-none ${
                  isActive
                    ? 'w-5 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.7)]'
                    : 'w-1.5 bg-white/40 group-hover:bg-white/70'
                }`}
                style={{ height: '4px', minHeight: '4px', maxHeight: '4px' }}
              />
            </button>
          );
        })}
      </div>
      {/* Counter badge: 1 / 10 */}
      <div className="absolute top-4 right-4 z-20 sm:hidden bg-black/60 backdrop-blur-md text-white text-[11px] font-bold px-2.5 py-1 rounded-full border border-white/10">
        {currentIndex + 1} / {heroMovies.length}
      </div>
    </div>
  );
};
