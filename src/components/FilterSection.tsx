import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Movie, MovieListPagination, ApiSource } from '../types';
import { COUNTRIES, GENRES, YEARS, movieApi, API_SOURCES } from '../services/movieApi';
import { TvSelect } from './TvSelect';
import { systemApiService } from '../services/systemApiService';
import { MovieCard } from './MovieCard';
import { Filter, ChevronLeft, ChevronRight, Sparkles, Database } from 'lucide-react';

interface FilterSectionProps {
  initialType?: string;
  fixedType?: string;
  /** Lưới trần cho tab thể loại: chỉ tiêu đề + lưới + phân trang, không filter UI. */
  plain?: boolean;
  initialGenre?: string;
  initialCountry?: string;
  initialKeyword?: string;
  onPlay?: (movie: Movie) => void;
  onPlayMovie?: (movie: Movie) => void;
  onOpenDetail?: (movie: Movie) => void;
  onSelectMovie?: (movie: Movie) => void;
  onToggleMyList: (movie: Movie) => void;
  isInMyList: boolean | ((slug: string) => boolean);
}

export const FilterSection: React.FC<FilterSectionProps> = ({
  initialType = 'all',
  fixedType,
  plain = false,
  initialGenre = '',
  initialCountry = '',
  initialKeyword = '',
  onPlay,
  onPlayMovie,
  onOpenDetail,
  onSelectMovie,
  onToggleMyList,
  isInMyList,
}) => {
  const actualInitialType = fixedType || initialType || 'all';
  const [movieType, setMovieType] = useState<string>(actualInitialType);
  const [selectedGenre, setSelectedGenre] = useState<string>(initialGenre);
  const [selectedCountry, setSelectedCountry] = useState<string>(initialCountry);
  const [selectedSource, setSelectedSource] = useState<ApiSource>(movieApi.getActiveSource());
  const [keyword, setKeyword] = useState<string>(initialKeyword);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [movies, setMovies] = useState<Movie[]>([]);
  const [pagination, setPagination] = useState<MovieListPagination | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledVersion, setEnabledVersion] = useState(0);

  // App TV-only: mọi lựa chọn chỉ ghi vào draft, bấm OK "Áp dụng" mới filter.
  // Lia D-pad không load từng nấc, lưới kết quả không remount làm mất focus.
  const [draftGenre, setDraftGenre] = useState<string>(initialGenre);
  const [draftCountry, setDraftCountry] = useState<string>(initialCountry);
  const [draftType, setDraftType] = useState<string>(actualInitialType);
  const [draftSource, setDraftSource] = useState<ApiSource>(movieApi.getActiveSource());
  const [draftKeyword, setDraftKeyword] = useState<string>(initialKeyword);
  const applyClickedRef = useRef(false);

  const shownGenre = draftGenre;
  const shownCountry = draftCountry;
  const shownType = draftType;
  const shownSource = draftSource;
  const shownKeyword = draftKeyword;

  const setGenreVal = (v: string) => setDraftGenre(v);
  const setCountryVal = (v: string) => setDraftCountry(v);
  const setTypeVal = (v: string) => setDraftType(v);
  const setSourceVal = (v: ApiSource) => setDraftSource(v);
  const setKeywordVal = (v: string) => setDraftKeyword(v);
  const applyFilters = () => {
    setSelectedGenre(draftGenre);
    setSelectedCountry(draftCountry);
    setMovieType(draftType);
    setSelectedSource(draftSource);
    try {
      movieApi.setSource(draftSource);
    } catch {}
    setKeyword(draftKeyword);
    setCurrentPage(1);
    applyClickedRef.current = true;
  };
  const isDirty =
    draftGenre !== selectedGenre ||
    draftCountry !== selectedCountry ||
    draftType !== movieType ||
    draftSource !== selectedSource ||
    draftKeyword !== keyword;

  const handlePlay = onPlay || onPlayMovie || (() => {});
  const handleOpenDetail = onOpenDetail || onSelectMovie || (() => {});

  const isSourceEnabled = (id: ApiSource): boolean => {
    if (id === 'all') return true;
    try {
      const active = systemApiService.getActiveEndpointsForCategory('movie');
      if (!active || active.length === 0) return true;
      return active.some((e) => e.id === id);
    } catch {
      return true;
    }
  };

  const visibleSources = useMemo(() => {
    // depend on enabledVersion to recompute when system apis change
    void enabledVersion;
    return API_SOURCES.filter((s) => isSourceEnabled(s.id));
  }, [enabledVersion]);

  // Subscribe to system api changes + init fallback for disabled source
  useEffect(() => {
    const syncEnabled = () => setEnabledVersion((v) => v + 1);
    // If current selectedSource is disabled (e.g. ophim disabled but still selected), fallback to 'all'
    if (!isSourceEnabled(selectedSource)) {
      setSelectedSource('all');
      movieApi.setSource('all');
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('qtb_system_apis_changed', syncEnabled);
      // also listen for direct storage changes
      const onStorage = (e: StorageEvent) => {
        if (e.key === 'qtb_system_apis_cache_v3') syncEnabled();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        window.removeEventListener('qtb_system_apis_changed', syncEnabled);
        window.removeEventListener('storage', onStorage);
      };
    }
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-validate selectedSource whenever enabled list changes
  useEffect(() => {
    if (!isSourceEnabled(selectedSource)) {
      setSelectedSource('all');
      setDraftSource('all');
      movieApi.setSource('all');
      setCurrentPage(1);
    } else if (!isSourceEnabled(draftSource)) {
      setDraftSource('all');
    }
  }, [enabledVersion, selectedSource]);

  const checkIsInMyList = (slug: string) =>
    typeof isInMyList === 'function' ? isInMyList(slug) : Boolean(isInMyList);

  // Sync props if changed (TV: đồng bộ cả draft lẫn applied)
  useEffect(() => {
    const t = fixedType || initialType;
    if (t) {
      setMovieType(t);
      setDraftType(t);
    }
    if (initialGenre) {
      setSelectedGenre(initialGenre);
      setDraftGenre(initialGenre);
    }
    if (initialCountry) {
      setSelectedCountry(initialCountry);
      setDraftCountry(initialCountry);
    }
    if (initialKeyword !== undefined) {
      setKeyword(initialKeyword);
      setDraftKeyword(initialKeyword);
      // If a search keyword is passed (e.g. from clicking an actor), clear specific category/country filters to avoid over-filtering
      if (initialKeyword.trim() && !fixedType) {
        setSelectedGenre('');
        setSelectedCountry('');
        setMovieType('all');
        setDraftGenre('');
        setDraftCountry('');
        setDraftType('all');
      }
    }
    setCurrentPage(1);
  }, [fixedType, initialType, initialGenre, initialCountry, initialKeyword]);

  // Fetch filtered movies
  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    setError(null);

    const loadFilteredData = async () => {
      try {
        let res;
        if (keyword.trim()) {
          res = await movieApi.search(keyword.trim(), currentPage, 24, selectedSource);
          // Khi đang tìm kiếm, vẫn tôn trọng bộ lọc thể loại / quốc gia / định dạng bằng cách lọc client-side
          // vì API search không hỗ trợ filter kết hợp
          if (res && Array.isArray(res.items) && (selectedGenre || selectedCountry || (movieType && movieType !== 'all'))) {
            const before = res.items;
            let filtered = before;
            if (selectedGenre) {
              filtered = filtered.filter((m: any) => {
                const cats = (m.category || m.categories || []) as any[];
                return cats.some((c: any) => {
                  const slug = typeof c === 'string' ? c : c.slug || c.id || '';
                  const name = typeof c === 'string' ? c : c.name || '';
                  return slug === selectedGenre || name === selectedGenre;
                });
              });
            }
            if (selectedCountry) {
              filtered = filtered.filter((m: any) => {
                const countries = (m.country || m.countries || []) as any[];
                return countries.some((c: any) => {
                  const slug = typeof c === 'string' ? c : c.slug || c.id || '';
                  const name = typeof c === 'string' ? c : c.name || '';
                  return slug === selectedCountry || name === selectedCountry;
                });
              });
            }
            if (movieType && movieType !== 'all') {
              filtered = filtered.filter((m: any) => {
                const t = (m.type || '').toString().toLowerCase();
                if (movieType === 'series') return t === 'series' || t === 'phim bo' || t.includes('series');
                if (movieType === 'single') return t === 'single' || t === 'phim le' || t.includes('single');
                if (movieType === 'anime') return t === 'hoat-hinh' || t === 'anime' || (Array.isArray(m.category) && m.category.some((c: any) => (c.slug || c.name || '').toLowerCase().includes('hoạt hình') || (c.slug || '').toLowerCase().includes('anime')));
                if (movieType === 'tv-shows') return t === 'tvshows' || t === 'tv-shows' || t.includes('tv');
                return true;
              });
            }
            const total = filtered.length;
            res = {
              ...res,
              items: filtered,
              pagination: {
                totalItems: total,
                totalItemsPerPage: 24,
                currentPage: 1,
                totalPages: Math.max(1, Math.ceil(total / 24)),
              },
            };
          }
        } else if (selectedGenre) {
          res = await movieApi.getByGenre(selectedGenre, currentPage, 24, selectedSource);
        } else if (selectedCountry) {
          res = await movieApi.getByCountry(selectedCountry, currentPage, 24, selectedSource);
        } else if (movieType === 'series') {
          res = await movieApi.getSeries(currentPage, 24, selectedSource);
        } else if (movieType === 'single') {
          res = await movieApi.getSingleMovies(currentPage, 24, selectedSource);
        } else if (movieType === 'anime') {
          res = await movieApi.getAnime(currentPage, 24, selectedSource);
        } else if (movieType === 'tv-shows') {
          res = await movieApi.getTvShows(currentPage, 24, selectedSource);
        } else {
          res = await movieApi.getNewUpdated(currentPage, 24, selectedSource);
        }

        if (isMounted) {
          setMovies(res.items || []);
          setPagination(res.pagination);
        }
      } catch (err: any) {
        void 0;
        if (isMounted) {
          setError('Không thể tải danh sách phim từ nguồn đã chọn. Vui lòng thử đổi nguồn API khác.');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadFilteredData();
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieType, selectedGenre, selectedCountry, keyword, currentPage, selectedSource, enabledVersion]);

  const handleResetFilters = () => {
    setMovieType('all');
    setSelectedGenre('');
    setSelectedCountry('');
    setSelectedSource('all');
    setKeyword('');
    setDraftType('all');
    setDraftGenre('');
    setDraftCountry('');
    setDraftSource('all');
    setDraftKeyword('');
    setCurrentPage(1);
  };

  // Sau khi Áp dụng xong, đưa focus xuống card đầu của lưới mới (nếu
  // focus đang ở nút Áp dụng) để D-pad đi tiếp được ngay, không kẹt.
  useEffect(() => {
    if (!applyClickedRef.current || isLoading) return;
    applyClickedRef.current = false;
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae || ae.id !== 'filter-apply-btn') return;
      const first = document.querySelector<HTMLElement>(
        '#filter-results-grid [data-tv-card]',
      );
      if (!first) return;
      const r = first.getBoundingClientRect();
      if (r.width <= 4 || r.height <= 4) return;
      try {
        first.focus({ preventScroll: true } as FocusOptions);
      } catch {
        first.focus();
      }
    } catch {}
  }, [movies, isLoading]);

  return (
    <div id="filter-explore-page" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-16">
      {/* Title */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black text-white flex items-center gap-2">
            <Filter className="w-6 h-6 text-sky-400" />
            <span>
              {keyword
                ? `Kết Quả Tìm Kiếm: "${keyword}"`
                : movieType === 'series'
                ? 'Kho Phim Bộ'
                : movieType === 'single'
                ? 'Kho Phim Lẻ'
                : movieType === 'anime'
                ? 'Phim Hoạt Hình & Anime'
                : movieType === 'tv-shows'
                ? 'Chương Trình Truyền Hình & TV Shows'
                : 'Khám Phá & Lọc Phim'}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Hơn hàng nghìn bộ phim Full HD phụ đề Vietsub từ KKPhim, OPhim và NguonC, 100% không quảng cáo, cập nhật liên tục.
          </p>
        </div>

      </div>

      {/* API Source Selector Tabs (ẩn ở tab thể loại plain) */}
      {!plain && (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2.5">
          <Database className="w-4 h-4 text-sky-400" />
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Chọn Nguồn Phim Vietsub:</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {visibleSources.map((source) => {
            const isSelected = shownSource === source.id;
            const isPending = draftSource === source.id && selectedSource !== source.id;
            return (
              <button
                key={source.id}
                onClick={() => setSourceVal(source.id)}
                className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between relative overflow-hidden ${
                  isSelected && !isPending
                    ? 'bg-blue-950/80 border-blue-500 shadow-lg shadow-blue-950/60 ring-1 ring-blue-500'
                    : isPending
                    ? 'bg-blue-950/40 border-dashed border-sky-500/70 text-slate-200'
                    : 'bg-[#0f172a] border-slate-800 hover:border-slate-700 text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className={`text-xs font-bold ${isSelected ? 'text-sky-300' : 'text-white'}`}>
                    {source.shortName}
                  </span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded font-extrabold ${
                      source.id === 'kkphim'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        : source.id === 'ophim'
                        ? 'bg-sky-950 text-sky-300 border border-sky-800'
                        : source.id === 'nguonc'
                        ? 'bg-amber-950 text-amber-300 border border-amber-800'
                        : 'bg-blue-900 text-blue-200'
                    }`}
                  >
                    Vietsub
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 line-clamp-1">{source.description}</p>
                {isSelected && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-sky-400" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* Filter Controls Bar (ẩn ở tab thể loại plain) */}
      {!plain && (
      <div className="bg-[#0f172a] border border-blue-900/60 rounded-2xl p-4 sm:p-5 mb-8 space-y-4 shadow-xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {/* Keyword Search */}
          <div data-tv-right="#filter-type-btn">
            <label className="block text-[11px] font-bold text-slate-400 uppercase mb-1.5">
              Từ khóa tìm kiếm:
            </label>
            <div className="relative">
              <input
                id="filter-keyword-input"
                type="text"
                placeholder="Nhập tên phim, diễn viên..."
                value={shownKeyword}
                onChange={(e) => setKeywordVal(e.target.value)}
                onKeyDown={(e) => {
                  // Enter khi đang gõ = Áp dụng luôn, khỏi lia xuống nút.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyFilters();
                    try {
                      (e.target as HTMLInputElement).blur();
                    } catch {}
                  }
                }}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-base sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              {shownKeyword && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setKeywordVal('');
                  }}
                  className="absolute right-3 top-3 text-slate-400 hover:text-white text-sm p-0.5 cursor-pointer"
                  aria-label="Xóa từ khóa"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Type Selector */}
          <div data-tv-left="#filter-keyword-input">
            <label className="block text-[11px] font-bold text-slate-400 uppercase mb-1.5">
              Định dạng phim:
            </label>
            <TvSelect
              id="filter-type-btn"
              label="Định dạng phim"
              value={shownType}
              onChange={setTypeVal}
              options={[
                { value: 'all', label: 'Tất cả định dạng' },
                { value: 'series', label: 'Phim Bộ (Nhiều tập)' },
                { value: 'single', label: 'Phim Lẻ (Chiếu rạp / 1 tập)' },
                { value: 'anime', label: 'Hoạt Hình & Anime' },
                { value: 'tv-shows', label: 'TV Shows / Game Shows' },
              ]}
            />
          </div>

          {/* Genre Selector */}
          <div data-tv-right="#filter-country-btn">
            <label className="block text-[11px] font-bold text-slate-400 uppercase mb-1.5">
              Thể loại:
            </label>
            <TvSelect
              id="filter-genre-btn"
              label="Thể loại"
              value={shownGenre}
              onChange={setGenreVal}
              options={[
                { value: '', label: 'Tất cả thể loại' },
                ...GENRES.map((g) => ({ value: g.slug, label: g.name })),
              ]}
            />
          </div>

          {/* Country Selector */}
          <div data-tv-left="#filter-genre-btn">
            <label className="block text-[11px] font-bold text-slate-400 uppercase mb-1.5">
              Quốc gia:
            </label>
            <TvSelect
              id="filter-country-btn"
              label="Quốc gia"
              value={shownCountry}
              onChange={setCountryVal}
              options={[
                { value: '', label: 'Tất cả quốc gia' },
                ...COUNTRIES.map((c) => ({ value: c.slug, label: c.name })),
              ]}
            />
          </div>
        </div>

        {/* Quick Genre Pills */}
        <div
          id="filter-suggest-row"
          data-tv-down="#filter-apply-btn"
          className="flex items-center gap-1.5 overflow-x-auto pb-1 pt-1 scrollbar-none text-xs"
        >
          <span className="text-slate-400 shrink-0 mr-1 font-medium">Gợi ý:</span>
          {GENRES.slice(0, 8).map((g) => {
            const active = shownGenre === g.slug;
            const pendingChip = active && selectedGenre !== g.slug;
            return (
            <button
              key={g.slug}
              onClick={() => setGenreVal(shownGenre === g.slug ? '' : g.slug)}
              className={`px-3 py-1 rounded-full text-xs shrink-0 transition-colors cursor-pointer ${
                active && !pendingChip
                  ? 'bg-blue-600 text-white font-bold shadow-md shadow-blue-600/30'
                  : pendingChip
                  ? 'bg-blue-900/60 text-sky-200 font-bold border border-dashed border-sky-500/70'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-700'
              }`}
            >
              {g.name}
            </button>
            );
          })}
        </div>
        {/* Chọn xong bấm OK mới lọc (không load từng nấc khi lia D-pad) */}
          <div className="flex items-center gap-3 pt-1">
            <button
              id="filter-apply-btn"
              data-tv-up="#filter-suggest-row button"
              onClick={applyFilters}
              className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-extrabold text-sm transition-all cursor-pointer ${
                isDirty
                  ? 'bg-blue-600 text-white shadow-xl shadow-blue-600/40'
                  : 'bg-slate-800 text-slate-400 border border-slate-700'
              }`}
            >
              <Filter className="w-4 h-4" />
              <span>Áp dụng bộ lọc{isDirty ? ' •' : ''}</span>
            </button>
            {isDirty && (
              <span className="text-xs text-amber-300 font-semibold">
                Có thay đổi chưa áp dụng
              </span>
            )}
          </div>
      </div>
      )}

      {/* Movie Results Grid */}
      {keyword && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 bg-blue-950/40 border border-blue-800/50 rounded-xl px-4 py-3 shadow-inner">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-xs sm:text-sm text-slate-200">
              Kết quả tìm kiếm cho: <strong className="text-sky-300 font-bold">"{keyword}"</strong>
              <span className="text-slate-400 ml-1 text-xs">(Bao gồm tên phim, diễn viên và đạo diễn)</span>
            </span>
          </div>
          <button
            onClick={() => {
              setKeyword('');
              setCurrentPage(1);
            }}
            className="text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700 cursor-pointer transition-colors flex items-center gap-1"
          >
            <span>Xóa từ khóa</span>
            <span className="text-slate-400">✕</span>
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="py-20 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 border-4 border-slate-700 border-t-blue-500 rounded-full animate-spin mb-4" />
          <p className="text-slate-400 text-sm">Đang tải danh sách phim...</p>
        </div>
      ) : error ? (
        <div className="py-16 text-center bg-slate-900/50 rounded-2xl p-8 border border-slate-800">
          <p className="text-red-400 text-sm mb-3">{error}</p>
          <button
            onClick={() => setCurrentPage(1)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-blue-600/30"
          >
            Thử lại
          </button>
        </div>
      ) : movies.length > 0 ? (
        <>
          <div id="filter-results-grid" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5 sm:gap-7 lg:gap-8">
            {movies.map((movie, idx) => (
              <div key={`${movie.slug || movie._id || 'filter'}-${idx}`} className="flex justify-center">
                <MovieCard
                  movie={movie}
                  onPlay={handlePlay}
                  onOpenDetail={handleOpenDetail}
                  onToggleMyList={onToggleMyList}
                  isInMyList={checkIsInMyList(movie.slug)}
                />
              </div>
            ))}
          </div>

          {/* Pagination Controls */}
          <div className="flex items-center justify-center gap-3 mt-12">
            <button
              id="pagination-prev-btn"
              disabled={currentPage <= 1}
              onClick={() => {
                setCurrentPage((p) => Math.max(1, p - 1));
                window.scrollTo(0, 0);
              }}
              className="flex items-center gap-1 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none text-xs font-semibold text-white border border-slate-700 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Trang trước</span>
            </button>

            <span className="text-xs text-slate-300 font-medium px-3.5 py-2 bg-[#0f172a] border border-blue-900/60 rounded-xl shadow">
              Trang <span className="text-cyan-400 font-bold">{currentPage}</span>
              {pagination?.totalPages ? ` / ${pagination.totalPages}` : ''}
            </span>

            <button
              id="pagination-next-btn"
              onClick={() => {
                setCurrentPage((p) => p + 1);
                window.scrollTo(0, 0);
              }}
              className="flex items-center gap-1 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white border border-slate-700 cursor-pointer"
            >
              <span>Trang kế tiếp</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      ) : (
        <div className="py-20 text-center bg-slate-900/40 rounded-2xl border border-slate-800 p-8">
          <p className="text-slate-300 text-base font-semibold mb-2">
            Không tìm thấy phim phù hợp với tiêu chí lọc
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Hãy thử tìm bằng từ khóa khác hoặc xóa bớt tiêu chí lọc.
          </p>
          <button
            onClick={handleResetFilters}
            className="px-5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-blue-600/30 cursor-pointer"
          >
            Xem tất cả phim mới
          </button>
        </div>
      )}
    </div>
  );
};
