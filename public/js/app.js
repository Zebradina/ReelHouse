import {
  api,
  art,
  escapeHtml,
  tintFor,
  formatRuntime,
  formatTime,
  formatDate,
} from './api.js';

/* ============================================================
   State + helpers
   ============================================================ */

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const scanStrip = document.getElementById('scan-strip');
const scanStripText = document.getElementById('scan-strip-text');
const scanBtn = document.getElementById('scan-btn');
const toasts = document.getElementById('toasts');
const sheet = document.getElementById('sheet');
const sheetBackdrop = document.getElementById('sheet-backdrop');

const state = {
  library: null,
  status: null,
  progress: {},
  subtitlePref: null,
  playerTimer: null,
  heroTimer: null,
  guideDay: 0,
  scanPoll: null,
  lastScanReport: null,
  movieMap: new Map(),
  showMap: new Map(),
  episodeMap: new Map(),
  discover: null,
};

/** Languages offered for TMDB metadata. */
const TMDB_LANGUAGES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'sv-SE', 'pl-PL', 'ja-JP'];

/** Where the transcoder's binaries came from, in plain words. */
function playbackSource(source) {
  if (source === 'bundled') return 'bundled';
  if (source === 'env') return 'from FFMPEG_PATH';
  if (source === 'system') return 'system';
  return 'unknown';
}

function esc(value) {
  return escapeHtml(value);
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = message;
  toasts.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s ease, transform .25s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, 3400);
}

function clearTransient() {
  if (state.heroTimer) clearInterval(state.heroTimer);
  if (state.playerTimer) clearInterval(state.playerTimer);
  if (state.playerCleanup) state.playerCleanup();
  state.heroTimer = null;
  state.playerTimer = null;
  state.playerCleanup = null;
  document.body.classList.remove('playing');
  closeSheet();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function tintStyle(value) {
  return `--tint:${tintFor(value)}`;
}

function backdropUrl(item, size = 'w1280') {
  return item && item.backdrop ? art(item.backdrop, size) : null;
}

function posterUrl(item, size = 'w342') {
  return item && item.poster ? art(item.poster, size) : null;
}

function firstEpisode(show) {
  if (!show || !Array.isArray(show.seasons)) return null;
  for (const season of show.seasons) {
    if (season.episodes && season.episodes.length) return { season, episode: season.episodes[0] };
  }
  return null;
}

function episodeLabel(show, season, episode) {
  return `${show.title} · S${pad(season)}E${pad(episode)}`;
}

function progressFor(id) {
  const entry = state.progress[id];
  if (!entry || !entry.duration) return null;
  return Math.min(1, entry.position / entry.duration);
}

/**
 * Has this item been watched far enough to be worth resuming? Short items use a
 * percentage gate so a 10-minute episode still lands in Continue watching.
 */
function isResumable(entry) {
  if (!entry || entry.finished || !entry.duration) return false;
  const threshold = Math.min(30, entry.duration * 0.1);
  return entry.position > threshold && entry.position / entry.duration < 0.95;
}

/* ============================================================
   Components
   ============================================================ */

function posterImage(item, size = 'w342') {
  const src = posterUrl(item, size);
  if (src) {
    return `<img src="${src}" alt="${esc(item.title)} poster" loading="lazy" decoding="async"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="poster-fallback" style="${tintStyle(item.title)};display:none"><span>${esc(item.title)}</span></div>`;
  }
  return `<div class="poster-fallback" style="${tintStyle(item.title)}"><span>${esc(item.title)}</span></div>`;
}

function mediaCard(item, kind, opts = {}) {
  const showHref = kind === 'movie' ? `#/movie/${item.id}` : `#/show/${item.id}`;
  const href = opts.href || showHref;
  const meta = [];
  if (item.year) meta.push(item.year);
  if (kind === 'show') {
    const seasons = item.seasonCount || (item.seasons ? item.seasons.length : 0);
    if (seasons) meta.push(`${seasons} season${seasons > 1 ? 's' : ''}`);
    if (item.rating) meta.push(`★ ${Number(item.rating).toFixed(1)}`);
  } else {
    if (item.runtime) meta.push(formatRuntime(item.runtime));
    if (item.rating) meta.push(`★ ${Number(item.rating).toFixed(1)}`);
  }
  const fraction = opts.progress ?? progressFor(item.id);
  return `
    <a class="card" href="${href}" title="${esc(item.title)}">
      <div class="poster">
        ${posterImage(item)}
        ${item.year ? `<span class="poster-badge">${item.year}</span>` : ''}
        ${fraction ? `<div class="poster-progress"><i style="width:${Math.round(fraction * 100)}%"></i></div>` : ''}
        <span class="poster-play"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg></span></span>
      </div>
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-meta">${meta.map(esc).join('<span class="dot-sep"></span>')}</div>
    </a>`;
}

function wideCard({ href, title, subtitle, backdrop, poster, tint, progress, badge }) {
  const src = backdrop ? art(backdrop, 'w780') : poster ? art(poster, 'w342') : null;
  const image = src
    ? `<img src="${src}" alt="" loading="lazy" onerror="this.remove()">`
    : `<div class="poster-fallback" style="${tintStyle(tint || title)}"><span>${esc(title)}</span></div>`;
  return `
    <a class="card card-wide" href="${href}" title="${esc(title)}">
      <div class="frame">
        ${image}
        ${badge ? `<span class="poster-badge">${esc(badge)}</span>` : ''}
        ${progress ? `<div class="progress"><i style="width:${Math.round(progress * 100)}%"></i></div>` : ''}
      </div>
      <div class="card-title">${esc(title)}</div>
      <div class="card-meta">${esc(subtitle || '')}</div>
    </a>`;
}

function sectionHead(title, link) {
  return `
    <div class="section-head">
      <h2>${esc(title)}</h2>
      ${link ? `<a class="see-all" href="${link.href}">${esc(link.label)} →</a>` : ''}
    </div>`;
}

function emptyState({ title, message, actionLabel, actionHref, actionAttr = '', icon = 'film' }) {
  const icons = {
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 4v5M16 4v5M3 15h18M8 20v-5M16 20v-5"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><path d="M8 21h8M8 2.8l4 3.2 4-3.2"/></svg>',
    guide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4.5" width="18" height="15.5" rx="2.5"/><path d="M3 9.5h18M8 4.5V2.5M16 4.5V2.5M7 13h4M7 16.5h7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11.5v5M9.5 14h5"/></svg>',
  };
  const cta = actionHref
    ? `<a class="btn btn-primary" href="${actionHref}">${esc(actionLabel)}</a>`
    : actionLabel
      ? `<button class="btn btn-primary" ${actionAttr}>${esc(actionLabel)}</button>`
      : '';
  return `
    <div class="empty">
      <div class="empty-icon">${icons[icon] || icons.film}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${cta}
    </div>`;
}

function heroMarkup(item, kind) {
  const bg = backdropUrl(item);
  const logo = item.logo ? art(item.logo, 'w500') : null;
  const media = bg
    ? `<div class="hero-media"><img src="${bg}" alt="" onerror="this.parentElement.innerHTML=''"></div>`
    : `<div class="hero-media"><div style="position:absolute;inset:0;background:
        radial-gradient(90% 120% at 18% 12%, hsl(${tintFor(item.title)} 46% 30%), transparent 62%),
        linear-gradient(155deg, hsl(${tintFor(item.title)} 40% 17%), #0a0b0f 78%)"></div></div>`;
  const href = kind === 'movie' ? `#/movie/${item.id}` : `#/show/${item.id}`;
  const play = kind === 'movie'
    ? `#/watch/movie/${item.id}`
    : (() => {
        const first = firstEpisode(item);
        return first ? `#/watch/episode/${first.episode.id}` : href;
      })();

  const tags = [];
  if (item.year) tags.push(`<span>${item.year}</span>`);
  if (item.rating) tags.push(`<span class="chip rating">★ ${Number(item.rating).toFixed(1)}</span>`);
  if (kind === 'show') {
    const seasons = item.seasonCount || (item.seasons || []).length;
    if (seasons) tags.push(`<span>${seasons} season${seasons > 1 ? 's' : ''}</span>`);
    if (item.episodeCount) tags.push(`<span>${item.episodeCount} episodes</span>`);
  } else if (item.runtime) {
    tags.push(`<span>${formatRuntime(item.runtime)}</span>`);
  }
  if (item.genres && item.genres.length) tags.push(`<span class="chip">${esc(item.genres.slice(0, 2).join(' · '))}</span>`);
  if (item.status) tags.push(`<span class="chip">${esc(item.status)}</span>`);

  return `
    ${media}
    <div class="hero-grain"></div>
    <div class="hero-content">
      <p class="eyebrow">${kind === 'movie' ? 'Now in your library' : 'TV series'}</p>
      ${logo
        ? `<img class="hero-logo" src="${logo}" alt="${esc(item.title)}" onerror="this.remove()">`
        : `<h1 class="hero-title">${esc(item.title)}</h1>`}
      <div class="hero-tags">${tags.join('<span class="dot-sep"></span>')}</div>
      ${item.overview ? `<p class="hero-overview">${esc(item.overview)}</p>` : ''}
      <div class="hero-actions">
        <a class="btn btn-primary" href="${play}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg>
          ${kind === 'movie' ? 'Play' : 'Play S' + pad(firstEpisode(item)?.season.number || 1) + 'E' + pad(firstEpisode(item)?.episode.episode || 1)}
        </a>
        <a class="btn btn-ghost" href="${href}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/></svg>
          More info
        </a>
      </div>
    </div>`;
}

function loadingCards(count = 8) {
  return `<div class="loading-row">${Array.from({ length: count }, () => '<div class="skeleton"></div>').join('')}</div>`;
}

/* ============================================================
   Data loading
   ============================================================ */

function indexLibrary(library) {
  state.library = library;
  state.movieMap.clear();
  state.showMap.clear();
  state.episodeMap.clear();
  for (const movie of library.movies || []) state.movieMap.set(movie.id, movie);
  for (const show of library.shows || []) {
    state.showMap.set(show.id, show);
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) state.episodeMap.set(episode.id, { ...episode, show, seasonNumber: season.number });
    }
  }
}

async function loadLibrary() {
  try {
    indexLibrary(await api.library());
  } catch (err) {
    toast(`Could not load library: ${err.message}`, 'error');
  }
}

async function loadProgress() {
  try {
    const data = await api.progress();
    state.progress = data.items || {};
  } catch {
    state.progress = {};
  }
}

/* ============================================================
   Home
   ============================================================ */

async function renderHome() {
  const lib = state.library || { movies: [], shows: [], counts: {} };
  const items = [
    ...(lib.movies || []).map((m) => ({ item: m, kind: 'movie' })),
    ...(lib.shows || []).map((s) => ({ item: s, kind: 'show' })),
  ].sort((a, b) => new Date(b.item.addedAt || 0) - new Date(a.item.addedAt || 0));

  if (items.length === 0) {
    view.innerHTML = `
      <div class="page fade-in">
        <div class="empty" style="margin-top:40px">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21"/></svg>
          </div>
          <h3>Welcome to ReelHouse</h3>
          <p>Your media stays on this machine. Point ReelHouse at your movie and TV folders, and it will organise everything, pull in artwork from TMDB, stream it in the built-in player, and fill the TV guide from your XMLTV feed.</p>
          <div class="row-actions" style="justify-content:center">
            <a class="btn btn-primary" href="#/settings">Add media folders</a>
            <button class="btn btn-ghost" id="empty-scan">Scan now</button>
          </div>
        </div>
      </div>`;
    const scan = document.getElementById('empty-scan');
    if (scan) scan.addEventListener('click', triggerScan);
    return;
  }

  const heroItems = items.slice(0, 6);

  view.innerHTML = `
    <section class="hero fade-in" id="hero"></section>
    <div class="page page-tight">
      <div id="continue-section"></div>
      <section class="section" id="movies-section">
        ${sectionHead('Recently added movies', { href: '#/movies', label: 'All movies' })}
        <div class="row-scroll">
          ${(lib.movies || []).slice(0, 14).map((m) => mediaCard(m, 'movie')).join('') || `<p class="muted tiny">No movies yet.</p>`}
        </div>
      </section>
      <section class="section">
        ${sectionHead('TV shows', { href: '#/shows', label: 'All shows' })}
        <div class="row-scroll">
          ${(lib.shows || []).slice(0, 14).map((s) => mediaCard(s, 'show')).join('') || `<p class="muted tiny">No shows yet.</p>`}
        </div>
      </section>
      <section class="section" id="on-now-section"></section>
    </div>`;

  mountHero(heroItems);
  mountContinue();
  mountOnNow();
}

