/** Thin wrapper around the local ReelHouse service. */

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const error = new Error((data && (data.error || data.raw)) || `Request failed (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  status: () => request('/api/status'),
  settings: () => request('/api/settings'),
  saveSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),
  library: () => request('/api/library'),
  item: (id) => request(`/api/item/${encodeURIComponent(id)}`),
  scan: () => request('/api/scan', { method: 'POST' }),
  scanStatus: () => request('/api/scan/status'),
  progress: () => request('/api/progress'),
  saveProgress: (payload) => request('/api/progress', { method: 'POST', body: payload }),
  removeProgress: (id) => request(`/api/progress/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  continueWatching: () => request('/api/continue'),
  epg: (from, to) =>
    request(`/api/epg?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  epgNow: () => request('/api/epg/now'),
  refreshEpg: () => request('/api/epg/refresh', { method: 'POST' }),
  live: () => request('/api/live'),
  refreshLive: () => request('/api/live/refresh', { method: 'POST' }),
  livePlay: (id) => request(`/api/live/play/${encodeURIComponent(id)}`),
  play: (kind, id, { transcode = false, season, episode } = {}) => {
    const params = new URLSearchParams();
    if (transcode) params.set('transcode', '1');
    if (season != null) params.set('season', String(season));
    if (episode != null) params.set('episode', String(episode));
    const query = params.toString() ? `?${params}` : '';
    return request(`/api/play/${kind}/${encodeURIComponent(id)}${query}`);
  },
  discover: () => request('/api/discover'),
  discoverProviders: (type, ids) =>
    request(`/api/discover/providers?type=${encodeURIComponent(type)}&ids=${ids.join(',')}`),
  verifyTmdb: (payload) => request('/api/tmdb/verify', { method: 'POST', body: payload }),
  refreshTmdb: (payload) => request('/api/tmdb/refresh', { method: 'POST', body: payload }),
  unlinkTmdb: () => request('/api/tmdb', { method: 'DELETE' }),
  search: (q, signal) => request(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
};

/** Route TMDB artwork through the local cache so it also works offline. */
export function art(path, size = 'w500') {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return `/api/art?path=${encodeURIComponent(path)}&size=${size}`;
}

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Stable pastel-dark tint derived from a title, used for art placeholders. */
export function tintFor(value) {
  let hash = 0;
  const text = String(value || 'x');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

export function formatRuntime(minutes) {
  if (!minutes || Number.isNaN(Number(minutes))) return null;
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function formatTime(iso, opts = {}) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...opts });
}

export function formatDate(iso, opts = {}) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', ...opts });
}
