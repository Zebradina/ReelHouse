'use strict';

/**
 * ReelHouse configuration.
 *
 * Everything the app needs lives in a single data directory:
 *   <data>/config.json     user settings
 *   <data>/library.json    scanned library + TMDB metadata
 *   <data>/progress.json   playback positions
 *   <data>/epg-cache.json  parsed XMLTV programmes
 *   <data>/artcache/       cached TMDB artwork
 *   <data>/tmdb-cache.json metadata response cache
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_NAME = 'ReelHouse';

function platformDataDir() {
  if (process.env.REELHOUSE_DATA) return path.resolve(process.env.REELHOUSE_DATA);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_NAME);
}

const DATA_DIR = platformDataDir();
const DIRS = {
  data: DATA_DIR,
  config: path.join(DATA_DIR, 'config.json'),
  library: path.join(DATA_DIR, 'library.json'),
  progress: path.join(DATA_DIR, 'progress.json'),
  epgCache: path.join(DATA_DIR, 'epg-cache.json'),
  tmdbCache: path.join(DATA_DIR, 'tmdb-cache.json'),
  artCache: path.join(DATA_DIR, 'artcache'),
  logs: path.join(DATA_DIR, 'logs'),
};

const home = os.homedir();
// Bumped when a default needs to reach existing installs (see load()).
const CONFIG_VERSION = 2;

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  tmdb: {
    apiKey: '',
    // Set when the key was verified: 'v3' (API key) or 'v4' (read access token).
    keyType: null,
    account: null,
    linkedAt: null,
    language: 'en-US',
    region: 'US',
  },
  // { path, type } where type is 'movies' | 'tv' | 'auto'
  mediaDirs: [
    { path: path.join(home, APP_NAME, 'Movies'), type: 'movies' },
    { path: path.join(home, APP_NAME, 'TV Shows'), type: 'tv' },
  ],
  epg: {
    // { id, name, source (path or URL), enabled }
    sources: [],
    refreshHours: 6,
  },
  scanOnStart: true,
  // Anything FFmpeg can open is worth indexing — that is the same set VLC
  // plays, and transcoding makes the rest of it watchable in the browser.
  videoExtensions: [
    '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.mpg', '.mpeg',
    '.ts', '.m2ts', '.mts', '.flv', '.ogv', '.vob', '.3gp', '.asf', '.rmvb',
    '.divx', '.f4v', '.mxf', '.m2v', '.ogm',
  ],
  playback: {
    // 'auto' transcodes only what the browser cannot decode; 'off' plays native formats only.
    transcode: 'auto',
    // Roll into the next episode when one ends (with a countdown in the player).
    autoplayNext: true,
    // 'fast' | 'balanced' | 'high' — encoder effort for transcoded playback.
    quality: 'balanced',
    // 720, 1080, or 0 to keep the source resolution.
    maxHeight: 1080,
  },
  server: { port: 8090, host: '127.0.0.1' },
};

function ensureDirs() {
  for (const dir of [DIRS.data, DIRS.artCache, DIRS.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const dir of DEFAULT_CONFIG.mediaDirs) {
    try {
      fs.mkdirSync(dir.path, { recursive: true });
    } catch {
      /* the user may not have permission in the default location; ignore */
    }
  }
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override === undefined ? base : override;
  if (typeof base !== 'object' || base === null) return override === undefined ? base : override;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const key of Object.keys(override)) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

let config = null;

function load() {
  ensureDirs();
  let saved = {};
  if (fs.existsSync(DIRS.config)) {
    try {
      saved = JSON.parse(fs.readFileSync(DIRS.config, 'utf8'));
    } catch (err) {
      console.error('[config] could not read config.json:', err.message);
    }
  }
  config = deepMerge(DEFAULT_CONFIG, saved);
  // Installs from before transcoding existed carry the short extension list and
  // would never index MKV-era extras such as .m2ts or .vob.
  if (Number(saved.version || 1) < 2) {
    config.videoExtensions = [...DEFAULT_CONFIG.videoExtensions];
    config.version = CONFIG_VERSION;
  }
  if (process.env.PORT) config.server.port = Number(process.env.PORT) || config.server.port;
  return config;
}

function get() {
  if (!config) load();
  return config;
}

function save(patch) {
  config = deepMerge(get(), patch || {});
  // API keys are saved by the user; keep the file private.
  fs.writeFileSync(DIRS.config, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

/** Public-safe copy of the config (never leak the TMDB key). */
function publicConfig() {
  const cfg = get();
  return {
    ...cfg,
    tmdb: { ...cfg.tmdb, apiKey: '', hasApiKey: Boolean(cfg.tmdb.apiKey) },
    // EPG URLs often carry a token in the query string; the settings form has to
    // round-trip them unchanged or saving would silently break the feed.
    epg: { ...cfg.epg, sources: cfg.epg.sources.map((s) => ({ ...s })) },
  };
}

module.exports = { APP_NAME, DIRS, DEFAULT_CONFIG, load, get, save, publicConfig, ensureDirs, platformDataDir };
