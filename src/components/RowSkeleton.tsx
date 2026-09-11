import React from 'react';

/** Khung giữ chỗ cho hàng phim chưa load xong (chống layout shift làm trượt focus TV). */
export const RowSkeleton: React.FC<{ title: string; tall?: boolean; count?: number }> = ({
  title,
  tall = false,
  count = 6,
}) => {
  return (
    <div aria-hidden className="relative my-6 sm:my-8 px-4 sm:px-6 lg:px-8 select-none">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-white tracking-tight flex items-center gap-2">
          <span>{title}</span>
        </h2>
      </div>
      <div className="relative -mx-2 px-2">
        <div
          className={`flex w-full overflow-hidden py-4 ${tall ? 'h-[300px] sm:h-[360px]' : 'h-[250px] sm:h-[330px] md:h-[360px]'}`}
          style={{ gap: '24px' }}
        >
          {Array.from({ length: count }).map((_, i) => (
            <div
              key={i}
              className={`flex-shrink-0 rounded-xl bg-[#0f172a] border border-slate-800/60 ${tall ? 'w-44 sm:w-56' : 'w-36 sm:w-48 md:w-52'}`}
            >
              <div className="w-full aspect-[2/3] rounded-xl bg-slate-800/60" />
              <div className="p-2.5 space-y-1.5">
                <div className="h-3 rounded bg-slate-800/80 w-3/4" />
                <div className="h-2.5 rounded bg-slate-800/50 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
