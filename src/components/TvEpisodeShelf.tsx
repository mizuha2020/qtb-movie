import React from 'react';
import { Play, ChevronRight } from 'lucide-react';
import { getImageUrl } from '../services/movieApi';
import type { MovieEpisode } from '../types';

interface Props {
  episodes: Array<MovieEpisode & { isSoon?: boolean }>;

  posterThumb: string;
  source?: string;
  onSelect: (ep: MovieEpisode & { isSoon?: boolean }) => void;
}


export const TvEpisodeShelf: React.FC<Props> = ({ episodes, posterThumb, source, onSelect }) => {
  if (!episodes || episodes.length === 0) return null;
  const firstReal = episodes.find((e) => !(e as any).isSoon) || episodes[0];
  return (
    <section id="detail-episodes-tv" className="px-14 pt-5 pb-12 bg-[#060a14]">
      <div className="flex items-center justify-between mb-4 max-w-[1500px]">
        <h2 className="flex items-center gap-2.5 text-xl font-extrabold text-white">
          <span className="w-8 h-8 rounded-full border-2 border-sky-500/70 flex items-center justify-center">
            <Play className="w-3.5 h-3.5 text-sky-400 fill-sky-400" />
          </span>
          Danh Sách Tập Phim
        </h2>
        <ChevronRight className="w-6 h-6 text-slate-500" />
      </div>
      <div className="flex gap-4 overflow-x-auto pb-3 max-w-[1500px]">
        {episodes.map((ep) => {
          const num = (ep.name || '').replace(/\D/g, '').padStart(2, '0') || ep.name;
          const isFirst = firstReal && ep.slug === firstReal.slug;
          return (
            <button
              key={ep.slug}
              data-tv-ep={ep.slug}
              {...(isFirst ? { 'data-tv-ep-first': 'true' } : {})}
              onClick={() => onSelect(ep)}
              className="relative shrink-0 w-[168px] aspect-[16/10] rounded-xl overflow-hidden text-left border-2 border-white/10 hover:border-sky-400/60 focus-visible:border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400/60"
            >
              <img src={posterThumb ? getImageUrl(posterThumb, source) : ''} alt={ep.name} className="absolute inset-0 w-full h-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
              <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/10" />
              <span className="absolute left-2.5 bottom-7 text-lg font-black text-white drop-shadow">{num}</span>
              <span className="absolute left-2.5 bottom-2 flex items-center gap-1 text-[10px] font-semibold text-slate-200">
                <Play className="w-3 h-3 text-sky-400 fill-sky-400" />Phát HD
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
