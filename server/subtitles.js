'use strict';

/**
 * Sidecar subtitle support.
 *
 * Finds .srt / .vtt files that sit next to a video (or in a Subs/Subtitles
 * folder beside it) and converts SubRip to WebVTT, which is the only subtitle
 * format browsers can render on a <video> element.
 */

const fs = require('fs');
const path = require('path');

const SUBTITLE_EXTS = new Set(['.srt', '.vtt']);
const SUBTITLE_DIRS = ['', 'Subs', 'Subtitles', 'subs', 'Subtitles/Subs', 'Subs/Subtitles'];

// token → [BCP-47 code, display name]
const LANGUAGES = {
  en: ['en', 'English'],
  eng: ['en', 'English'],
  english: ['en', 'English'],
  'en-us': ['en', 'English'],
  'en-gb': ['en', 'English (UK)'],
  fr: ['fr', 'French'],
  fre: ['fr', 'French'],
  fra: ['fr', 'French'],
  french: ['fr', 'French'],
  de: ['de', 'German'],
  ger: ['de', 'German'],
  deu: ['de', 'German'],
  german: ['de', 'German'],
  es: ['es', 'Spanish'],
  spa: ['es', 'Spanish'],
  spanish: ['es', 'Spanish'],
  it: ['it', 'Italian'],
  ita: ['it', 'Italian'],
  italian: ['it', 'Italian'],
  pt: ['pt', 'Portuguese'],
  por: ['pt', 'Portuguese'],
  ptbr: ['pt-BR', 'Portuguese (Brazil)'],
  'pt-br': ['pt-BR', 'Portuguese (Brazil)'],
  'pt-pt': ['pt-PT', 'Portuguese (Portugal)'],
  nl: ['nl', 'Dutch'],
  dut: ['nl', 'Dutch'],
  nld: ['nl', 'Dutch'],
  dutch: ['nl', 'Dutch'],
  sv: ['sv', 'Swedish'],
  swe: ['sv', 'Swedish'],
  swedish: ['sv', 'Swedish'],
  no: ['no', 'Norwegian'],
  nb: ['nb', 'Norwegian'],
  nor: ['no', 'Norwegian'],
  da: ['da', 'Danish'],
  dan: ['da', 'Danish'],
  fi: ['fi', 'Finnish'],
  fin: ['fi', 'Finnish'],
  pl: ['pl', 'Polish'],
  pol: ['pl', 'Polish'],
  cs: ['cs', 'Czech'],
  cze: ['cs', 'Czech'],
  ces: ['cs', 'Czech'],
  hu: ['hu', 'Hungarian'],
  hun: ['hu', 'Hungarian'],
  ro: ['ro', 'Romanian'],
  ron: ['ro', 'Romanian'],
  ru: ['ru', 'Russian'],
  rus: ['ru', 'Russian'],
  uk: ['uk', 'Ukrainian'],
  ukr: ['uk', 'Ukrainian'],
  el: ['el', 'Greek'],
  gre: ['el', 'Greek'],
  ell: ['el', 'Greek'],
  tr: ['tr', 'Turkish'],
  tur: ['tr', 'Turkish'],
  ar: ['ar', 'Arabic'],
  ara: ['ar', 'Arabic'],
  he: ['he', 'Hebrew'],
  heb: ['he', 'Hebrew'],
  hi: ['hi', 'Hindi'],
  hin: ['hi', 'Hindi'],
  ja: ['ja', 'Japanese'],
  jpn: ['ja', 'Japanese'],
  ko: ['ko', 'Korean'],
  kor: ['ko', 'Korean'],
  zh: ['zh', 'Chinese'],
  chi: ['zh', 'Chinese'],
  zho: ['zh', 'Chinese'],
  'zh-cn': ['zh-CN', 'Chinese (Simplified)'],
  'zh-tw': ['zh-TW', 'Chinese (Traditional)'],
  th: ['th', 'Thai'],
  tha: ['th', 'Thai'],
  vi: ['vi', 'Vietnamese'],
  vie: ['vi', 'Vietnamese'],
  id: ['id', 'Indonesian'],
  ind: ['id', 'Indonesian'],
};

const SDH_TOKENS = new Set(['sdh', 'cc', 'hoh', 'hi']);
const FORCED_TOKENS = new Set(['forced', 'foreign']);