function mountHero(items) {
  const hero = document.getElementById('hero');
  if (!hero) return;
  let index = 0;

  hero.innerHTML = `<div id="hero-slide">${heroMarkup(items[0].item, items[0].kind)}</div>
    <div class="hero-dots" id="hero-dots">${items.map((_, i) => `<button class="hero-dot ${i === 0 ? 'active' : ''}" data-index="${i}" aria-label="Featured item ${i + 1}"></button>`).join('')}</div>`;

  const paint = (next) => {
    index = next;
    const slide = document.getElementById('hero-slide');
    if (!slide) return;
    slide.innerHTML = heroMarkup(items[index].item, items[index].kind);
    hero.querySelectorAll('.hero-dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
  };

  hero.querySelectorAll('.hero-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      paint(Number(dot.dataset.index));
      restart();
    });
  });

  const restart = () => {
    if (state.heroTimer) clearInterval(state.heroTimer);
    if (items.length < 2) return;
    state.heroTimer = setInterval(() => {
      // Rotating replaces the slide's DOM, which destroys the Play button. On a
      // TV the button may be the focused element, and taking it away drops focus
      // to <body> — so never rotate while the viewer is inside the hero.
      if (hero.contains(document.activeElement)) return;
      paint((index + 1) % items.length);
    }, 9000);
  };
  restart();
}

