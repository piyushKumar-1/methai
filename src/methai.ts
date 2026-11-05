// Loads the assistant's configuration at start-up: from a URL (the methai dashboard publishes one)
// or an object. A URL's last good copy is kept in the app's storage; the next start asks the server
// whether it changed (If-None-Match / If-Modified-Since) and reuses the copy on 304, or when offline.
import { validateMethaiConfig, type MethaiConfig } from './config';

/** Where the last good copy is kept: MMKV, AsyncStorage or anything with these two methods. */
export interface ConfigStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface MethaiInitOptions {
  /** Keeps the last good copy across launches. Default: in memory only. */
  storage?: ConfigStorage;
  /** Storage key. Default 'methai.config:' + the URL. */
  storageKey?: string;
  /** Sent with the request (auth…). */
  headers?: Record<string, string>;
  /** Give up on the network after this long and use the local copy. Default 4000ms. */
  timeoutMs?: number;
  /** Used when there is neither a network answer nor a local copy. */
  fallback?: MethaiConfig;
  fetchImpl?: typeof fetch;
}

export type ConfigSource = 'inline' | 'network' | 'not-modified' | 'cache' | 'fallback';

export interface MethaiConfigState {
  config: MethaiConfig;
  /** Where it came from: the server (new or 304), the local copy (offline / bad answer), or the fallback. */
  source: ConfigSource;
  etag?: string;
  lastModified?: string;
  /** Why the network copy wasn't used, if it wasn't. */
  error?: string;
}

interface Stored {
  url: string;
  etag?: string;
  lastModified?: string;
  config: MethaiConfig;
  savedAt: number;
}

/** In-memory storage, for when the app passes none (and for tests). */
export function memoryStorage(): ConfigStorage {
  const items = new Map<string, string>();
  return { getItem: key => items.get(key), setItem: (key, value) => void items.set(key, value) };
}

export class Methai {
  private current: MethaiConfigState | undefined;
  private source: { url: string; opts: MethaiInitOptions } | undefined;
  private listeners = new Set<(state: MethaiConfigState) => void>();

  /** The configuration in use (undefined before init). */
  get config(): MethaiConfig | undefined {
    return this.current?.config;
  }

  get state(): MethaiConfigState | undefined {
    return this.current;
  }

  subscribe(listener: (state: MethaiConfigState) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Loads the configuration: a URL (fetched, cached, revalidated with ETags) or the config itself.
   * Resolves with the config to use; rejects only when nothing usable exists (no network answer, no
   * local copy, no fallback), or when an inline config is invalid.
   */
  async init(source: string | MethaiConfig, opts: MethaiInitOptions = {}): Promise<MethaiConfig> {
    if (typeof source !== 'string') {
      const checked = validateMethaiConfig(source);
      if (!checked.ok) throw new Error(`Invalid methai config: ${checked.errors.join('; ')}`);
      return this.use({ config: checked.config, source: 'inline' });
    }
    this.source = { url: source, opts };
    return this.load();
  }

  /** Asks the server again (with the cached ETag), e.g. when the app comes to the foreground. */
  async refresh(): Promise<MethaiConfig> {
    if (!this.source) throw new Error('methai.init(url) first');
    return this.load();
  }

  private use(state: MethaiConfigState): MethaiConfig {
    this.current = state;
    for (const l of [...this.listeners]) l(state);
    return state.config;
  }

  private async load(): Promise<MethaiConfig> {
    const { url, opts } = this.source!;
    const storage = opts.storage ?? (this.memory ??= memoryStorage());
    const key = opts.storageKey ?? `methai.config:${url}`;
    let stored: Stored | undefined;
    try {
      const raw = await storage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Stored) : undefined;
      if (parsed?.url === url && validateMethaiConfig(parsed.config).ok) stored = parsed;
    } catch {}

    const fromCache = (error: string): MethaiConfig => {
      if (stored) return this.use({ config: stored.config, source: 'cache', etag: stored.etag, lastModified: stored.lastModified, error });
      if (opts.fallback) return this.use({ config: opts.fallback, source: 'fallback', error });
      throw new Error(`methai config unavailable: ${error}`);
    };

    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: {
          Accept: 'application/json',
          ...opts.headers,
          ...(stored?.etag && { 'If-None-Match': stored.etag }),
          ...(stored?.lastModified && { 'If-Modified-Since': stored.lastModified }),
        },
        signal: controller.signal,
      });
    } catch (e: any) {
      return fromCache(controller.signal.aborted ? `no answer in ${(opts.timeoutMs ?? 4000) / 1000}s` : String(e?.message ?? e));
    } finally {
      clearTimeout(timer);
    }

    // Unchanged since the copy we have.
    if (res.status === 304 && stored) return this.use({ config: stored.config, source: 'not-modified', etag: stored.etag, lastModified: stored.lastModified });
    if (!res.ok) return fromCache(`HTTP ${res.status}`);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fromCache('the server sent something that is not JSON');
    }
    const checked = validateMethaiConfig(body);
    if (!checked.ok) return fromCache(`invalid config: ${checked.errors.join('; ')}`);
    const fresh: Stored = {
      url,
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
      config: checked.config,
      savedAt: Date.now(),
    };
    try {
      await storage.setItem(key, JSON.stringify(fresh));
    } catch {}
    return this.use({ config: fresh.config, source: 'network', etag: fresh.etag, lastModified: fresh.lastModified });
  }

  private memory: ConfigStorage | undefined;
}

/** The app's methai configuration. */
export const methai = new Methai();
