'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Tmdb } = require('./tmdb');

const VIDEO_FALLBACK = [
  '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.mts', '.flv', '.ogv', '.vob', '.3gp', '.asf', '.rmvb',
  '.divx', '.f4v', '.mxf', '.m2v', '.ogm',
];

const RELEASE_TAGS =
  /\b(2160p|1080p|720p|480p|4k|uhd|hdr10|hdr|dv|dolby\s?vision|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|dvdrip|hdrip|remux|x264|x265|h264|h265|hevc|avc|10bit|8bit|aac|ac3|dts|dd5\.?1|ddp5\.?1|atmos|proper|repack|extended|unrated|limited|internal|amzn|nf|dsnp|hmax|atvp|multi|dual\s?audio)\b/gi;

function hashId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function cleanTitle(raw) {
  let title = String(raw || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, (m) => (/^\s*\(\s*\d{4}\s*\)\s*$/.test(m) ? m : ' '))
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(new RegExp(RELEASE_TAGS.source, 'gi'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return title;
}

/** Extract "Title (2019)" / "Title.2019.1080p" style title + year. */
function parseMovieName(filename) {
  const base = path.basename(filename, path.extname(filename));
  let year = null;
  const paren = base.match(/[([{]\s*((?:19|20)\d{2})\s*[)\]}]/);
  const loose = base.match(/(?:^|[.\s_-])((?:19|20)\d{2})(?=[.\s_-]|$)/g);
  if (paren) {
    year = Number(paren[1]);
  } else if (loose) {
    // Prefer the last plausible year so "2001 A Space Odyssey 1968" resolves right.
    const years = loose.map((m) => Number(m.replace(/[^0-9]/g, ''))).filter(Boolean);
    year = years.length ? years[years.length - 1] : null;
  }
  let title = base;
  if (paren) {
    title = base.slice(0, base.indexOf(paren[0]));
  } else if (year) {
    const idx = base.search(new RegExp(`[.\\s_-]${year}(?=[.\\s_-]|$)`));
    title = idx > 0 ? base.slice(0, idx) : base;
  }
  title = cleanTitle(title);
  if (!title) title = cleanTitle(base);
  return { title, year: year && year > 1900 && year < 2100 ? year : null };
}

const SEASON_EPISODE_PATTERNS = [
  /[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})/,
  /[Ss]eason[\s._-]*(\d{1,2})[\s._-]*[Ee]pisode[\s._-]*(\d{1,3})/i,
  /(?:^|[^\d])(\d{1,2})[xX](\d{2,3})(?:[^\d]|$)/,
  /[Ee]pisode[\s._-]*(\d{1,3})/i,
];

function parseEpisodeName(filename) {
  const base = path.basename(filename, path.extname(filename));
  for (const re of SEASON_EPISODE_PATTERNS) {
    const m = base.match(re);
    if (!m) continue;
    if (re.source.includes('Episode') && !re.source.includes('Season')) {
      return { season: null, episode: Number(m[1]), leftover: base.slice(0, m.index) };
    }
    return { season: Number(m[1]), episode: Number(m[2]), leftover: base.slice(m.index + m[0].length) };
  }
  return null;
}

function episodeTitleFromFilename(filename, parsed) {
  if (!parsed) return null;
  let rest = parsed.leftover
    .replace(/^[\s._-]+/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(new RegExp(RELEASE_TAGS.source, 'gi'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Strip a stray "- " separator common in "Show - S01E02 - Title.mkv".
  rest = rest.replace(/^-\s*/, '').trim();
  if (!rest || rest.length < 2) return null;
  return rest;
}

function walk(dir, extensions, depth = 0, out = [], limit = 12) {
  if (depth > limit) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, depth + 1, out, limit);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext) && !entry.name.startsWith('._')) out.push(full);
    }
  }
  return out;
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** Find the show folder for a file: walk up past "Season 01" style folders. */
function showFolderFor(file, root) {
  let dir = path.dirname(file);
  const seasonRe = /^(season|series|s)\s*\d{1,3}$/i;
  while (dir.length > root.length && seasonRe.test(path.basename(dir))) {
    dir = path.dirname(dir);
  }
  if (dir === root || !dir.startsWith(root)) {
    // File sits directly in the media root: no folder to name it after.
    return null;
  }
  return dir;
}

