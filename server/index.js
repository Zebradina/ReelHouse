'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const { Store } = require('./store');
const { Tmdb, IMAGE_ROOT } = require('./tmdb');
const { Scanner } = require('./scanner');
const { Epg } = require('./epg');
const { Live, rewritePlaylist } = require('./live');
const { discoverSubtitles, toVtt, decode } = require('./subtitles');
const transcode = require('./transcode');
const discovery = require('./discovery');

const { DIRS } = config;
const APP_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');

// What the listener actually bound to. Settings compares this with the saved
// config to tell the user whether a restart is still needed.
const runtime = { host: null, port: null, discovery: false };

const { Readable } = require('stream');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
};

/** Normalise a TMDB watch-provider array, deduped and in TMDB's display order. */
function providerList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const provider of list) {
    const id = provider && provider.provider_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: provider.provider_name || 'Unknown service',
      logo: provider.logo_path || null,
      priority: Number(provider.display_priority) || 0,
    });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** One Discover card: only the fields the frontend shows. */
function discoverItem(raw, type) {
  return {
    id: raw.id,
    type,
    title: raw.title || raw.name || 'Untitled',
    year: Number(String(raw.release_date || raw.first_air_date || '').slice(0, 4)) || null,
    poster: raw.poster_path || null,
    backdrop: raw.backdrop_path || null,
    overview: raw.overview || '',
    rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : null,
    popularity: Number(raw.popularity) || 0,
  };
}

function discoverResults(payload, type) {
  if (!payload || !Array.isArray(payload.results)) return [];
  return payload.results
    .filter((raw) => raw && raw.id && (raw.poster_path || raw.backdrop_path))
    .map((raw) => discoverItem(raw, type));
}

/** Channel names differ only in punctuation between a playlist and an XMLTV file. */
function normaliseChannelName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * How the browser should play a channel URL.
 *
 * HLS is the default rather than a guess: IPTV links frequently have no file
 * extension at all (`/live/user/pass/101`), and those are virtually always
 * m3u8. The player falls back to a plain video source if the manifest fails.
 */
