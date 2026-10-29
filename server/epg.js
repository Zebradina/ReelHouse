'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ['channel', 'programme', 'display-name', 'title', 'desc', 'category', 'icon', 'episode-num'].includes(name),
});

function textOf(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const english = node.find((n) => n && n['@_lang'] && String(n['@_lang']).toLowerCase().startsWith('en'));
    return textOf(english || node[0]);
  }
  if (typeof node === 'object') return node['#text'] != null ? String(node['#text']) : null;
  return String(node);
}

/** XMLTV timestamps are "YYYYMMDDHHMMSS +ZZZZ" in local time of the source. */
function parseXmltvDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{4})?/);
  if (!m) {
    const natural = new Date(raw);
    return Number.isNaN(natural.getTime()) ? null : natural.toISOString();
  }
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz) {
    iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
  } else {
    iso += 'Z';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function channelNumber(name, index) {
  const m = String(name || '').match(/(\d{2,4})/);
  if (m) return m[1];
  return String(101 + index);
}

function normaliseChannel(raw, index) {
  const id = String(raw['@_id'] || `channel-${index}`);
  let name = textOf(raw['display-name']) || id;
  const number = channelNumber(name, index);
  // Plenty of guides repeat the channel number in the name ("103 Harbour
  // Drama"). The guide has a number column, so drop it rather than waste the
  // narrow name column repeating it.
  const stripped = name.replace(new RegExp(`^${number}[\\s.\\-:|]+(\\S.*)$`), '$1').trim();
  if (stripped) name = stripped;
  const iconNode = Array.isArray(raw.icon) ? raw.icon[0] : raw.icon;
  return {
    id,
    name,
    number,
    icon: (iconNode && iconNode['@_src']) || null,
  };
}

function normaliseProgramme(raw) {
  const start = parseXmltvDate(raw['@_start']);
  const stop = parseXmltvDate(raw['@_stop']);
  if (!start) return null;
  const iconNode = Array.isArray(raw.icon) ? raw.icon[0] : raw.icon;
  const categories = (Array.isArray(raw.category) ? raw.category : raw.category ? [raw.category] : [])
    .map((c) => textOf(c))
    .filter(Boolean);
  const episodeNum = (Array.isArray(raw['episode-num']) ? raw['episode-num'] : raw['episode-num'] ? [raw['episode-num']] : [])
    .find((e) => (e['@_system'] || '').includes('xmltv_ns'));
  let seasonEpisode = null;
  if (episodeNum) {
    const text = textOf(episodeNum) || '';
    const parts = text.split('/');
    const s = Number(parts[0]);
    const e = Number(parts[1]);
    if (Number.isFinite(s) && Number.isFinite(e)) seasonEpisode = { season: s + 1, episode: e + 1 };
  }
  const ratingNode = raw.rating;
  return {
    channel: String(raw['@_channel'] || ''),
    start,
    stop: stop || new Date(new Date(start).getTime() + 30 * 60000).toISOString(),
    title: textOf(raw.title) || 'Untitled',
    subTitle: textOf(raw['sub-title']) || null,
    desc: textOf(raw.desc) || null,
    category: categories[0] || null,
    categories,
    icon: (iconNode && iconNode['@_src']) || null,
    rating: ratingNode ? textOf(ratingNode.value) : null,
    seasonEpisode,
  };
}

async function readSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(source, {
        signal: controller.signal,
        headers: { accept: 'application/xml,text/xml,*/*', 'user-agent': 'ReelHouse/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  const file = source.startsWith('~') ? path.join(require('os').homedir(), source.slice(1)) : source;
  return fsp.readFile(file, 'utf8');
}

class Epg {
  constructor({ cacheFile }) {
    this.cacheFile = cacheFile;
    this.data = { version: 1, updatedAt: null, channels: [], programmes: [], errors: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        if (parsed && Array.isArray(parsed.channels)) this.data = parsed;
      }
    } catch (err) {
      console.error('[epg] could not read cache:', err.message);
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.data));
    } catch (err) {
      console.error('[epg] could not write cache:', err.message);
    }
  }

  /** Parse every enabled source and merge the result. */
  async refresh(sources = []) {
    const channels = new Map();
    const programmes = [];
    const errors = [];
    let read = 0;

    for (const source of sources) {
      if (source.enabled === false) continue;
      try {
        const xml = await readSource(source.source);
        const doc = parser.parse(xml);
        const root = doc.tv || doc.TV || doc;
        const rawChannels = Array.isArray(root.channel) ? root.channel : root.channel ? [root.channel] : [];
        rawChannels.forEach((raw, index) => {
          const channel = normaliseChannel(raw, channels.size + index);
          if (!channels.has(channel.id)) channels.set(channel.id, channel);
        });
        const rawProgrammes = Array.isArray(root.programme) ? root.programme : root.programme ? [root.programme] : [];
        for (const raw of rawProgrammes) {
          const programme = normaliseProgramme(raw);
          if (programme && programme.channel) programmes.push(programme);
        }
        read += 1;
      } catch (err) {
        errors.push({ source: String(source.source).replace(/api[_-]?key=[^&]+/gi, 'api_key=***'), message: err.message });
        console.error(`[epg] ${source.name || source.source}:`, err.message);
      }
    }

    // A programme whose channel is missing still needs a channel row.
    for (const programme of programmes) {
      if (!channels.has(programme.channel)) {
        channels.set(programme.channel, { id: programme.channel, name: programme.channel, number: String(101 + channels.size), icon: null });
      }
    }

    programmes.sort((a, b) => new Date(a.start) - new Date(b.start));

    this.data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sourceCount: read,
      channels: [...channels.values()],
      programmes,
      errors,
    };
    this.save();
    return this.summary();
  }

  summary() {
    return {
      updatedAt: this.data.updatedAt,
      channelCount: this.data.channels.length,
      programmeCount: this.data.programmes.length,
      sourceCount: this.data.sourceCount || 0,
      errors: this.data.errors || [],
      demo: Boolean(this.data.demo),
    };
  }

  /** Programmes intersecting a time window, grouped for the guide UI. */
  window(fromIso, toIso) {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const programmes = this.data.programmes.filter((p) => {
      const start = new Date(p.start).getTime();
      const stop = new Date(p.stop).getTime();
      return stop > from && start < to;
    });
    const active = new Set(programmes.map((p) => p.channel));
    const channels = this.data.channels.filter((c) => active.has(c.id));
    return { channels, programmes };
  }

  /** First programme per channel at a point in time — used for "Now on TV". */
  now(at = new Date()) {
    const time = at.getTime();
    const current = this.data.programmes.filter((p) => {
      const start = new Date(p.start).getTime();
      const stop = new Date(p.stop).getTime();
      return start <= time && stop > time;
    });
    const byChannel = new Map();
    for (const p of current) byChannel.set(p.channel, p);
    return [...byChannel.entries()].map(([channelId, programme]) => ({
      channel: this.data.channels.find((c) => c.id === channelId) || { id: channelId, name: channelId },
      programme,
    }));
  }
}

module.exports = { Epg, parseXmltvDate };