function seasonNumberFromPath(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 4; i += 1) {
    const m = path.basename(dir).match(/(?:season|series|s)\s*(\d{1,3})/i);
    if (m) return Number(m[1]);
    if (dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return null;
}

function yearFromPath(dir) {
  const m = path.basename(dir).match(/[([{]\s*((?:19|20)\d{2})\s*[)\]}]/) || path.basename(dir).match(/(?:^|[.\s_-])((?:19|20)\d{2})$/);
  return m ? Number(m[1]) : null;
}

function licenceSafe(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function sortTitleFor(title) {
  return licenceSafe(title).toLowerCase().replace(/^(the|a|an)\s+/, '');
}

class Scanner {
  constructor({ tmdb }) {
    this.tmdb = tmdb;
  }

  /**
   * Scan all configured folders.
   * @param {{mediaDirs: Array, extensions: string[]}} options
   * @param {(progress: object) => void} onProgress
   */
  async scan({ mediaDirs = [], extensions = VIDEO_FALLBACK }, onProgress = () => {}) {
    const startedAt = Date.now();
    const files = [];
    const dirErrors = [];

    onProgress({ phase: 'walking', message: 'Looking for media files…', found: 0, total: 0 });

    for (const dir of mediaDirs) {
      if (!dir || !dir.path) continue;
      if (!fs.existsSync(dir.path)) {
        dirErrors.push(`${dir.path} (not found)`);
        continue;
      }
      const type = dir.type || 'auto';
      const found = walk(dir.path, extensions);
      for (const file of found) {
        const ep = parseEpisodeName(file);
        const resolvedType = type === 'auto' ? (ep ? 'tv' : 'movies') : type;
        files.push({ file, root: dir.path, type: resolvedType, episode: ep });
      }
    }

    onProgress({ phase: 'parsing', message: `Found ${files.length} video file(s)`, found: files.length, total: files.length });

    const movieFiles = files.filter((f) => f.type === 'movies');
    const tvFiles = files.filter((f) => f.type === 'tv');

    const movies = await this.#buildMovies(movieFiles, onProgress, movieFiles.length + tvFiles.length);
    const shows = await this.#buildShows(tvFiles, onProgress, movieFiles.length + tvFiles.length);

    const result = {
      version: 1,
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - startedAt,
      movies,
      shows,
      dirErrors,
      counts: {
        movies: movies.length,
        shows: shows.length,
        episodes: shows.reduce((n, s) => n + s.seasons.reduce((m, se) => m + se.episodes.length, 0), 0),
        files: files.length,
      },
    };

    onProgress({
      phase: 'done',
      message: `Library ready: ${result.counts.movies} movies, ${result.counts.shows} shows`,
      found: files.length,
      total: files.length,
      counts: result.counts,
    });

    return result;
  }

  async #buildMovies(files, onProgress, total) {
    const movies = [];
    const base = [];
    for (const entry of files) {
      const stat = statSafe(entry.file);
      const { title, year } = parseMovieName(entry.file);
      base.push({
        entry,
        title,
        year,
        size: stat ? stat.size : 0,
        addedAt: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
      });
    }

    let done = 0;
    for (const item of base) {
      const relPath = path.relative(item.entry.root, item.entry.file);
      const id = hashId(item.entry.file);
      let meta = null;
      if (this.tmdb.enabled) {
        const hit = await this.tmdb.searchMovie(item.title, item.year);
        if (hit) meta = await this.tmdb.movie(hit.id);
      }
      const art = Tmdb.art(meta);
      movies.push({
        id,
        kind: 'movie',
        title: (meta && meta.title) || item.title,
        sortTitle: sortTitleFor((meta && meta.title) || item.title),
        year: item.year || (meta && meta.release_date ? Number(meta.release_date.slice(0, 4)) : null),
        file: item.entry.file,
        relPath,
        root: item.entry.root,
        size: item.size,
        addedAt: item.addedAt,
        overview: meta ? meta.overview : null,
        tagline: meta ? meta.tagline : null,
        rating: meta ? Number(meta.vote_average) || null : null,
        runtime: meta ? Number(meta.runtime) || null : null,
        genres: meta && meta.genres ? meta.genres.map((g) => g.name) : [],
        releaseDate: meta ? meta.release_date : null,
        tmdbId: meta ? meta.id : null,
        poster: art.poster,
        backdrop: art.backdrop,
        logo: art.logo,
        hasArt: Boolean(art.poster || art.backdrop),
      });
      done += 1;
      onProgress({
        phase: 'metadata',
        message: `Movie ${done} of ${base.length}: ${item.title}`,
        found: total,
        total,
        item: item.title,
      });
    }
    return movies.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }

  async #buildShows(files, onProgress, total) {
    // Group files by show folder (or by parsed title when sitting in the root).
    const groups = new Map();
    for (const entry of files) {
      const parsed = entry.episode;
      const folder = showFolderFor(entry.file, entry.root);
      let showKey;
      let showName;
      if (folder) {
        // "Severance (2022)" → title "Severance", year captured separately.
        showName = cleanTitle(path.basename(folder).replace(/[([{]\s*((?:19|20)\d{2})\s*[)\]}]/g, ' '));
        showKey = folder.toLowerCase();
      } else {
        const baseName = path.basename(entry.file, path.extname(entry.file));
        const cut = parsed ? baseName.slice(0, Math.max(0, baseName.search(/[Ss]\d{1,2}[\s._-]*[Ee]\d{1,3}|(\d{1,2})[xX](\d{2,3})/))) : baseName;
        showName = cleanTitle(cut) || cleanTitle(baseName);
        showKey = `name:${licenceSafe(showName).toLowerCase()}`;
      }
      if (!groups.has(showKey)) {
        groups.set(showKey, { key: showKey, name: showName, folder: folder || entry.root, year: folder ? yearFromPath(folder) : null, files: [] });
      }
      groups.get(showKey).files.push(entry);
    }

    const shows = [];
    for (const group of groups.values()) {
      let meta = null;
      if (this.tmdb.enabled) {
        const hit = await this.tmdb.searchTv(group.name);
        if (hit) meta = await this.tmdb.tv(hit.id);
      }

      const art = Tmdb.art(meta);
      const show = {
        id: hashId(`tv:${group.key}`),
        kind: 'show',
        title: (meta && meta.name) || group.name,
        sortTitle: sortTitleFor((meta && meta.name) || group.name),
        year: group.year || (meta && meta.first_air_date ? Number(meta.first_air_date.slice(0, 4)) : null),
        folder: group.folder,
        overview: meta ? meta.overview : null,
        rating: meta ? Number(meta.vote_average) || null : null,
        genres: meta && meta.genres ? meta.genres.map((g) => g.name) : [],
        status: meta ? meta.status : null,
        releaseDate: meta ? meta.first_air_date : null,
        tmdbId: meta ? meta.id : null,
        poster: art.poster,
        backdrop: art.backdrop,
        logo: art.logo,
        hasArt: Boolean(art.poster || art.backdrop),
        seasons: [],
      };

      const bySeason = new Map();
      for (const entry of group.files) {
        const parsed = entry.episode || {};
        const season = parsed.season || seasonNumberFromPath(entry.file) || 1;
        const episode = parsed.episode || 1;
        if (!bySeason.has(season)) bySeason.set(season, []);
        bySeason.get(season).push({ entry, episode, parsed });
      }

      for (const [seasonNumber, eps] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
        let seasonMeta = null;
        if (meta && this.tmdb.enabled) {
          seasonMeta = await this.tmdb.season(meta.id, seasonNumber);
        }
        const episodes = [];
        for (const { entry, episode, parsed } of eps.sort((a, b) => a.episode - b.episode)) {
          const stat = statSafe(entry.file);
          const tmdbEp = seasonMeta && Array.isArray(seasonMeta.episodes)
            ? seasonMeta.episodes.find((e) => Number(e.episode_number) === episode)
            : null;
          episodes.push({
            id: hashId(entry.file),
            season: seasonNumber,
            episode,
            title: (tmdbEp && tmdbEp.name) || episodeTitleFromFilename(entry.file, parsed) || `Episode ${episode}`,
            overview: tmdbEp ? tmdbEp.overview : null,
            still: tmdbEp ? tmdbEp.still_path : null,
            airDate: tmdbEp ? tmdbEp.air_date : null,
            runtime: tmdbEp ? Number(tmdbEp.runtime) || null : null,
            file: entry.file,
            size: stat ? stat.size : 0,
            addedAt: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
          });
        }
        show.seasons.push({
          number: seasonNumber,
          name: (seasonMeta && seasonMeta.name) || `Season ${seasonNumber}`,
          overview: seasonMeta ? seasonMeta.overview : null,
          poster: seasonMeta ? seasonMeta.poster_path : null,
          episodes,
        });
        onProgress({
          phase: 'metadata',
          message: `Show ${shows.length + 1}: ${show.title} — season ${seasonNumber}`,
          found: total,
          total,
          item: show.title,
        });
      }

      show.episodeCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
      show.addedAt = show.seasons
        .flatMap((s) => s.episodes.map((e) => e.addedAt))
        .sort()
        .pop() || new Date().toISOString();
      show.seasonCount = show.seasons.length;
      shows.push(show);
    }

    return shows.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }
}

module.exports = { Scanner, parseMovieName, parseEpisodeName, cleanTitle, hashId, walk, SEASON_EPISODE_PATTERNS };