async function mountContinue() {
  const holder = document.getElementById('continue-section');
  if (!holder) return;
  let items = [];
  try {
    const data = await api.continueWatching();
    items = data.items || [];
  } catch {
    return;
  }
  if (!items.length) {
    holder.innerHTML = '';
    return;
  }
  holder.innerHTML = `
    <section class="section" style="margin-top:0">
      ${sectionHead('Continue watching')}
      <div class="row-scroll row-wide">
        ${items.map((entry) => {
          const episode = state.episodeMap.get(entry.id);
          const movie = state.movieMap.get(entry.id);
          const href = entry.kind === 'episode' || episode
            ? `#/watch/episode/${entry.id}`
            : `#/watch/movie/${entry.id}`;
          const title = entry.title || (movie && movie.title) || (episode && episode.title) || 'Resume';
          const remaining = entry.duration ? Math.max(0, entry.duration - entry.position) : 0;
          const left = remaining ? `${remaining < 60 ? '<1m' : formatRuntime(remaining / 60)} left` : '';
          return `<div class="continue-item">
            ${wideCard({
              href,
              title,
              subtitle: [entry.subtitle || (movie ? 'Movie' : ''), left].filter(Boolean).join(' · '),
              backdrop: entry.backdrop || (movie && movie.backdrop) || (episode && episode.show.backdrop),
              poster: entry.poster || (movie && movie.poster),
              progress: entry.duration ? entry.position / entry.duration : null,
              badge: 'Resume',
            })}
            <button class="continue-remove" type="button" data-id="${esc(entry.id)}"
              title="Remove from Continue watching"
              aria-label="Remove ${esc(title)} from Continue watching">×</button>
          </div>`;
        }).join('')}
      </div>
    </section>`;

  // Forget a resume point without touching the file or the rest of the library.
  holder.querySelectorAll('.continue-remove').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try {
        await api.removeProgress(button.dataset.id);
        delete state.progress[button.dataset.id];
        await mountContinue();
      } catch (err) {
        toast(`Could not remove: ${err.message}`, 'error');
        button.disabled = false;
      }
    });
  });
}

async function mountOnNow() {
  const holder = document.getElementById('on-now-section');
  if (!holder) return;
  let entries = [];
  try {
    const data = await api.epgNow();
    entries = data.entries || [];
  } catch {
    entries = [];
  }
  if (!entries.length) {
    holder.innerHTML = '';
    return;
  }
  holder.innerHTML = `
    ${sectionHead('On TV now', { href: '#/guide', label: 'Open TV guide' })}
    <div class="row-scroll row-wide">
      ${entries.slice(0, 12).map(({ channel, programme }) => {
        const start = new Date(programme.start);
        const stop = new Date(programme.stop);
        const pct = Math.min(1, Math.max(0, (Date.now() - start) / (stop - start)));
        return `<button class="card card-wide" data-now="${esc(programme.title)}" data-channel="${esc(channel.name)}"
            data-start="${esc(programme.start)}" data-stop="${esc(programme.stop)}" data-desc="${esc(programme.desc || '')}">
          <div class="frame">
            <div class="poster-fallback" style="${tintStyle(channel.name + programme.title)};align-items:flex-start;justify-content:flex-end">
              <span style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin-bottom:auto">${esc(channel.name)}</span>
              <span style="font-size:16px">${esc(programme.title)}</span>
            </div>
            <span class="poster-badge" style="background:rgba(240,182,75,.16);color:var(--accent);border-color:rgba(240,182,75,.35)">LIVE</span>
            <div class="progress"><i style="width:${Math.round(pct * 100)}%"></i></div>
          </div>
          <div class="card-title">${esc(programme.title)}</div>
          <div class="card-meta">${esc(channel.name)} · ${formatTime(programme.start)} – ${formatTime(programme.stop)}</div>
        </button>`;
      }).join('')}
    </div>`;

  holder.querySelectorAll('[data-now]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openSheet({
        eyebrow: btn.dataset.channel,
        title: btn.dataset.now,
        subtitle: `${formatTime(btn.dataset.start)} – ${formatTime(btn.dataset.stop)} · On now`,
        description: btn.dataset.desc,
      });
    });
  });
}

/* ============================================================
   Library pages
   ============================================================ */

async function renderCollection(kind) {
  const lib = state.library || { movies: [], shows: [] };
  const isMovies = kind === 'movies';
  const items = isMovies ? lib.movies || [] : lib.shows || [];
  const title = isMovies ? 'Movies' : 'TV Shows';
  const counts = (state.library && state.library.counts) || {};

  view.innerHTML = `
    <div class="page fade-in">
      <div class="page-head">
        <div>
          <h1>${title}</h1>
          <p>${isMovies
            ? `${items.length} title${items.length === 1 ? '' : 's'}${counts.files ? ` · ${counts.files} video files indexed` : ''}`
            : `${items.length} series${counts.episodes ? ` · ${counts.episodes} episodes` : ''}`}</p>
        </div>
        <div class="row-actions" style="margin:0">
          <select class="select" id="sort" style="width:170px;height:36px">
            <option value="recent">Recently added</option>
            <option value="title">Title A–Z</option>
            <option value="year">Year (newest)</option>
            <option value="rating">Rating</option>
          </select>
          <button class="btn btn-quiet" id="rescan">Rescan</button>
        </div>
      </div>
      <div id="collection-grid">${
        items.length ? `<div class="grid">${items.map((i) => mediaCard(i, isMovies ? 'movie' : 'show')).join('')}</div>` :
        emptyState({
          title: isMovies ? 'No movies indexed yet' : 'No TV shows indexed yet',
          message: isMovies
            ? 'Add a folder containing movies to Settings, then rescan. File names like “Blade Runner (1982).mkv” match best; TMDB lookups use the title and year.'
            : 'Add a folder containing TV series to Settings. ReelHouse reads “Show Name/Season 01/Show Name - S01E02 - Title.mkv” style folders.',
          actionLabel: 'Open settings',
          actionHref: '#/settings',
          icon: isMovies ? 'film' : 'tv',
        })
      }</div>
    </div>`;

  const sort = document.getElementById('sort');
  const grid = document.getElementById('collection-grid');
  sort.addEventListener('change', () => {
    const sorted = [...items];
    if (sort.value === 'title') sorted.sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title));
    if (sort.value === 'year') sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
    if (sort.value === 'rating') sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    grid.innerHTML = `<div class="grid">${sorted.map((i) => mediaCard(i, isMovies ? 'movie' : 'show')).join('')}</div>`;
  });

  document.getElementById('rescan').addEventListener('click', triggerScan);
}

/* ============================================================
   Detail pages
   ============================================================ */

async function renderMovie(id) {
  const movie = state.movieMap.get(id);
  if (!movie) {
    view.innerHTML = `<div class="page"><div class="empty"><h3>Movie not found</h3><p>It may have been removed from disk. Try rescanning your library.</p><a class="btn btn-primary" href="#/movies">Back to movies</a></div></div>`;
    return;
  }

  const saved = state.progress[movie.id];
  const resume = isResumable(saved);

  const facts = [
    ['Released', movie.releaseDate ? formatDate(movie.releaseDate) : movie.year || '—'],
    ['Runtime', movie.runtime ? formatRuntime(movie.runtime) : '—'],
    ['Rating', movie.rating ? `★ ${Number(movie.rating).toFixed(1)} / 10` : '—'],
    ['Genres', movie.genres && movie.genres.length ? movie.genres.join(', ') : '—'],
  ];

  const bg = backdropUrl(movie, 'w1280');
  view.innerHTML = `
    <article class="fade-in">
      <div class="detail-hero">
        <div class="detail-hero-bg" style="${bg
          ? `background-image:url('${bg}')`
          : `background:radial-gradient(80% 110% at 30% 10%, hsl(${tintFor(movie.title)} 45% 28%), #0a0b0f 74%)`}"></div>
        <div class="detail-inner">
          <div class="detail-poster">${posterImage(movie, 'w500')}</div>
          <div class="detail-copy">
            ${movie.logo
              ? `<img class="detail-logo" src="${art(movie.logo, 'w500')}" alt="${esc(movie.title)}" onerror="this.remove()">`
              : `<h1>${esc(movie.title)}</h1>`}
            ${movie.tagline ? `<p class="muted" style="margin:0 0 10px;font-size:13px;font-style:italic">“${esc(movie.tagline)}”</p>` : ''}
            <div class="detail-meta">
              ${movie.year ? `<span>${movie.year}</span><span class="dot-sep"></span>` : ''}
              ${movie.runtime ? `<span>${formatRuntime(movie.runtime)}</span><span class="dot-sep"></span>` : ''}
              ${movie.rating ? `<span class="chip rating">★ ${Number(movie.rating).toFixed(1)}</span>` : ''}
              ${(movie.genres || []).slice(0, 3).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
            </div>
            ${movie.overview ? `<p class="detail-overview">${esc(movie.overview)}</p>` : `<p class="detail-overview muted">No synopsis yet. Add a TMDB API key in Settings to fetch artwork and descriptions for your library.</p>`}
            <div class="detail-actions">
              <a class="btn btn-primary" href="#/watch/movie/${movie.id}">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg>
                ${resume ? `Resume ${formatTimeFromSeconds(saved.position)}` : 'Play'}
              </a>
              <a class="btn btn-ghost" href="#/movies">Back to movies</a>
            </div>
          </div>
        </div>
      </div>
      <div class="detail-body">
        <dl class="detail-facts">
          ${facts.map(([k, v]) => `<div class="fact"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        <p class="tiny muted" style="margin-top:14px">File: <span class="mono">${esc(movie.relPath || '')}</span></p>
      </div>
    </article>`;
}

function formatTimeFromSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

async function renderShow(id) {
  const show = state.showMap.get(id);
  if (!show) {
    view.innerHTML = `<div class="page"><div class="empty"><h3>Show not found</h3><p>It may have been removed from disk. Try rescanning your library.</p><a class="btn btn-primary" href="#/shows">Back to shows</a></div></div>`;
    return;
  }

  const bg = backdropUrl(show, 'w1280');
  const first = firstEpisode(show);

  // The newest episode the viewer has part-watched, so the page can offer
  // "Continue S01E03" instead of always starting at episode one.
  let inProgress = null;
  for (const season of show.seasons || []) {
    for (const episode of season.episodes || []) {
      const entry = state.progress[episode.id];
      if (!isResumable(entry)) continue;
      if (!inProgress || new Date(entry.updatedAt) > new Date(inProgress.entry.updatedAt)) {
        inProgress = { season, episode, entry };
      }
    }
  }

  view.innerHTML = `
    <article class="fade-in">
      <div class="detail-hero">
        <div class="detail-hero-bg" style="${bg
          ? `background-image:url('${bg}')`
          : `background:radial-gradient(80% 110% at 30% 10%, hsl(${tintFor(show.title)} 45% 28%), #0a0b0f 74%)`}"></div>
        <div class="detail-inner">
          <div class="detail-poster">${posterImage(show, 'w500')}</div>
          <div class="detail-copy">
            ${show.logo
              ? `<img class="detail-logo" src="${art(show.logo, 'w500')}" alt="${esc(show.title)}" onerror="this.remove()">`
              : `<h1>${esc(show.title)}</h1>`}
            <div class="detail-meta">
              ${show.year ? `<span>${show.year}</span><span class="dot-sep"></span>` : ''}
              <span>${show.seasonCount || (show.seasons || []).length} season${(show.seasonCount || (show.seasons || []).length) === 1 ? '' : 's'}</span>
              <span class="dot-sep"></span>
              <span>${show.episodeCount || 0} episodes</span>
              ${show.rating ? `<span class="chip rating">★ ${Number(show.rating).toFixed(1)}</span>` : ''}
              ${show.status ? `<span class="chip">${esc(show.status)}</span>` : ''}
              ${(show.genres || []).slice(0, 2).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}
            </div>
            ${show.overview ? `<p class="detail-overview">${esc(show.overview)}</p>` : `<p class="detail-overview muted">No synopsis yet. Add a TMDB API key in Settings to fetch artwork and descriptions.</p>`}
            <div class="detail-actions">
              ${inProgress
                ? `<a class="btn btn-primary" href="#/watch/episode/${inProgress.episode.id}">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg>
                Continue S${pad(inProgress.season.number)}E${pad(inProgress.episode.episode)} · ${formatTimeFromSeconds(inProgress.entry.position)}
              </a>`
                : first ? `<a class="btn btn-primary" href="#/watch/episode/${first.episode.id}">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg>
                Play S${pad(first.season.number)}E${pad(first.episode.episode)}
              </a>` : ''}
              ${inProgress && first ? `<a class="btn btn-ghost" href="#/watch/episode/${first.episode.id}">Start from the beginning</a>` : ''}
              <a class="btn btn-ghost" href="#/shows">Back to shows</a>
            </div>
          </div>
        </div>
      </div>
      <div class="detail-body">
        <div class="season-bar" id="season-bar">
          ${(show.seasons || []).map((season, i) => `
            <button class="season-pill ${i === 0 ? 'active' : ''}" data-season="${season.number}">
              Season ${season.number}${season.episodes.length ? ` · ${season.episodes.length} ep` : ''}
            </button>`).join('')}
        </div>
        <div class="episode-list" id="episode-list"></div>
      </div>
    </article>`;

  const list = document.getElementById('episode-list');
  const paint = (seasonNumber) => {
    const season = show.seasons.find((s) => String(s.number) === String(seasonNumber)) || show.seasons[0];
    if (!season) {
      list.innerHTML = `<p class="muted">No episodes found for this show.</p>`;
      return;
    }
    document.querySelectorAll('.season-pill').forEach((pill) => {
      pill.classList.toggle('active', String(pill.dataset.season) === String(season.number));
    });
    list.innerHTML = season.episodes.map((ep) => {
      const fraction = progressFor(ep.id);
      const still = ep.still ? art(ep.still, 'w300') : null;
      return `
        <a class="episode" href="#/watch/episode/${ep.id}">
          <div class="episode-num">${pad(ep.episode)}</div>
          <div class="episode-still">
            ${still ? `<img src="${still}" alt="" loading="lazy" onerror="this.remove()">` : `<div class="poster-fallback" style="${tintStyle(show.title + ep.episode)}"><span style="font-size:11px">${esc(show.title)}</span></div>`}
            ${fraction ? `<div class="progress"><i style="width:${Math.round(fraction * 100)}%"></i></div>` : ''}
          </div>
          <div class="episode-body">
            <div class="episode-title">
              ${esc(ep.title)}
              ${ep.airDate && new Date(ep.airDate) > new Date() ? '<span class="ep-pill">UPCOMING</span>' : ''}
            </div>
            <p class="episode-desc">${esc(ep.overview || 'No description available.')}</p>
          </div>
          <div class="episode-side">
            ${ep.runtime ? `<span>${formatRuntime(ep.runtime)}</span>` : ''}
            ${fraction ? `<span>${Math.round(fraction * 100)}%</span>` : ''}
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5.14v13.72L19 12z"/></svg>
          </div>
        </a>`;
    }).join('');
  };

  document.querySelectorAll('.season-pill').forEach((pill) => {
    pill.addEventListener('click', () => paint(pill.dataset.season));
  });
  paint(show.seasons && show.seasons.length ? show.seasons[0].number : 1);
}

/* ============================================================
   Discover — what's popular, and where it is streaming
   ============================================================ */

/** Streaming regions offered in Settings; TMDB uses ISO 3166-1 codes. */
const STREAM_REGIONS = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['NZ', 'New Zealand'], ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'],
  ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['SE', 'Sweden'],
  ['NO', 'Norway'], ['DK', 'Denmark'], ['PL', 'Poland'], ['BR', 'Brazil'],
  ['MX', 'Mexico'], ['IN', 'India'], ['JP', 'Japan'], ['ZA', 'South Africa'],
];

function regionName(code) {
  const match = STREAM_REGIONS.find(([iso]) => iso === String(code || '').toUpperCase());
  return match ? match[1] : String(code || 'this region').toUpperCase();
}

/** Availability fetched so far, keyed `movie:123` / `tv:456`; 'error' means the lookup failed. */
const providerCache = new Map();

function tmdbWatchUrl(item) {
  return `https://www.themoviedb.org/${item.type === 'tv' ? 'tv' : 'movie'}/${item.id}/watch`;
}

/** One named service plus a couple of logos — a 176px card has no room for more. */
function providerChips(block) {
  if (block === undefined) return '<span class="prov-loading">Checking…</span>';
  if (block === 'error') return '<span class="prov-none">Availability unknown</span>';
  const subscription = block ? [...block.flatrate, ...block.free] : [];
  const list = subscription.length ? subscription : block ? [...block.rent, ...block.buy] : [];
  if (!list.length) return '<span class="prov-none">Not streaming</span>';

  const [first, ...rest] = list;
  const extra = rest.slice(0, 2).map((provider) => (provider.logo
    ? `<img class="prov-logo" src="${art(provider.logo, 'w92')}" alt="${esc(provider.name)}" title="${esc(provider.name)}" loading="lazy" onerror="this.remove()">`
    : ''));
  return `
    <span class="prov-chip" title="${esc(first.name)}">
      ${first.logo ? `<img src="${art(first.logo, 'w92')}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span>${esc(first.name)}</span>
    </span>
    ${extra.join('')}
    ${list.length > 3 ? `<span class="prov-more">+${list.length - 3}</span>` : ''}`;
}

function discoverCard(item) {
  const key = `${item.type}:${item.id}`;
  const meta = [item.year, item.type === 'tv' ? 'TV series' : 'Movie'].filter(Boolean);
  return `
    <article class="card dcard" data-disc="${key}" tabindex="0" role="button"
      aria-label="${esc(item.title)} — where to watch">
      <div class="poster">
        ${item.poster
          ? `<img src="${art(item.poster, 'w342')}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
          : `<div class="poster-fallback" style="${tintStyle(item.title)}"><span>${esc(item.title)}</span></div>`}
        ${item.rating ? `<span class="poster-badge">★ ${item.rating.toFixed(1)}</span>` : ''}
        <span class="poster-play"><span><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12z"/></svg></span></span>
      </div>
      <div class="card-title">${esc(item.title)}</div>
      <div class="card-meta">${meta.map(esc).join('<span class="dot-sep"></span>')}</div>
      <div class="dcard-watch" data-key="${key}">${providerChips(providerCache.get(key))}</div>
    </article>`;
}

function findDiscoverItem(key) {
  for (const row of (state.discover && state.discover.rows) || []) {
    const found = row.items.find((item) => `${item.type}:${item.id}` === key);
    if (found) return found;
  }
  return null;
}

/** Rows paint immediately; availability chips stream in per row afterwards. */
async function loadRowProviders(row) {
  const byType = new Map();
  for (const card of row.querySelectorAll('.dcard')) {
    const key = card.dataset.disc;
    if (providerCache.has(key)) continue;
    const [type, id] = key.split(':');
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(Number(id));
  }

  await Promise.all([...byType.entries()].map(async ([type, ids]) => {
    if (!ids.length) return;
    let data = null;
    try {
      data = await api.discoverProviders(type, ids);
    } catch {
      /* reported per card below */
    }
    for (const id of ids) {
      const key = `${type}:${id}`;
      const value = data ? data.providers[key] ?? null : 'error';
      providerCache.set(key, value);
      const holder = row.querySelector(`.dcard-watch[data-key="${key}"]`);
      if (holder) holder.innerHTML = providerChips(value);
    }
  }));
}

async function renderDiscover() {
  view.innerHTML = `
    <div class="page fade-in">
      <div class="page-head"><div><h1>Discover</h1><p>Popular films and series, and where you can stream them.</p></div></div>
      <div class="loading-row">${Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('')}</div>
    </div>`;

  let data;
  try {
    data = await api.discover();
  } catch (err) {
    view.innerHTML = `
      <div class="page fade-in">
        <div class="page-head"><div><h1>Discover</h1><p>Popular films and series, and where you can stream them.</p></div></div>
        <div class="empty"><h3>Discover is unavailable</h3><p>${esc(err.message)}</p>
          <button class="btn btn-primary" id="discover-retry">Try again</button></div>
      </div>`;
    const retry = document.getElementById('discover-retry');
    if (retry) retry.addEventListener('click', renderDiscover);
    return;
  }
  state.discover = data;

  if (!data.configured) {
    view.innerHTML = `
      <div class="page fade-in">
        <div class="page-head"><div><h1>Discover</h1><p>Popular films and series, and where you can stream them.</p></div></div>
        ${emptyState({
          title: 'Link TMDB to switch on Discover',
          message: 'Discover pulls trending and popular titles plus streaming availability from TMDB. Add your free TMDB API key in Settings and this tab fills up.',
          actionLabel: 'Open Settings',
          actionHref: '#/settings',
          icon: 'film',
        })}
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="page page-tight fade-in">
      <div class="page-head">
        <div>
          <h1>Discover</h1>
          <p>Trending and popular titles, with streaming availability in <strong>${esc(regionName(data.region))}</strong>.</p>
        </div>
        <div class="row-actions" style="margin:0">
          <a class="btn btn-quiet btn-sm" href="#/settings">Change region</a>
        </div>
      </div>
      ${data.error ? `<p class="form-error">${esc(data.error)}</p>` : ''}
      ${data.rows.map((row) => `
        <section class="section">
          ${sectionHead(row.title)}
          <div class="row-scroll" data-row="${esc(row.id)}">${row.items.map(discoverCard).join('')}</div>
        </section>`).join('')}
      <p class="attrib discover-attrib">Streaming availability in ${esc(regionName(data.region))} comes from JustWatch via TMDB.
        Buttons open the title's JustWatch page, which hands you to the service. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>`;

  view.querySelectorAll('.dcard').forEach((card) => {
    const open = () => openDiscoverSheet(card.dataset.disc);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
  view.querySelectorAll('.row-scroll[data-row]').forEach((row) => {
    loadRowProviders(row);
  });
}

function renderWatchBlock(holder, item, region) {
  if (!holder) return;
  const key = `${item.type}:${item.id}`;
  const block = providerCache.get(key);

  if (block === undefined) {
    holder.innerHTML = '<p class="prov-loading">Checking where this is streaming…</p>';
    return;
  }
  if (block === 'error') {
    holder.innerHTML = '<p class="prov-none">Could not fetch availability from TMDB. Check your connection and try again.</p>';
    return;
  }

  const groups = [
    { label: 'Included with a subscription', list: block ? block.flatrate : [] },
    { label: 'Free with ads', list: block ? [...block.free, ...block.ads] : [] },
    { label: 'Rent', list: block ? block.rent : [] },
    { label: 'Buy', list: block ? block.buy : [] },
  ].filter((group) => group.list.length);

  if (!groups.length) {
    holder.innerHTML = `
      <p class="prov-none">Not on a streaming service in ${esc(regionName(region))} right now.</p>
      <a class="btn btn-quiet btn-sm" href="${tmdbWatchUrl(item)}" target="_blank" rel="noopener">Check options on TMDB</a>`;
    return;
  }

  const link = block.link || tmdbWatchUrl(item);
  const button = (provider) => `
    <a class="watch-btn" href="${esc(link)}" target="_blank" rel="noopener" title="Opens ${esc(provider.name)} via JustWatch">
      ${provider.logo ? `<img src="${art(provider.logo, 'w92')}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span>${esc(provider.name)}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M9 7h8v8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </a>`;

  holder.innerHTML = `${groups.map((group) => `
      <div class="watch-group">
        <p class="watch-label">${group.label}</p>
        <div class="watch-buttons">${group.list.map(button).join('')}</div>
      </div>`).join('')}
    ${block.link ? `<a class="watch-all" href="${esc(block.link)}" target="_blank" rel="noopener">All watching options →</a>` : ''}`;
}

async function openDiscoverSheet(key) {
  const item = findDiscoverItem(key);
  if (!item) return;
  const region = state.discover.region;

  sheet.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="Close">✕</button>
    <div class="disc-sheet">
      ${item.backdrop ? `<div class="disc-hero"><img src="${art(item.backdrop, 'w780')}" alt="" onerror="this.remove()"></div>` : ''}
      <p class="eyebrow"${item.backdrop ? '' : ' style="margin-top:26px"'}>${[item.type === 'tv' ? 'TV series' : 'Movie', item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).map(esc).join(' · ')}</p>
      <h2 id="sheet-title">${esc(item.title)}</h2>
      ${item.overview ? `<p class="sheet-desc">${esc(item.overview)}</p>` : ''}
      <div id="disc-watch" class="disc-watch"></div>
      <p class="attrib">Availability in ${esc(regionName(region))} from JustWatch via TMDB. Links open the title's JustWatch page, which hands you to the service.</p>
    </div>`;
  sheet.hidden = false;
  sheetBackdrop.hidden = false;
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('sheet-close').focus();

  renderWatchBlock(document.getElementById('disc-watch'), item, region);
  if (providerCache.has(key)) return;

  try {
    const data = await api.discoverProviders(item.type, [item.id]);
    providerCache.set(key, data.providers[key] ?? null);
  } catch {
    providerCache.set(key, 'error');
  }
  // The sheet may have been closed while the lookup was in flight.
  if (!sheet.hidden) renderWatchBlock(document.getElementById('disc-watch'), item, region);
}

/* ============================================================
   TV Guide
   ============================================================ */

const PX_PER_MIN = 4;
const MINUTES_PER_DAY = 1440;

async function renderGuide() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + state.guideDay);
  const from = new Date(day);
  const to = new Date(day.getTime() + 24 * 3600 * 1000);

  const label = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const isToday = state.guideDay === 0;

  view.innerHTML = `
    <div class="page fade-in">
      <div class="page-head" style="margin-bottom:14px">
        <div>
          <h1>TV Guide</h1>
          <p>${isToday ? 'Live schedule for today' : 'Schedule'} · ${esc(label)}</p>
        </div>
        <div class="day-nav">
          <button class="btn btn-quiet" id="day-prev" aria-label="Previous day">‹ Prev</button>
          <span class="day-label">${esc(label)} ${isToday ? '<span>· today</span>' : ''}</span>
          <button class="btn btn-quiet" id="day-next" aria-label="Next day">Next ›</button>
          ${isToday ? '' : '<button class="btn btn-quiet" id="day-today">Today</button>'}
        </div>
      </div>
      <div id="guide-holder"><div class="guide-shell"><div class="guide-empty" style="padding:40px;text-align:center;color:var(--muted)">Loading guide…</div></div></div>
    </div>`;

  document.getElementById('day-prev').addEventListener('click', () => { state.guideDay -= 1; renderGuide(); });
  document.getElementById('day-next').addEventListener('click', () => { state.guideDay += 1; renderGuide(); });
  const todayBtn = document.getElementById('day-today');
  if (todayBtn) todayBtn.addEventListener('click', () => { state.guideDay = 0; renderGuide(); });

  const holder = document.getElementById('guide-holder');
  let data;
  try {
    data = await api.epg(from.toISOString(), to.toISOString());
  } catch (err) {
    holder.innerHTML = emptyState({
      title: 'The guide could not load',
      message: err.message,
      actionLabel: 'Open settings',
      actionHref: '#/settings',
      icon: 'guide',
    });
    return;
  }

  if (!data.channels.length) {
    holder.innerHTML = emptyState({
      title: 'No guide data yet',
      message: 'Add an XMLTV file or URL in Settings (most IPTV providers and several online sources give you one), then refresh the guide. Channels and programmes will appear here as a scrollable timeline.',
      actionLabel: 'Add an EPG source',
      actionHref: '#/settings',
      icon: 'guide',
    });
    return;
  }

  const timelineWidth = MINUTES_PER_DAY * PX_PER_MIN;

  const minutesOf = (iso) => {
    const d = new Date(iso);
    return (d.getTime() - day.getTime()) / 60000;
  };
  const nowMinutes = (Date.now() - day.getTime()) / 60000;
  const showNowLine = isToday && nowMinutes >= 0 && nowMinutes <= MINUTES_PER_DAY;

  const ruler = [];
  for (let m = 0; m < MINUTES_PER_DAY; m += 30) {
    const hour = Math.floor(m / 60);
    const minute = m % 60;
    ruler.push(
      `<div class="ruler-tick ${minute ? 'half' : ''}" style="left:${m * PX_PER_MIN}px">${
        minute ? '' : `${pad(hour)}:00`
      }</div>`,
    );
  }

  const rows = data.channels.map((channel) => {
    const programmes = data.programmes
      .filter((p) => p.channel === channel.id)
      .map((p) => {
        const start = Math.max(0, minutesOf(p.start));
        const stop = Math.min(MINUTES_PER_DAY, minutesOf(p.stop));
        if (stop <= 0 || start >= MINUTES_PER_DAY) return '';
        const width = Math.max(26, (stop - start) * PX_PER_MIN - 3);
        const live = showNowLine && nowMinutes >= start && nowMinutes < stop;
        const timeLabel = `${formatTime(p.start)} – ${formatTime(p.stop)}`;
        return `<button class="programme ${live ? 'live' : ''}"
          style="left:${start * PX_PER_MIN}px;width:${width}px"
          data-title="${esc(p.title)}" data-sub="${esc(p.subTitle || '')}" data-desc="${esc(p.desc || '')}"
          data-start="${esc(p.start)}" data-stop="${esc(p.stop)}" data-channel="${esc(channel.name)}"
          data-channel-id="${esc(channel.id)}" data-category="${esc(p.category || '')}">
          <span class="programme-title">${esc(p.title)}</span>
          <span class="programme-time">${live ? '● ' : ''}${timeLabel}</span>
          ${width > 190 && p.desc ? `<span class="programme-desc">${esc(p.desc)}</span>` : ''}
        </button>`;
      })
      .join('');

    const initial = channel.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'TV';
    const play = channel.live
      ? `<button class="channel-play" data-live="${esc(channel.id)}" aria-label="Watch ${esc(channel.name)} live" title="Watch live">
           <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
         </button>`
      : '';
    const empty = channel.live && !programmes
      ? '<div class="guide-track-empty">No guide data for this channel — press play to watch live</div>'
      : '';
    return `
      <div class="guide-row">
        <div class="guide-channel ${channel.live ? 'is-live' : ''}">
          ${play}
          <div class="channel-logo">${channel.icon ? `<img src="${esc(channel.icon)}" alt="" loading="lazy" onerror="this.remove()">` : esc(initial)}</div>
          <div class="channel-meta">
            <div class="channel-name">${esc(channel.name)}</div>
            <div class="channel-num">${esc(channel.number || '')}${channel.live ? '<span class="live-tag">LIVE</span>' : ''}</div>
          </div>
        </div>
        <div class="guide-track" style="width:${timelineWidth}px;--half:${30 * PX_PER_MIN}px">${programmes}${empty}</div>
      </div>`;
  }).join('');

  holder.innerHTML = `
    <div class="guide-toolbar">
      <div class="pill-note">
        <span class="status-dot ok"></span>
        ${data.channels.length} channels · ${data.programmes.length} programmes
      </div>
      <p class="tiny muted" style="margin:0">Scroll sideways for later · ▶ on a channel to watch live · click a programme for details</p>
    </div>
    <div class="guide-shell">
      <div class="guide-scroll" id="guide-scroll">
        <div class="guide-grid">
          <div class="guide-head">
            <div class="gutter">Channel</div>
            <div class="guide-ruler" style="width:${timelineWidth}px">${ruler.join('')}</div>
          </div>
          ${rows}
          ${showNowLine ? `<div class="now-line" style="left:calc(var(--guide-gutter) + ${nowMinutes * PX_PER_MIN}px);top:44px"></div>` : ''}
        </div>
      </div>
    </div>`;

  const scroller = document.getElementById('guide-scroll');
  const initialScroll = (isToday ? Math.max(0, nowMinutes - 45) : 18 * 60) * PX_PER_MIN;
  scroller.scrollLeft = Math.min(initialScroll, timelineWidth - scroller.clientWidth + 160);

  holder.querySelectorAll('.programme').forEach((block) => {
    block.addEventListener('click', () => {
      const title = block.dataset.title;
      const channel = data.channels.find((c) => c.id === block.dataset.channelId);
      // A programme on a channel we can actually receive beats a library match.
      const action = channel && channel.live
        ? { label: `Watch ${channel.name} live`, href: `#/live/${encodeURIComponent(channel.id)}` }
        : findLibraryMatch(title);
      openSheet({
        eyebrow: `${block.dataset.channel} · ${formatTime(block.dataset.start)} – ${formatTime(block.dataset.stop)}`,
        title,
        subtitle: block.dataset.sub || block.dataset.category || '',
        description: block.dataset.desc || 'No programme description supplied by the guide source.',
        action,
      });
    });
  });

  holder.querySelectorAll('.channel-play').forEach((button) => {
    button.addEventListener('click', () => {
      location.hash = `#/live/${encodeURIComponent(button.dataset.live)}`;
    });
  });
}

function findLibraryMatch(programmeTitle) {
  const needle = String(programmeTitle || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (!needle) return null;
  for (const movie of state.movieMap.values()) {
    const title = String(movie.title).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (title && (needle.startsWith(title) || title.startsWith(needle))) {
      return { href: `#/movie/${movie.id}`, label: 'Open movie' };
    }
  }
  for (const show of state.showMap.values()) {
    const title = String(show.title).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (title && (needle.startsWith(title) || title.startsWith(needle))) {
      return { href: `#/show/${show.id}`, label: 'Open series' };
    }
  }
  return null;
}

/* ============================================================
   Sheet
   ============================================================ */

function openSheet({ eyebrow, title, subtitle, description, action }) {
  sheet.innerHTML = `
    <button class="sheet-close" id="sheet-close" aria-label="Close">✕</button>
    ${eyebrow ? `<p class="eyebrow" style="margin-top:22px">${esc(eyebrow)}</p>` : '<div style="height:26px"></div>'}
    <h2 id="sheet-title">${esc(title)}</h2>
    ${subtitle ? `<p class="sheet-sub">${esc(subtitle)}</p>` : ''}
    <p class="sheet-desc">${esc(description)}</p>
    ${action ? `<div class="sheet-meta"><a class="btn btn-primary btn-sm" href="${action.href}">${esc(action.label)}</a></div>` : ''}`;
  sheet.hidden = false;
  sheetBackdrop.hidden = false;
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheet.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeSheet));
  document.getElementById('sheet-close').focus();
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  sheetBackdrop.hidden = true;
}

sheetBackdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeSheet();
    hideSearch();
  }
});

