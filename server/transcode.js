'use strict';

/**
 * Playback compatibility layer.
 *
 * Browsers only decode a handful of containers and codecs; VLC plays almost
 * anything. To close that gap ReelHouse ships the same engine VLC uses for
 * decoding — FFmpeg — and turns anything the browser cannot open into HLS
 * segments encoded as H.264/AAC on demand.
 *
 * Two outcomes per file:
 *   direct     the browser can play the original bytes (range streaming)
 *   transcode  H.264/AAC segments encoded from the source
 *
 * Stream copy is deliberately not used for the video: seeking a copy lands on
 * the previous keyframe, which would put audio and video seconds apart inside
 * a segment. Re-encoding every frame keeps the timeline exact.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const SEGMENT_SECONDS = 4;
const MAX_SEGMENTS = 100000;
const CACHE_BYTES = 128 * 1024 * 1024; // ~2 minutes of 1080p segments
const MAX_PARALLEL = 3;

/** Electron runs app code from app.asar; binaries live beside it, unpacked. */
function unpackAsar(file) {
  if (typeof file !== 'string') return file;
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function bundledBinary(name) {
  try {
    if (name === 'ffmpeg') return unpackAsar(require('ffmpeg-static')) || null;
    // Host-only ffprobe (the platform packages are optional dependencies), so
    // every build carries exactly one binary.
    const probe = require('@ffprobe-installer/ffprobe');
    return unpackAsar(probe.path) || null;
  } catch {
    return null;
  }
}

const binaryCache = new Map();

function versionOf(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      const first = String(stdout || '').split('\n')[0] || '';
      const match = /version\s+([^\s]+)/i.exec(first);
      return resolve({ version: match ? match[1] : first.trim(), banner: first.trim() });
    });
  });
}

/**
 * Locate a working binary: explicit env override, then the bundled copy, then
 * whatever `ffmpeg`/`ffprobe` is on PATH.
 */
async function findBinary(name) {
  if (binaryCache.has(name)) return binaryCache.get(name);
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const candidates = [];
  if (process.env[envKey]) candidates.push({ bin: process.env[envKey], source: 'env' });
  const bundled = bundledBinary(name);
  if (bundled) candidates.push({ bin: bundled, source: 'bundled' });
  candidates.push({ bin: name, source: 'system' });

  for (const candidate of candidates) {
    if (candidate.source !== 'system') {
      try {
        fs.accessSync(candidate.bin, fs.constants.X_OK);
      } catch {
        continue;
      }
    }
    try {
      const info = await versionOf(candidate.bin);
      const resolved = { ...candidate, ...info };
      binaryCache.set(name, resolved);
      return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  binaryCache.set(name, null);
  return null;
}

function status() {
  return Promise.all([findBinary('ffmpeg'), findBinary('ffprobe')]).then(([ffmpeg, ffprobe]) => ({
    ffmpeg: ffmpeg ? { found: true, version: ffmpeg.version, source: ffmpeg.source } : { found: false },
    ffprobe: ffprobe ? { found: true, version: ffprobe.version, source: ffprobe.source } : { found: false },
    // Decoding without probing is possible but playback would have no timeline.
    ready: Boolean(ffmpeg && ffprobe),
  }));
}

/* ------------------------------------------------------------------ probing */

const probeCache = new Map();
const PROBE_CACHE_LIMIT = 500;

function runJson(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      try {
        return resolve(JSON.parse(stdout));
      } catch (parseError) {
        return reject(parseError);
      }
    });
  });
}

/**
 * Read stream info for a file. Returns null when probing is impossible, which
 * the planner treats as "transcode if we can, otherwise unsupported".
 */
async function probe(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);

  const ffprobe = await findBinary('ffprobe');
  if (!ffprobe) {
    probeCache.set(key, null);
    return null;
  }

  let info;
  try {
    const data = await runJson(ffprobe.bin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) || null;
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const duration = Number(data.format?.duration) || Number(video?.duration) || 0;
    info = {
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      container: String(data.format?.format_name || '').split(',')[0] || null,
      video: video
        ? {
            codec: video.codec_name || null,
            width: video.width || null,
            height: video.height || null,
            profile: video.profile || null,
          }
        : null,
      audio: audio
        ? {
            codec: audio.codec_name || null,
            channels: audio.channels || null,
            language: audio.tags?.language || null,
          }
        : null,
      audioTracks: streams.filter((s) => s.codec_type === 'audio').length,
      subtitleTracks: streams.filter((s) => s.codec_type === 'subtitle').length,
    };
  } catch {
    info = null;
  }

  if (probeCache.size >= PROBE_CACHE_LIMIT) {
    probeCache.delete(probeCache.keys().next().value);
  }
  probeCache.set(key, info);
  return info;
}

/* ----------------------------------------------------------------- planning */

// Containers Chromium opens itself.
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
// Video codecs Chromium decodes (HEVC is hardware/platform dependent, so it is
// routed through transcoding to keep playback reliable everywhere).
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
// Audio codecs Chromium decodes.
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);
// MP4 with Opus/Vorbis is patchy; only WebM/MOV handle those natively.
const WEBM_ONLY_AUDIO = new Set(['opus', 'vorbis']);

function extensionOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

/**
 * Decide how a file should be played.
 * @returns {{mode:'direct'|'transcode'|'unsupported', reason:string}}
 */
