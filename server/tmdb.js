'use strict';

const { DIRS, get } = require('./config');
const { Store } = require('./store');

const API_ROOT = 'https://api.themoviedb.org/3';
const IMAGE_ROOT = 'https://image.tmdb.org/t/p';
// Discover rows refresh twice a day; availability changes more slowly.
const DISCOVER_TTL = 6 * 60 * 60 * 1000;
const PROVIDER_TTL = 12 * 60 * 60 * 1000;

/**
 * Thin TMDB v3 client with an on-disk response cache.
 *
 * Works with either a v3 API key ("abc123...") or a v4 read access token
 * ("eyJhbGci..."). A cached response is reused forever unless `force` is set,
 * which keeps rescans of a large library fast and light on the API.
 */
class Tmdb {
  constructor() {
    this.cache = new Store(DIRS.tmdbCache, { version: 1, entries: {} });
    this.queue = [];
    this.running = 0;
    this.lastCall = 0;
    this.status = 'idle'; // idle | ok | error
    this.lastError = null;
  }

  get apiKey() {
    return (get().tmdb.apiKey || '').trim();
  }

  get enabled() {
    return this.apiKey.length > 0;
  }

  get language() {
    return get().tmdb.language || 'en-US';
  }

  /**
   * Check a candidate key against TMDB without saving it.
   * Returns { keyType, account } where account is only known for v4 tokens.
   */
  static async verify(rawKey, language = 'en-US') {
    const key = String(rawKey || '').trim();
    if (!key) {
      const err = new Error('Paste a TMDB API key or read access token.');
      err.status = 400;
      throw err;
    }
    const isToken = key.startsWith('eyJ');
    const headers = { accept: 'application/json', ...(isToken ? { Authorization: `Bearer ${key}` } : {}) };
    const url = new URL(`${API_ROOT}/configuration`);
    url.searchParams.set('language', language);
    if (!isToken) url.searchParams.set('api_key', key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url.toString(), { headers, signal: controller.signal });
    } catch (err) {
      const netErr = new Error(
        err.name === 'AbortError'
          ? 'TMDB did not respond within 15 seconds.'
          : 'Could not reach TMDB — check your internet connection.',
      );
      netErr.status = 502;
      throw netErr;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const err = new Error('TMDB rejected that key. Copy the API Key (v3) or API Read Access Token (v4) from themoviedb.org → Settings → API.');
      err.status = 401;
      throw err;
    }
    if (res.status === 429) {
      const err = new Error('TMDB is rate-limiting this key — wait a minute and try again.');
      err.status = 429;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`TMDB answered ${res.status} ${res.statusText}.`);
      err.status = 502;
      throw err;
    }

    const result = { keyType: isToken ? 'v4' : 'v3', account: null };
    if (isToken) {
      // v4 tokens can name the account; v3 keys cannot, so a username is optional.
      try {
        const who = await fetch(`${API_ROOT}/authentication`, { headers, signal: AbortSignal.timeout(8000) });
        if (who.ok) {
          const person = await who.json();
          result.account = person.username || person.name || null;
        }
      } catch {
        /* verifying the key is what matters; the name is a nicety */
      }
    }
    return result;
  }

  /** Throw away cached TMDB responses so the next scan fetches fresh metadata. */
  resetCache() {
    this.cache.data.entries = {};
    this.cache.write();
    this.status = 'idle';
    this.lastError = null;
  }

  headers() {
    const key = this.apiKey;
    const base = { accept: 'application/json' };
    if (key.startsWith('eyJ')) return { ...base, Authorization: `Bearer ${key}` };
    return base;
  }

  /** Serialise requests and keep to roughly 4/s, under TMDB's rate limits. */
  #schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    if (this.running >= 3 || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.running += 1;
    const wait = Math.max(0, 260 - (Date.now() - this.lastCall));
    setTimeout(async () => {
      this.lastCall = Date.now();
      try {
        job.resolve(await job.fn());
      } catch (err) {
        job.reject(err);
      } finally {
        this.running -= 1;
        this.#drain();
      }
    }, wait);
  }

  async #fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { headers: this.headers(), signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`TMDB ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async request(endpoint, params = {}, { force = false, ttl = 0 } = {}) {
    if (!this.enabled) return null;
    const key = `${endpoint}?${new URLSearchParams({ ...params, language: this.language }).toString()}`;
    const cached = this.cache.data.entries[key];
    // Library metadata is cached forever; Discover lists go stale, so they pass a TTL.
    if (cached && !force && (!ttl || Date.now() - cached.fetchedAt < ttl)) return cached.data;

    const url = new URL(API_ROOT + endpoint);
    for (const [k, v] of Object.entries({ ...params, language: this.language })) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (!this.apiKey.startsWith('eyJ')) url.searchParams.set('api_key', this.apiKey);

    try {
      const data = await this.#schedule(() => this.#fetchJson(url.toString()));
      this.cache.data.entries[key] = { fetchedAt: Date.now(), data };
      this.cache.save(2000);
      this.status = 'ok';
      this.lastError = null;
      return data;
    } catch (err) {
      this.status = 'error';
      this.lastError = err.message;
      // A missing title is a normal result, not a failure.
      if (err.status === 404) return null;
      console.error('[tmdb]', err.message);
      return cached ? cached.data : null;
    }
  }

  /** Streaming region for watch-provider lookups (ISO 3166-1 alpha-2). */
  get region() {
    return String(get().tmdb.region || 'US').toUpperCase();
  }

  /**
   * Rows for the Discover tab. Lists are cheap; provider availability for each
   * title is a separate request, so the UI asks for those lazily.
   */
  popular(type, page = 1) {
    const endpoint = type === 'tv' ? '/tv/popular' : '/movie/popular';
    return this.request(endpoint, { page, region: this.region }, { ttl: DISCOVER_TTL });
  }

  trending(type) {
    return this.request(`/trending/${type === 'tv' ? 'tv' : 'movie'}/week`, {}, { ttl: DISCOVER_TTL });
  }

  watchProviders(type, id) {
    const endpoint = type === 'tv' ? `/tv/${id}/watch/providers` : `/movie/${id}/watch/providers`;
    return this.request(endpoint, {}, { ttl: PROVIDER_TTL });
  }

  async searchMovie(title, year) {
    const data = await this.request('/search/movie', { query: title, year: year || '', include_adult: 'false' });
    if (!data || !data.results || data.results.length === 0) return null;
    if (year) {
      const exact = data.results.find((r) => String(r.release_date || '').startsWith(String(year)));
      if (exact) return exact;
    }
    return data.results[0];
  }

  async searchTv(title) {
    const data = await this.request('/search/tv', { query: title, include_adult: 'false' });
    if (!data || !data.results || data.results.length === 0) return null;
    return data.results[0];
  }

  movie(id) {
    return this.request(`/movie/${id}`, { append_to_response: 'images' });
  }

  tv(id) {
    return this.request(`/tv/${id}`, { append_to_response: 'images' });
  }

  season(id, seasonNumber) {
    return this.request(`/tv/${id}/season/${seasonNumber}`);
  }

  static image(path, size = 'w500') {
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    return `${IMAGE_ROOT}/${size}${path}`;
  }

  /** Normalised artwork block used by the frontend. */
  static art(source, { preferLanguage = 'en' } = {}) {
    if (!source) return { poster: null, backdrop: null, logo: null, profile: null };
    const images = source.images || {};
    const pick = (list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const langMatch = list.find((i) => i.iso_639_1 === preferLanguage);
      const choice = langMatch || list.find((i) => !i.iso_639_1) || list[0];
      return choice ? choice.file_path : null;
    };
    const logo = pick(images.logos) || null;
    const backdrop = source.backdrop_path || pick(images.backdrops) || null;
    const poster = source.poster_path || pick(images.posters) || null;
    return { poster, backdrop, logo, profile: source.profile_path || null };
  }
}

module.exports = { Tmdb, IMAGE_ROOT };