/* ============================================================
   Player
   ============================================================ */

/** Next episode in broadcast order, crossing season boundaries. */
function nextEpisodeAfter(show, current) {
  if (!show || !current) return null;
  const ordered = [];
  for (const season of [...(show.seasons || [])].sort((a, b) => a.number - b.number)) {
    for (const episode of [...(season.episodes || [])].sort((a, b) => a.episode - b.episode)) {
      ordered.push({ ...episode, seasonNumber: season.number });
    }
  }
  const index = ordered.findIndex((episode) => episode.id === current.id);
  if (index === -1 || index === ordered.length - 1) return null;
  return ordered[index + 1];
}

async function renderPlayer(kind, id) {
  document.body.classList.add('playing');

  let movie = kind === 'movie' ? state.movieMap.get(id) : null;
  let episodeEntry = kind === 'episode' ? state.episodeMap.get(id) : null;

  // A deep link — or something added since the last scan — may not be in the
  // client cache. Without resolving it here the resume point is stored with an
  // empty title and no artwork, which is what the Continue watching row shows.
  if (!movie && !episodeEntry) {
    try {
      const resolved = await api.item(id);
      if (resolved.kind === 'movie') {
        movie = resolved.item;
        state.movieMap.set(movie.id, movie);
      } else if (resolved.kind === 'episode') {
        episodeEntry = resolved.item;
        state.episodeMap.set(episodeEntry.id, episodeEntry);
      }
    } catch {
      /* the play request below reports missing files */
    }
  }

  const show = episodeEntry ? episodeEntry.show : null;
  const next = episodeEntry ? nextEpisodeAfter(show, episodeEntry) : null;

  const parentHref = movie ? `#/movie/${movie.id}` : show ? `#/show/${show.id}` : '#/';
  const title = movie ? movie.title : show ? show.title : 'Playback';
  const subtitle = movie
    ? [movie.year, movie.runtime ? formatRuntime(movie.runtime) : null].filter(Boolean).join(' · ')
    : episodeEntry
      ? episodeLabel(show, episodeEntry.seasonNumber, episodeEntry.episode) + ` · ${episodeEntry.title}`
      : '';

  const upNextStill = next && next.still ? art(next.still, 'w300') : null;
  const nextLabel = next
    ? `S${pad(next.seasonNumber)}E${pad(next.episode)}${show ? ` · ${show.title}` : ''}`
    : '';

  view.innerHTML = `
    <div class="player-page">
      <div class="player-top">
        <button class="back" id="player-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Back
        </button>
        <div class="player-titles">
          <h1>${esc(title)}</h1>
          <p>${esc(subtitle)}</p>
        </div>
        <div class="player-tools">
          <span class="player-chip tc-badge" id="transcode-badge" hidden>Transcoding</span>
          ${next ? '<button class="player-chip" id="next-btn" title="Play next episode (N)">Next episode</button>' : ''}
          <div class="subs-wrap" id="subs-wrap" hidden>
            <button class="player-chip" id="subs-btn" aria-haspopup="true" aria-expanded="false" title="Subtitles (C)">CC</button>
            <div class="subs-menu" id="subs-menu" hidden></div>
          </div>
        </div>
      </div>
      <div class="player-stage">
        <video id="player" controls autoplay playsinline preload="metadata"></video>
      </div>
      <div class="player-note" id="player-note" hidden></div>
      <div class="up-next" id="up-next" hidden>
        <div class="frame">
          ${upNextStill
            ? `<img src="${upNextStill}" alt="" onerror="this.remove()">`
            : `<div class="poster-fallback" style="${tintStyle((show && show.title) || title)}"><span>${esc(next ? next.title : '')}</span></div>`}
        </div>
        <div class="body">
          <p class="kicker">Up next</p>
          <h3>${esc(next ? next.title : '')}</h3>
          <p id="up-next-sub">${esc(nextLabel)} · starting in <span id="up-next-count">9</span>s</p>
          <div class="actions">
            <button class="btn btn-primary btn-sm" id="up-next-play">Play now</button>
            <button class="btn btn-quiet btn-sm" id="up-next-cancel">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;

  const video = document.getElementById('player');
  const note = document.getElementById('player-note');
  const label = movie ? movie.title : show ? `${show.title} · S${pad(episodeEntry.seasonNumber)}E${pad(episodeEntry.episode)}` : '';
  const listeners = [];
  let upNextTimer = null;
  let subtitleActive = -1;
  let selectSubtitle = null;
  let toggleCaptions = null;
  /* Set while a subtitle menu exists; closes it and reports whether it did. */
  let dismissSubsMenu = null;

  const goNext = next
    ? () => {
        if (upNextTimer) clearInterval(upNextTimer);
        location.hash = `#/watch/episode/${next.id}`;
      }
    : null;

  document.getElementById('player-back').addEventListener('click', () => {
    if (state.playerTimer) clearInterval(state.playerTimer);
    state.playerTimer = null;
    location.hash = parentHref;
  });

  const nextBtn = document.getElementById('next-btn');
  if (nextBtn && goNext) nextBtn.addEventListener('click', goNext);

  let info;
  try {
    info = await api.play(kind, id);
  } catch (err) {
    if (!document.body.contains(note)) return;
    note.hidden = false;
    note.textContent = err.status === 410
      ? `This file is no longer on disk (${err.data && err.data.file ? err.data.file : 'missing'}). Rescan your library.`
      : `Unable to start playback: ${err.message}`;
    return;
  }
  if (!document.body.contains(video)) return;

  /* ---------------------------------------------------- playback mode */
  const playback = info.playback || { mode: 'direct', reason: '', hlsUrl: null };
  const transcodeBadge = document.getElementById('transcode-badge');
  let hlsController = null;

  const showNote = (html) => {
    note.hidden = false;
    note.innerHTML = html;
  };

  const markTranscoding = () => {
    if (!transcodeBadge) return;
    transcodeBadge.hidden = false;
    transcodeBadge.title = playback.reason || 'Converting this file for the browser';
  };

  /** hls.js drives transcoded playback; Safari can take the raw playlist. */
  const startHls = (url) => {
    const Hls = window.Hls;
    if (Hls && Hls.isSupported()) {
      hlsController = new Hls({ enableWorker: true, maxBufferLength: 40, backBufferLength: 60 });
      hlsController.loadSource(url);
      hlsController.attachMedia(video);
      hlsController.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !hlsController) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hlsController.recoverMediaError();
          return;
        }
        const detail = (data.response && data.response.text) || data.details || 'the stream stopped';
        showNote(esc(`Transcoded playback failed: ${String(detail).slice(0, 200)}`));
        if (transcodeBadge) transcodeBadge.hidden = true;
        hlsController.destroy();
        hlsController = null;
      });
      return true;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return true;
    }
    showNote('This browser cannot play transcoded HLS streams.');
    return false;
  };

  if (playback.mode === 'transcode' && playback.hlsUrl) {
    markTranscoding();
    startHls(playback.hlsUrl);
  } else if (playback.mode === 'unsupported') {
    note.hidden = false;
    note.textContent = playback.reason;
  } else {
    video.src = info.streamUrl;
  }

  /* ---------------------------------------------------- subtitles */
  const tracks = Array.isArray(info.subtitles) ? info.subtitles : [];
  if (tracks.length) {
    for (const track of tracks) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = track.label;
      el.srclang = track.language || 'und';
      el.src = track.url;
      video.appendChild(el);
    }

    const wrap = document.getElementById('subs-wrap');
    const menu = document.getElementById('subs-menu');
    const button = document.getElementById('subs-btn');
    wrap.hidden = false;

    menu.innerHTML = [{ id: -1, label: 'Off' }, ...tracks]
      .map((track) => `<button class="subs-item ${track.id === -1 ? 'active' : ''}" data-index="${track.id}"><span class="check">${track.id === -1 ? '✓' : ''}</span>${esc(track.label)}${track.format === 'srt' ? ' <em class="fmt">SRT</em>' : ''}</button>`)
      .join('');

    selectSubtitle = (index) => {
      subtitleActive = index;
      const list = video.textTracks;
      for (let i = 0; i < list.length; i += 1) {
        list[i].mode = i === index ? 'showing' : 'disabled';
      }
      button.classList.toggle('active', index >= 0);
      menu.querySelectorAll('.subs-item').forEach((item) => {
        const active = Number(item.dataset.index) === index;
        item.classList.toggle('active', active);
        item.querySelector('.check').textContent = active ? '✓' : '';
      });
      if (index >= 0) state.subtitlePref = tracks[index] ? tracks[index].language || 'und' : 'und';
      else state.subtitlePref = 'off';
    };

    const closeMenu = () => {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.hidden;
      menu.hidden = !opening;
      button.setAttribute('aria-expanded', String(opening));
    });

    menu.querySelectorAll('.subs-item').forEach((item) => {
      item.addEventListener('click', () => {
        selectSubtitle(Number(item.dataset.index));
        closeMenu();
        /* Return focus to the control that opened the menu, rather than leaving
           it on a button that is now hidden — on a TV that would send the next
           D-pad press back to the top of the player. */
        button.focus();
      });
    });

    dismissSubsMenu = () => {
      if (menu.hidden) return false;
      closeMenu();
      button.focus();
      return true;
    };

    const onDocClick = (event) => {
      if (!wrap.contains(event.target)) closeMenu();
    };
    document.addEventListener('click', onDocClick);
    listeners.push(() => document.removeEventListener('click', onDocClick));

    // Restore the language picked during this session.
    if (state.subtitlePref && state.subtitlePref !== 'off') {
      const preferred = tracks.find((track) => (track.language || 'und') === state.subtitlePref);
      if (preferred) selectSubtitle(preferred.id);
    }

    toggleCaptions = () => {
      if (subtitleActive === -1) selectSubtitle(tracks[0].id);
      else selectSubtitle(-1);
    };
  }

  const onKey = (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (event.key === 'Escape') {
      /* Back dismisses an open menu before it leaves the player. */
      if (dismissSubsMenu && dismissSubsMenu()) return;
      location.hash = parentHref;
      return;
    }
    if ((event.key === 'n' || event.key === 'N') && goNext) {
      event.preventDefault();
      goNext();
      return;
    }
    if ((event.key === 'c' || event.key === 'C') && toggleCaptions) {
      event.preventDefault();
      toggleCaptions();
    }
  };
  document.addEventListener('keydown', onKey);
  listeners.push(() => document.removeEventListener('keydown', onKey));

  /* ---------------------------------------------------- playback */
  const resumeAt = isResumable(state.progress[id]) ? state.progress[id].position : 0;
  video.addEventListener('loadedmetadata', () => {
    const gate = Math.min(20, video.duration * 0.05);
    if (resumeAt > gate && resumeAt < video.duration - 2) video.currentTime = resumeAt;
  }, { once: true });

  /* ---------------------------------------------------- transcode fallback */
  let forcingTranscode = false;
  const forceTranscode = async () => {
    if (forcingTranscode) return;
    forcingTranscode = true;
    note.hidden = true;
    try {
      const forced = await api.play(kind, id, { transcode: true });
      if (!document.body.contains(video)) return;
      if (!forced.playback || !forced.playback.hlsUrl) {
        showNote('This file cannot be transcoded.');
        return;
      }
      playback.reason = forced.playback.reason;
      markTranscoding();
      if (startHls(forced.playback.hlsUrl)) video.play().catch(() => {});
    } catch (err) {
      showNote(esc(`Transcoding failed: ${err.message}`));
    } finally {
      forcingTranscode = false;
    }
  };

  video.addEventListener('error', () => {
    if (hlsController) {
      showNote(esc(`${info.file} could not be played: the transcoder stopped. Check the service log.`));
      return;
    }
    if (playback.mode === 'direct') {
      showNote(
        `${esc(info.file)} cannot be decoded directly by this browser. `
        + '<button class="note-btn" id="force-transcode" type="button">Transcode it</button>',
      );
      const button = document.getElementById('force-transcode');
      if (button) button.addEventListener('click', forceTranscode);
      return;
    }
    showNote(esc(`${info.file} could not be played.`));
  });

  video.play().catch(() => {
    // Browsers may refuse autoplay after a route change; the controls still work.
    if (video.readyState === 0) return;
    note.hidden = false;
    note.textContent = 'Autoplay was blocked — press play to continue.';
  });

  const save = () => {
    if (!video.duration || Number.isNaN(video.duration)) return;
    const payload = {
      id,
      kind,
      position: video.currentTime,
      duration: video.duration,
      title: label,
      subtitle,
      poster: movie ? movie.poster : show ? show.poster : null,
      backdrop: movie ? movie.backdrop : show ? show.backdrop : null,
    };
    state.progress[id] = { ...payload, updatedAt: new Date().toISOString(), finished: false };
    api.saveProgress(payload).catch(() => {});
  };

  state.playerTimer = setInterval(() => {
    if (!video.paused && !video.ended) save();
  }, 10000);

  video.addEventListener('pause', () => save());

  /* ---------------------------------------------------- up next */
  const upNext = document.getElementById('up-next');
  const countLabel = document.getElementById('up-next-count');

  const startUpNext = () => {
    if (!next || !upNext || !goNext) return;
    upNext.hidden = false;

    // Autoplay can be switched off in Settings → Playback; the card still
    // appears so the next episode is one click away.
    if (playback.autoplayNext === false) {
      const sub = document.getElementById('up-next-sub');
      if (sub) sub.textContent = `${nextLabel} · autoplay is off`;
      return;
    }

    let remaining = 9;
    if (countLabel) countLabel.textContent = String(remaining);
    if (upNextTimer) clearInterval(upNextTimer);
    upNextTimer = setInterval(() => {
      remaining -= 1;
      if (countLabel) countLabel.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(upNextTimer);
        upNextTimer = null;
        goNext();
      }
    }, 1000);
  };

  const cancelUpNext = () => {
    if (upNextTimer) clearInterval(upNextTimer);
    upNextTimer = null;
    if (upNext) upNext.hidden = true;
  };

  document.getElementById('up-next-play')?.addEventListener('click', goNext || (() => {}));
  document.getElementById('up-next-cancel')?.addEventListener('click', cancelUpNext);

  video.addEventListener('ended', () => {
    save();
    startUpNext();
  });

  const onUnload = () => save();
  window.addEventListener('beforeunload', onUnload);

  state.playerCleanup = () => {
    save();
    window.removeEventListener('beforeunload', onUnload);
    if (upNextTimer) clearInterval(upNextTimer);
    if (hlsController) {
      hlsController.destroy();
      hlsController = null;
    }
    for (const remove of listeners) remove();
  };
}