function plan(file, info, { force = false, transcode = 'auto' } = {}) {
  const ext = extensionOf(file);
  // No stream information at all: FFmpeg cannot open it, so converting it is
  // pointless. Keep the message actionable instead of spinning on segments.
  if (!info) {
    return {
      mode: 'unsupported',
      reason: 'This file could not be read — it may be empty, corrupt, or not a video FFmpeg can open.',
    };
  }
  const videoCodec = info.video ? info.video.codec : null;
  const audioCodec = info.audio ? info.audio.codec : null;
  const containerOk = DIRECT_CONTAINERS.has(ext);
  const videoOk = Boolean(videoCodec && DIRECT_VIDEO.has(videoCodec));
  const webmAudio = audioCodec && WEBM_ONLY_AUDIO.has(audioCodec);
  const audioOk = !audioCodec || (DIRECT_AUDIO.has(audioCodec) && (!webmAudio || ext === 'webm'));

  if (transcode === 'off') {
    if (containerOk && videoOk && audioOk) return { mode: 'direct', reason: 'native' };
    return { mode: 'unsupported', reason: 'Transcoding is turned off in Settings, and this file needs it.' };
  }
  if (!force && containerOk && videoOk && audioOk) {
    return { mode: 'direct', reason: 'native' };
  }
  const why = !videoOk
    ? `${String(videoCodec || 'This').toUpperCase()} video cannot be decoded by the browser`
    : !containerOk
      ? `The ${ext.toUpperCase() || 'file'} container is not supported natively`
      : !audioOk
        ? `${String(audioCodec).toUpperCase()} audio is not supported by this container`
        : 'Forced transcoding is on';
  return { mode: 'transcode', reason: `${why}; converting to H.264 with AAC audio.` };
}

/* ---------------------------------------------------------------- playlists */

function segmentSpans(duration, length = SEGMENT_SECONDS) {
  const count = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(duration / length)));
  const spans = [];
  for (let index = 0; index < count; index += 1) {
    const remaining = duration - index * length;
    spans.push(Math.max(0.05, Math.min(length, remaining)));
  }
  // A trailing sliver is not worth a request: fold it into the previous segment.
  if (spans.length > 1 && spans[spans.length - 1] < 1) {
    spans[spans.length - 2] += spans.pop();
  }
  return spans;
}

function playlist({ duration, length = SEGMENT_SECONDS, segmentQuery = '' }) {
  const spans = segmentSpans(duration, length);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(length + 1)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  spans.forEach((span, index) => {
    lines.push(`#EXTINF:${span.toFixed(3)},`);
    lines.push(`seg-${index}.ts${segmentQuery}`);
  });
  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/* ---------------------------------------------------------------- segments */

class SegmentCache {
  constructor(limit = CACHE_BYTES) {
    this.limit = limit;
    this.bytes = 0;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key, buffer) {
    if (buffer.length > this.limit) return;
    const previous = this.map.get(key);
    if (previous) {
      this.bytes -= previous.length;
      this.map.delete(key);
    }
    this.map.set(key, buffer);
    this.bytes += buffer.length;
    while (this.bytes > this.limit && this.map.size > 1) {
      const [oldKey, oldBuffer] = this.map.entries().next().value;
      this.map.delete(oldKey);
      this.bytes -= oldBuffer.length;
    }
  }
}

const segments = new SegmentCache();
const inflight = new Map();
let running = 0;
const waiting = [];

function encodeSegment({ file, start, length, maxHeight, quality, ffmpeg }) {
  const preset = quality === 'high' ? 'fast' : 'veryfast';
  const crf = quality === 'high' ? 18 : quality === 'fast' ? 23 : 21;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  // Seek before -i so FFmpeg jumps rather than decodes from the start.
  args.push('-ss', start.toFixed(3), '-i', file, '-t', length.toFixed(3));
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p');
  if (maxHeight) args.push('-vf', `scale=-2:'min(${maxHeight},ih)'`);
  args.push('-profile:v', 'high');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
  args.push('-sn', '-dn', '-max_muxing_queue_size', '1024');
  // Keep timestamps on the original timeline so seeking and subtitles line up.
  args.push('-output_ts_offset', start.toFixed(3), '-muxdelay', '0');
  args.push('-f', 'mpegts', 'pipe:1');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    const chunks = [];
    let size = 0;
    let stderr = '';
    let failed = null;

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 96 * 1024 * 1024) {
        failed = new Error('Segment is too large');
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-1200);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (failed) return reject(failed);
      if (code !== 0) {
        return reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim() || 'no output'}`));
      }
      if (!chunks.length) return reject(new Error('FFmpeg produced an empty segment'));
      return resolve(Buffer.concat(chunks));
    });
  });
}

/** Limit concurrent encoders so one playback cannot starve the machine. */
function withSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (running < MAX_PARALLEL) run();
    else waiting.push(run);
  });
}

/**
 * Produce the MPEG-TS bytes for one HLS segment, from cache when possible.
 */
async function segment(options) {
  const { file, start, length, maxHeight, quality, force } = options;
  const stat = fs.statSync(file);
  const key = [file, stat.size, stat.mtimeMs, start, length, maxHeight, quality, force ? 'f' : 'a'].join('|');
  const cached = segments.get(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const ffmpeg = await findBinary('ffmpeg');
  if (!ffmpeg) {
    const err = new Error('FFmpeg is not available, so this file cannot be transcoded.');
    err.status = 503;
    throw err;
  }

  const job = withSlot(() => encodeSegment({ file, start, length, maxHeight, quality, ffmpeg: ffmpeg.bin }))
    .then((buffer) => {
      segments.set(key, buffer);
      return buffer;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

module.exports = {
  SEGMENT_SECONDS,
  findBinary,
  status,
  probe,
  plan,
  playlist,
  segment,
};
