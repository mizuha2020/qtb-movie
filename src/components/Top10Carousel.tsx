import React, {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
  useLayoutEffect,
} from "react";
import { Movie } from "../types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getImageUrl } from "../services/movieApi";
import { useTvMode } from "../hooks/useTvMode";
import { smoothScrollHorizontal } from "../utils/scrollUtils";
import { RowSkeleton } from "./RowSkeleton";

interface Top10CarouselProps {
  title: string;
  movies: Movie[];
  onOpenDetail: (movie: Movie) => void;
  onPlay: (movie: Movie) => void;
  accentColor?: string;
  hideTitle?: boolean;
  /** Đang chờ dữ liệu -> vẽ skeleton giữ chỗ, chống layout shift trượt focus TV */
  pending?: boolean;
}

export const Top10Carousel: React.FC<Top10CarouselProps> = ({
  title,
  movies,
  onOpenDetail,
  accentColor = "#2563EB",
  hideTitle = false,
  pending = false,
}) => {
  // Native scroll cho: màn nhỏ (<1024) + MỌI thiết bị cảm ứng (pointer chính là coarse),
  // không phân biệt cỡ màn hình — màn cảm ứng càng to càng phải vuốt tự do.
  // Chỉ desktop chuột (pointer fine) mới dùng carousel transform + nút </>.
  // TV ép native scroll: nhẹ hơn (không nhân 3 DOM), DPAD đi 1 phát 1 item.
  const isTv = useTvMode();
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

  const top10Movies = useMemo(() => movies.slice(0, 10), [movies]);

  // ========== MOBILE: native scroll (e0ccb2e / 52269b8) ==========
  const rowRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftStartRef = useRef(0);
  const hasMovedRef = useRef(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const scrollAnimCancelRef = useRef<(() => void) | null>(null);

  const checkScrollBounds = useCallback(() => {
    if (!isMobile) return;
    const el = rowRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 8);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 8);
  }, [isMobile]);
  useEffect(() => {
    if (!isMobile) return;
    checkScrollBounds();
    window.addEventListener("resize", checkScrollBounds);
    return () => window.removeEventListener("resize", checkScrollBounds);
  }, [checkScrollBounds, top10Movies, isMobile]);

  const handleMobileScrollBtn = (direction: "left" | "right") => {
    const el = rowRef.current;
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
    const el = rowRef.current;
    if (!el) return;
    isDraggingRef.current = true;
    hasMovedRef.current = false;
    startXRef.current = e.pageX - el.offsetLeft;
    scrollLeftStartRef.current = el.scrollLeft;
  };
  const onMobileMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const el = rowRef.current;
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
  const handleClickItem = (movie: Movie) => {
    if (hasMovedRef.current) return;
    onOpenDetail(movie);
  };

  // ========== DESKTOP: transform 2-page loop giữ nguyên ==========
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const startXDesktopRef = useRef(0);
  const startYRef = useRef(0);
  const startOffsetRef = useRef(0);
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [disableTransition, setDisableTransition] = useState(false);
  const [page, setPage] = useState(0);
  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);
  const loopMovies = useMemo(
    () => [...top10Movies, ...top10Movies, ...top10Movies],
    [top10Movies],
  );
  const singleWidthRef = useRef(0);
  const maxSingleRef = useRef(0);
  const getSingleWidth = useCallback(() => {
    const track = trackRef.current;
    if (!track) return 0;
    return track.scrollWidth / 3;
  }, [loopMovies.length]);
  const getMaxSingle = useCallback(() => {
    const vp = viewportRef.current;
    const single = singleWidthRef.current || getSingleWidth();
    if (!vp || single === 0) return 0;
    return Math.max(0, single - vp.clientWidth);
  }, [getSingleWidth]);
  const refreshMetrics = useCallback(() => {
    const single = getSingleWidth();
    const vp = viewportRef.current;
    if (single > 0 && vp) {
      singleWidthRef.current = single;
      maxSingleRef.current = Math.max(0, single - vp.clientWidth);
    }
  }, [getSingleWidth]);
  useLayoutEffect(() => {
    if (isMobile) return;
    const init = () => {
      refreshMetrics();
      const single = singleWidthRef.current;
      if (single > 0) {
        setDisableTransition(true);
        setOffset(single);
        offsetRef.current = single;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${single}px)`;
        setPage(0);
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
  }, [refreshMetrics, loopMovies, isMobile]);

  const handleDesktopScrollBtn = (direction: "left" | "right") => {
    const single = singleWidthRef.current || getSingleWidth();
    const maxSingle = maxSingleRef.current || getMaxSingle();
    if (single === 0) return;
    if (direction === "right") {
      if (page === 0) {
        const next = single + maxSingle;
        setOffset(next);
        offsetRef.current = next;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${next}px)`;
        setPage(1);
      } else {
        const next = single * 2;
        setOffset(next);
        offsetRef.current = next;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${next}px)`;
        setTimeout(() => {
          setDisableTransition(true);
          const snap = single;
          setOffset(snap);
          offsetRef.current = snap;
          if (trackRef.current)
            trackRef.current.style.transform = `translateX(-${snap}px)`;
          setPage(0);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setDisableTransition(false)),
          );
        }, 760);
      }
    } else {
      if (page === 1) {
        const next = single;
        setOffset(next);
        offsetRef.current = next;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${next}px)`;
        setPage(0);
      } else {
        const next = maxSingle;
        setOffset(next);
        offsetRef.current = next;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${next}px)`;
        setTimeout(() => {
          setDisableTransition(true);
          const snap = single + maxSingle;
          setOffset(snap);
          offsetRef.current = snap;
          if (trackRef.current)
            trackRef.current.style.transform = `translateX(-${snap}px)`;
          setPage(1);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setDisableTransition(false)),
          );
        }, 760);
      }
    }
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
      const single = singleWidthRef.current || getSingleWidth();
      const maxSingle = maxSingleRef.current || getMaxSingle();
      if (single === 0) {
        setDisableTransition(false);
        return;
      }
      const cur = offsetRef.current;
      const middle0 = single;
      const middle1 = single + maxSingle;
      const dist0 = Math.abs(cur - middle0);
      const dist1 = Math.abs(cur - middle1);
      let normalizedOffset = cur;
      let needsSnap = false;
      if (cur < single * 0.5) {
        normalizedOffset = cur + single;
        needsSnap = true;
      } else if (cur >= single * 2) {
        normalizedOffset = cur - single;
        needsSnap = true;
      }
      const snapTo =
        Math.abs(normalizedOffset - middle0) <
        Math.abs(normalizedOffset - middle1)
          ? middle0
          : middle1;
      if (needsSnap) {
        setOffset(snapTo);
        offsetRef.current = snapTo;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${snapTo}px)`;
        setPage(snapTo === middle0 ? 0 : 1);
        setDisableTransition(true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setDisableTransition(false)),
        );
      } else {
        const nearest = dist0 < dist1 ? middle0 : middle1;
        setOffset(nearest);
        offsetRef.current = nearest;
        if (trackRef.current)
          trackRef.current.style.transform = `translateX(-${nearest}px)`;
        setPage(nearest === middle0 ? 0 : 1);
        setDisableTransition(false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setDisableTransition(false)),
        );
      }
      setTimeout(() => {
        hasMovedRef.current = false;
      }, 50);
    } else setDisableTransition(false);
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

  // DESKTOP: trackpad/chuột wheel ngang -> trượt track (wheel dọc vẫn cuộn trang bình thường)
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

  if (!top10Movies.length) {
    if (pending && !hideTitle) return <RowSkeleton title={title} tall />;
    return null;
  }

  if (isMobile) {
    return (
      <div className="py-4 px-2 sm:px-4 select-none">
        {!hideTitle && (
          <h2 className="text-white text-xl sm:text-2xl font-bold mb-4 flex items-center gap-2">
            <span
              className="w-1.5 h-6 rounded-full inline-block"
              style={{ backgroundColor: accentColor }}
            ></span>
            {title}
          </h2>
        )}
        <div className="relative group">
          <div
            ref={rowRef}
            data-tv-row
            onScroll={checkScrollBounds}
            onMouseDown={onMobileMouseDown}
            onMouseMove={onMobileMouseMove}
            onMouseUp={onMobileMouseUpOrLeave}
            onMouseLeave={onMobileMouseUpOrLeave}
            className="flex items-end overflow-x-auto scrollbar-none overscroll-x-contain gap-0 cursor-grab active:cursor-grabbing py-2"
            style={{ WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}
          >
            {top10Movies.map((movie, index) => (
              <div
                key={`${movie.slug || "top10"}-${index}`}
                className={`relative flex-shrink-0 flex items-end ${isTv ? "w-44 h-60" : "w-64 h-80"}`}
              >
                <div className="absolute left-0 bottom-0 z-0 flex items-center justify-start h-full">
                  <span
                    className={`font-black italic text-black select-none ${isTv ? "text-[8rem]" : "text-[12rem]"}`}
                    style={{
                      WebkitTextStroke: `3px ${accentColor}`,
                      textShadow: `0 0 24px ${accentColor}80`,
                    }}
                  >
                    {index + 1}
                  </span>
                </div>
                <div
                  tabIndex={0}
                  data-tv-card={movie.slug}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "NumpadEnter" || e.key === " ") {
                      e.preventDefault();
                      handleClickItem(movie);
                    }
                  }}
                  className={`relative z-10 rounded-lg overflow-hidden cursor-pointer shadow-2xl bg-[#0f172a] focus:outline-none focus:ring-4 focus:ring-blue-500 ${isTv ? "ml-10 w-32 h-48" : "ml-16 w-48 h-72 transition-transform hover:scale-105"}`}
                  onClick={() => handleClickItem(movie)}
                >
                  <img
                    src={getImageUrl(movie.poster_url || movie.thumb_url)}
                    alt={movie.name}
                    className="w-full h-full object-cover pointer-events-none"
                    loading={isTv ? "lazy" : "eager"}
                    decoding="async"
                    onError={(e) => {
                      const target = e.currentTarget as HTMLImageElement;
                      if (!target.src.includes("unsplash")) {
                        target.src = "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80";
                      }
                    }}
                  />
                  <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black to-transparent">
                    <p className="text-white font-bold truncate">
                      {movie.name}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const isRed = accentColor.toLowerCase() === "#e50914";

  return (
    <div className="py-4 px-2 sm:px-4 select-none">
      {!hideTitle && (
        <h2 className="text-white text-xl sm:text-2xl font-bold mb-4 flex items-center gap-2">
          <span
            className="w-1.5 h-6 rounded-full inline-block"
            style={{ backgroundColor: accentColor }}
          ></span>
          {title}
        </h2>
      )}
      <div className="relative group">
        <button
          className={`absolute -left-2 sm:-left-4 top-1/2 -translate-y-1/2 z-30 w-8 sm:w-9 h-14 sm:h-16 bg-[#0b1329]/85 ${
            isRed ? "hover:bg-red-600" : "hover:bg-blue-600"
          } text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100 backdrop-blur-md rounded-full border border-slate-700/80 shadow-xl cursor-pointer hover:scale-105 active:scale-95`}
          onClick={() => handleDesktopScrollBtn("left")}
          aria-label="Cuộn sang trái"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div
          ref={viewportRef}
          className="overflow-hidden py-2 cursor-grab active:cursor-grabbing"
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
            className="flex items-end gap-12 sm:gap-14 py-2"
            style={
              {
                display: "flex",
                flexWrap: "nowrap",
                alignItems: "flex-end",
                width: "max-content",
                transform: `translateX(-${offset}px)`,
                transition:
                  isDragging || disableTransition
                    ? "none"
                    : "transform 750ms cubic-bezier(0.4, 0, 0.2, 1)",
              } as React.CSSProperties
            }
          >
            {loopMovies.map((movie, idx) => {
              const origIndex = idx % (top10Movies.length || 10);
              return (
                <div
                  key={`${movie.slug || "top10"}-${idx}`}
                  className={`relative flex-shrink-0 flex items-end overflow-visible ${isTv ? "w-44 h-60" : "w-64 h-80"}`}
                >
                  <div className="absolute -left-8 bottom-6 z-0 flex items-center justify-start h-72 overflow-visible">
                    <span
                      className={`leading-none font-black italic text-black select-none block ${isTv ? "text-[8rem]" : "text-[15rem]"}`}
                      style={{
                        WebkitTextStroke: `3px ${accentColor}`,
                        textShadow: `0 0 24px ${accentColor}80`,
                        lineHeight: "1",
                      }}
                    >
                      {origIndex + 1}
                    </span>
                  </div>
                  <div
                    tabIndex={0}
                    data-tv-card={movie.slug}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === "NumpadEnter" || e.key === " ") {
                        e.preventDefault();
                        handleClickItem(movie);
                      }
                    }}
                    className={`relative z-10 rounded-lg overflow-hidden cursor-pointer shadow-2xl bg-[#0f172a] focus:outline-none focus:ring-4 focus:ring-blue-500 ${isTv ? "ml-10 w-32 h-48" : "ml-16 w-48 h-72 transition-transform hover:scale-105"}`}
                    onClick={() => handleClickItem(movie)}
                  >
                    <img
                      src={getImageUrl(movie.poster_url || movie.thumb_url)}
                      alt={movie.name}
                      className="w-full h-full object-cover pointer-events-none"
                      loading={isTv ? "lazy" : "eager"}
                      decoding="async"
                      onError={(e) => {
                        const target = e.currentTarget as HTMLImageElement;
                        if (!target.src.includes("unsplash")) {
                          target.src = "https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80";
                        }
                      }}
                    />
                    <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black to-transparent">
                      <p className="text-white font-bold truncate">
                        {movie.name}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <button
          className={`absolute -right-2 sm:-right-4 top-1/2 -translate-y-1/2 z-30 w-8 sm:w-9 h-14 sm:h-16 bg-[#0b1329]/85 ${
            isRed ? "hover:bg-red-600" : "hover:bg-blue-600"
          } text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100 backdrop-blur-md rounded-full border border-slate-700/80 shadow-xl cursor-pointer hover:scale-105 active:scale-95`}
          onClick={() => handleDesktopScrollBtn("right")}
          aria-label="Cuộn sang phải"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};