/* ============================================================
   Live TV
   ============================================================ */

/**
 * A single channel from the M3U playlist.
 *
 * Live playback has none of the on-demand player's furniture: no resume point,
 * no next episode, no duration to scrub — and nothing is saved as progress,
 * because a channel has no "where you were".
 */
async function renderLive(channelId) {
  view.innerHTML = `
    <div class="player-page">
      <div class="player-top">
        <button class="back" id="player-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Back
        </button>
        <div class="player-titles">
          <h1 id="live-title">Live TV</h1>
          <p id="live-sub">Connecting…</p>
        </div>
        <div class="player-tools"><span class="player-chip live-chip">● LIVE</span></div>
      </div>
      <div class="player-stage"><video id="player" controls autoplay playsinline preload="auto"></video></div>
      <div class="player-note" id="player-note" hidden></div>
    </div>`;

  const video = document.getElementById('player');
  const note = document.getElementById('player-note');
  const titleEl = document.getElementById('live-title');
  const subEl = document.getElementById('live-sub');

  document.getElementById('player-back').addEventListener('click', () => {
    location.hash = '#/guide';
  });

  const fail = (message) => {
    note.hidden = false;
    note.textContent = message;
  };

  let info;
  try {
    info = await api.livePlay(channelId);
  } catch (err) {
    titleEl.textContent = 'Channel unavailable';
    fail(err.status === 404
      ? 'That channel is no longer in the playlist. Refresh channels in Settings → Live TV.'
      : err.message);
    return;
  }

  titleEl.textContent = info.name;
  subEl.textContent = [info.group, 'Live TV'].filter(Boolean).join(' · ');

  const Hls = window.Hls;
  const Dash = window.dashjs;
  let controller = null;
  let dashPlayer = null;
  let fellBack = false;

  const useNative = () => {
    video.src = info.url;
    video.play().catch(() => {});
  };

  if (info.kind === 'dash' && Dash) {
    dashPlayer = Dash.MediaPlayer().create();
    // CMCD is viewer analytics for broadcaster dashboards; it only produces a
    // console warning here, because the manifest is served from the proxy.
    dashPlayer.updateSettings({ streaming: { cmcd: { enabled: false } } });
    dashPlayer.on(Dash.MediaPlayer.events.ERROR, (event) => {
      const detail = (event && event.error && (event.error.message || event.error.code)) || 'the stream stopped';
      fail(`This channel could not be played (${detail}).`);
    });
    // The manifest is already proxied and its segment URLs rewritten by the
    // server, so dash.js talks to this origin and nothing else.
    dashPlayer.initialize(video, info.url, true);
  } else if (info.kind === 'dash') {
    fail('This channel is MPEG-DASH but the DASH player did not load, so it cannot be opened. Restart ReelHouse and try again.');
  } else if (info.kind === 'hls' && Hls && Hls.isSupported()) {
    controller = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 });
    controller.loadSource(info.url);
    controller.attachMedia(video);
    controller.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (!fellBack) {
        // Some panels serve a progressive file behind a link that looks like HLS.
        fellBack = true;
        try { controller.destroy(); } catch { /* already gone */ }
        controller = null;
        useNative();
        return;
      }
      fail(`This channel could not be played (${data.details || data.type}).`);
    });
  } else {
    useNative();
  }

  video.addEventListener('error', () => {
    if (fellBack && !controller) fail('This channel could not be played. The stream may be offline.');
  });

  state.playerCleanup = () => {
    if (controller) {
      controller.destroy();
      controller = null;
    }
    if (dashPlayer) {
      try { dashPlayer.reset(); } catch { /* already gone */ }
      dashPlayer = null;
    }
    video.removeAttribute('src');
    video.load();
  };
}

