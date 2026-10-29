'use strict';

/**
 * Generates a small demo library + XMLTV guide so you can explore ReelHouse
 * before pointing it at real media.
 *
 *   npm run demo
 *
 * Video files are empty placeholders (they exist so scanning works); the
 * artwork comes from TMDB once a key is added. Audio/video is not included.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(ROOT, 'demo-library');
const MOVIES = path.join(DEMO, 'Movies');
const TV = path.join(DEMO, 'TV Shows');

const MOVIE_NAMES = [
  'Dune Part Two (2024)',
  'The Grand Budapest Hotel (2014)',
  'Blade Runner 2049 (2017)',
  'Everything Everywhere All at Once (2022)',
  'Spirited Away (2001)',
  'The Batman (2022)',
  'Arrival (2016)',
  'Whiplash (2014)',
];

const SHOWS = [
  { show: 'Severance', year: 2022, episodes: [['Good News About Hell', 1], ['Half Loop', 2], ['In Perpetuity', 3]] },
  { show: 'The Bear', year: 2022, episodes: [['System', 1], ['Hands', 2], ['Brigade', 3]] },
  { show: 'Andor', year: 2022, episodes: [['Kassa', 1], ['That Would Be Me', 2], ['Reckoning', 3]] },
];

const PLACEHOLDER = Buffer.from(
  'This is a ReelHouse demo placeholder, not a real video.\r\n' +
    'Add your own media folders in Settings to play actual files.\r\n',
);

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writePlaceholder(file) {
  ensure(path.dirname(file));
  if (!fs.existsSync(file)) fs.writeFileSync(file, PLACEHOLDER);
}

/* Sample sidecar subtitles (CRLF + BOM + ASS tags, to exercise conversion). */
function demoSubtitle(name) {
  const lines = [
    '1',
    '00:00:01,000 --> 00:00:05,000',
    `{\\an8}ReelHouse sample subtitles — ${name}`,
    '',
    '2',
    '00:00:05,500 --> 00:00:10,000',
    'This .srt sidecar is converted to WebVTT in the browser.',
    '',
    '3',
    '00:00:10,500 --> 00:00:15,000',
    'Drop your own <i>.srt</i> or <i>.vtt</i> next to a video to use it.',
  ].join('\r\n');
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines}\r\n`, 'utf8')]);
}

function demoVtt(name) {
  return [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:05.000',
    `ReelHouse sample subtitles — ${name}`,
    '',
    '00:00:05.500 --> 00:00:10.000',
    'WebVTT sidecar files are served as-is.',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ guide */

const CHANNELS = [
  { id: 'reelone.demo', number: '101', name: 'Reel One', genre: 'general' },
  { id: 'cinema24.demo', number: '102', name: 'Cinema 24', genre: 'movies' },
  { id: 'harbour.demo', number: '103', name: 'Harbour Drama', genre: 'drama' },
  { id: 'northlight.demo', number: '104', name: 'Northlight', genre: 'drama' },
  { id: 'sportsline.demo', number: '105', name: 'Sportsline', genre: 'sport' },
  { id: 'kidscorner.demo', number: '106', name: 'Kids Corner', genre: 'kids' },
  { id: 'docworld.demo', number: '107', name: 'Doc World', genre: 'docs' },
  { id: 'latenight.demo', number: '108', name: 'Late Night', genre: 'movies' },
];

const POOLS = {
  general: [
    ['Morning Report', 'News, weather and a look at the day ahead.', 60],
    ['The Big Quiz', 'Two teams battle through six rounds of trivia.', 60],
    ['Kitchen Sessions', 'Chefs cook a three-course meal from pantry staples.', 30],
    ['Severance', 'Mark leads a team whose memories are surgically divided between work and home.', 60],
    ['Evening Headlines', 'The day’s main stories, explained.', 30],
    ['Great Escapes', 'A travelogue through coastal towns and mountain passes.', 60],
  ],
  movies: [
    ['Dune Part Two', 'Paul Atreides unites with the Fremen while seeking revenge against the conspirators who destroyed his family.', 120],
    ['The Grand Budapest Hotel', 'A concierge and his lobby boy become entangled in the theft of a priceless painting.', 120],
    ['Blade Runner 2049', 'A young blade runner discovers a secret that could plunge what is left of society into chaos.', 150],
    ['Arrival', 'A linguist is recruited to communicate with alien visitors.', 120],
    ['Whiplash', 'A young drummer enrols at a cut-throat music conservatory.', 120],
    ['Spirited Away', 'A young girl wanders into a world ruled by spirits.', 120],
  ],
  drama: [
    ['The Bear', 'A young chef returns home to run his family’s sandwich shop.', 30],
    ['Andor', 'A thief becomes a reluctant revolutionary.', 60],
    ['Harbour Lights', 'Two families navigate a changing fishing town.', 60],
    ['The Long Winter', 'A doctor arrives in an isolated village as the snow closes in.', 60],
    ['Second Chances', 'An estranged couple inherit the same bookshop.', 30],
  ],
  sport: [
    ['Match of the Day', 'Highlights and analysis from the weekend fixtures.', 90],
    ['The Climb', 'A season inside a cycling team chasing a grand tour.', 60],
    ['Court Vision', 'Basketball tactics broken down by former players.', 30],
    ['Live: Athletics', 'Track and field from the summer meet.', 120],
  ],
  kids: [
    ['Moonlight Meadow', 'Friends solve gentle mysteries in a meadow at night.', 30],
    ['Rocket Club', 'Three kids build a rocket out of junk.', 30],
    ['Paws and Puzzles', 'A dog detective and her squirrel sidekick.', 30],
    ['Story Tree', 'Bedtime stories read under a very old oak tree.', 30],
  ],
  docs: [
    ['Deep Field', 'Astronomers point the telescope at an apparently empty patch of sky.', 60],
    ['The Salt Roads', 'How trade routes shaped the modern world.', 60],
    ['Coral Lines', 'Reef restoration on a shrinking coastline.', 60],
  ],
};

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function xmltvStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`
  );
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildGuide() {
  const random = seeded(20261028);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1); // yesterday
  const end = new Date(start);
  end.setDate(end.getDate() + 3); // through tomorrow

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="ReelHouse demo">'];

  for (const channel of CHANNELS) {
    lines.push(`  <channel id="${channel.id}">`);
    lines.push(`    <display-name>${xmlEscape(`${channel.number} ${channel.name}`)}</display-name>`);
    lines.push('  </channel>');
  }

  for (const channel of CHANNELS) {
    const pool = POOLS[channel.genre] || POOLS.general;
    let cursor = new Date(start);
    let guard = 0;
    while (cursor < end && guard < 400) {
      guard += 1;
      const [title, desc, minutes] = pool[Math.floor(random() * pool.length)];
      const stop = new Date(cursor.getTime() + minutes * 60000);
      lines.push(`  <programme start="${xmltvStamp(cursor)}" stop="${xmltvStamp(stop)}" channel="${channel.id}">`);
      lines.push(`    <title lang="en">${xmlEscape(title)}</title>`);
      lines.push(`    <desc lang="en">${xmlEscape(desc)}</desc>`);
      lines.push(`    <category lang="en">${xmlEscape(channel.genre === 'movies' ? 'Film' : 'Entertainment')}</category>`);
      lines.push('  </programme>');
      cursor = stop;
    }
  }

  lines.push('</tv>');
  return lines.join('\n');
}

