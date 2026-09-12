import { onValue, ref, set } from 'firebase/database';
import { rtdb, sanitizeData } from './firebase';
import { ActiveApp, AppConfig, AppConfigItem } from '../types';

const CONFIG_PATH = 'appConfig';

const DEFAULT_CONFIG: AppConfig = {
  cinema: { enabled: true, label: 'Gấu Cinema HD', description: 'Xem phim online chất lượng cao', icon: 'film' },
  livetv: { enabled: true, label: 'Gấu LiveTV', description: 'Kênh thể thao trực tiếp', icon: 'tv' },
};

type Listener = (config: AppConfig) => void;

class AppConfigService {
  private listeners: Set<Listener> = new Set();
  private unsubscribeRtdb: (() => void) | null = null;
  private currentConfig: AppConfig = { ...DEFAULT_CONFIG };
  private initialized = false;

  private ensureConnection(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (!rtdb) {
        void 0;
        return;
      }

      const configRef = ref(rtdb, CONFIG_PATH);
      this.unsubscribeRtdb = onValue(
        configRef,
        (snap) => {
          const data = snap.val() as AppConfig | null;
          if (data) {
            this.currentConfig = { ...DEFAULT_CONFIG, ...data };
            this.currentConfig.cinema.enabled = true;
          } else {
            this.currentConfig = { ...DEFAULT_CONFIG };
          }
          this.notify();
        },
        (error: Error) => {
          void 0;
          this.currentConfig = { ...DEFAULT_CONFIG };
          this.notify();
        }
      );
    } catch (e) {
      void 0;
      this.currentConfig = { ...DEFAULT_CONFIG };
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener({ ...this.currentConfig });
      } catch (e) {
        void 0;
      }
    }
  }

  subscribe(onChange: Listener): () => void {
    this.listeners.add(onChange);
    this.ensureConnection();

    // Immediately fire with current config
    onChange({ ...this.currentConfig });

    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0 && this.unsubscribeRtdb) {
        this.unsubscribeRtdb();
        this.unsubscribeRtdb = null;
        this.initialized = false;
      }
    };
  }

  getConfig(): AppConfig {
    return { ...this.currentConfig };
  }

  isAppEnabled(app: ActiveApp): boolean {
    if (app === 'cinema') return true;
    return this.currentConfig[app]?.enabled ?? true;
  }

  async toggleApp(app: ActiveApp, enabled: boolean, adminId?: string): Promise<void> {
    if (app === 'cinema') return;
    const update: Partial<AppConfigItem> = {
      enabled,
    };
    if (!enabled) {
      update.disabledAt = Date.now();
      update.disabledBy = adminId || 'admin';
    } else {
      update.disabledAt = undefined;
      update.disabledBy = undefined;
    }
    await set(ref(rtdb, `${CONFIG_PATH}/${app}`), sanitizeData({ ...this.currentConfig[app], ...update }));
  }

  async initDefaultConfig(): Promise<void> {
    await set(ref(rtdb, CONFIG_PATH), sanitizeData(DEFAULT_CONFIG));
  }
}

export const appConfigService = new AppConfigService();