/* ============================================================
   Settings
   ============================================================ */

async function renderSettings() {
  let config;
  let status;
  try {
    [config, status] = await Promise.all([api.settings(), api.status()]);
  } catch (err) {
    view.innerHTML = `<div class="page"><div class="empty"><h3>Settings unavailable</h3><p>${esc(err.message)}</p></div></div>`;
    return;
  }

  const counts = status.library.counts || {};
  const isDesktop = Boolean(window.reelhouseDesktop && window.reelhouseDesktop.pickFolder);
  const tmdbLinked = Boolean(config.tmdb.hasApiKey);
  const playbackStatus = status.playback || { ready: false, ffmpeg: null, ffprobe: null };
  const network = status.network || { lanAccess: false, boundToLan: false, discovery: false, restartRequired: false, urls: [] };
  const tmdbLanguages = TMDB_LANGUAGES
    .map((code) => `<option value="${code}" ${config.tmdb.language === code ? 'selected' : ''}>${code}</option>`)
    .join('');
  const tmdbRegions = STREAM_REGIONS
    .map(([iso, name]) => `<option value="${iso}" ${String(config.tmdb.region || 'US').toUpperCase() === iso ? 'selected' : ''}>${name}</option>`)
    .join('');

  const allDirs = config.mediaDirs || [];
  // Scan errors read "/path (not found)"; keep the path so a folder's own card
  // can flag itself.
  const missingDirs = new Set(
    (status.library.dirErrors || []).map((entry) => String(entry).replace(/\s*\(not found\)$/i, '')),
  );

  /* One folder row. The card it lives in decides the type, so there is no
     per-row dropdown to forget about. */
  const dirRow = (dir, placeholder) => `
    <div class="dir-row${isDesktop ? ' has-tools' : ''}">
      <input class="input" type="text" value="${esc(dir.path)}" placeholder="${esc(placeholder)}" aria-label="Folder path" spellcheck="false" />
      ${isDesktop ? '<button class="btn btn-quiet btn-sm dir-browse" type="button">Browse…</button>' : ''}
      ${isDesktop ? '<button class="btn btn-quiet btn-sm dir-open" type="button" title="Open this folder in Finder">Open</button>' : ''}
      <button class="icon-btn dir-remove" aria-label="Remove folder" title="Remove folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>
    </div>`;

  const folderCard = ({ type, title, blurb, placeholder, addLabel }) => {
    const dirs = allDirs.filter((dir) => (dir.type || 'auto') === type);
    const missing = dirs.filter((dir) => missingDirs.has(dir.path));
    return `
      <section class="settings-card" id="folders-${type}">
        <div class="card-head">
          <h2>${title}</h2>
          <span class="pill-note">${dirs.length} ${dirs.length === 1 ? 'folder' : 'folders'}</span>
        </div>
        <p>${blurb}</p>
        <div class="dir-list" id="dirs-${type}" data-type="${type}">
          ${dirs.map((dir) => dirRow(dir, placeholder)).join('')}
          <p class="dir-empty tiny muted"${dirs.length ? ' hidden' : ''}>No folders yet.</p>
        </div>
        <div class="row-actions">
          <button class="btn btn-quiet btn-sm" type="button" data-add-dir="${type}">${addLabel}</button>
          <span class="tiny muted">Folders are created if they do not exist.</span>
        </div>
        ${missing.length ? `<p class="form-error">Not on disk: ${missing.map((dir) => esc(dir.path)).join(', ')}</p>` : ''}
      </section>`;
  };

  const folderCards = [
    {
      type: 'movies',
      title: 'Movies folders',
      placeholder: '/Volumes/Media/Movies',
      addLabel: '+ Add movie folder',
      blurb: 'Films live here. ReelHouse reads the title and year from the file name — <span class="mono">Blade Runner (1982).mp4</span> matches best.',
    },
    {
      type: 'tv',
      title: 'TV shows folders',
      placeholder: '/Volumes/Media/TV Shows',
      addLabel: '+ Add TV show folder',
      blurb: 'Shows live here, one folder per show, with optional <span class="mono">Season 01</span> subfolders. Episode files should contain <span class="mono">S01E02</span>.',
    },
    {
      type: 'auto',
      title: 'Mixed folders',
      placeholder: '/Volumes/Media',
      addLabel: '+ Add mixed folder',
      blurb: 'A single folder holding both. ReelHouse decides per file from its name, so a film that looks like an episode can be misread — prefer separate folders when you can.',
    },
  ].map(folderCard).join('');

  const liveStatus = status.live || { channelCount: 0, sourceCount: 0, errors: [], updatedAt: null };

  const liveRow = (source = {}) => `
    <div class="epg-row live-row" data-id="${esc(source.id || '')}">
      <input class="input live-name" type="text" value="${esc(source.name || '')}" placeholder="Playlist name" aria-label="Playlist name" />
      <input class="input live-url" type="text" value="${esc(source.url || '')}" placeholder="https://…/playlist.m3u or /path/playlist.m3u" aria-label="M3U playlist URL" />
      <button class="icon-btn live-remove" aria-label="Remove playlist" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>
    </div>`;

  const liveRows = (config.live.sources || []).map((source) => liveRow(source)).join('');

  const epgRows = (config.epg.sources || []).map((source) => `
    <div class="epg-row">
      <input class="input epg-name" type="text" value="${esc(source.name || '')}" placeholder="Guide name" aria-label="Guide name" />
      <input class="input epg-source" type="text" value="${esc(source.source || '')}" placeholder="https://…/guide.xml or /path/guide.xml" aria-label="XMLTV source" />
      <button class="icon-btn epg-remove" aria-label="Remove guide source" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>
    </div>`).join('');

  view.innerHTML = `
    <div class="page fade-in settings-wrap">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p>Everything is stored locally on this machine.</p>
        </div>
      </div>

      ${folderCards}

      <section class="settings-card" id="tmdb-card">
        <div class="card-head">
          <h2>TMDB API</h2>
          <span class="link-badge ${tmdbLinked ? 'on' : ''}">
            <span class="status-dot ${tmdbLinked ? (status.tmdb.status === 'error' ? 'err' : 'ok') : ''}"></span>
            ${tmdbLinked ? `Linked${status.tmdb.account ? ` as ${esc(status.tmdb.account)}` : ''}` : 'Not linked'}
          </span>
        </div>
        <p>Posters, banners, logos, synopses, ratings and episode stills come from TMDB. Your credential is stored in this machine's data folder and only ever sent to TMDB.</p>
        ${tmdbLinked ? `<div class="kv tmdb-facts">
          <div><span>Credential</span><strong>${status.tmdb.keyType === 'v4' ? 'Read access token (v4)' : 'API key (v3)'}</strong></div>
          <div><span>Account</span><strong>${status.tmdb.account ? esc(status.tmdb.account) : 'Not reported by v3 keys'}</strong></div>
          <div><span>Language</span><strong>${esc(status.tmdb.language || config.tmdb.language)}</strong></div>
          <div><span>Linked</span><strong>${status.tmdb.linkedAt ? formatDate(status.tmdb.linkedAt) : 'Yes'}</strong></div>
        </div>` : ''}
        ${status.tmdb.lastError ? `<p class="form-error">Last TMDB request failed: ${esc(status.tmdb.lastError)}</p>` : ''}
        <div class="field">
          <label for="tmdb-lang">Metadata language</label>
          <select class="select" id="tmdb-lang" style="max-width:220px">${tmdbLanguages}</select>
          <div class="hint">Titles, synopses and artwork are fetched in this language. Changing it re-fetches metadata for everything in the library.</div>
        </div>
        <div class="field">
          <label for="tmdb-region">Streaming region</label>
          <select class="select" id="tmdb-region" style="max-width:220px">${tmdbRegions}</select>
          <div class="hint">Discover shows where titles are streaming in this country. Saved as soon as you pick one; availability comes from JustWatch via TMDB.</div>
        </div>
        <div id="tmdb-form"${tmdbLinked ? ' hidden' : ''}>
          <div class="field">
            <label for="tmdb-key">API key or read access token</label>
            <input class="input" id="tmdb-key" type="password" autocomplete="off" spellcheck="false"
              placeholder="Paste your TMDB v3 API key or v4 read access token" />
            <div class="hint">Free from <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a>. Either the API Key (v3) or the API Read Access Token (v4) works; the key is checked before it is saved.</div>
          </div>
          <p class="form-error" id="tmdb-error" hidden></p>
          <div class="row-actions">
            <button class="btn btn-primary btn-sm" id="tmdb-link">${tmdbLinked ? 'Test &amp; replace key' : 'Test &amp; link'}</button>
            ${tmdbLinked
              ? '<button class="btn btn-quiet btn-sm" id="tmdb-cancel" type="button">Cancel</button>'
              : '<a class="btn btn-quiet btn-sm" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Create a free key</a>'}
          </div>
        </div>
        ${tmdbLinked ? `<div class="row-actions">
          <button class="btn btn-quiet btn-sm" id="tmdb-replace" type="button">Replace key</button>
          <button class="btn btn-primary btn-sm" id="tmdb-refresh">Save language &amp; refresh</button>
          <button class="btn btn-quiet btn-sm" id="tmdb-unlink">Unlink</button>
        </div>` : ''}
        <p class="attrib">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </section>

      <section class="settings-card" id="playback-card">
        <div class="card-head">
          <h2>Playback</h2>
          <span class="link-badge ${playbackStatus.ready ? 'on' : ''}">
            <span class="status-dot ${playbackStatus.ready ? 'ok' : 'err'}"></span>
            ${playbackStatus.ready ? 'Transcoding ready' : 'FFmpeg missing'}
          </span>
        </div>
        <p>Files the browser cannot decode — MKV, AVI, HEVC, MPEG-2, WMV, DTS audio and the rest of what VLC handles — are converted to H.264/AAC as you watch. Nothing is converted up front, so playback starts after a few seconds and seeking re-encodes only the part you jump to.</p>
        <div class="kv" style="margin-bottom:18px">
          <div><span>FFmpeg</span><strong>${playbackStatus.ffmpeg && playbackStatus.ffmpeg.found ? `${esc(playbackStatus.ffmpeg.version)} · ${esc(playbackSource(playbackStatus.ffmpeg.source))}` : 'Not found'}</strong></div>
          <div><span>ffprobe</span><strong>${playbackStatus.ffprobe && playbackStatus.ffprobe.found ? `${esc(playbackStatus.ffprobe.version)} · ${esc(playbackSource(playbackStatus.ffprobe.source))}` : 'Not found'}</strong></div>
        </div>
        <div class="field">
          <label for="playback-mode">Conversion</label>
          <select class="select" id="playback-mode" style="max-width:320px">
            <option value="auto" ${config.playback.transcode === 'auto' ? 'selected' : ''}>Automatic — convert only unsupported files</option>
            <option value="off" ${config.playback.transcode === 'off' ? 'selected' : ''}>Off — play native formats only</option>
          </select>
          <div class="hint">Turning conversion off saves CPU but limits playback to MP4/MOV/WebM with H.264, VP8/9 or AV1 and AAC, MP3 or Opus audio.</div>
        </div>
        <div class="field">
          <label class="check-row" for="playback-autoplay">
            <input type="checkbox" id="playback-autoplay" ${config.playback.autoplayNext !== false ? 'checked' : ''} />
            <span>Autoplay the next episode
              <em>When an episode ends, the next one starts automatically after a 9-second countdown.</em>
            </span>
          </label>
        </div>
        <div class="field">
          <label for="playback-quality">Conversion quality</label>
          <select class="select" id="playback-quality" style="max-width:320px">
            <option value="fast" ${config.playback.quality === 'fast' ? 'selected' : ''}>Fast — quickest start, larger files</option>
            <option value="balanced" ${config.playback.quality === 'balanced' ? 'selected' : ''}>Balanced — good picture, moderate CPU</option>
            <option value="high" ${config.playback.quality === 'high' ? 'selected' : ''}>High — best picture, heavy CPU</option>
          </select>
        </div>
        <div class="field">
          <label for="playback-height">Maximum resolution when converting</label>
          <select class="select" id="playback-height" style="max-width:320px">
            <option value="720" ${Number(config.playback.maxHeight) === 720 ? 'selected' : ''}>720p</option>
            <option value="1080" ${Number(config.playback.maxHeight) === 1080 ? 'selected' : ''}>1080p</option>
            <option value="0" ${Number(config.playback.maxHeight) === 0 ? 'selected' : ''}>Original</option>
          </select>
        </div>
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" id="save-playback">Save playback settings</button>
          <span class="tiny muted">${playbackStatus.ready ? 'The player shows a “Transcoding” badge whenever it is converting.' : 'Install FFmpeg (brew install ffmpeg, winget install Gyan.FFmpeg) and restart to enable conversion.'}</span>
        </div>
      </section>

      <section class="settings-card" id="devices-card">
        <div class="card-head">
          <h2>TV &amp; devices</h2>
          <span class="link-badge ${network.boundToLan && !network.restartRequired ? 'on' : ''}">
            <span class="status-dot ${network.boundToLan && !network.restartRequired ? 'ok' : ''}"></span>
            ${network.restartRequired ? 'Restart needed' : network.boundToLan ? 'On your network' : 'This machine only'}
          </span>
        </div>
        <p>ReelHouse listens on this machine only by default. Turn network access on and the ReelHouse app on your TV finds it automatically over Wi-Fi — no addresses to type.</p>
        <div class="field">
          <label class="check-row" for="lan-access">
            <input type="checkbox" id="lan-access" ${network.lanAccess ? 'checked' : ''} />
            <span>Let devices on my network connect
              <em>Anyone on this network can browse and play the library while this is on — there is no password.</em>
            </span>
          </label>
        </div>
        ${network.boundToLan
          ? `<div class="kv">
              ${(network.urls.length ? network.urls : ['Not on a network right now'])
                .map((url) => `<div><span>Address</span><strong class="mono">${esc(url)}</strong></div>`)
                .join('')}
              <div><span>TV discovery</span><strong>${network.discovery ? 'Answering' : 'Not answering'}</strong></div>
            </div>`
          : ''}
        ${network.restartRequired
          ? `<p class="form-error">${network.lanAccess
              ? 'Restart ReelHouse to start accepting devices on your network.'
              : 'Restart ReelHouse to stop serving other devices — until then they can still connect.'}</p>`
          : ''}
      </section>

      <section class="settings-card" id="live-card">
        <div class="card-head">
          <h2>Live TV (M3U)</h2>
          <span class="link-badge ${liveStatus.channelCount ? 'on' : ''}">
            <span class="status-dot ${liveStatus.channelCount ? 'ok' : ''}"></span>
            ${liveStatus.channelCount ? `${liveStatus.channelCount} channels` : 'No channels'}
          </span>
        </div>
        <p>Add an M3U/M3U8 playlist from your IPTV provider (or a path to a playlist file). Its channels appear in the TV Guide with a play button and stream live when you press it. The free-to-air UK list below is free channels only — no subscription service offers one, so a paid channel has to come from a playlist you are entitled to.</p>
        <div id="live-rows">${liveRows}</div>
        <div class="row-actions" style="margin-top:10px">
          <button class="btn btn-quiet" id="add-live">+ Add playlist</button>
          <button class="btn btn-quiet" id="refresh-live">Refresh channels now</button>
          <span class="tiny muted">${liveStatus.updatedAt
            ? `${liveStatus.sourceCount} playlist${liveStatus.sourceCount === 1 ? '' : 's'} · updated ${formatDate(liveStatus.updatedAt)}`
            : 'Not loaded yet'}</span>
        </div>
        ${liveStatus.errors && liveStatus.errors.length
          ? `<p class="tiny" style="color:var(--danger);margin-top:10px">${liveStatus.errors.map((e) => esc(`${e.name || e.source}: ${e.message}`)).join('<br>')}</p>`
          : ''}
        <p class="tiny muted" style="margin-top:10px">Channels are matched to the guide by <span class="mono">tvg-id</span>, falling back to the channel name. Playlist links often carry your username and password — they are stored in this machine's data folder only.</p>
      </section>

      <section class="settings-card">
        <h2>TV guide (EPG)</h2>
        <p>Point ReelHouse at one or more XMLTV files or URLs. The guide refreshes automatically every ${config.epg.refreshHours || 6} hours, and you can refresh it on demand.</p>
        <div id="epg-rows">${epgRows}</div>
        <div class="row-actions">
          <button class="btn btn-quiet" id="add-epg">+ Add source</button>
          <button class="btn btn-quiet" id="refresh-epg">Refresh guide now</button>
          <span class="tiny muted">${status.epg.channelCount || 0} channels · ${status.epg.programmeCount || 0} programmes${status.epg.updatedAt ? ` · updated ${formatDate(status.epg.updatedAt)}` : ''}</span>
        </div>
        ${status.epg.errors && status.epg.errors.length
          ? `<p class="tiny" style="color:var(--danger);margin-top:10px">${status.epg.errors.map((e) => esc(`${e.source}: ${e.message}`)).join('<br>')}</p>`
          : ''}
      </section>

      <section class="settings-card">
        <h2>Library</h2>
        <div class="kv">
          <div><span>Movies</span><strong>${counts.movies || 0}</strong></div>
          <div><span>Shows</span><strong>${counts.shows || 0}</strong></div>
          <div><span>Episodes</span><strong>${counts.episodes || 0}</strong></div>
          <div><span>Last scan</span><strong>${status.library.scannedAt ? formatDate(status.library.scannedAt) : 'Never'}</strong></div>
        </div>
        <div class="row-actions">
          <button class="btn btn-primary btn-sm" id="scan-now">Scan library</button>
          <span class="tiny muted mono">${esc(status.dataDir)}</span>
        </div>
        ${(status.library.dirErrors || []).length
          ? '<p class="tiny muted" style="margin-top:10px">Some folders could not be read — see the warning on the folder card above.</p>'
          : ''}
      </section>

      <section class="settings-card">
        <h2>About</h2>
        <p>ReelHouse ${esc(status.version)} · local media centre. The desktop app runs this same service on your machine; the web app at <span class="mono">${esc(location.origin)}</span> talks to it directly.</p>
        <div class="row-actions">
          <a class="btn btn-quiet" href="#/">Back to library</a>
          ${isDesktop ? '<button class="btn btn-quiet" id="open-data">Open data folder</button>' : ''}
        </div>
      </section>

      <div class="row-actions" style="position:sticky;bottom:16px;margin-bottom:24px">
        <button class="btn btn-primary" id="save-settings">Save changes</button>
        <span class="tiny muted">Saving re-scans folders and refreshes the guide.</span>
      </div>
    </div>`;

  const settingsRoot = view.querySelector('.settings-wrap');
  const FOLDER_PLACEHOLDER = {
    movies: '/Volumes/Media/Movies',
    tv: '/Volumes/Media/TV Shows',
    auto: '/Volumes/Media',
  };

  const syncDirEmpty = (list) => {
    if (!list) return;
    const count = list.querySelectorAll('.dir-row').length;
    const empty = list.querySelector('.dir-empty');
    if (empty) empty.hidden = count > 0;
    const pill = list.closest('.settings-card')?.querySelector('.pill-note');
    if (pill) pill.textContent = `${count} ${count === 1 ? 'folder' : 'folders'}`;
  };

  settingsRoot.addEventListener('click', async (event) => {
    const add = event.target.closest('[data-add-dir]');
    if (add) {
      const type = add.dataset.addDir;
      const list = document.getElementById(`dirs-${type}`);
      if (!list) return;
      list.insertAdjacentHTML('beforeend', dirRow({ path: '' }, FOLDER_PLACEHOLDER[type] || ''));
      syncDirEmpty(list);
      const input = list.lastElementChild.querySelector('input');
      if (input) input.focus();
      return;
    }

    const remove = event.target.closest('.dir-remove');
    if (remove) {
      const list = remove.closest('.dir-list');
      remove.closest('.dir-row').remove();
      syncDirEmpty(list);
      return;
    }

    const browse = event.target.closest('.dir-browse');
    if (browse && window.reelhouseDesktop) {
      const picked = await window.reelhouseDesktop.pickFolder();
      if (picked) browse.closest('.dir-row').querySelector('input').value = picked;
      return;
    }

    const open = event.target.closest('.dir-open');
    if (open && window.reelhouseDesktop && window.reelhouseDesktop.openPath) {
      const target = open.closest('.dir-row').querySelector('input').value.trim();
      if (!target) {
        toast('Add a folder path first.', 'error');
        return;
      }
      await window.reelhouseDesktop.openPath(target);
    }
  });

  const addEpg = document.getElementById('add-epg');
  addEpg.addEventListener('click', () => {
    const wrapper = document.getElementById('epg-rows');
    const row = document.createElement('div');
    row.className = 'epg-row';
    row.innerHTML = `
      <input class="input epg-name" type="text" placeholder="Freeview" aria-label="Guide name" />
      <input class="input epg-source" type="text" placeholder="https://…/guide.xml" aria-label="XMLTV source" />
      <button class="icon-btn epg-remove" aria-label="Remove guide source" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>`;
    wrapper.appendChild(row);
    row.querySelector('input').focus();
  });


  const openData = document.getElementById('open-data');
  if (openData && window.reelhouseDesktop) {
    openData.addEventListener('click', () => window.reelhouseDesktop.openDataFolder());
  }
  document.getElementById('epg-rows').addEventListener('click', (event) => {
    const btn = event.target.closest('.epg-remove');
    if (btn) btn.closest('.epg-row').remove();
  });

  document.getElementById('refresh-epg').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      const result = await api.refreshEpg();
      toast(`Guide updated: ${result.summary.channelCount} channels, ${result.summary.programmeCount} programmes`, 'success');
      await loadLibrary();
      renderSettings();
    } catch (err) {
      toast(`Guide refresh failed: ${err.message}`, 'error');
      button.disabled = false;
      button.textContent = 'Refresh guide now';
    }
  });

  /* ------------------------------------------------------- Live TV (M3U) */
  document.getElementById('add-live').addEventListener('click', () => {
    const wrapper = document.getElementById('live-rows');
    const row = document.createElement('div');
    row.className = 'epg-row live-row';
    row.innerHTML = `
      <input class="input live-name" type="text" placeholder="My IPTV" aria-label="Playlist name" />
      <input class="input live-url" type="text" placeholder="https://…/playlist.m3u" aria-label="M3U playlist URL" />
      <button class="icon-btn live-remove" aria-label="Remove playlist" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
      </button>`;
    wrapper.appendChild(row);
    row.querySelector('input').focus();
  });

  document.getElementById('live-rows').addEventListener('click', (event) => {
    const btn = event.target.closest('.live-remove');
    if (btn) btn.closest('.live-row').remove();
  });

  const collectLiveSources = () => [...document.querySelectorAll('#live-rows .live-row')]
    .map((row) => ({
      id: row.dataset.id || undefined,
      name: row.querySelector('.live-name').value.trim() || 'M3U playlist',
      url: row.querySelector('.live-url').value.trim(),
    }))
    .filter((source) => source.url);

  document.getElementById('refresh-live').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      // Reloading from the form, not from disk: a playlist someone has just
      // pasted has to work before they remember to press Save changes.
      await api.saveSettings({ live: { sources: collectLiveSources() } });
      const result = await api.refreshLive();
      const failed = result.summary.errors || [];
      if (result.summary.channelCount) {
        toast(`Channels updated: ${result.summary.channelCount} live${failed.length ? ` · ${failed.length} playlist${failed.length === 1 ? '' : 's'} failed` : ''}`, failed.length ? 'error' : 'success');
      } else {
        toast(failed.length ? `No channels loaded — ${failed[0].message}` : 'No playlists to load yet', 'error');
      }
      renderSettings();
    } catch (err) {
      toast(`Channel refresh failed: ${err.message}`, 'error');
      button.disabled = false;
      button.textContent = 'Refresh channels now';
    }
  });

  document.getElementById('scan-now').addEventListener('click', triggerScan);

  /* ------------------------------------------------------- TMDB link card */
  if (document.getElementById('tmdb-card')) {
    const errorBox = document.getElementById('tmdb-error');
    const keyInput = document.getElementById('tmdb-key');
    const langSelect = document.getElementById('tmdb-lang');

    const showError = (message) => {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = message;
      } else {
        toast(message, 'error');
      }
    };

    const afterChange = async () => {
      await Promise.all([loadLibrary(), api.status().then((next) => { state.status = next; })]);
      renderSettings();
      setTimeout(() => watchScan(), 500);
    };

    const linkButton = document.getElementById('tmdb-link');
    if (linkButton) {
      const submit = async () => {
        const apiKey = keyInput.value.trim();
        if (!apiKey) {
          showError('Paste your TMDB key first.');
          keyInput.focus();
          return;
        }
        if (errorBox) errorBox.hidden = true;
        linkButton.disabled = true;
        linkButton.textContent = 'Checking…';
        try {
          const result = await api.verifyTmdb({ apiKey, language: langSelect.value });
          toast(result.tmdb.account ? `TMDB linked as ${result.tmdb.account}` : 'TMDB linked — fetching artwork', 'success');
          await afterChange();
        } catch (err) {
          showError(err.message);
          linkButton.disabled = false;
          linkButton.textContent = tmdbLinked ? 'Test & replace key' : 'Test & link';
          keyInput.focus();
        }
      };
      linkButton.addEventListener('click', submit);
      keyInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
    }

    // Replacing a working key: open the same form, then put it away again.
    const keyForm = document.getElementById('tmdb-form');
    const replaceButton = document.getElementById('tmdb-replace');
    const cancelButton = document.getElementById('tmdb-cancel');
    if (replaceButton && keyForm) {
      replaceButton.addEventListener('click', () => {
        keyForm.hidden = false;
        replaceButton.hidden = true;
        if (errorBox) errorBox.hidden = true;
        keyInput.focus();
      });
    }
    if (cancelButton && keyForm) {
      cancelButton.addEventListener('click', () => {
        keyForm.hidden = true;
        if (replaceButton) replaceButton.hidden = false;
        keyInput.value = '';
        if (errorBox) errorBox.hidden = true;
      });
    }

    const refreshButton = document.getElementById('tmdb-refresh');
    if (refreshButton) {
      refreshButton.addEventListener('click', async () => {
        refreshButton.disabled = true;
        refreshButton.textContent = 'Refreshing…';
        try {
          await api.refreshTmdb({ language: langSelect.value });
          toast('Refreshing metadata from TMDB…', 'success');
          setTimeout(() => watchScan(), 400);
        } catch (err) {
          toast(err.message, 'error');
        }
        refreshButton.disabled = false;
        refreshButton.textContent = 'Save language & refresh';
      });
    }

    const regionSelect = document.getElementById('tmdb-region');
    if (regionSelect) {
      regionSelect.addEventListener('change', async () => {
        regionSelect.disabled = true;
        try {
          await api.saveSettings({ tmdb: { region: regionSelect.value } });
          // Availability is per region, so throw away what Discover already knows.
          state.discover = null;
          providerCache.clear();
          toast(`Streaming region: ${regionName(regionSelect.value)}`, 'success');
        } catch (err) {
          toast(`Could not save region: ${err.message}`, 'error');
        }
        regionSelect.disabled = false;
      });
    }

    const unlinkButton = document.getElementById('tmdb-unlink');
    if (unlinkButton) {
      let armed = false;
      let disarm = null;
      const reset = () => {
        armed = false;
        clearTimeout(disarm);
        unlinkButton.textContent = 'Unlink';
        unlinkButton.classList.remove('btn-danger');
      };
      unlinkButton.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          unlinkButton.textContent = 'Confirm unlink';
          unlinkButton.classList.add('btn-danger');
          disarm = setTimeout(reset, 4000);
          return;
        }
        clearTimeout(disarm);
        unlinkButton.disabled = true;
        unlinkButton.textContent = 'Unlinking…';
        try {
          await api.unlinkTmdb();
          toast('TMDB unlinked — refreshing library', 'success');
          await afterChange();
        } catch (err) {
          toast(err.message, 'error');
          reset();
          unlinkButton.disabled = false;
        }
      });
    }
  }

  const lanToggle = document.getElementById('lan-access');
  if (lanToggle) {
    lanToggle.addEventListener('change', async () => {
      lanToggle.disabled = true;
      const enabled = lanToggle.checked;
      try {
        await api.saveSettings({ server: { lanAccess: enabled } });
        toast(enabled ? 'Network access on — restart ReelHouse to apply' : 'Network access off — restart ReelHouse to apply', 'success');
        renderSettings();
      } catch (err) {
        lanToggle.checked = !enabled;
        lanToggle.disabled = false;
        toast(err.message, 'error');
      }
    });
  }

  const savePlayback = document.getElementById('save-playback');
  if (savePlayback) {
    savePlayback.addEventListener('click', async () => {
      savePlayback.disabled = true;
      savePlayback.textContent = 'Saving…';
      try {
        await api.saveSettings({
          playback: {
            transcode: document.getElementById('playback-mode').value,
            autoplayNext: document.getElementById('playback-autoplay').checked,
            quality: document.getElementById('playback-quality').value,
            maxHeight: Number(document.getElementById('playback-height').value),
          },
        });
        toast('Playback settings saved', 'success');
        renderSettings();
      } catch (err) {
        toast(`Could not save: ${err.message}`, 'error');
        savePlayback.disabled = false;
        savePlayback.textContent = 'Save playback settings';
      }
    });
  }

  document.getElementById('save-settings').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const dirs = [...document.querySelectorAll('.dir-list')]
      .flatMap((list) => [...list.querySelectorAll('.dir-row')].map((row) => ({
        path: row.querySelector('input').value.trim(),
        type: list.dataset.type,
      })))
      .filter((dir) => dir.path);
    const sources = [...document.querySelectorAll('#epg-rows .epg-row')]
      .map((row) => ({
        name: row.querySelector('.epg-name').value.trim() || 'XMLTV source',
        source: row.querySelector('.epg-source').value.trim(),
      }))
      .filter((source) => source.source);

    const liveSources = collectLiveSources();

    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      // TMDB is managed by its own card; saving folders must never touch the key.
      await api.saveSettings({
        mediaDirs: dirs,
        epg: { sources },
        live: { sources: liveSources },
      });
      toast('Settings saved — scanning folders…', 'success');
      await Promise.all([loadLibrary(), api.status().then((s) => { state.status = s; })]);
      renderSettings();
      setTimeout(() => watchScan(), 400);
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'error');
      button.disabled = false;
      button.textContent = 'Save changes';
    }
  });
}

