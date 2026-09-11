// Client-side M3U8 ad-cleaner (same rules as server.ts /api/proxy/m3u8).
// Runs in the browser so it uses the client's VN IP (works) instead of the
// cloud server IP (blocked -> 502/404). Upstream sends CORS *, so fetch works.
//
// Rule cứng bên dưới là fallback offline. Rule động do admin cấu hình trên
// RTDB `system_cache/adblock` (qua adblockService) được check thêm —
// upstream đổi pattern chỉ cần sửa trên admin, không build lại app.
//
// NGUYÊN TẮC CHỐNG CẮT NHẦM PHIM (fix Hồ Tâm tập 12 mất đoạn phút thứ 3):
// - Upstream (phim1280) tách cả PHIM CÓ QC CHỮ burned-in thành cụm segment riêng
//   (convertv7/<hash>.ts) bọc DISCONTINUITY — cắt theo URL là mất luôn 20s phim.
// - Đã verify bằng frame thật: cụm convertv7 @2:59 là cảnh phim (giữ),
//   cụm /v7/<hash>/segment_NNNN.ts @14:59 là video QC cờ bạc (cắt).
// - Vì vậy sau bước flag theo URL còn bước kiểm tra "ngoại lai" (foreign):
//   chỉ cắt cụm flagged khi khác cây thư mục nội dung, hoặc tên kiểu
//   segment_NNNN nối tiếp, hoặc có đổi EXT-X-KEY/MAP ở biên (asset chèn ngoài).
// - Pattern yếu (promo/banner/..., rule RTDB) vẫn cần thêm kề discontinuity.
// - Safety cap: cắt quá 35% hoặc >20 segment liên tiếp -> giữ nguyên playlist.
import { adblockService } from '../services/adblockService';

/** Pattern mạnh: gần như chắc chắn là QC, được cắt thẳng không cần discontinuity. */
const STRONG_PATTERNS = [
  'quangcao',
  'quang-cao',
  'preroll',
  'midroll',
  'adservice',
  'doubleclick',
  'convertv',
  '/convert',
  'advert',
];

/** Pattern yếu: chỉ cắt khi kề #EXT-X-DISCONTINUITY (kẻo cắt nhầm nội dung). */
const WEAK_PATTERNS = [
  '/ads/',
  '/ad/',
  '_ad_',
  '-ad-',
  '.ad.',
  '/promo',
  '_promo',
  '-promo',
  '/banner',
  '_banner',
  '-banner',
  '/intro/',
  '_intro',
  '-intro',
];

/**
 * Path versioned kiểu SSAI (/v7/<hash>/, /v8/...) từng là pattern QC thật
 * (convertv7 + /v7/<hash>/segment_*.ts) — nhưng CDN thường cũng dùng path
 * versioned cho nội dung thật, nên CHỈ coi là QC khi kề discontinuity.
 */