function describeSuffix(suffix) {
  const result = { language: null, languageLabel: null, forced: false, sdh: false };
  if (!suffix) return result;

  const lower = suffix.toLowerCase();
  const whole = LANGUAGES[lower];
  if (whole) {
    result.language = whole[0];
    result.languageLabel = whole[1];
    return result;
  }

  // "en.forced.sdh", "en-US", "English-Forced" style suffixes.
  for (const token of lower.split(/[._\-\s]+/).filter(Boolean)) {
    if (FORCED_TOKENS.has(token)) {
      result.forced = true;
    } else if (SDH_TOKENS.has(token)) {
      result.sdh = true;
    } else if (!result.language && LANGUAGES[token]) {
      const [code, name] = LANGUAGES[token];
      result.language = code;
      result.languageLabel = name;
    }
  }
  return result;
}

/**
 * @param {string} mediaFile absolute path to the video
 * @returns {Array<{path:string, format:string, language:string|null, label:string, forced:boolean, sdh:boolean, fileName:string}>}
 */
function discoverSubtitles(mediaFile) {
  if (!mediaFile) return [];
  const dir = path.dirname(mediaFile);
  const base = path.basename(mediaFile, path.extname(mediaFile));
  const found = [];
  const seen = new Set();

  for (const relative of SUBTITLE_DIRS) {
    const folder = relative ? path.join(dir, relative) : dir;
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUBTITLE_EXTS.has(ext)) continue;
      const stem = entry.name.slice(0, -ext.length);
      if (stem !== base && !stem.startsWith(`${base}.`)) continue;

      const full = path.join(folder, entry.name);
      // macOS and Windows treat "Subs" and "subs" as one folder, and realpath
      // keeps the requested case, so identify files by device + inode instead.
      let key = full.toLowerCase();
      try {
        const stat = fs.statSync(full);
        if (stat.ino || stat.dev) key = `${stat.dev}:${stat.ino}`;
      } catch {
        /* keep the path-based key */
      }
      if (seen.has(key)) continue;
      seen.add(key);

      const suffix = stem === base ? '' : stem.slice(base.length + 1);
      const meta = describeSuffix(suffix);
      found.push({
        path: full,
        format: ext.slice(1),
        ...meta,
        fileName: entry.name,
      });
    }
  }

  found.sort((a, b) => {
    // Known languages first, English ahead of the rest, full tracks before
    // forced ones, then by file name.
    const rank = (s) => (s.language ? (s.language.startsWith('en') ? 0 : 1) : 2);
    return rank(a) - rank(b)
      || Number(a.sdh) - Number(b.sdh)
      || Number(a.forced) - Number(b.forced)
      || a.fileName.localeCompare(b.fileName);
  });

  const labelCounts = new Map();
  return found.map((entry, index) => {
    let label = entry.languageLabel || 'Subtitles';
    if (entry.forced) label += ' (Forced)';
    if (entry.sdh) label += ' (SDH)';
    const seenCount = (labelCounts.get(label) || 0) + 1;
    labelCounts.set(label, seenCount);
    if (seenCount > 1) label += ` ${seenCount}`;
    return {
      id: index,
      label,
      language: entry.language,
      format: entry.format,
      forced: entry.forced,
      sdh: entry.sdh,
      fileName: entry.fileName,
      path: entry.path,
    };
  });
}

/** Decode UTF-8/UTF-16 subtitle buffers (BOM sniffed). */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function normaliseText(raw) {
  return String(raw || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
}

function escapeVttText(text) {
  return text.replace(/&(?!amp;|lt;|gt;|nbsp;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;');
}

/**
 * Convert an SRT document (or pass through a VTT one) to valid WebVTT.
 */
function toVtt(input, format) {
  const text = normaliseText(input);
  if (format === 'vtt' || /^WEBVTT/.test(text.trimStart())) {
    const body = text.trimStart().replace(/^WEBVTT[^\n]*\n?/, '');
    return `WEBVTT\n\n${body.trim()}\n`;
  }

  let body = text
    // SubStation Alpha override blocks such as {\an8}
    .replace(/\{\\[^}]*\}/g, '')
    // Cue numbers on their own line directly above a timestamp. [ \t] only:
    // \s* would swallow the blank line that separates cues.
    .replace(/^[ \t]*\d+[ \t]*\n(?=[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->)/gm, '');

  // WebVTT requires a dot separator and two-digit hours.
  body = body.replace(
    /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g,
    (_, h, m, s, ms) => `${String(h).padStart(2, '0')}:${m}:${s}.${String(ms).padEnd(3, '0')}`,
  );

  const trimmed = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : line.replace(/[ \t]+$/g, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return `WEBVTT\n\n${escapeVttText(trimmed)}\n`;
}

module.exports = { discoverSubtitles, toVtt, decode, describeSuffix, LANGUAGES };