function liveKind(url) {
  const clean = String(url || '').split('?')[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return 'hls';
  if (/\.(mp4|m4v|webm|ogv|mp3|aac|ts)$/.test(clean)) return 'file';
  return 'hls';
}

function createApp() {
  config.load();

  const tmdb = new Tmdb();
  const scanner = new Scanner({ tmdb });
  const library = new Store(DIRS.library, { version: 1, movies: [], shows: [], counts: { movies: 0, shows: 0, episodes: 0, files: 0 } });
  const progress = new Store(DIRS.progress, { version: 1, items: {} });
  const epg = new Epg({ cacheFile: DIRS.epgCache });
  const live = new Live({ cacheFile: DIRS.liveCache });

  // A rescan asked for mid-scan (link, unlink, settings save) must not be lost.
  let rescanQueued = false;

  const state = {
    scan: {
      running: false,
      phase: 'idle',
      message: 'Not scanned yet',
      found: 0,
      total: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    index: { movies: new Map(), shows: new Map(), episodes: new Map() },
  };

  function rebuildIndex() {
    state.index.movies.clear();
    state.index.shows.clear();
    state.index.episodes.clear();
    for (const movie of library.data.movies || []) state.index.movies.set(movie.id, movie);
    for (const show of library.data.shows || []) {
      state.index.shows.set(show.id, show);
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) state.index.episodes.set(episode.id, { ...episode, show });
      }
    }
  }
  rebuildIndex();

  function requireFile(file) {
    if (!file) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- scanning
  let scanTimer = null;

  function scheduleScan(delay = 150) {
    // A scan in flight (or already scheduled) gets one follow-up, not a pile-up.
    if (state.scan.running) {
      rescanQueued = true;
      return;
    }
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      runScan();
    }, delay);
  }

  async function runScan() {
    if (state.scan.running) {
      rescanQueued = true;
      return state.scan;
    }
    state.scan = {
      running: true,
      phase: 'starting',
      message: 'Preparing scan…',
      found: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    try {
      const cfg = config.get();
      const result = await scanner.scan(
        { mediaDirs: cfg.mediaDirs, extensions: cfg.videoExtensions },
        (update) => {
          state.scan = { ...state.scan, ...update, running: true };
        },
      );
      library.data = result;
      library.write();
      rebuildIndex();
      state.scan = {
        ...state.scan,
        running: false,
        phase: 'done',
        message: result.counts.files === 0
          ? 'No video files found. Add a media folder in Settings.'
          : `Library ready: ${result.counts.movies} movies · ${result.counts.shows} shows · ${result.counts.episodes} episodes`,
        finishedAt: new Date().toISOString(),
        counts: result.counts,
        dirErrors: result.dirErrors,
      };
    } catch (err) {
      console.error('[scan]', err);
      state.scan = { ...state.scan, running: false, phase: 'error', error: err.message, message: `Scan failed: ${err.message}`, finishedAt: new Date().toISOString() };
    }
    if (rescanQueued) {
      rescanQueued = false;
      setTimeout(runScan, 150);
    }
    return state.scan;
  }

  async function refreshEpg() {
    const cfg = config.get();
    if (!cfg.epg.sources.length) return epg.summary();
    const summary = await epg.refresh(cfg.epg.sources);
    state.epg = summary;
    return summary;
  }

  async function refreshLive() {
    const cfg = config.get();
    if (!cfg.live.sources.length) {
      // Clearing the list should not leave yesterday's channels in the guide.
      if (live.channels().length) {
        await live.refresh([]);
      }
      return live.summary();
    }
    const summary = await live.refresh(cfg.live.sources);
    state.live = summary;
    return summary;
  }

  /**
   * XMLTV channel -> playlist channel, so guide data follows the station into
   * the row you can actually press play on. tvg-id is the reliable link; name
   * matching is the fallback for playlists that carry no ids.
   */
  function channelRemap() {
    const map = new Map();
    const liveChannels = live.channels();
    if (!liveChannels.length) return map;

    const byTvg = new Map(epg.data.channels.map((channel) => [channel.id, channel]));
    const byName = new Map(epg.data.channels.map((channel) => [normaliseChannelName(channel.name), channel]));
    const claimed = new Set();

    for (const channel of liveChannels) {
      const match =
        (channel.tvgId && byTvg.get(channel.tvgId)) ||
        byName.get(normaliseChannelName(channel.name)) ||
        null;
      if (!match || claimed.has(match.id)) continue;
      claimed.add(match.id);
      byName.delete(normaliseChannelName(match.name));
      map.set(match.id, channel);
    }
    return map;
  }

  /**
   * Channels and programmes for the guide.
   *
   * Playlist channels come first, in playlist order (that is the order the user
   * chose), followed by schedules the EPG knows but no playlist covers — those
   * rows still show what is on, they just cannot be watched.
   */
  function guideWindow(fromIso, toIso) {
    const window = epg.window(fromIso, toIso);
    const liveChannels = live.channels();
    if (!liveChannels.length) {
      return { channels: window.channels.map((c) => ({ ...c, live: false, hasGuide: true })), programmes: window.programmes };
    }

    const remap = channelRemap();
    const matched = new Map();
    for (const [xmltvId, channel] of remap) matched.set(channel.id, xmltvId);

    const channels = liveChannels.map((channel) => {
      const guide = matched.has(channel.id) ? epg.data.channels.find((c) => c.id === matched.get(channel.id)) : null;
      return {
        id: channel.id,
        name: channel.name,
        number: channel.number,
        icon: channel.icon || (guide && guide.icon) || null,
        group: channel.group || null,
        live: true,
        hasGuide: Boolean(guide),
      };
    });

    for (const channel of window.channels) {
      if (remap.has(channel.id)) continue;
      channels.push({ ...channel, live: false, hasGuide: true });
    }

    const programmes = window.programmes.map((programme) => {
      const target = remap.get(programme.channel);
      return target ? { ...programme, channel: target.id } : programme;
    });

    return { channels, programmes };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Same-origin API guard: refuse cross-site browser requests to this server.
  // A TV on the LAN loads the app from http://<lan-ip>:<port>, so "same host as
  // this request" has to count as same-origin — otherwise every device would
  // get a 403 on its very first API call.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      const host = new URL(origin).host;
      if (req.headers.host && host === req.headers.host) return next();
      if (['127.0.0.1', 'localhost', '::1'].includes(new URL(origin).hostname)) return next();
    } catch {
      /* fall through */
    }
    res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  });

  /** What Settings and the TV app need to know about network access. */
  function networkSummary() {
    const cfg = config.get();
    const lanAccess = cfg.server.lanAccess === true;
    const boundToLan = runtime.host === '0.0.0.0';
    const addresses = boundToLan ? discovery.lanAddresses() : [];
    const port = runtime.port || cfg.server.port;
    return {
      lanAccess,
      boundToLan,
      discovery: runtime.discovery,
      // The saved setting only takes effect on the next start.
      restartRequired: lanAccess !== boundToLan,
      port,
      addresses,
      urls: addresses.map((ip) => `http://${ip}:${port}`),
    };
  }

  function tmdbSummary() {
    const cfg = config.get();
    const key = cfg.tmdb.apiKey || '';
    return {
      configured: tmdb.enabled,
      keyType: cfg.tmdb.keyType || (key ? (key.startsWith('eyJ') ? 'v4' : 'v3') : null),
      account: cfg.tmdb.account || null,
      linkedAt: cfg.tmdb.linkedAt || null,
      language: cfg.tmdb.language,
      region: tmdb.region,
      status: tmdb.status,
      lastError: tmdb.lastError,
    };
  }

  // ------------------------------------------------------------------- status
  app.get('/api/status', async (req, res) => {
    const cfg = config.get();
    const playback = await transcode.status();
    res.json({
      app: 'ReelHouse',
      version: require('../package.json').version,
      dataDir: DIRS.data,
      tmdb: tmdbSummary(),
      library: {
        scannedAt: library.data.scannedAt || null,
        counts: library.data.counts || { movies: 0, shows: 0, episodes: 0, files: 0 },
        dirErrors: library.data.dirErrors || [],
      },
      scan: state.scan,
      epg: epg.summary(),
      live: live.summary(),
      mediaDirs: cfg.mediaDirs,
      network: networkSummary(),
      playback: {
        ...playback,
        transcode: cfg.playback.transcode,
        autoplayNext: cfg.playback.autoplayNext !== false,
        quality: cfg.playback.quality,
        maxHeight: cfg.playback.maxHeight,
      },
    });
  });

  app.get('/api/settings', (req, res) => {
    res.json(config.publicConfig());
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body || {};
    const patch = {};

    let tmdbRescan = false;
    if (body.tmdb) {
      const current = config.get().tmdb;
      const incoming = String(body.tmdb.apiKey || '').trim();
      const language = body.tmdb.language || current.language;
      // Empty string means "unchanged" so the UI never has to echo the secret back.
      patch.tmdb = incoming === '' ? { language } : { apiKey: incoming, language };
      const region = String(body.tmdb.region || '').trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(region)) patch.tmdb.region = region;
      // A new key or language changes every title's metadata; a region does not.
      tmdbRescan = Boolean(incoming) || language !== current.language;
    }

    if (Array.isArray(body.mediaDirs)) {
      const seen = new Set();
      patch.mediaDirs = body.mediaDirs
        .filter((d) => d && typeof d.path === 'string' && d.path.trim())
        .map((d) => ({
          path: path.resolve(d.path.replace(/^~(?=\/|$)/, require('os').homedir())),
          type: ['movies', 'tv', 'auto'].includes(d.type) ? d.type : 'auto',
        }))
        // The same folder listed twice would be scanned twice and duplicate the library.
        .filter((d) => {
          if (seen.has(d.path)) return false;
          seen.add(d.path);
          return true;
        });
      for (const dir of patch.mediaDirs) {
        try {
          fs.mkdirSync(dir.path, { recursive: true });
        } catch {
          /* reported by the next scan */
        }
      }
    }

    if (body.live && Array.isArray(body.live.sources)) {
      patch.live = {
        sources: body.live.sources
          .filter((s) => s && typeof (s.url || s.source) === 'string' && String(s.url || s.source).trim())
          .map((s, i) => ({
            id: s.id || `live-${crypto.randomBytes(4).toString('hex')}-${i}`,
            name: String(s.name || '').trim() || 'M3U playlist',
            url: String(s.url || s.source).trim(),
            enabled: s.enabled !== false,
          })),
      };
    }

    if (body.epg && Array.isArray(body.epg.sources)) {
      patch.epg = {
        sources: body.epg.sources
          .filter((s) => s && typeof s.source === 'string' && s.source.trim())
          .map((s, i) => ({
            id: s.id || `src-${crypto.randomBytes(4).toString('hex')}-${i}`,
            name: s.name || 'XMLTV source',
            source: s.source.trim(),
            enabled: s.enabled !== false,
          })),
      };
    }

    // LAN access is a binding choice, so it only applies after a restart.
    if (body.server && typeof body.server === 'object') {
      patch.server = { lanAccess: body.server.lanAccess === true };
    }

    if (body.playback && typeof body.playback === 'object') {
      const current = config.get().playback;
      patch.playback = {
        transcode: body.playback.transcode === 'off' ? 'off' : 'auto',
        autoplayNext: body.playback.autoplayNext !== false,
        quality: ['fast', 'balanced', 'high'].includes(body.playback.quality) ? body.playback.quality : current.quality,
        maxHeight: [720, 1080, 0].includes(Number(body.playback.maxHeight)) ? Number(body.playback.maxHeight) : current.maxHeight,
      };
    }

    config.save(patch);
    res.json({ ok: true, config: config.publicConfig() });

    if (patch.mediaDirs) scheduleScan();
    if (patch.epg) setTimeout(refreshEpg, 150);
    if (patch.live) setTimeout(refreshLive, 150);
    // New language or key: metadata on disk still carries the old look.
    if (patch.tmdb && tmdb.enabled && tmdbRescan) scheduleScan();
  });

  // ---------------------------------------------------------------------- tmdb
  /** Save a key only once TMDB has accepted it, then re-enrich the library. */
  app.post('/api/tmdb/verify', async (req, res) => {
    const body = req.body || {};
    const key = String(body.apiKey || '').trim() || tmdb.apiKey;
    const requested = String(body.language || '').trim();
    const language = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(requested) ? requested : config.get().tmdb.language;

    try {
      const link = await Tmdb.verify(key, language);
      config.save({
        tmdb: {
          apiKey: key,
          keyType: link.keyType,
          account: link.account,
          linkedAt: new Date().toISOString(),
          language,
        },
      });
      tmdb.resetCache();
      scheduleScan(120);
      return res.json({ ok: true, tmdb: tmdbSummary() });
    } catch (err) {
      return res.status(err.status || 502).json({ ok: false, error: err.message });
    }
  });

  /** Re-fetch metadata for the whole library (new language, corrected art, etc). */
  app.post('/api/tmdb/refresh', (req, res) => {
    if (!tmdb.enabled) {
      return res.status(409).json({ ok: false, error: 'Link a TMDB account first.' });
    }
    const requested = String((req.body || {}).language || '').trim();
    if (requested && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(requested) && requested !== config.get().tmdb.language) {
      config.save({ tmdb: { language: requested } });
    }
    tmdb.resetCache();
    scheduleScan(120);
    return res.json({ ok: true, tmdb: tmdbSummary() });
  });

  /** Forget the key. The next scan drops TMDB titles and artwork. */
  app.delete('/api/tmdb', (req, res) => {
    config.save({ tmdb: { apiKey: '', keyType: null, account: null, linkedAt: null } });
    tmdb.resetCache();
    scheduleScan(120);
    return res.json({ ok: true, tmdb: tmdbSummary() });
  });

  // ---------------------------------------------------------------- discover
  /** Trending and popular rows for the Discover tab (availability is lazy). */
  app.get('/api/discover', async (req, res) => {
    const region = tmdb.region;
    if (!tmdb.enabled) {
      return res.json({ configured: false, region, rows: [], updatedAt: null, error: null });
    }

    const [trendingMovies, trendingShows, popularMovies, popularShows] = await Promise.all([
      tmdb.trending('movie'),
      tmdb.trending('tv'),
      tmdb.popular('movie'),
      tmdb.popular('tv'),
    ]);

    const trending = [...discoverResults(trendingMovies, 'movie'), ...discoverResults(trendingShows, 'tv')]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 18);

    const rows = [
      { id: 'trending', title: 'Trending this week', items: trending },
      { id: 'movies', title: 'Popular movies', items: discoverResults(popularMovies, 'movie').slice(0, 18) },
      { id: 'tv', title: 'Popular TV shows', items: discoverResults(popularShows, 'tv').slice(0, 18) },
    ].filter((row) => row.items.length);

    // No rows means every list request failed; translate the usual causes.
    const failure = tmdb.lastError || '';
    const error = rows.length
      ? null
      : /^TMDB 40[13]/.test(failure)
        ? 'TMDB rejected the saved key. Re-link it in Settings → TMDB.'
        : /^TMDB 429/.test(failure)
          ? 'TMDB is rate-limiting requests. Try again in a minute.'
          : 'Could not load Discover from TMDB. Check your internet connection.';

    return res.json({
      configured: true,
      region,
      rows,
      updatedAt: new Date().toISOString(),
      error,
    });
  });

  /**
   * Where to watch a handful of titles in the configured region. TMDB has no
   * batch endpoint for this, so the UI asks per row after the page has painted.
   */
  app.get('/api/discover/providers', async (req, res) => {
    if (!tmdb.enabled) return res.status(409).json({ error: 'Link a TMDB account first.' });

    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 24);
    if (!ids.length) return res.status(400).json({ error: 'ids is required' });

    const region = tmdb.region;
    const providers = {};
    await Promise.all(ids.map(async (id) => {
      const data = await tmdb.watchProviders(type, id);
      const block = data && data.results ? data.results[region] : null;
      providers[`${type}:${id}`] = block
        ? {
          link: block.link || null,
          flatrate: providerList(block.flatrate),
          free: providerList(block.free),
          ads: providerList(block.ads),
          rent: providerList(block.rent),
          buy: providerList(block.buy),
        }
        : null;
    }));

    return res.json({ region, providers });
  });

  // ------------------------------------------------------------------ library
  app.get('/api/library', (req, res) => {
    const data = library.data;
    res.json({
      scannedAt: data.scannedAt || null,
      counts: data.counts || { movies: 0, shows: 0, episodes: 0, files: 0 },
      movies: (data.movies || []).map((m) => ({ ...m, file: undefined })),
      shows: (data.shows || []).map((s) => ({
        ...s,
        folder: undefined,
        seasons: (s.seasons || []).map((season) => ({
          ...season,
          episodes: season.episodes.map((e) => ({ ...e, file: undefined })),
        })),
      })),
    });
  });

  app.get('/api/item/:id', (req, res) => {
    const { id } = req.params;
    const movie = state.index.movies.get(id);
    if (movie) return res.json({ kind: 'movie', item: movie });
    const show = state.index.shows.get(id);
    if (show) return res.json({ kind: 'show', item: show });
    const episode = state.index.episodes.get(id);
    if (episode) return res.json({ kind: 'episode', item: episode });
    return res.status(404).json({ error: 'Not found' });
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ movies: [], shows: [], programmes: [] });
    const matches = (value) => String(value || '').toLowerCase().includes(q);
    const movies = (library.data.movies || []).filter((m) => matches(m.title) || matches(m.overview)).slice(0, 24);
    const shows = (library.data.shows || []).filter((s) => matches(s.title) || matches(s.overview)).slice(0, 24);
    const nowMs = Date.now();
    const programmes = epg.data.programmes
      .filter((p) => new Date(p.stop).getTime() > nowMs && (matches(p.title) || matches(p.desc)))
      .slice(0, 24)
      .map((p) => ({ ...p, channelName: (epg.data.channels.find((c) => c.id === p.channel) || {}).name }));
    return res.json({
      movies: movies.map((m) => ({ ...m, file: undefined })),
      shows: shows.map((s) => ({ ...s, folder: undefined })),
      programmes,
    });
  });

  // ------------------------------------------------------------------ artwork
  const SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'original']);

  app.get('/api/art', async (req, res) => {
    const size = SIZES.has(String(req.query.size)) ? String(req.query.size) : 'w500';
    const imagePath = String(req.query.path || '');
    if (!imagePath || !imagePath.startsWith('/') || imagePath.includes('..') || !/^\/[\w@./-]+\.(jpg|jpeg|png|webp|svg)$/i.test(imagePath)) {
      return res.status(400).send('Invalid image path');
    }
    const cacheKey = crypto.createHash('sha1').update(`${size}:${imagePath}`).digest('hex');
    const cached = path.join(DIRS.artCache, `${cacheKey}${path.extname(imagePath)}`);

    if (fs.existsSync(cached)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(path.extname(cached));
      return fs.createReadStream(cached).pipe(res);
    }

    try {
      const url = `${IMAGE_ROOT}/${size}${imagePath}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const upstream = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!upstream.ok) return res.status(upstream.status).send('Artwork unavailable');
      const buffer = Buffer.from(await upstream.arrayBuffer());
      await fsp.mkdir(DIRS.artCache, { recursive: true }).catch(() => {});
      await fsp.writeFile(cached, buffer).catch(() => {});
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.type(upstream.headers.get('content-type') || 'image/jpeg');
      return res.send(buffer);
    } catch (err) {
      console.error('[art]', err.message);
      return res.status(502).send('Artwork fetch failed');
    }
  });

  // ------------------------------------------------------------------ playback
  function resolvePlayable(kind, id, season, episode) {
    if (kind === 'movie') return state.index.movies.get(id) || null;
    if (kind === 'episode') return state.index.episodes.get(id) || null;
    if (kind === 'show') {
      const show = state.index.shows.get(id);
      if (!show) return null;
      const seasonEntry = show.seasons.find((s) => String(s.number) === String(season)) || show.seasons[0];
      if (!seasonEntry) return null;
      return seasonEntry.episodes.find((e) => String(e.episode) === String(episode)) || seasonEntry.episodes[0] || null;
    }
    return null;
  }

  app.get('/api/play/:kind/:id', async (req, res) => {
    const { kind, id } = req.params;
    const target = resolvePlayable(kind, id, req.query.season, req.query.episode);
    if (!target) return res.status(404).json({ error: 'Media not found' });
    if (!requireFile(target.file)) return res.status(410).json({ error: 'File is missing from disk', file: path.basename(target.file) });

    const seasonParams = new URLSearchParams();
    if (kind === 'show' && req.query.season) {
      seasonParams.set('season', String(req.query.season));
      seasonParams.set('episode', String(req.query.episode || 1));
    }
    const seasonQuery = seasonParams.toString() ? `?${seasonParams}` : '';

    const subtitles = discoverSubtitles(target.file).map((track) => ({
      id: track.id,
      label: track.label,
      language: track.language,
      format: track.format,
      forced: track.forced,
      sdh: track.sdh,
      fileName: track.fileName,
      url: `/api/subtitles/${kind}/${target.id}/${track.id}${seasonQuery}`,
    }));

    const info = await transcode.probe(target.file);
    const playbackConfig = config.get().playback;
    const forced = req.query.transcode === '1';
    const decision = transcode.plan(target.file, info, { force: forced, transcode: playbackConfig.transcode });

    const hlsParams = new URLSearchParams(seasonParams);
    if (forced) hlsParams.set('force', '1');
    const hlsQuery = hlsParams.toString() ? `?${hlsParams}` : '';
    const streamUrl = decision.mode === 'direct' || decision.mode === 'unsupported'
      ? `/api/stream/${kind}/${target.id}${seasonQuery}`
      : `/api/hls/${kind}/${target.id}/index.m3u8${hlsQuery}`;

    return res.json({
      id: target.id,
      file: path.basename(target.file),
      size: target.size,
      streamUrl,
      mime: MIME[path.extname(target.file).toLowerCase()] || 'application/octet-stream',
      subtitles,
      playback: {
        mode: decision.mode,
        reason: decision.reason,
        autoplayNext: playbackConfig.autoplayNext !== false,
        duration: info ? info.duration : 0,
        container: path.extname(target.file).slice(1).toLowerCase(),
        video: info ? info.video : null,
        audio: info ? info.audio : null,
        hlsUrl: decision.mode === 'transcode' ? streamUrl : null,
        forceUrl: `/api/play/${kind}/${target.id}?${new URLSearchParams({ ...Object.fromEntries(seasonParams), transcode: '1' })}`,
      },
    });
  });

  // Sidecar subtitles, converted to WebVTT so the browser can render them.
  app.get('/api/subtitles/:kind/:id/:index', async (req, res) => {
    const { kind, id } = req.params;
    const target = resolvePlayable(kind, id, req.query.season, req.query.episode);
    if (!target || !target.file) return res.status(404).type('text/plain').send('Media not found');

    const index = Number(req.params.index);
    const track = discoverSubtitles(target.file)[index];
    if (!track) return res.status(404).type('text/plain').send('Subtitle not found');

    try {
      const buffer = await fsp.readFile(track.path);
      const vtt = toVtt(decode(buffer), track.format);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Language', track.language || 'und');
      return res.send(vtt);
    } catch (err) {
      console.error('[subtitles]', err.message);
      return res.status(500).type('text/plain').send('Subtitle could not be read');
    }
  });

  // -------------------------------------------------------------- transcoding
  function hlsDecision(target, req) {
    const playbackConfig = config.get().playback;
    return transcode.probe(target.file).then((info) => ({
      info,
      decision: transcode.plan(target.file, info, {
        force: req.query.force === '1',
        transcode: playbackConfig.transcode,
      }),
      playbackConfig,
    }));
  }

  app.get('/api/hls/:kind/:id/index.m3u8', async (req, res) => {
    const { kind, id } = req.params;
    const target = resolvePlayable(kind, id, req.query.season, req.query.episode);
    if (!target || !target.file || !requireFile(target.file)) {
      return res.status(404).type('text/plain').send('Media not found');
    }
    const { info, decision } = await hlsDecision(target, req);
    if (!info || !info.duration) {
      return res.status(422).type('text/plain').send('This file has no readable timeline');
    }
    if (decision.mode !== 'transcode') {
      return res.status(409).type('text/plain').send('This file does not need transcoding');
    }

    const params = new URLSearchParams();
    if (req.query.season) {
      params.set('season', String(req.query.season));
      params.set('episode', String(req.query.episode || 1));
    }
    if (req.query.force === '1') params.set('force', '1');
    const segmentQuery = params.toString() ? `?${params}` : '';

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(transcode.playlist({ duration: info.duration, segmentQuery }));
  });

  // One segment, encoded on demand: this is what makes seeking anywhere work
  // without transcoding the whole film first.
  app.get(/^\/api\/hls\/([^/]+)\/([^/]+)\/seg-(\d+)\.ts$/, async (req, res) => {
    const [kind, id] = [req.params[0], req.params[1]];
    const index = Number(req.params[2]);
    const target = resolvePlayable(kind, id, req.query.season, req.query.episode);
    if (!target || !target.file || !requireFile(target.file)) {
      return res.status(404).type('text/plain').send('Media not found');
    }
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).type('text/plain').send('Bad segment');
    }

    const { info, decision, playbackConfig } = await hlsDecision(target, req);
    if (!info || !info.duration) {
      return res.status(422).type('text/plain').send('This file has no readable timeline');
    }
    if (decision.mode !== 'transcode') {
      return res.status(409).type('text/plain').send('This file does not need transcoding');
    }

    const start = index * transcode.SEGMENT_SECONDS;
    if (start >= info.duration) return res.status(416).type('text/plain').send('Past the end');
    const length = Math.max(0.1, Math.min(transcode.SEGMENT_SECONDS, info.duration - start));

    try {
      const buffer = await transcode.segment({
        file: target.file,
        start,
        length,
        maxHeight: playbackConfig.maxHeight,
        quality: playbackConfig.quality,
        force: req.query.force === '1',
      });
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Length', String(buffer.length));
      return res.end(buffer);
    } catch (err) {
      console.error('[hls]', err.message);
      return res.status(err.status || 500).type('text/plain').send(err.message);
    }
  });

  app.get('/api/stream/:kind/:id', (req, res) => {
    const { kind, id } = req.params;
    const target = resolvePlayable(kind, id, req.query.season, req.query.episode);
    if (!target || !requireFile(target.file)) return res.status(404).send('Media not found');

    const file = target.file;
    const stat = fs.statSync(file);
    const total = stat.size;
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    if (!range) {
      res.setHeader('Content-Length', total);
      return fs.createReadStream(file).pipe(res);
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  });

  // ------------------------------------------------------------------ progress
  app.get('/api/progress', (req, res) => {
    res.json({ items: progress.data.items });
  });

  app.post('/api/progress', (req, res) => {
    const { id, position, duration, kind, title, subtitle, poster, backdrop } = req.body || {};
    if (!id || !Number.isFinite(Number(position))) return res.status(400).json({ error: 'id and position are required' });
    const now = new Date().toISOString();
    const previous = progress.data.items[id] || {};
    const pos = Math.max(0, Number(position));
    const dur = Number(duration) || previous.duration || 0;
    const finished = dur > 0 && pos / dur > 0.95;
    progress.data.items[id] = {
      ...previous,
      id,
      kind: kind || previous.kind || 'movie',
      title: title || previous.title || '',
      subtitle: subtitle || previous.subtitle || '',
      poster: poster || previous.poster || null,
      backdrop: backdrop || previous.backdrop || null,
      position: finished ? 0 : pos,
      duration: dur,
      finished: Boolean(finished),
      updatedAt: now,
    };
    progress.save();
    return res.json({ ok: true, item: progress.data.items[id] });
  });

  /** Forget one resume point (the × on a Continue watching card). */
  app.delete('/api/progress/:id', (req, res) => {
    const { id } = req.params;
    if (!progress.data.items[id]) return res.status(404).json({ ok: false, error: 'No resume point for that item' });
    delete progress.data.items[id];
    progress.write();
    return res.json({ ok: true });
  });

  app.get('/api/continue', (req, res) => {
    // 30 seconds is a sensible "really started watching" gate for a film, but
    // it would hide short episodes and shorts entirely, so short items use 10%.
    const items = Object.values(progress.data.items)
      .filter((p) => {
        if (p.finished) return false;
        if (!p.duration) return p.position > 30;
        return p.position > Math.min(30, p.duration * 0.1) && p.position / p.duration < 0.95;
      })
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 20);
    res.json({ items });
  });

  // ---------------------------------------------------------------------- EPG
  app.get('/api/epg', (req, res) => {
    const now = Date.now();
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(now);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(now + 6 * 3600 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: 'Invalid from/to' });
    }
    const window = guideWindow(from.toISOString(), to.toISOString());
    return res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      channels: window.channels,
      programmes: window.programmes,
      summary: epg.summary(),
      live: live.summary(),
    });
  });

  app.get('/api/epg/now', (req, res) => {
    const remap = channelRemap();
    const entries = epg.now().map((entry) => {
      const channel = remap.get(entry.channel.id);
      // A programme on a station the playlist also carries becomes watchable.
      return channel
        ? {
            ...entry,
            channel: {
              id: channel.id,
              name: channel.name,
              number: channel.number,
              icon: channel.icon || entry.channel.icon || null,
              live: true,
            },
          }
        : { ...entry, channel: { ...entry.channel, live: false } };
    });
    res.json({ now: new Date().toISOString(), entries });
  });

  app.post('/api/epg/refresh', async (req, res) => {
    try {
      const summary = await refreshEpg();
      return res.json({ ok: true, summary });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ----------------------------------------------------------------- live TV
  app.get('/api/live', (req, res) => {
    res.json({
      summary: live.summary(),
      channels: live.channels().map((channel) => ({
        id: channel.id,
        name: channel.name,
        number: channel.number,
        icon: channel.icon,
        group: channel.group,
        tvgId: channel.tvgId,
      })),
    });
  });

  app.post('/api/live/refresh', async (req, res) => {
    try {
      return res.json({ ok: true, summary: await refreshLive() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Where to point hls.js or a <video> for one channel. */
  app.get('/api/live/play/:id', (req, res) => {
    const channel = live.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    return res.json({
      id: channel.id,
      name: channel.name,
      group: channel.group,
      kind: liveKind(channel.url),
      url: `/api/live/proxy?u=${encodeURIComponent(channel.url)}`,
    });
  });

  /**
   * Fetch an upstream stream on the browser's behalf.
   *
   * Playlists are rewritten so every variant and segment comes back through here
   * (see rewritePlaylist); everything else is piped through untouched, including
   * Range requests, which is what makes seeking in a progressive stream work.
   */
  app.get('/api/live/proxy', async (req, res) => {
    let target;
    try {
      target = new URL(String(req.query.u || ''));
    } catch {
      return res.status(400).type('text/plain').send('Missing or invalid u parameter');
    }
    if (!/^https?:$/.test(target.protocol)) {
      return res.status(400).type('text/plain').send('Only http and https streams can be proxied');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const upstream = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'ReelHouse/1.0',
          accept: '*/*',
          ...(req.headers.range ? { range: req.headers.range } : {}),
        },
      });
      clearTimeout(timer);

      const type = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (/mpegurl/.test(type) || /\.m3u8$/i.test(target.pathname)) {
        const text = await upstream.text();
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.setHeader('cache-control', 'no-store');
        return res.send(rewritePlaylist(text, target.toString()));
      }

      res.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('cache-control', 'no-store');
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      clearTimeout(timer);
      if (res.headersSent) return res.end();
      const reason = err.name === 'AbortError' ? 'the stream did not answer in time' : err.message;
      return res.status(502).type('text/plain').send(`Could not reach the stream: ${reason}`);
    }
  });

  // ------------------------------------------------------------------- actions
  app.post('/api/scan', async (req, res) => {
    if (state.scan.running) return res.status(202).json({ ok: true, scan: state.scan });
    runScan();
    return res.status(202).json({ ok: true, scan: state.scan });
  });

  app.get('/api/scan/status', (req, res) => {
    res.json({ scan: state.scan, counts: library.data.counts || null, dirErrors: library.data.dirErrors || [] });
  });

  // ------------------------------------------------------------------- static
  // hls.js ships with the app so transcoded playback also works offline.
  app.get('/vendor/hls.min.js', (req, res) => {
    const file = path.join(APP_ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
    if (!fs.existsSync(file)) return res.status(404).type('text/plain').send('hls.js is not installed');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return fs.createReadStream(file).pipe(res);
  });

  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      lastModified: true,
      // The UI is not content-hashed: never let a stale script outlive an update.
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', /\.(js|css)$/.test(filePath) ? 'no-store' : 'no-cache');
      },
    }),
  );

  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('[server]', err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  // ---------------------------------------------------------------- background
  async function bootstrap() {
    const cfg = config.get();
    if (cfg.scanOnStart) {
      setTimeout(() => runScan(), 400);
    }
    if (cfg.epg.sources.length) {
      setTimeout(() => refreshEpg(), 1200);
    }
    if (cfg.live.sources.length) {
      setTimeout(() => refreshLive(), 1500);
    }
    const hours = Math.max(1, Number(cfg.epg.refreshHours) || 6);
    const timer = setInterval(() => {
      if (config.get().epg.sources.length) refreshEpg();
      if (config.get().live.sources.length) refreshLive();
    }, hours * 3600 * 1000);
    if (timer.unref) timer.unref();
  }

  return { app, bootstrap, state, library, epg, live, tmdb, runScan, refreshEpg, refreshLive };
}

function start({ port, host } = {}) {
  const cfg = config.get();
  const lanAccess = cfg.server.lanAccess === true;
  const listenPort = port || cfg.server.port || 8090;
  // Listening on 0.0.0.0 is what lets a TV on the same network reach the app at
  // all; the loopback default stays for anyone who has not opted in.
  const listenHost = host || (lanAccess ? '0.0.0.0' : cfg.server.host || '127.0.0.1');
  const instance = createApp();

  return new Promise((resolve, reject) => {
    let attempt = 0;

    const listen = () => {
      const port = listenPort + attempt;
      const server = instance.app.listen(port, listenHost);

      server.once('listening', () => {
        const actual = server.address();
        const url = `http://${listenHost === '0.0.0.0' ? 'localhost' : listenHost}:${actual.port}`;
        runtime.host = listenHost;
        runtime.port = actual.port;

        // Advertise on the LAN so the TV app can find this machine without
        // anyone typing an IP address.
        let listener = null;
        if (lanAccess) {
          listener = discovery.start({
            port: actual.port,
            version: require('../package.json').version,
          });
        }
        runtime.discovery = Boolean(listener);
        server.once('close', () => {
          if (listener) listener.close();
          runtime.host = null;
          runtime.port = null;
          runtime.discovery = false;
        });

        instance.bootstrap();
        const lanUrls = lanAccess
          ? discovery.lanAddresses().map((ip) => `http://${ip}:${actual.port}`)
          : [];
        resolve({ ...instance, server, url, port: actual.port, host: listenHost, lanAccess, lanUrls });
      });

      // Another copy of ReelHouse may already own the default port.
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 25) {
          attempt += 1;
          setTimeout(listen, 60);
          return;
        }
        reject(err);
      });
    };

    listen();
  });
}

module.exports = { createApp, start, APP_ROOT, PUBLIC_DIR };