const WEAK_REGEXES = [/\/v\d+\//i];

function matchesStrong(uri: string): boolean {
  const l = (uri || '').toLowerCase();
  if (!l) return false;
  for (const k of STRONG_PATTERNS) {
    if (k && l.includes(k)) return true;
  }
  return false;
}

function matchesWeak(uri: string): boolean {
  const l = (uri || '').toLowerCase();
  if (!l) return false;
  for (const k of WEAK_PATTERNS) {
    if (k && l.includes(k)) return true;
  }
  for (const re of WEAK_REGEXES) {
    try {
      if (re.test(l)) return true;
    } catch { /* skip */ }
  }
  // Rule động từ RTDB do admin thêm -> coi là yếu (cần discontinuity đi kèm)
  try {
    if (adblockService.matches(l)) return true;
  } catch {
    // ignore
  }
  return false;
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/** Thư mục chứa segment (origin + path trừ file cuối) — dùng so cây nội dung. */
function dirOf(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    const p = u.pathname;
    const cut = p.lastIndexOf('/');
    return `${u.origin}${cut > 0 ? p.slice(0, cut) : ''}`.toLowerCase();
  } catch {
    const s = absoluteUrl.toLowerCase();
    const cut = s.lastIndexOf('/');
    return cut > 0 ? s.slice(0, cut) : s;
  }
}

function fileOf(absoluteUrl: string): string {
  try {
    return new URL(absoluteUrl).pathname.split('/').pop() || '';
  } catch {
    const s = absoluteUrl.split('?')[0];
    return s.slice(s.lastIndexOf('/') + 1);
  }
}

/** Tên kiểu asset chèn ngoài: segment_0001.ts nối tiếp (khác hẳn hash ngẫu nhiên của nội dung). */
function isSequentialAdName(file: string): boolean {
  return /segment[_-]?\d+\./i.test(file || '');
}

export function cleanMediaPlaylist(content: string, baseUrl: string): { cleaned: string; removed: number } {
  const lines = content.split(/\r?\n/);
  // Pre-pass: xác định vị trí segment + cờ discontinuity trước/sau mỗi segment
  const segIdx: number[] = []; // line index của từng segment URI
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    segIdx.push(i);
  }
  if (segIdx.length === 0) return { cleaned: content, removed: 0 };

  const discBefore = new Array<boolean>(segIdx.length).fill(false);
  const discAfter = new Array<boolean>(segIdx.length).fill(false);
  const keyBefore = new Array<boolean>(segIdx.length).fill(false);
  const keyAfter = new Array<boolean>(segIdx.length).fill(false);
  const absUrls: string[] = new Array(segIdx.length);
  for (let s = 0; s < segIdx.length; s++) {
    const uri = lines[segIdx[s]].trim();
    absUrls[s] = uri.startsWith('http') ? uri : resolveUrl(baseUrl, uri);
  }
  for (let s = 0; s < segIdx.length; s++) {
    // discontinuity / KEY-MAP ngay trước segment (bỏ qua EXTINF ở giữa)
    if (s > 0) {
      for (let j = segIdx[s] - 1; j > segIdx[s - 1]; j--) {
        const t = lines[j].trim();
        if (t.startsWith('#EXT-X-DISCONTINUITY')) discBefore[s] = true;
        else if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) keyBefore[s] = true;
      }
    }
    // discontinuity / KEY-MAP ngay sau segment
    const end = s + 1 < segIdx.length ? segIdx[s + 1] : lines.length;
    for (let j = segIdx[s] + 1; j < end; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith('#EXT-X-DISCONTINUITY')) { discAfter[s] = true; continue; }
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) { keyAfter[s] = true; continue; }
      break;
    }
  }

  // Flag theo URL rồi lan theo span (cụm segment liền mạch không bị
  // DISCONTINUITY cắt ngang): SSAI chèn cả cụm ad giữa 2 disc, chỉ segment
  // biên chạm disc — không lan thì lọt 9/11 segment như block2 Hồ Tâm.
  // Span bị flag khi: có segment match mạnh, hoặc span bị bọc disc + có segment match yếu.
  const segStrong = new Array<boolean>(segIdx.length).fill(false);
  const segWeak = new Array<boolean>(segIdx.length).fill(false);
  for (let s = 0; s < segIdx.length; s++) {
    const uri = lines[segIdx[s]].trim();
    const absolute = absUrls[s];
    if (matchesStrong(absolute) || matchesStrong(uri)) { segStrong[s] = true; continue; }
    if (matchesWeak(absolute) || matchesWeak(uri)) segWeak[s] = true;
  }
  // Cắt span tại mọi biên có discontinuity
  const spanId = new Array<number>(segIdx.length).fill(0);
  {
    let cur = 0;
    for (let s = 0; s < segIdx.length; s++) {
      if (s > 0 && (discAfter[s - 1] || discBefore[s])) cur++;
      spanId[s] = cur;
    }
  }
  const spanCount = segIdx.length > 0 ? spanId[segIdx.length - 1] + 1 : 0;
  const spanFirst = new Array<number>(spanCount).fill(-1);
  const spanLast = new Array<number>(spanCount).fill(-1);
  for (let s = 0; s < segIdx.length; s++) {
    if (spanFirst[spanId[s]] === -1) spanFirst[spanId[s]] = s;
    spanLast[spanId[s]] = s;
  }
  const flagged = new Array<boolean>(segIdx.length).fill(false);
  for (let p = 0; p < spanCount; p++) {
    const a = spanFirst[p];
    const b = spanLast[p];
    let strong = false;
    let weak = false;
    for (let k = a; k <= b; k++) {
      if (segStrong[k]) { strong = true; break; }
      if (segWeak[k]) weak = true;
    }
    if (!strong && !weak) continue;
    const bracketed = discBefore[a] || discAfter[b];
    // Mạnh: flag luôn (quyết định cắt vẫn qua kiểm tra ngoại lai bên dưới).
    // Yếu: chỉ flag khi span bị bọc discontinuity (kẻo cắt nhầm nội dung,
    // vd QC chữ burned-in nằm liền mạch trong phim).
    if (strong || bracketed) {
      for (let k = a; k <= b; k++) flagged[k] = true;
    }
  }

  // Cây thư mục nội dung = dir phổ biến nhất của các segment KHÔNG flagged.
  // Cụm flagged cùng cây + cùng kiểu tên hash + không đổi KEY -> phim chèn overlay -> GIỮ.
  const dirCount = new Map<string, number>();
  for (let s = 0; s < segIdx.length; s++) {
    if (flagged[s]) continue;
    const d = dirOf(absUrls[s]);
    dirCount.set(d, (dirCount.get(d) || 0) + 1);
  }
  let contentRoot = '';
  let contentVotes = 0;
  for (const [d, n] of dirCount) {
    if (n > contentVotes) { contentVotes = n; contentRoot = d; }
  }
  const inSameTree = (absolute: string): boolean => {
    if (!contentRoot) return false;
    const d = dirOf(absolute);
    return d === contentRoot || d.startsWith(contentRoot + '/');
  };

  // Quyết định giữ/cắt theo từng cụm flagged liên tiếp
  const drop = new Array<boolean>(segIdx.length).fill(false);
  const segPos = new Map<number, number>();
  segIdx.forEach((lineIdx, s) => segPos.set(lineIdx, s));
  for (let s = 0; s < segIdx.length;) {
    if (!flagged[s]) { s++; continue; }
    let e = s;
    while (e + 1 < segIdx.length && flagged[e + 1]) e++;
    // Cụm flagged [s..e]: cắt chỉ khi có tín hiệu "ngoại lai"
    let sameTree = true;
    let seqName = false;
    for (let k = s; k <= e; k++) {
      if (!inSameTree(absUrls[k])) sameTree = false;
      if (isSequentialAdName(fileOf(absUrls[k]))) seqName = true;
    }
    let keyChange = keyBefore[s] || keyAfter[e];
    for (let k = s; k <= e && !keyChange; k++) {
      if (keyBefore[k] || keyAfter[k]) keyChange = true;
    }
    const foreign = !sameTree || seqName || keyChange;
    if (foreign) {
      for (let k = s; k <= e; k++) drop[k] = true;
    } else {
      try {
        console.log(`[m3u8-clean] keep ${e - s + 1} flagged-in-tree segment(s) (possible overlay film) at #${s} from ${baseUrl}`);
      } catch { /* ignore */ }
    }
    s = e + 1;
  }

  const removed = drop.filter(Boolean).length;
  if (removed === 0) return { cleaned: content, removed: 0 };

  // Safety cap: cắt quá nhiều hoặc 1 mạch dài -> nhận diện sai, giữ nguyên
  let longestRun = 0;
  let run = 0;
  for (const d of drop) {
    if (d) { run++; longestRun = Math.max(longestRun, run); }
    else run = 0;
  }
  if (removed / segIdx.length > 0.35 || longestRun > 20) {
    try {
      console.warn(`[m3u8-clean] abort: would remove ${removed}/${segIdx.length} (run ${longestRun}) from ${baseUrl} — keep original`);
    } catch { /* ignore */ }
    return { cleaned: content, removed: 0 };
  }

  // Rebuild: giữ nguyên thứ tự tag gốc, chỉ bỏ segment bị cắt (+ EXTINF + discontinuity lẻ của nó)
  const out: string[] = [];
  let pendingExtInf: string | null = null;
  let pendingDiscontinuity = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }
    if (trimmed.startsWith('#EXTINF')) {
      pendingExtInf = line;
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (pendingExtInf) { out.push(pendingExtInf); pendingExtInf = null; }
      if (pendingDiscontinuity) { out.push('#EXT-X-DISCONTINUITY'); pendingDiscontinuity = false; }
      out.push(line);
      continue;
    }
    const s = segPos.get(i);
    if (s !== undefined && drop[s]) {
      pendingExtInf = null;
      pendingDiscontinuity = false;
      continue;
    }
    if (pendingExtInf) { out.push(pendingExtInf); pendingExtInf = null; }
    if (pendingDiscontinuity) { out.push('#EXT-X-DISCONTINUITY'); pendingDiscontinuity = false; }
    const absolute = trimmed.startsWith('http') ? trimmed : resolveUrl(baseUrl, trimmed);
    out.push(absolute);
  }
  try {
    console.log(`[m3u8-clean] removed ${removed}/${segIdx.length} ad segments from ${baseUrl}`);
  } catch { /* ignore */ }
  return { cleaned: out.join('\n'), removed };
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { Accept: '*/*' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch m3u8 from client IP, strip ad segments, return a blob: URL.
 * Returns null if fetch/clean fails or nothing was removed (caller falls back to direct/proxy).
 */
export interface CleanedM3u8 {
  blobUrl: string;
  removed: number;
  /** variant blob URLs khi master multivariant – caller revoke chung với blobUrl */
  extraBlobs?: string[];
}

/**
 * Cache TEXT bản clean theo URL gốc (TTL 30 phút, tối đa 20 entries).
 * Blob URL không giữ qua lần mở (caller revoke khi unmount), nhưng text thì
 * dựng blob mới tức thì -> lần sau (đổi tập rồi quay lại, preview...) phát
 * bản sạch NGAY, không fetch+clean lại. Không swap giữa playback.
 */
interface CleanTextCache {
  time: number;
  removed: number;
  /** media playlist đơn: text đã clean */
  mediaText?: string;
  /** master: template với marker __VARIANT_<idx>__ + text từng variant */
  masterTemplate?: string[];
  variantTexts?: string[];
}
const CLEAN_TEXT_TTL = 30 * 60 * 1000;
const cleanTextCache = new Map<string, CleanTextCache>();

function makeBlob(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
}

/** Dựng CleanedM3u8 từ cache (đồng bộ, không mạng). Null nếu chưa có/hết hạn. */
export function getCachedCleaned(rawUrl: string): CleanedM3u8 | null {
  try {
    const e = cleanTextCache.get(rawUrl);
    if (!e) return null;
    if (Date.now() - e.time > CLEAN_TEXT_TTL) {
      cleanTextCache.delete(rawUrl);
      return null;
    }
    if (e.mediaText) {
      return { blobUrl: makeBlob(e.mediaText), removed: e.removed };
    }
    if (e.masterTemplate && e.variantTexts) {
      const lines = [...e.masterTemplate];
      const extraBlobs: string[] = [];
      e.variantTexts.forEach((t, i) => {
        const url = makeBlob(t);
        extraBlobs.push(url);
        for (let li = 0; li < lines.length; li++) {
          if (lines[li] === `__VARIANT_${i}__`) lines[li] = url;
        }
      });
      return { blobUrl: makeBlob(lines.join('\n')), removed: e.removed, extraBlobs };
    }
  } catch {}
  return null;
}

function storeCleanCache(rawUrl: string, entry: CleanTextCache): void {
  try {
    if (cleanTextCache.size >= 20) {
      const oldest = cleanTextCache.keys().next().value;
      if (oldest !== undefined) cleanTextCache.delete(oldest);
    }
    cleanTextCache.set(rawUrl, { ...entry, time: Date.now() });
  } catch {}
}
export async function loadCleanedM3u8Url(rawUrl: string): Promise<CleanedM3u8 | null> {
  if (!rawUrl || !rawUrl.startsWith('http')) return null;
  // Cache hit -> dựng blob tức thì, không fetch
  try {
    const hit = getCachedCleaned(rawUrl);
    if (hit) return hit;
  } catch {}
  // Refresh rule chặn QC nền (không await để không chậm phát video)
  try {
    adblockService.refresh().catch(() => {});
  } catch {
    // ignore
  }
  try {
    const content = await fetchText(rawUrl);
    if (content.includes('#EXT-X-STREAM-INF')) {
      // Master multivariant: GIỮ NGUYÊN cấu trúc để player ABR + tua mượt
      // (gộp về 1 variant max-bitrate như trước khiến seek phải tải segment nặng -> lag).
      // Clean từng variant rồi trỏ master sang blob tương ứng.
      const lines = content.split(/\r?\n/);
      const variantUris: { lineIdx: number; uri: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const next = (lines[i + 1] || '').trim();
          if (next && !next.startsWith('#')) {
            variantUris.push({ lineIdx: i + 1, uri: next.startsWith('http') ? next : resolveUrl(rawUrl, next) });
          }
        }
      }
      if (variantUris.length === 0) return null;
      const cleanedVariants = await Promise.all(
        variantUris.slice(0, 8).map(async (v) => {
          try {
            const media = await fetchText(v.uri);
            if (!media.includes('#EXTM3U')) return null;
            const { cleaned, removed } = cleanMediaPlaylist(media, v.uri);
            if (!cleaned.includes('#EXTM3U')) return null;
            const blob = new Blob([cleaned], { type: 'application/vnd.apple.mpegurl' });
            return { lineIdx: v.lineIdx, url: URL.createObjectURL(blob), removed, text: cleaned };
          } catch {
            return null;
          }
        })
      );
      const ok = cleanedVariants.filter(Boolean) as { lineIdx: number; url: string; removed: number; text: string }[];
      if (ok.length === 0) return null;
      const extraBlobs: string[] = [];
      let removed = 0;
      for (const c of ok) {
        lines[c.lineIdx] = c.url;
        extraBlobs.push(c.url);
        removed += c.removed;
      }
      // Variant nào clean fail thì giữ URI gốc (absolute) để player vẫn đủ level
      for (const v of variantUris) {
        if (!ok.some((c) => c.lineIdx === v.lineIdx)) lines[v.lineIdx] = v.uri;
      }
      // Không cắt gì ở variant nào -> dùng master gốc, khỏi tạo blob
      if (removed === 0) {
        for (const u of extraBlobs) revokeBlobUrl(u);
        return null;
      }
      // Lưu cache text để lần sau dựng blob tức thì (marker thay variant blob)
      const template = [...lines];
      const variantTexts: string[] = [];
      ok.forEach((c, i) => {
        template[c.lineIdx] = `__VARIANT_${i}__`;
        variantTexts.push(c.text);
      });
      storeCleanCache(rawUrl, { time: 0, removed, masterTemplate: template, variantTexts });
      const master = new Blob([lines.join('\n')], { type: 'application/vnd.apple.mpegurl' });
      return { blobUrl: URL.createObjectURL(master), removed, extraBlobs };
    }
    if (content.includes('#EXTM3U')) {
      const { cleaned, removed } = cleanMediaPlaylist(content, rawUrl);
      // Không cắt gì -> trả null để player dùng URL gốc (tránh blob gây lệch seek/preview)
      if (removed === 0) return null;
      storeCleanCache(rawUrl, { time: 0, removed, mediaText: cleaned });
      const blob = new Blob([cleaned], { type: 'application/vnd.apple.mpegurl' });
      return { blobUrl: URL.createObjectURL(blob), removed };
    }
    return null;
  } catch {
    return null;
  }
}

export function revokeBlobUrl(url: string | string[] | null | undefined) {
  try {
    const list = Array.isArray(url) ? url : [url];
    for (const u of list) {
      if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
    }
  } catch { /* ignore */ }
}