/* ------------------------------------------------------------------- main */

function main() {
  ensure(MOVIES);
  ensure(TV);

  for (const name of MOVIE_NAMES) {
    writePlaceholder(path.join(MOVIES, `${name}.mp4`));
  }

  for (const show of SHOWS) {
    const folder = path.join(TV, `${show.show} (${show.year})`);
    show.episodes.forEach(([title, number]) => {
      const seasonDir = path.join(folder, 'Season 01');
      writePlaceholder(path.join(seasonDir, `${show.show} - S01E${String(number).padStart(2, '0')} - ${title}.mkv`));
    });
  }

  fs.writeFileSync(
    path.join(TV, 'Severance (2022)', 'Season 01', 'Severance - S01E01 - Good News About Hell.en.srt'),
    demoSubtitle('Severance S01E01'),
  );
  fs.writeFileSync(
    path.join(TV, 'Severance (2022)', 'Season 01', 'Severance - S01E02 - Half Loop.en.srt'),
    demoSubtitle('Severance S01E02'),
  );
  fs.writeFileSync(path.join(MOVIES, 'Dune Part Two (2024).en.vtt'), demoVtt('Dune Part Two'));

  const guidePath = path.join(DEMO, 'guide-demo.xml');
  fs.writeFileSync(guidePath, buildGuide());

  // Register the demo folders and guide with the app.
  const config = require('../server/config');
  const current = config.get();
  const dirs = current.mediaDirs.filter((dir) => !dir.path.startsWith(DEMO));
  dirs.push({ path: MOVIES, type: 'movies' }, { path: TV, type: 'tv' });
  const sources = (current.epg.sources || []).filter((source) => !String(source.source).startsWith(DEMO));
  sources.push({ id: 'demo-guide', name: 'ReelHouse demo guide (XMLTV)', source: guidePath, enabled: true });
  config.save({ mediaDirs: dirs, epg: { sources } });

  console.log('\n  Demo library created');
  console.log('  ──────────────────────────────────────────────');
  console.log(`  Movies      ${MOVIES}`);
  console.log(`  TV shows    ${TV}`);
  console.log(`  TV guide    ${guidePath}`);
  console.log(`  Settings    ${config.DIRS.config}`);
  console.log('\n  Video files are empty placeholders; UI, scanning and the guide');
  console.log('  are fully functional. Run `npm start` to launch ReelHouse.\n');
}

main();
