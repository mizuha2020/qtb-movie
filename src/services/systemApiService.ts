import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from 'firebase/firestore';
import { db, handleFirestoreError, isFirestoreQuotaExhausted, OperationType, sanitizeData } from './firebase';
import { SystemApiEndpoint, ApiCategory, ApiHealthStatus } from '../types';
import { getFullApiUrl } from './apiConfig';

export const DEFAULT_SYSTEM_APIS: SystemApiEndpoint[] = [
  // 1. Movie APIs
  {
    id: 'kkphim',
    name: 'KKPhim Movie API',
    category: 'movie',
    baseUrl: 'https://phimapi.com',
    testUrl: 'https://phimapi.com/danh-sach/phim-moi-cap-nhat?page=1',
    description: 'API kho phim Vietsub, phim bộ, phim lẻ chất lượng cao với luồng M3U8 siêu tốc.',
    enabled: true,
    isDefault: true,
    priority: 1,
    lastStatus: 'live',
    lastLatencyMs: 180,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'ophim',
    name: 'OPhim VIP API',
    category: 'movie',
    baseUrl: 'https://ophim1.com',
    testUrl: 'https://ophim1.com/danh-sach/phim-moi-cap-nhat?page=1',
    description: 'Nguồn phim điện ảnh & truyền hình phong phú, hỗ trợ nhiều server mirror dự phòng.',
    enabled: true,
    isDefault: true,
    priority: 2,
    lastStatus: 'live',
    lastLatencyMs: 260,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'nguonc',
    name: 'NguonC Streaming API',
    category: 'movie',
    baseUrl: 'https://phim.nguonc.com',
    testUrl: 'https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1',
    description: 'Nguồn phim độc lập, streaming tốc độ cao, đa dạng thể loại anime và TV shows.',
    enabled: true,
    isDefault: true,
    priority: 3,
    lastStatus: 'live',
    lastLatencyMs: 340,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },

  // 2. Manga APIs
  {
    id: 'truyenqq',
    name: 'TruyenQQ Manga',
    category: 'manga',
    baseUrl: 'https://truyenqqko.com',
    testUrl: 'https://truyenqqko.com/truyen-moi-cap-nhat',
    description: 'Kho truyện tranh cập nhật chương mới phong phú và tốc độ cao.',
    enabled: true,
    isDefault: true,
    priority: 1,
    lastStatus: 'live',
    lastLatencyMs: 180,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'otruyen',
    name: 'OTruyen Manga API',
    category: 'manga',
    baseUrl: 'https://otruyenapi.com/v1/api',
    testUrl: 'https://otruyenapi.com/v1/api/home',
    description: 'Kho truyện tranh tiếng Việt cập nhật liên tục từ các nhóm dịch hàng đầu.',
    enabled: true,
    isDefault: true,
    priority: 2,
    lastStatus: 'live',
    lastLatencyMs: 420,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'mangadex',
    name: 'MangaDex Global API',
    category: 'manga',
    baseUrl: 'https://api.mangadex.org',
    testUrl: 'https://api.mangadex.org/ping',
    description: 'Nguồn truyện tranh quốc tế đa ngôn ngữ, lưu trữ đồ sộ và ổn định toàn cầu.',
    enabled: true,
    isDefault: true,
    priority: 3,
    lastStatus: 'live',
    lastLatencyMs: 380,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'cuutruyen',
    name: 'Cứu Truyện API',
    category: 'manga',
    baseUrl: 'https://api.cuutruyen.net/v1',
    testUrl: 'https://api.cuutruyen.net/v1/mangas?page=1',
    description: 'Thư viện truyện scan bản dịch chọn lọc chất lượng cao và giao diện đọc mượt mà.',
    enabled: true,
    isDefault: true,
    priority: 4,
    lastStatus: 'live',
    lastLatencyMs: 290,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },

  // 3. LiveTV / IPTV APIs
  {
    id: 'iptv_tinhlagi',
    name: 'TinhLaGi TV Playlist',
    category: 'livetv',
    baseUrl: 'https://bit.ly/tinhlagitivi',
    testUrl: 'https://bit.ly/tinhlagitivi',
    description: 'Danh sách luồng truyền hình trực tuyến VTV, HTV, Thể thao và Giải trí hàng đầu.',
    enabled: true,
    isDefault: true,
    priority: 1,
    lastStatus: 'live',
    lastLatencyMs: 210,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
  {
    id: 'iptv_vn',
    name: 'IPTV-Org Vietnam',
    category: 'livetv',
    baseUrl: 'https://iptv-org.github.io/iptv/countries/vn.m3u',
    testUrl: 'https://iptv-org.github.io/iptv/countries/vn.m3u',
    description: 'Danh sách kênh truyền hình mở quốc tế và nội địa Việt Nam.',
    enabled: true,
    isDefault: true,
    priority: 2,
    lastStatus: 'live',
    lastLatencyMs: 195,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },

  // 4. Utility APIs
  {
    id: 'server_proxy',
    name: 'Gấu Cinema Proxy & Health',
    category: 'utility',
    baseUrl: '/api/proxy/generic',
    testUrl: '/api/health',
    description: 'Máy chủ proxy đệm cache dữ liệu, tối ưu hóa tốc độ và xử lý CORS toàn hệ thống.',
    enabled: true,
    isDefault: true,
    priority: 1,
    lastStatus: 'live',
    lastLatencyMs: 45,
    lastStatusCode: 200,
    lastChecked: Date.now(),
  },
];

const LOCAL_STORAGE_KEY = 'qtb_system_apis_cache_v3';

class SystemApiService {
  private inMemoryApis: SystemApiEndpoint[] = [];
  private isInitialized = false;
  private realtimeUnsub: (() => void) | null = null;
  private lastEnabledKey = '';
  private enabledListeners = new Set<() => void>();

  constructor() {
    this.loadFromLocalStorage();
  }

  private loadFromLocalStorage(): void {
    try {
      const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const existingIds = new Set(parsed.map((a: any) => a.id));
          const merged = [...parsed];
          let hasNew = false;
          for (const def of DEFAULT_SYSTEM_APIS) {
            if (!existingIds.has(def.id)) {
              merged.push(def);
              hasNew = true;
            }
          }
          merged.sort((a, b) => (a.priority || 99) - (b.priority || 99));
          this.inMemoryApis = merged;
          if (hasNew) {
            this.saveToLocalStorage(merged);
          }
          return;
        }
      }
    } catch {}
    this.inMemoryApis = [...DEFAULT_SYSTEM_APIS];
  }

  private saveToLocalStorage(apis: SystemApiEndpoint[]): void {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(apis));
      this.inMemoryApis = apis;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('qtb_system_apis_changed', { detail: apis }));
      }
    } catch (e) {
      void 0;
    }
  }

  /**
   * Get all managed APIs from Firestore (with automatic seeding and local cache fallback)
   */
  async getAllApis(): Promise<SystemApiEndpoint[]> {
    try {
      if (isFirestoreQuotaExhausted()) {
        this.loadFromLocalStorage();
        return this.inMemoryApis.length > 0 ? this.inMemoryApis : DEFAULT_SYSTEM_APIS;
      }

      const colRef = collection(db, 'system_apis');
      const snap = await getDocs(colRef);

      if (!snap.empty) {
        const list = snap.docs.map((d) => d.data() as SystemApiEndpoint);
        
        // Auto-merge any newly added system defaults (like truyenqq) into Firestore if missing
        const existingIds = new Set(list.map((a) => a.id));
        let hasNewDefault = false;
        for (const defaultApi of DEFAULT_SYSTEM_APIS) {
          if (!existingIds.has(defaultApi.id)) {
            list.push(defaultApi);
            hasNewDefault = true;
            const docRef = doc(db, 'system_apis', defaultApi.id);
            setDoc(docRef, sanitizeData(defaultApi)).catch(() => {});
          }
        }

        list.sort((a, b) => (a.priority || 99) - (b.priority || 99));
        this.saveToLocalStorage(list);
        this.isInitialized = true;
        return list;
      }

      // If empty, seed initial defaults to Firestore
      void 0;
      for (const api of DEFAULT_SYSTEM_APIS) {
        const docRef = doc(db, 'system_apis', api.id);
        await setDoc(docRef, sanitizeData(api)).catch(() => {});
      }

      this.saveToLocalStorage(DEFAULT_SYSTEM_APIS);
      this.isInitialized = true;
      return DEFAULT_SYSTEM_APIS;
    } catch (err) {
      void 0;
      this.loadFromLocalStorage();
      return this.inMemoryApis.length > 0 ? this.inMemoryApis : DEFAULT_SYSTEM_APIS;
    }
  }

  /**
   * Add a new API endpoint (applied to entire system)
   */
  async addApi(
    apiData: Omit<SystemApiEndpoint, 'lastChecked' | 'lastLatencyMs' | 'lastStatusCode' | 'lastStatus'>
  ): Promise<SystemApiEndpoint> {
    const id = apiData.id?.trim()
      ? apiData.id.toLowerCase().replace(/[^a-z0-9_]/g, '_')
      : `api_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Initial test ping
    const testResult = await this.testEndpoint(apiData.testUrl || apiData.baseUrl);

    const fullApi: SystemApiEndpoint = {
      ...apiData,
      id,
      baseUrl: apiData.baseUrl.trim(),
      testUrl: (apiData.testUrl || apiData.baseUrl).trim(),
      enabled: apiData.enabled ?? true,
      priority: Number(apiData.priority) || 5,
      lastStatus: testResult.status,
      lastLatencyMs: testResult.latencyMs,
      lastStatusCode: testResult.statusCode,
      lastErrorMessage: testResult.message,
      lastChecked: Date.now(),
      updatedAt: Date.now(),
    };

    try {
      const docRef = doc(db, 'system_apis', id);
      await setDoc(docRef, sanitizeData(fullApi));

      const current = await this.getAllApis();
      const updated = [...current.filter((a) => a.id !== id), fullApi];
      this.saveToLocalStorage(updated);
      return fullApi;
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, `system_apis/${id}`);
      throw e;
    }
  }

  /**
   * Update an existing API endpoint
   */
  async updateApi(api: SystemApiEndpoint, updatedBy?: string): Promise<SystemApiEndpoint> {
    const fullApi: SystemApiEndpoint = {
      ...api,
      baseUrl: api.baseUrl.trim(),
      testUrl: (api.testUrl || api.baseUrl).trim(),
      priority: Number(api.priority) || 5,
      updatedAt: Date.now(),
      updatedBy: updatedBy || 'admin',
    };

    try {
      const docRef = doc(db, 'system_apis', api.id);
      await setDoc(docRef, sanitizeData(fullApi), { merge: true });

      const current = await this.getAllApis();
      const updated = current.map((a) => (a.id === api.id ? fullApi : a));
      this.saveToLocalStorage(updated);
      return fullApi;
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `system_apis/${api.id}`);
      throw e;
    }
  }

  /**
   * Delete an API endpoint
   */
  async deleteApi(apiId: string): Promise<void> {
    try {
      const docRef = doc(db, 'system_apis', apiId);
      await deleteDoc(docRef);

      const current = await this.getAllApis();
      const updated = current.filter((a) => a.id !== apiId);
      this.saveToLocalStorage(updated);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `system_apis/${apiId}`);
      throw e;
    }
  }

  /**
   * Toggle enabled status of an API
   */
  async toggleApiStatus(apiId: string, enabled: boolean): Promise<void> {
    try {
      const docRef = doc(db, 'system_apis', apiId);
      await updateDoc(docRef, { enabled, updatedAt: Date.now() });

      const current = await this.getAllApis();
      const updated = current.map((a) => (a.id === apiId ? { ...a, enabled } : a));
      this.saveToLocalStorage(updated);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `system_apis/${apiId}`);
      throw e;
    }
  }

  /**
   * Helper to derive the best test URL for a given API endpoint
   */
  getSmartTestUrl(api: { baseUrl: string; testUrl?: string; category?: string }): string {
    const baseUrl = (api.baseUrl || '').trim().replace(/\/+$/, '');
    const customTestUrl = (api.testUrl || '').trim();

    // If custom test URL is provided and differs from bare root, use it
    if (customTestUrl && customTestUrl !== baseUrl) {
      return customTestUrl;
    }

    if (baseUrl.includes('phimapi.com')) {
      return 'https://phimapi.com/danh-sach/phim-moi-cap-nhat?page=1';
    }
    if (baseUrl.includes('ophim')) {
      return `${baseUrl}/danh-sach/phim-moi-cap-nhat?page=1`;
    }
    if (baseUrl.includes('nguonc.com')) {
      return `${baseUrl}/api/films/phim-moi-cap-nhat?page=1`;
    }
    if (baseUrl.includes('otruyen')) {
      return baseUrl.endsWith('/v1/api') ? `${baseUrl}/home` : `${baseUrl}/v1/api/home`;
    }
    if (baseUrl.includes('truyenqq')) {
      return 'https://truyenqqko.com/truyen-moi-cap-nhat';
    }
    if (baseUrl.includes('mangadex.org')) {
      return 'https://api.mangadex.org/ping';
    }
    if (baseUrl.includes('cuutruyen.net')) {
      return `${baseUrl}/mangas?page=1`;
    }
    if (baseUrl.startsWith('/') || baseUrl.includes('localhost')) {
      return '/api/health';
    }

    return customTestUrl || baseUrl;
  }

  /**
   * Test an endpoint and measure latency accurately
   */
  async testEndpoint(url: string): Promise<{
    ok: boolean;
    status: ApiHealthStatus;
    statusCode: number;
    latencyMs: number;
    message: string;
  }> {
    if (!url) {
      return { ok: false, status: 'down', statusCode: 400, latencyMs: 0, message: 'URL trống' };
    }

    const smartUrl = this.getSmartTestUrl({ baseUrl: url, testUrl: url });

    // Use backend ping endpoint to bypass browser CORS and measure network timing
    try {
      const res = await fetch(getFullApiUrl('/api/system/apis/ping'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: smartUrl, timeoutMs: 9000 }),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          ok: !!data.ok,
          status: data.status || 'down',
          statusCode: data.statusCode || (data.ok ? 200 : 500),
          latencyMs: data.latencyMs || 0,
          message: data.message || (data.ok ? 'OK' : 'Lỗi kết nối'),
        };
      }
    } catch (e) {
      void 0;
    }

    // Direct browser fetch fallback
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const directRes = await fetch(smartUrl, { signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      return {
        ok: directRes.ok,
        status: directRes.ok ? (latencyMs < 800 ? 'live' : 'slow') : 'down',
        statusCode: directRes.status,
        latencyMs,
        message: directRes.ok ? `Phản hồi trực tiếp (${latencyMs}ms)` : `Lỗi HTTP ${directRes.status}`,
      };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        ok: false,
        status: 'down',
        statusCode: 504,
        latencyMs,
        message: err?.message || 'Không thể phản hồi',
      };
    }
  }

  /**
   * Ping and update health status for a single API in Firestore
   */
  async pingAndSaveApi(api: SystemApiEndpoint): Promise<SystemApiEndpoint> {
    const targetUrl = this.getSmartTestUrl(api);
    const testResult = await this.testEndpoint(targetUrl);

    const updatedApi: SystemApiEndpoint = {
      ...api,
      lastStatus: testResult.status,
      lastLatencyMs: testResult.latencyMs,
      lastStatusCode: testResult.statusCode,
      lastErrorMessage: testResult.message,
      lastChecked: Date.now(),
    };

    try {
      const docRef = doc(db, 'system_apis', api.id);
      await setDoc(docRef, sanitizeData(updatedApi), { merge: true });

      const current = this.inMemoryApis;
      const updated = current.map((a) => (a.id === api.id ? updatedApi : a));
      this.saveToLocalStorage(updated);
    } catch (e) {
      void 0;
    }

    return updatedApi;
  }

  /**
   * Ping all registered APIs in parallel and update status
   */
  async pingAllApis(): Promise<SystemApiEndpoint[]> {
    const apis = await this.getAllApis();
    const tasks = apis.map((api) => this.pingAndSaveApi(api));
    const results = await Promise.all(tasks);
    return results;
  }

  /**
   * Subscribe to dynamic API updates
   */
  subscribe(callback: (apis: SystemApiEndpoint[]) => void): () => void {
    // Initial emission
    if (this.inMemoryApis.length > 0) {
      callback(this.inMemoryApis);
    }
    this.getAllApis().then((list) => callback(list)).catch(() => {});

    // Listen to local storage / broadcast changes
    const handler = (e: any) => {
      if (e.detail) {
        callback(e.detail);
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('qtb_system_apis_changed', handler);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('qtb_system_apis_changed', handler);
      }
    };
  }

  /**
   * Reset APIs to system defaults
   */
  async resetToDefaults(): Promise<SystemApiEndpoint[]> {
    try {
      const colRef = collection(db, 'system_apis');
      const snap = await getDocs(colRef);
      for (const d of snap.docs) {
        await deleteDoc(d.ref);
      }
      for (const api of DEFAULT_SYSTEM_APIS) {
        const docRef = doc(db, 'system_apis', api.id);
        await setDoc(docRef, sanitizeData(api));
      }
      this.saveToLocalStorage(DEFAULT_SYSTEM_APIS);
      return DEFAULT_SYSTEM_APIS;
    } catch (e) {
      this.saveToLocalStorage(DEFAULT_SYSTEM_APIS);
      return DEFAULT_SYSTEM_APIS;
    }
  }

  // Alias methods for component ease of use
  async addEndpoint(data: any): Promise<SystemApiEndpoint> {
    return this.addApi(data);
  }

  async updateEndpoint(id: string, data: Partial<SystemApiEndpoint>): Promise<SystemApiEndpoint> {
    const existing = this.inMemoryApis.find((a) => a.id === id) || ({} as SystemApiEndpoint);
    return this.updateApi({ ...existing, ...data, id } as SystemApiEndpoint);
  }

  async deleteEndpoint(id: string): Promise<void> {
    return this.deleteApi(id);
  }

  async toggleEndpoint(id: string, enabled: boolean): Promise<void> {
    return this.toggleApiStatus(id, enabled);
  }

  async checkEndpointHealth(id: string): Promise<{ status: ApiHealthStatus; latencyMs: number; message: string }> {
    const api = this.inMemoryApis.find((a) => a.id === id);
    if (!api) throw new Error('Không tìm thấy API');
    const updated = await this.pingAndSaveApi(api);
    return {
      status: updated.lastStatus,
      latencyMs: updated.lastLatencyMs || 0,
      message: updated.lastErrorMessage || 'OK',
    };
  }

  async checkAllEndpointsHealth(): Promise<SystemApiEndpoint[]> {
    return this.pingAllApis();
  }

  /**
   * Dynamic Runtime Resolver: Get active base URL for a given category and source ID
   */
  getActiveBaseUrl(category: ApiCategory, preferredId?: string, fallbackUrl?: string): string {
    const matching = this.inMemoryApis.filter(
      (a) => a.category === category && a.enabled && a.lastStatus !== 'down'
    );

    if (preferredId) {
      const target = this.inMemoryApis.find((a) => a.id === preferredId);
      if (target && target.enabled && target.lastStatus !== 'down') {
        return target.baseUrl;
      }
    }

    if (matching.length > 0) {
      // Sort by priority (1 is highest) and latency
      matching.sort((a, b) => {
        if (a.priority !== b.priority) return (a.priority || 99) - (b.priority || 99);
        return (a.lastLatencyMs || 9999) - (b.lastLatencyMs || 9999);
      });
      return matching[0].baseUrl;
    }

    // If all are down or disabled, fall back to preferred even if down or fallbackUrl
    if (preferredId) {
      const target = this.inMemoryApis.find((a) => a.id === preferredId);
      if (target) return target.baseUrl;
    }

    return fallbackUrl || '';
  }

  /**
   * Get all active endpoints for a category
   */
  getActiveEndpointsForCategory(category: ApiCategory): SystemApiEndpoint[] {
    return this.inMemoryApis
      .filter((a) => a.category === category && a.enabled)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
  }

  /** Đăng ký nghe đổi tập enabled (để bust cache phim...). */
  onEnabledChange(cb: () => void): () => void {
    this.enabledListeners.add(cb);
    return () => {
      this.enabledListeners.delete(cb);
    };
  }

  private emitEnabledChange(): void {
    try {
      this.enabledListeners.forEach((cb) => {
        try {
          cb();
        } catch {}
      });
    } catch {}
  }

  /**
   * Realtime sync từ Firestore sang mọi thiết bị (kể cả TV khác mạng admin).
   * Trước đây TV chỉ đọc localStorage của chính nó + event cùng-tab nên
   * toggle của admin không bao giờ tới được TV.
   */
  subscribeRealtime(): () => void {
    if (this.realtimeUnsub) return this.realtimeUnsub;
    // Refresh 1 phát ngay (phòng snapshot chậm/chặn).
    this.getAllApis().catch(() => {});
    try {
      const colRef = collection(db, 'system_apis');
      this.realtimeUnsub = onSnapshot(
        colRef,
        (snap) => {
          try {
            if (snap.empty) return;
            const list = snap.docs.map((d) => d.data() as SystemApiEndpoint);
            const existingIds = new Set(list.map((a) => a.id));
            for (const def of DEFAULT_SYSTEM_APIS) {
              if (!existingIds.has(def.id)) list.push(def);
            }
            list.sort((a, b) => (a.priority || 99) - (b.priority || 99));
            const key = list
              .filter((a) => a.enabled)
              .map((a) => a.id)
              .sort()
              .join(',');
            const first = !this.lastEnabledKey;
            const changed = !first && key !== this.lastEnabledKey;
            this.lastEnabledKey = key;
            this.isInitialized = true;
            this.saveToLocalStorage(list);
            if (changed) this.emitEnabledChange();
          } catch {}
        },
        () => {},
      );
    } catch {}
    return () => {};
  }
}

export const systemApiService = new SystemApiService();