/* ============================================================
   Scanning
   ============================================================ */

async function triggerScan() {
  try {
    await api.scan();
    toast('Scanning library…');
    scanBtn.classList.add('spinning');
    watchScan();
  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  }
}

async function watchScan() {
  if (state.scanPoll) return;
  let settled = false;
  const tick = async () => {
    if (settled) return false;
    let data;
    try {
      data = await api.scanStatus();
    } catch {
      return true;
    }
    const scan = data.scan;
    if (scan.running) {
      scanStrip.hidden = false;
      scanStripText.textContent = scan.message || 'Scanning…';
      scanBtn.classList.add('spinning');
      return true;
    }
    // A fast scan can finish between the polling ticks; report it once only.
    settled = true;
    scanStrip.hidden = true;
    scanBtn.classList.remove('spinning');
    // Several watchers can observe one scan; report each result exactly once.
    const report = scan.finishedAt && state.lastScanReport !== scan.finishedAt;
    if (!report) return false;
    state.lastScanReport = scan.finishedAt;
    if (scan.phase === 'error') {
      toast(scan.message, 'error');
    } else if (scan.phase === 'done') {
      await Promise.all([loadLibrary(), loadProgress()]);
      toast(scan.message, 'success');
      const route = currentRoute();
      if (['home', 'movies', 'shows'].includes(route.name)) route.render();
    }
    return false;
  };

  const stop = () => {
    clearInterval(interval);
    if (state.scanPoll === interval) state.scanPoll = null;
  };
  const interval = setInterval(async () => {
    if (!(await tick())) stop();
  }, 900);
  state.scanPoll = interval;

  if (!(await tick())) stop();
}

