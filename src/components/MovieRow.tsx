import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
} from "react";
import { Movie } from "../types";
import { MovieCard } from "./MovieCard";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTvMode } from "../hooks/useTvMode";
import { smoothScrollHorizontal } from "../utils/scrollUtils";

interface MovieRowProps {
  title: string;
  movies: Movie[];
  isTop10?: boolean;
  onPlay?: (movie: Movie) => void;
  onPlayMovie?: (movie: Movie) => void;
  onOpenDetail?: (movie: Movie) => void;
  onSelectMovie?: (movie: Movie) => void;
  onToggleMyList: (movie: Movie) => void;
  isInMyList: boolean | ((slug: string) => boolean);
  icon?: React.ReactNode;
  subtitle?: string;
}

export const MovieRow: React.FC<MovieRowProps> = ({
  title,
  movies,
  isTop10 = false,
  onPlay,
  onPlayMovie,
  onOpenDetail,
  onSelectMovie,
  onToggleMyList,
  isInMyList,
  icon,
  subtitle,
}) => {
  const isTv = useTvMode();
  // Native scroll cho: màn nhỏ (<1024) + MỌI thiết bị cảm ứng (pointer chính là coarse),
  // không phân biệt cỡ màn hình — màn cảm ứng càng to càng phải vuốt tự do.
  // Chỉ desktop chuột (pointer fine) mới dùng carousel transform + nút </>.
  // TV (tv-mode) LUÔN dùng native scroll: nhẹ hơn (không nhân 3 DOM), DPAD đi 1 phát 1 item.
  const checkIsMobileOrTablet = () => {
    if (typeof window === "undefined") return false;
    try {
      if (document.documentElement.classList.contains("tv-mode")) return true;
    } catch {}
    if (window.innerWidth < 1024) return true;
    try {
      if (window.matchMedia("(pointer: coarse)").matches) return true;
    } catch {
      // matchMedia không khả dụng -> coi như desktop chuột
    }
    return false;
  };
  const [isMobile, setIsMobile] = useState(checkIsMobileOrTablet);
  useEffect(() => {
    // tv-mode bật sau mount (detect async) -> ép lại native scroll
    if (isTv) setIsMobile(true);
  }, [isTv]);
  useEffect(() => {
    const onResize = () => setIsMobile(checkIsMobileOrTablet());
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Shared dimensions
  const [itemWidth, setItemWidth] = useState(isTop10 ? 224 : 208);
  const [gap, setGap] = useState(24);

  useEffect(() => {
    const updateDimensions = () => {
      const mobile = window.innerWidth < 640;
      const isTablet = window.innerWidth >= 640 && window.innerWidth < 1024;
      const isTvScreen =
        window.innerWidth >= 1920 ||
        document.documentElement.classList.contains("tv-mode");
      if (isTvScreen) {
        // TV gọn kiểu Netflix: card 176px -> 1 màn hình thấy ~10 card + 3-4 hàng
        setGap(24);
        setItemWidth(176);
        return;
      }
      setGap(mobile ? (isTop10 ? 20 : 16) : isTop10 ? 32 : 24);
      if (isTop10) {
        setItemWidth(mobile ? 176 : 224);
      } else {
        if (mobile) setItemWidth(144);
        else if (isTablet) setItemWidth(192);
        else setItemWidth(208);
      }
    };
    updateDimensions();
    window.addEventListener("resize", updateDimensions);
    return () => window.removeEventListener("resize", updateDimensions);
  }, [isTop10]);

  const rowHeightClass = isTv
    ? "h-[300px]"
    : isTop10
    ? "h-[300px] sm:h-[360px]"
    : "h-[250px] sm:h-[330px] md:h-[360px]";

  // ========== MOBILE: native scroll (behavior ổn định tại commit 52269b8 / e0ccb2e) ==========
  const containerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const scrollAnimCancelRef = useRef<(() => void) | null>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftStartRef = useRef(0);
  const hasMovedRef = useRef(false);

  const checkScrollBounds = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 8);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 8);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    checkScrollBounds();
    const handleResize = () => checkScrollBounds();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [checkScrollBounds, movies, isMobile]);

  const handleMobileScrollBtn = (direction: "left" | "right") => {
    const el = containerRef.current;
    if (!el) return;
    if (scrollAnimCancelRef.current) scrollAnimCancelRef.current();
    const scrollAmount = Math.round(el.clientWidth * 0.75);
    const delta = direction === "left" ? -scrollAmount : scrollAmount;
    scrollAnimCancelRef.current = smoothScrollHorizontal(
      el,
      delta,
      460,
      checkScrollBounds,
    );
  };

  const onMobileMouseDown = (e: React.MouseEvent) => {
    const el = containerRef.current;
    if (!el) return;
    isDraggingRef.current = true;
    hasMovedRef.current = false;
    startXRef.current = e.pageX - el.offsetLeft;
    scrollLeftStartRef.current = el.scrollLeft;
  };
  const onMobileMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const x = e.pageX - el.offsetLeft;
    const walk = (x - startXRef.current) * 1.3;
    if (Math.abs(walk) > 5) hasMovedRef.current = true;
    el.scrollLeft = scrollLeftStartRef.current - walk;
  };
  const onMobileMouseUpOrLeave = () => {
    isDraggingRef.current = false;
    setTimeout(() => {
      hasMovedRef.current = false;
    }, 50);
  };

  // ========== DESKTOP: transform infinite loop (giữ như hiện tại) ==========
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const startXDesktopRef = useRef(0);
  const startYRef = useRef(0);
  const startOffsetRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [disableTransition, setDisableTransition] = useState(false);
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  const loopMovies = useMemo(() => {
    if (movies.length <= 1) return movies;
    return [...movies, ...movies, ...movies];
  }, [movies]);

  const getSingleWidth = useCallback(() => {
    const track = trackRef.current;
    if (!track || loopMovies.length === 0) return 0;
    return track.scrollWidth / 3;
  }, [loopMovies.length]);

  useLayoutEffect(() => {
    if (isMobile) return;
    const init = () => {
      const single = getSingleWidth();
      if (single > 0) {
        setDisableTransition(true);
        setOffset(single);
        offsetRef.current = single;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${single}px)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setDisableTransition(false)),
        );
      }
    };
    const id = setTimeout(init, 60);
    window.addEventListener("resize", init);
    return () => {
      clearTimeout(id);
      window.removeEventListener("resize", init);
    };
  }, [getSingleWidth, loopMovies, isMobile]);

  const handleDesktopScrollBtn = (direction: "left" | "right") => {
    const vp = viewportRef.current;
    const single = getSingleWidth();
    if (!vp || single === 0) return;
    const scrollAmount = Math.round(vp.clientWidth * 0.78);
    const delta = direction === "left" ? -scrollAmount : scrollAmount;
    const next = offsetRef.current + delta;
    setOffset(next);
    offsetRef.current = next;
    if (trackRef.current)
      trackRef.current.style.transform = `translateX(-${next}px)`;
    setTimeout(() => {
      const cur = next;
      if (cur >= single * 2) {
        setDisableTransition(true);
        setOffset(cur - single);
        offsetRef.current = cur - single;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${cur - single}px)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setDisableTransition(false)),
        );
      } else if (cur < 0) {
        setDisableTransition(true);
        setOffset(cur + single);
        offsetRef.current = cur + single;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${cur + single}px)`;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setDisableTransition(false)),
        );
      }
    }, 760);
  };

  const onDesktopMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    hasMovedRef.current = false;
    setIsDragging(true);
    setDisableTransition(true);
    startXDesktopRef.current = e.pageX;
    startOffsetRef.current = offsetRef.current;
  };
  const onDesktopMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.pageX - startXDesktopRef.current;
    if (Math.abs(dx) > 5) hasMovedRef.current = true;
    const next = startOffsetRef.current - dx;
    offsetRef.current = next;
    if (trackRef.current)
      trackRef.current.style.transform = `translateX(-${next}px)`;
  };
  const onDesktopMouseUpOrLeave = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
      const single = getSingleWidth();
      const cur = offsetRef.current;
      if (single > 0) {
        let snapped = cur;
        let needsSnap = false;
        if (cur >= single * 2) {
          snapped = cur - single;
          needsSnap = true;
        } else if (cur < 0) {
          snapped = cur + single;
          needsSnap = true;
        } else if (cur < single * 0.5) {
          snapped = cur + single;
          needsSnap = true;
        }
        if (needsSnap) {
          setOffset(snapped);
          offsetRef.current = snapped;
          if (trackRef.current)
            trackRef.current.style.transform = `translateX(-${snapped}px)`;
          setDisableTransition(true);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setDisableTransition(false)),
          );
        } else {
          setOffset(cur);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setDisableTransition(false)),
          );
        }
      } else {
        setOffset(cur);
        setDisableTransition(false);
      }
      setTimeout(() => {
        hasMovedRef.current = false;
      }, 50);
    } else {
      setDisableTransition(false);
    }
  };
  const onDesktopTouchStart = (e: React.TouchEvent) => {
    isDraggingRef.current = true;
    hasMovedRef.current = false;
    setIsDragging(true);
    setDisableTransition(true);
    startXDesktopRef.current = e.touches[0].pageX;
    startYRef.current = e.touches[0].pageY;
    startOffsetRef.current = offsetRef.current;
  };
  const onDesktopTouchMove = (e: React.TouchEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.touches[0].pageX - startXDesktopRef.current;
    const dy = e.touches[0].pageY - startYRef.current;
    if (!hasMovedRef.current && Math.abs(dy) > Math.abs(dx) * 1.2) {
      isDraggingRef.current = false;
      setIsDragging(false);
      setDisableTransition(false);
      return;
    }
    if (Math.abs(dx) > 5) hasMovedRef.current = true;
    const next = startOffsetRef.current - dx;
    offsetRef.current = next;
    if (trackRef.current)
      trackRef.current.style.transform = `translateX(-${next}px)`;
  };
  const onDesktopTouchEnd = () => onDesktopMouseUpOrLeave();

  // DESKTOP: trackpad/chuột wheel ngang -> trượt track (wheel dọc vẫn cuộn trang bình thường).
  // Track dùng transform nên không có native scroll — handler này lấp khoảng trống đó.
  const wheelSnapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isMobile) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!horizontal || e.deltaX === 0) return;
      e.preventDefault();
      const track = trackRef.current;
      if (!track) return;
      isDraggingRef.current = true;
      hasMovedRef.current = true;
      setIsDragging(true);
      setDisableTransition(true);
      const next = offsetRef.current + e.deltaX;
      offsetRef.current = next;
      track.style.transform = `translateX(-${next}px)`;
      if (wheelSnapTimerRef.current) clearTimeout(wheelSnapTimerRef.current);
      wheelSnapTimerRef.current = setTimeout(() => {
        onDesktopMouseUpOrLeave();
      }, 140);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      vp.removeEventListener("wheel", onWheel);
      if (wheelSnapTimerRef.current) clearTimeout(wheelSnapTimerRef.current);
    };
  }, [isMobile, loopMovies]);

  const handlePlay = useCallback(
    (movie: Movie) => {
      if (hasMovedRef.current) return;
      if (onPlay) onPlay(movie);
      else if (onPlayMovie) onPlayMovie(movie);
    },
    [onPlay, onPlayMovie],
  );

  const handleOpenDetail = useCallback(
    (movie: Movie) => {
      if (hasMovedRef.current) return;
      if (onOpenDetail) onOpenDetail(movie);
      else if (onSelectMovie) onSelectMovie(movie);
    },
    [onOpenDetail, onSelectMovie],
  );

  const checkIsInMyList = useCallback(
    (slug: string) => {
      return typeof isInMyList === "function"
        ? isInMyList(slug)
        : Boolean(isInMyList);
    },
    [isInMyList],
  );

  if (!movies || movies.length === 0) return null;
  const canScroll = movies.length > 2;

  // MOBILE: native scroll - behavior giống e0ccb2e/52269b8
  if (isMobile) {
    return (
      <div className="relative group/row my-6 sm:my-8 px-4 sm:px-6 lg:px-8 select-none">
        <div className="flex items-baseline justify-between mb-3">
          <div className="flex items-center gap-2">
            {icon && <span className="text-sky-400">{icon}</span>}
            <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>{title}</span>
              {isTop10 && (
                <span className="text-xs bg-blue-600 text-white px-2.5 py-0.5 rounded-full font-bold tracking-wider uppercase shadow-md shadow-blue-600/30">
                  Hôm Nay
                </span>
              )}
            </h2>
          </div>
          {subtitle && (
            <span className="text-xs text-slate-400 font-medium">
              {subtitle}
            </span>
          )}
        </div>
        <div className="relative -mx-2 px-2">
          <div
            ref={containerRef}
            data-tv-row
            onScroll={checkScrollBounds}
            onMouseDown={onMobileMouseDown}
            onMouseMove={onMobileMouseMove}
            onMouseUp={onMobileMouseUpOrLeave}
            onMouseLeave={onMobileMouseUpOrLeave}
            className={`flex w-full overflow-x-auto scrollbar-none overscroll-x-contain ${rowHeightClass} py-4 cursor-grab active:cursor-grabbing`}
            style={{
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
              gap: `${gap}px`,
            }}
          >
            {movies.map((movie, index) => (
              <div
                key={`${movie.slug || movie._id || "movie"}-${index}`}
                className="flex-shrink-0 h-full"
                style={{ width: `${itemWidth}px` }}
              >
                <MovieCard
                  movie={movie}
                  rank={isTop10 ? index + 1 : undefined}
                  isTop10={isTop10}
                  onPlay={handlePlay}
                  onOpenDetail={handleOpenDetail}
                  onToggleMyList={onToggleMyList}
                  isInMyList={checkIsInMyList(movie.slug || "")}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // DESKTOP: transform loop + animation 750ms
  return (
    <div className="relative group/row my-6 sm:my-8 px-4 sm:px-6 lg:px-8 select-none">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          {icon && <span className="text-sky-400">{icon}</span>}
          <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <span>{title}</span>
            {isTop10 && (
              <span className="text-xs bg-blue-600 text-white px-2.5 py-0.5 rounded-full font-bold tracking-wider uppercase shadow-md shadow-blue-600/30">
                Hôm Nay
              </span>
            )}
          </h2>
        </div>
        {subtitle && (
          <span className="text-xs text-slate-400 font-medium">{subtitle}</span>
        )}
      </div>

      <div className="relative -mx-2 px-2">
        {canScroll && (
          <button
            onClick={() => handleDesktopScrollBtn("left")}
            className={`absolute -left-2 sm:-left-4 top-1/2 -translate-y-1/2 z-30 w-8 sm:w-9 ${
              isTv
                ? "w-11 h-20 opacity-100"
                : "h-14 sm:h-16 opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100"
            } bg-[#0b1329]/85 hover:bg-blue-600 text-white flex items-center justify-center transition-all backdrop-blur-md rounded-full border border-slate-700/80 shadow-xl cursor-pointer focus:opacity-100 focus:ring-2 focus:ring-blue-500 hover:scale-105 active:scale-95`}
            aria-label="Cuộn sang trái"
          >
            <ChevronLeft
              className={`${
                isTv ? "w-6 h-6" : "w-5 h-5"
              } hover:scale-110 transition-transform`}
            />
          </button>
        )}

        <div
          ref={viewportRef}
          className={`overflow-hidden py-4 ${rowHeightClass} cursor-grab active:cursor-grabbing`}
          style={{ touchAction: "pan-y" }}
        >
          <div
            ref={trackRef}
            onMouseDown={onDesktopMouseDown}
            onMouseMove={onDesktopMouseMove}
            onMouseUp={onDesktopMouseUpOrLeave}
            onMouseLeave={onDesktopMouseUpOrLeave}
            onTouchStart={onDesktopTouchStart}
            onTouchMove={onDesktopTouchMove}
            onTouchEnd={onDesktopTouchEnd}
            className="flex w-max will-change-transform"
            style={
              {
                display: "flex",
                flexWrap: "nowrap",
                gap: `${gap}px`,
                transform: `translateX(-${offset}px)`,
                transition:
                  isDragging || disableTransition
                    ? "none"
                    : "transform 750ms cubic-bezier(0.4, 0, 0.2, 1)",
                willChange: "transform",
              } as React.CSSProperties
            }
          >
            {loopMovies.map((movie, index) => {
              const origIndex = index % movies.length;
              return (
                <div
                  key={`${movie.slug || movie._id || "movie"}-${index}`}
                  className="flex-shrink-0 h-full"
                  style={{ width: `${itemWidth}px` }}
                >
                  <MovieCard
                    movie={movie}
                    rank={isTop10 ? origIndex + 1 : undefined}
                    isTop10={isTop10}
                    onPlay={handlePlay}
                    onOpenDetail={handleOpenDetail}
                    onToggleMyList={onToggleMyList}
                    isInMyList={checkIsInMyList(movie.slug || "")}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {canScroll && (
          <button
            onClick={() => handleDesktopScrollBtn("right")}
            className={`absolute -right-2 sm:-right-4 top-1/2 -translate-y-1/2 z-30 w-8 sm:w-9 ${
              isTv
                ? "w-11 h-20 opacity-100"
                : "h-14 sm:h-16 opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100"
            } bg-[#0b1329]/85 hover:bg-blue-600 text-white flex items-center justify-center transition-all backdrop-blur-md rounded-full border border-slate-700/80 shadow-xl cursor-pointer focus:opacity-100 focus:ring-2 focus:ring-blue-500 hover:scale-105 active:scale-95`}
            aria-label="Cuộn sang phải"
          >
            <ChevronRight
              className={`${
                isTv ? "w-6 h-6" : "w-5 h-5"
              } hover:scale-110 transition-transform`}
            />
          </button>
        )}
      </div>
    </div>
  );
};
