'use strict';

/**
 * Live TV channels from M3U playlists.
 *
 * An M3U playlist is a flat list of channels — one `#EXTINF` line of metadata
 * followed by the stream URL:
 *
 *   #EXTM3U
 *   #EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://…/bbc1.png" group-title="UK",BBC One
 *   http://provider.example/live/user/pass/101.m3u8
 *
 * The `tvg-id` is what links a channel to XMLTV guide data, so the same value is
 * kept here and matched against the EPG when the guide is built.
 *
 * Fetching is deliberately shallow: playlists can be hundreds of kilobytes and
 * change constantly, so we read the whole thing, keep the channel list and throw
 * the text away. Nothing is written to disk except the parsed channel list.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

/** Attributes on an #EXTINF line, e.g. tvg-id="x" group-title="UK". */
const ATTRIBUTE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

/** Query values that are almost always credentials in IPTV URLs. */
const SECRET_QUERY = /([?&](?:api[_-]?key|token|password|pass|auth|user|username)=)[^&]+/gi;

function redact(value) {
  return String(value || '').replace(SECRET_QUERY, '$1***');
}

/** `BBC One HD` -> `bbc-one-hd`, for channels that carry no tvg-id. */
function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseExtinf(line) {
  const attrs = {};
  ATTRIBUTE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE.exec(line))) attrs[match[1].toLowerCase()] = match[2];

  // The display name is everything after the final comma.
  const comma = line.lastIndexOf(',');
  const title = comma === -1 ? '' : line.slice(comma + 1).trim();
  return { attrs, title };
}

/**
 * Parse an M3U/M3U8 playlist into channel records.
 *
 * Unknown `#` directives (#EXTGRP, #EXTVLCOPT, #KODIPROP, #EXT-X-…) are skipped,
 * and anything before the first #EXTINF is ignored — that is how playlists mark
 * up headers and per-channel options.
 *
 * @param {string} text
 * @param {{ sourceName?: string }} [options]
 */
function parsePlaylist(text, { sourceName = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];
  const used = new Set();
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXTINF:/i.test(line)) {
      pending = parseExtinf(line);
      continue;
    }
    // Every other directive is either a header or an option we do not use.
    if (line.startsWith('#')) continue;
    if (!pending) continue;

    let name = pending.attrs['tvg-name'] || pending.title || pending.attrs['tvg-id'] || 'Unnamed channel';
    // Many playlists prefix the name with the channel number ("101 BBC One").
    // The number belongs in the number slot, not in front of the name in a
    // guide column that is only wide enough for the name.
    let lead = null;
    const numbered = /^(\d{1,4})[\s.\-:|]+(\S.*)$/.exec(name.trim());
    if (numbered && !pending.attrs['tvg-chno']) {
      lead = numbered[1];
      name = numbered[2].trim();
    }
    let id = (pending.attrs['tvg-id'] || '').trim() || slug(name) || `channel-${channels.length + 1}`;
    // A playlist may repeat a tvg-id (regional feeds); ids have to stay unique
    // because they are what the guide and the player address channels by.
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    used.add(id);

    channels.push({
      id,
      name,
      url: line,
      tvgId: pending.attrs['tvg-id'] || null,
      icon: pending.attrs['tvg-logo'] || null,
      group: pending.attrs['group-title'] || null,
      number: String(pending.attrs['tvg-chno'] || lead || channels.length + 1),
      source: sourceName || null,
    });
    pending = null;
  }

  return channels;
}

async function readPlaylist(location) {
  if (/^https?:\/\//i.test(location)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(location, {
        signal: controller.signal,
        headers: { accept: 'application/x-mpegurl,audio/x-mpegurl,text/plain,*/*', 'user-agent': 'ReelHouse/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const file = location.startsWith('~') ? path.join(os.homedir(), location.slice(1)) : location;
  return fsp.readFile(file, 'utf8');
}

/**
 * Point every URI in a playlist at the local proxy.
 *
 * Browsers refuse cross-origin HLS unless the provider sends CORS headers, which
 * IPTV panels rarely do, and relative segment paths only resolve against the
 * playlist's own URL — which the browser never sees once playback is proxied.
 * Rewriting absolute proxy URLs fixes both, and it happens for variant playlists
 * too, so master -> media -> segment all stay on one origin.
 */
function rewritePlaylist(text, baseUrl) {
  const wrap = (value) => {
    try {
      return `/api/live/proxy?u=${encodeURIComponent(new URL(value, baseUrl).toString())}`;
    } catch {
      return value;
    }
  };

  return String(text || '')
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith('#')) {
        // #EXT-X-KEY and #EXT-X-MAP carry their URI in an attribute.
        return line.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${wrap(uri)}"`);
      }
      return wrap(line);
    })
    .join('\n');
}

class Live {
  constructor({ cacheFile }) {
    this.cacheFile = cacheFile;
    this.data = { version: 1, updatedAt: null, sourceCount: 0, channels: [], errors: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        if (parsed && Array.isArray(parsed.channels)) this.data = parsed;
      }
    } catch (err) {
      console.error('[live] could not read cache:', err.message);
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.data));
    } catch (err) {
      console.error('[live] could not write cache:', err.message);
    }
  }

  /** Fetch and parse every enabled playlist, replacing the channel list. */
  async refresh(sources = []) {
    const channels = new Map();
    const errors = [];
    let read = 0;

    for (const source of sources) {
      if (source.enabled === false) continue;
      const location = String(source.url || source.source || '').trim();
      if (!location) continue;
      try {
        const text = await readPlaylist(location);
        const parsed = parsePlaylist(text, { sourceName: source.name || null });
        if (!parsed.length) throw new Error('no channels found — is this an M3U playlist?');
        for (const channel of parsed) {
          if (!channels.has(channel.id)) channels.set(channel.id, channel);
        }
        read += 1;
      } catch (err) {
        errors.push({ source: redact(location), name: source.name || null, message: err.message });
        console.error(`[live] ${source.name || redact(location)}:`, err.message);
      }
    }

    this.data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sourceCount: read,
      channels: [...channels.values()],
      errors,
    };
    this.save();
    return this.summary();
  }

  channels() {
    return this.data.channels || [];
  }

  get(id) {
    return this.channels().find((channel) => channel.id === id) || null;
  }

  summary() {
    return {
      updatedAt: this.data.updatedAt,
      channelCount: this.channels().length,
      sourceCount: this.data.sourceCount || 0,
      errors: this.data.errors || [],
    };
  }
}

module.exports = { Live, parsePlaylist, rewritePlaylist, redact };