/* ============================================================
   Search
   ============================================================ */

function wireSearch() {
  const wrap = document.getElementById('search-wrap');
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  let controller = null;
  let debounce = null;

  const hide = () => hideSearch();
  window.__hideSearch = hide;

  const render = (data, query) => {
    const total = data.movies.length + data.shows.length + data.programmes.length;
    if (!total) {
      results.innerHTML = `<div class="sr-empty">No matches for “${esc(query)}”</div>`;
      results.hidden = false;
      return;
    }
    const item = (thumb, title, meta, href) => `
      <button class="sr-item" data-href="${esc(href)}">
        <span class="sr-thumb">${thumb}</span>
        <span class="sr-body"><span class="sr-title">${esc(title)}</span><span class="sr-meta">${esc(meta)}</span></span>
      </button>`;
    const thumb = (obj) => (obj.poster ? `<img src="${art(obj.poster, 'w92')}" alt="">` : '');

    results.innerHTML = [
      data.movies.length ? '<div class="sr-section">Movies</div>' : '',
      ...data.movies.slice(0, 5).map((m) => item(thumb(m), m.title, [m.year, m.runtime ? formatRuntime(m.runtime) : null].filter(Boolean).join(' · ') || 'Movie', `#/movie/${m.id}`)),
      data.shows.length ? '<div class="sr-section">TV shows</div>' : '',
      ...data.shows.slice(0, 5).map((s) => item(thumb(s), s.title, [s.year, `${s.episodeCount || 0} episodes`].filter(Boolean).join(' · '), `#/show/${s.id}`)),
      data.programmes.length ? '<div class="sr-section">On the guide</div>' : '',
      ...data.programmes.slice(0, 5).map((p) => item('', p.title, `${p.channelName || 'TV'} · ${formatTime(p.start)}`, `#/guide`)),
    ].join('');
    results.hidden = false;
    results.querySelectorAll('.sr-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.hash = btn.dataset.href;
        hideSearch();
        input.blur();
      });
    });
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(debounce);
    if (controller) controller.abort();
    if (query.length < 2) {
      results.hidden = true;
      return;
    }
    debounce = setTimeout(async () => {
      controller = new AbortController();
      try {
        const data = await api.search(query, controller.signal);
        render(data, query);
      } catch (err) {
        if (err.name !== 'AbortError') results.innerHTML = `<div class="sr-empty">Search unavailable</div>`;
      }
    }, 220);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && results.innerHTML) results.hidden = false;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      results.hidden = true;
      input.blur();
    }
    if (event.key === 'Enter') {
      const first = results.querySelector('.sr-item');
      if (first) first.click();
    }
  });

  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target)) results.hidden = true;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault();
      input.focus();
    }
  });
}

function hideSearch() {
  const results = document.getElementById('search-results');
  if (results) results.hidden = true;
}

/* ============================================================
   Router
   ============================================================ */

function currentRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');

  if (parts.length === 0) return { name: 'home', render: renderHome, nav: 'home' };
  if (parts[0] === 'movies') return { name: 'movies', render: () => renderCollection('movies'), nav: 'movies' };
  if (parts[0] === 'shows') return { name: 'shows', render: () => renderCollection('shows'), nav: 'shows' };
  if (parts[0] === 'discover') return { name: 'discover', render: renderDiscover, nav: 'discover' };
  if (parts[0] === 'movie' && parts[1]) return { name: 'movie', render: () => renderMovie(parts[1]), nav: 'movies' };
  if (parts[0] === 'show' && parts[1]) return { name: 'show', render: () => renderShow(parts[1]), nav: 'shows' };
  if (parts[0] === 'guide') return { name: 'guide', render: renderGuide, nav: 'guide' };
  if (parts[0] === 'settings') return { name: 'settings', render: renderSettings, nav: '' };
  if (parts[0] === 'watch' && parts[1] && parts[2]) {
    return { name: 'watch', render: () => renderPlayer(parts[1], parts[2]), nav: '' };
  }
  if (parts[0] === 'live' && parts[1]) {
    return { name: 'live', render: () => renderLive(decodeURIComponent(parts[1])), nav: 'guide' };
  }
  return { name: 'home', render: renderHome, nav: 'home' };
}

async function route() {
  clearTransient();
  const routeInfo = currentRoute();
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.nav === routeInfo.nav));
  closeSheet();
  hideSearch();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (!state.library && routeInfo.name !== 'settings') {
    view.innerHTML = `<div class="page"><div class="loading-row">${Array.from({ length: 10 }, () => '<div class="skeleton"></div>').join('')}</div></div>`;
    await loadLibrary();
    await loadProgress();
  }

  try {
    await routeInfo.render();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="page"><div class="empty"><h3>Something went wrong</h3><p>${esc(err.message)}</p><a class="btn btn-primary" href="#/">Back home</a></div></div>`;
  }
}

/* ============================================================
   Boot
   ============================================================ */

(async function boot() {
  if (window.reelhouseDesktop) document.body.classList.add('desktop');
  wireSearch();
  scanBtn.addEventListener('click', triggerScan);
  window.addEventListener('hashchange', route);

  try {
    state.status = await api.status();
  } catch {
    view.innerHTML = `<div class="page"><div class="empty"><h3>ReelHouse service is not reachable</h3><p>Start it with <span class="mono">npm start</span> (or open the desktop app), then reload this page.</p></div></div>`;
    return;
  }

  if (state.status.scan && state.status.scan.running) watchScan();
  await Promise.all([loadLibrary(), loadProgress()]);
  await route();
})();
