# ReelHouse

A local-first home media centre — movies, TV shows, a live TV guide, TMDB banners/artwork, and a built-in player — served by a small service on your own machine, with a desktop app shell for **macOS** and **Windows**.

Nothing leaves your computer. ReelHouse does not copy your media, does not transcode, and has no cloud account: it indexes the folders you point it at, fetches metadata from TMDB when you add a key, and streams files straight off disk to the browser window.

![App icon](build/icon.png)

---

## Features

| | |
|---|---|
| **Movies** | Folder scan, filename/year parsing, TMDB posters, banners, logos, synopsis, runtime, rating, genres |
| **TV Shows** | Show → season → episode structure from `S01E02` names, episode stills, titles, air dates, season selector |
| **TV Guide (EPG)** | XMLTV files or URLs, multi-source merge, scrollable timeline, live "now" line, day navigation, programme details |
| **Live TV (M3U)** | Point Settings at one or more M3U/M3U8 playlists and their channels join the guide with a play button; HLS is proxied through the server so CORS and credentials stay off the browser |
| **Banners** | Widescreen TMDB backdrops on the home hero carousel, movie/series detail pages, and "On TV now" cards |
| **Player** | HTML5 player with byte-range streaming (seek anywhere instantly), resume position, progress bars everywhere |
| **Codecs** | MKV, AVI, HEVC, MPEG-2/4, WMV/VC-1, DTS, AC-3, TrueHD and everything else FFmpeg opens — converted to H.264/AAC on demand, only when the browser needs it |
| **Subtitles** | Sidecar `.srt` / `.vtt` next to a video (or in `Subs/`), language detection, SRT converted to WebVTT on the fly, on/off menu in the player |
| **Up next** | When an episode ends, the next one starts after a 9-second countdown; play now, cancel, or switch autoplay off in Settings. Crosses season boundaries |
| **Continue watching** | Playback position saved every 10s and on pause/exit; a home row with time left and a × to forget an item, a Continue button on show pages, and resume from any card |
| **Discover** | Trending and popular movies/TV from TMDB, with the services streaming each title in your region and links to watch them |
| **Search** | Instant search across movies, shows and the guide |
| **Desktop apps** | Electron shell boots the service in-process, native folder picker, menu shortcuts, macOS `.dmg` / Windows `.exe` |
| **Android TV** | Sideloadable APK that finds the server on your Wi-Fi and runs the same interface with a remote, no address typing |
| **Local by default** | Binds to `127.0.0.1`; network access is a switch in Settings, cross-origin requests are rejected, TMDB key stored with `0600` permissions |

The TV guide shows the schedule you supply. ReelHouse ships no channel feeds of its own: add an XMLTV source for the listings and, if you want to watch, an M3U playlist for the streams — both in Settings. A guide without a playlist still works as a schedule; a playlist without a guide still plays, it just has no programmes in the timeline.

---

## Quick start (web app)

Requires **Node.js 20+** (developed on Node 26).

```bash
npm install
npm run demo     # optional: creates a demo library + demo TV guide
npm start
```

Open **http://127.0.0.1:8090**.

`npm run demo` writes `demo-library/` (sample folders + `guide-demo.xml` + a couple of sample subtitle files) and registers it with the app so every screen has something in it on first launch. **The demo video files are empty placeholders** — the library, artwork lookups, guide, subtitle tracks and navigation are all real, but there is no video to decode. Delete `demo-library/` and remove the folders in Settings whenever you like.

### Add your own media

1. **Settings → Movies folders** — add one or more folders where films live.
   **Settings → TV shows folders** — add folders where series live, one folder per show.
   **Settings → Mixed folders** — for a single folder holding both; ReelHouse decides per file from its name (`S01E02`).
   In the desktop app every row also has **Browse…** (native picker) and **Open** (reveals it in Finder / Explorer).
2. **Settings → TMDB API → Test & link** — paste a free key from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (either the v3 API key or the v4 read access token). The key is checked with TMDB before it is saved, and the library is re-fetched automatically. Once linked the card shows the credential type, account, language and link date, with **Save language & refresh**, **Replace key** and **Unlink**.
3. **Save changes** if you edited folders — the library rescans automatically.

Without a TMDB key the app still indexes and plays your files; cards and hero banners use generated gradient artwork instead.

### Naming your files

```
Movies/
  Blade Runner 2049 (2017).mkv
  Dune Part Two (2024) [2160p].mp4

TV Shows/
  Severance (2022)/
    Season 01/
      Severance - S01E01 - Good News About Hell.mkv
      Severance - S01E02 - Half Loop.mkv
```

Release tags (`1080p`, `WEB-DL`, `x265`, `DDP5.1`, …), bracketed groups and dots are stripped automatically. Anything unmatched still appears — you just get no TMDB data until a match is found.

---

## Desktop apps (macOS + Windows)

The Electron shell runs the exact same service in-process, then opens a window on it. No external server, no admin rights, no install of Node.

```bash
npm run desktop      # run the app from source
npm run dist:mac     # build .dmg + .zip (arm64 + x64) into dist/
npm run dist:win     # build NSIS installer + portable .exe into dist/
```

Notes:

- Desktop data lives in the platform app-data folder under `…/ReelHouse/data`, separate from the CLI (`~/Library/Application Support/ReelHouse` on macOS, `%APPDATA%\ReelHouse` on Windows).
- Build Windows installers on Windows for the smoothest result; cross-building from macOS needs Wine for NSIS.
- `npm run dist:mac` builds both architectures on one machine, but only the host architecture gets a matching FFmpeg — use the release workflow below when publishing.
- Unpacked macOS builds are unsigned and un-notarised. Opening one on another Mac requires right-click → Open, or a release build signed with the Developer ID configured below.
- Menu shortcuts: `Cmd/Ctrl+Shift+R` rescans the library, `Cmd/Ctrl+,` opens Settings; reload, zoom and fullscreen are in the View menu.
- The desktop bundle carries its own FFmpeg (~50 MB per platform), so MKV/HEVC/AVI playback needs nothing installed. The binaries are unpacked from the app bundle and executed locally.

### Releases

Pushing a `v*` tag builds every installer on GitHub Actions and attaches it to that tag's release:

| Job | Runner | Artifact |
|---|---|---|
| macOS arm64 | `macos-15` | `ReelHouse-<version>-arm64.dmg` |
| macOS Intel | `macos-15-intel` | `ReelHouse-<version>.dmg` |
| Windows x64 | `windows-latest` | `ReelHouse Setup <version>.exe` + portable `.exe` |
| Android TV | `ubuntu-latest` | `ReelHouse-<version>-tv.apk` |

To rebuild the assets of a release that already exists: `gh workflow run installers.yml -f tag=v1.6.0`.

Each release also carries `SHA256SUMS.txt`, and the same hashes are appended to the release notes, so a download can be checked before it is trusted:

```bash
shasum -a 256 ReelHouse-1.6.0-arm64.dmg                  # macOS
certutil -hashfile "ReelHouse Setup 1.6.0.exe" SHA256   # Windows
```

Each macOS architecture is built on a matching runner because `ffmpeg-static` and `@ffprobe-installer` install the binary for the machine they install on: an Intel DMG built on Apple silicon would ship an arm64 FFmpeg, and transcoding would fail on the very Macs it targets. The workflow mounts the DMG it is about to publish and fails unless the app, FFmpeg and ffprobe all match the runner's architecture.

### Code signing

Signing is driven entirely by repository secrets (Settings → Secrets and variables → Actions). No certificate, password or key is ever committed.

| Secret | What it is | If it is not set |
|---|---|---|
| `MAC_CSC_LINK` | Developer ID Application certificate, `.p12` exported from Keychain, base64 | macOS DMGs ship unsigned |
| `MAC_CSC_KEY_PASSWORD` | Password for that `.p12` | — |
| `APPLE_ID` | Apple ID used with the notary service | app is signed but not notarised |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID | notarisation fails the build |
| `APPLE_TEAM_ID` | 10-character team ID | notarisation fails the build |
| `WIN_CSC_LINK` | Authenticode certificate, `.pfx` or `.p12`, base64 | Windows installers ship unsigned |
| `WIN_CSC_KEY_PASSWORD` | Password for that certificate | — |

Export the certificate from Keychain Access (*My Certificates* → your *Developer ID Application* identity → Export…), then base64 it into the secret:

```bash
base64 -i DeveloperID.p12 | pbcopy     # paste as MAC_CSC_LINK
base64 -i authenticode.pfx | pbcopy    # paste as WIN_CSC_LINK
```

The three Apple values are all-or-nothing: setting only some of them fails the build instead of quietly publishing a signed-but-unnotarised app.

What a signed build does beyond signing:

- signs with the hardened runtime and [build/entitlements.mac.plist](build/entitlements.mac.plist), with [build/entitlements.mac.inherit.plist](build/entitlements.mac.inherit.plist) for Electron's helpers and the bundled `ffmpeg`/`ffprobe`, which are executed as child processes
- submits the app to Apple's notary service and **staples** the ticket onto it ([build/notarize.js](build/notarize.js)). electron-builder's own notarisation only submits; without stapling, first launch still fails for anyone offline, and the ticket has to travel inside the DMG
- re-opens the DMG it is about to publish and fails unless the app and both FFmpeg binaries verify, the authority is `Developer ID Application`, `xcrun stapler validate` passes and Gatekeeper (`spctl`) accepts it
- checks every Windows `.exe` with `Get-AuthenticodeSignature` and fails unless each reports `Valid`, because electron-builder downgrades a failed signature to a warning

Secrets are exported into the job environment only when they exist — an unset secret is an empty string, and electron-builder treats an empty `CSC_LINK` as a certificate it must import, which fails the build. When a secret set is incomplete the build still runs and annotates the release build with a warning, so a fork without secrets can still produce installers.

Notarisation needs a paid Apple Developer Program membership and a **Developer ID Application** certificate; an *Apple Development* certificate signs but Apple will not notarise it.

---

## Android TV

`android/` holds a small Android app for a TV or a streaming box. It runs the same web interface as the desktop app in a WebView, so the library, guide, Discover and player are all there, plus the two things a remote needs: a connect screen and a focus ring that can be driven with arrow keys and OK.

Grab `ReelHouse-<version>-tv.apk` from [Releases](../../releases) and install it either way:

```bash
adb connect 192.168.1.42:5555          # if the TV has network debugging on
adb install -r ReelHouse-1.6.0-tv.apk
```

or copy the APK to the TV and open it with a file manager or the Downloader app. Android 5.0 (API 21) or newer, TV and server on the same network.

**Turn network access on first.** The server only listens on `127.0.0.1` until you do: Settings → TV & devices → *Let devices on my network connect*, then restart ReelHouse. It rebinds to all interfaces and starts answering discovery probes on UDP 8090, and the card then shows the address to type if your router blocks broadcast.

How the TV finds it:

- the app broadcasts `REELHOUSE/1 DISCOVER` to UDP 8090–8093 (the server shifts port if 8090 is taken)
- the server replies with its LAN addresses, and the app confirms each one with `GET /api/status` before offering it, so a stale reply or a different app on that port never appears
- the last server is remembered, so the next launch is one OK press; Back from the browser returns to the connect screen to pick another

There is no login. Anyone who can reach the port can browse and play the library — that is why network access is a switch rather than the default.

Limitations worth knowing:

- It is a WebView, not a native player: no surround passthrough, and a TV whose system WebView is years out of date may not decode H.264 in MKV. Those files still play, because the server converts them, at the cost of CPU.
- The 10-foot treatment is a focus ring, larger type and OK-to-open on cards — the layout is otherwise the desktop layout.
- The APK is signed with a debug key so sideloading works; if that key changes between builds, the TV will ask you to uninstall the old app before installing the new one.
- Building it locally needs a JDK 17 and the Android SDK: `cd android && ./gradlew assembleRelease`.

---

## Configuration

Settings (and the equivalent `config.json`) covers:

| Setting | Meaning |
|---|---|
| Movies / TV shows folders | Any number of folders per card; the card decides whether its files are films or episodes |
| Playback | Conversion on/off, encoder effort (fast / balanced / high) and maximum output resolution (720p / 1080p / original) |
| Mixed folders | One folder holding both kinds, matched per file from `S01E02`-style names |
| TMDB link + language | Key is verified against TMDB before saving and never returned to the browser; the card shows credential type, account and link date, and *Save language & refresh* re-fetches the library |
| TV guide sources | Any number of XMLTV files or `http(s)` URLs; refresh every 6h and on demand |
| Live TV playlists | Any number of M3U/M3U8 playlists, as `http(s)` URLs or a path on this machine; refreshed on save and on demand |
| Scan on start | Index at launch (default on) |

Files are kept in one data directory:

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/ReelHouse` (desktop: `…/ReelHouse/data`) |
| Windows | `%APPDATA%\ReelHouse` |
| Linux | `~/.config/ReelHouse` |

```
config.json        settings (mode 0600 — contains your TMDB key)
library.json       scanned library + metadata
progress.json      playback positions
epg-cache.json     parsed XMLTV channels/programmes
live-cache.json    channels parsed from your M3U playlists
tmdb-cache.json    metadata response cache (keeps rescans cheap)
artcache/          downloaded TMDB artwork (served offline afterwards)
```

Set `REELHOUSE_DATA=/some/path` to use a different directory, or `PORT=9000` to change the port. If the port is busy the server moves to the next free one automatically.

`server.lanAccess` (Settings → TV & devices) decides whether the server listens on `127.0.0.1` or on every interface so devices on your network — a TV, a phone — can reach it. It is off until you turn it on, only takes effect after a restart, and is what the Android TV app's discovery depends on.

---

## Using the app

| View | What it does |
|---|---|
| **Home** | Rotating hero banner (backdrops/logos), Continue Watching, recently added movies, TV shows, On TV now |
| **Movies / TV Shows** | Sortable poster grid; TMDB ratings; hover play |
| **Detail pages** | Full-bleed backdrop banner, logo art, synopsis, facts, season pill selector, episode list with stills and progress |
| **Discovery** | Trending this week, popular movies and popular TV, with streaming-service badges and a where-to-watch sheet per title |
| **TV Guide** | Channel column + 24-hour timeline, 30-minute gridlines, live programme highlighting, current-time marker, ▶ on any playlist channel to watch live, programme sheet with library deep-link |
| **Live player** | Channel name and group, a LIVE badge, native controls and subtitles where the stream carries them; Back returns to the guide |
| **Search** | `/` to focus; results across movies, series and the guide |
| **Player** | Range-streamed video, resume, subtitles, up-next autoplay, keyboard/native controls (`N` next, `C` captions, `Esc` back), clear message when a codec can't be decoded |

### Subtitles

Drop a subtitle file next to the video with the same base name — language and accessibility tags in the suffix are picked up automatically:

```
Dune Part Two (2024).mkv
Dune Part Two (2024).en.srt
Dune Part Two (2024).en.forced.srt
Dune Part Two (2024).fr.vtt

Severance (2022)/Season 01/
  Severance - S01E01 - Good News About Hell.mkv
  Severance - S01E01 - Good News About Hell.en.srt
  Subs/Severance - S01E01 - Good News About Hell.de.srt
```

Both `Subs/` and `Subtitles/` subfolders are checked. SRT is converted to WebVTT on the fly (cue numbers, `{\an8}`-style tags, comma timestamps and UTF-16 BOMs are handled), so no conversion tool is needed. Pick a track with the **CC** button, or press `C` to toggle captions; your language choice carries into the next episode for the session.

### Discover

**Discover** shows what is trending this week plus the popular movies and TV shows right now. Each card carries the services streaming that title in your country — subscription services first, and rent/buy only when nothing is included. Press a card for the backdrop, synopsis and the full list grouped into *Included with a subscription*, *Free with ads*, *Rent* and *Buy*.

Where to watch comes from JustWatch through TMDB, so it is per country: pick yours under **Settings → TMDB → Streaming region** (saved as soon as you choose it, no re-scan). The buttons open the title's JustWatch page, which hands you straight to the service — streaming services do not publish per-title deep links. Availability is checked lazily after the page paints, so the rows appear immediately and the badges fill in a moment later; lists are cached for 6 hours and availability for 12.

Discover needs a linked TMDB key. Without one the tab explains how to link it. The required “This product uses the TMDB API but is not endorsed or certified by TMDB” notice sits in the page footer.

### Live TV

**Settings → Live TV (M3U)** takes any number of playlists — an IPTV provider's `http(s)` link, or a path to a `.m3u` file on this machine. Channels appear in the guide in playlist order with a ▶ button; press it (or a programme on that channel) to watch. The list is refreshed when you save and via **Refresh channels now**.

Channels are matched to guide data by `tvg-id` first and channel name second, so a playlist entry inherits the station's programmes. Names that repeat the channel number (`101 BBC One`) are split, leaving the number in the guide's number column.

Saving a playlist stores its URL in `config.json` (mode `0600`) — provider links usually embed your username and password, so they are never sent back to the browser and are redacted in logs and error messages.

Playback goes through `/api/live/proxy`, which fetches the stream server-side and rewrites HLS playlists so variants, keys and segments all come back through ReelHouse. That is what makes provider streams work at all: they rarely send CORS headers, and the relative segment paths only resolve against the playlist's own URL. A provider that requires a specific `User-Agent` or referer may still refuse; those are not spoofed.

Live channels are streams, not files: there is no resume, no transcoding and no next-episode — a channel that fails to open shows the player's error rather than a converted fallback.

### Up next

When an episode finishes, a card for the following episode appears with a 9-second countdown. Choose **Play now**, **Cancel**, press `N` to skip ahead immediately, or let it advance on its own. Ordering follows seasons and episode numbers, so the last episode of a season rolls into the next one; the final episode simply stops.

Autoplay is on by default and can be switched off in **Settings → Playback**. With it off the card still appears, marked *autoplay is off*, so the next episode is one click away without anything starting on its own.

### Continue watching

The home row lists everything you stopped part-way through, most recent first, with the time left and a **×** to forget an item without touching the file. Position is saved every 10 seconds and on pause, exit and episode end; anything past 95% counts as watched and drops out of the row. Short items use a 10% threshold so a 10-minute episode still appears, and show pages offer **Continue S01E02** with the timestamp instead of restarting at episode one — plus **Start from the beginning** if you want that instead.

### Playback and codecs

ReelHouse ships FFmpeg (the engine VLC uses for decoding), so it plays the same containers and codecs VLC does. How a file is handled is decided per file:

| Situation | What happens |
|---|---|
| MP4/MOV/WebM with H.264, VP8/9 or AV1 and AAC/MP3/Opus audio | **Direct play** — the original bytes are range-streamed, seeking is instant, no CPU cost |
| Anything else — MKV, AVI, WMV, TS, VOB, HEVC, MPEG-2, VC-1, DTS, AC-3, TrueHD… | **Transcoded** — H.264/AAC HLS segments encoded on demand into a small in-memory cache. A **Transcoding** badge appears in the player while it converts |

Transcoding converts only the 4-second chunk being watched, so playback starts after a moment and seeking re-encodes from the point you jump to instead of the beginning. Nothing is written to your media folders. Tuning lives in **Settings → Playback**: turn conversion off for native-only playback, pick the encoder effort (fast / balanced / high) and cap the output at 720p, 1080p or the source resolution.

If a direct-play file fails at runtime (an odd profile, a damaged file), the player offers a **Transcode it** button instead of giving up.

Binary resolution: `FFMPEG_PATH` / `FFPROBE_PATH` environment variables win, then the bundled copies, then whatever is on `PATH` — so a system FFmpeg with hardware encoders can be swapped in without touching the app.

---

## HTTP API

All endpoints are served by the local service; the UI uses nothing else.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/status` | Version, counts, scan state, TMDB/EPG status |
| `GET` | `/api/library` | Movies, shows, seasons, episodes (file paths redacted) |
| `GET` | `/api/item/:id` | One movie, show or episode |
| `GET` | `/api/search?q=` | Library + guide search |
| `POST` | `/api/scan` · `GET /api/scan/status` | Start a scan / poll progress |
| `GET`/`PUT` | `/api/settings` | Read (key redacted) / update settings |
| `POST` | `/api/tmdb/verify` | Test a key (or the saved one) with TMDB, save it on success, re-enrich the library |
| `POST` | `/api/tmdb/refresh` | Clear the TMDB cache and re-fetch metadata, optionally in a new language |
| `DELETE` | `/api/tmdb` | Unlink: forget the key and rescan without it |
| `GET` | `/api/epg?from=&to=` | Guide window |
| `GET` | `/api/epg/now` | What's on right now, per channel |
| `GET` | `/api/live` | Configured playlists' channels |
| `POST` | `/api/live/refresh` | Re-fetch every playlist |
| `GET` | `/api/live/play/:id` | Playback URL for one channel (always the proxy) |
| `GET` | `/api/live/proxy?u=` | Server-side stream fetch; rewrites HLS playlists through itself |
| `POST` | `/api/epg/refresh` | Re-parse all XMLTV sources |
| `GET` | `/api/play/:kind/:id` | Resolve a playable file, stream URL and subtitle tracks |
| `GET` | `/api/stream/:kind/:id` | Video bytes with `Range` support |
| `GET` | `/api/hls/:kind/:id/index.m3u8` | HLS playlist for a file that needs converting (segments are 4s) |
| `GET` | `/api/hls/:kind/:id/seg-:n.ts` | One MPEG-TS segment, encoded on demand and cached |
| `GET` | `/api/subtitles/:kind/:id/:index` | Subtitle track as WebVTT (SRT converted server-side) |
| `GET`/`POST` | `/api/progress` · `GET /api/continue` | Playback positions |
| `DELETE` | `/api/progress/:id` | Forget one resume point (the × on a Continue watching card) |
| `GET` | `/api/discover` | Trending and popular movies/TV for the Discover tab |
| `GET` | `/api/discover/providers?type=&ids=` | Streaming availability per title for the configured region |
| `GET` | `/api/art?path=&size=` | Cached TMDB artwork proxy |

`kind` is `movie`, `show` (with `?season=&episode=`) or `episode`.

---

## Project layout

```
android/                     Android TV client (Gradle project, no app dependencies)
  app/src/main/java/…/ConnectActivity.java   Server discovery + manual address
  app/src/main/java/…/BrowserActivity.java   WebView host: fullscreen video, Back handling
  app/src/main/java/…/Discovery.java         UDP probe, /api/status verification
  app/src/main/assets/tv-shim.js             Focus ring + OK-to-open, injected per page
server/
  index.js      Express app: API, streaming, artwork cache, scan orchestration
  discovery.js  UDP responder the TV app looks for on the LAN
  config.js     Data dir + persisted settings
  store.js      Atomic JSON store with coalesced writes
  tmdb.js       Cached TMDB client (v3 key or v4 token), artwork helper
  scanner.js    Folder walk, filename parsing, TMDB enrichment
  epg.js        XMLTV parser, time-window queries, "now" lookups
  subtitles.js  Sidecar discovery, language labels, SRT → WebVTT conversion
  transcode.js  FFmpeg discovery, ffprobe, direct/transcode decisions, HLS segments
  start.js      `npm start` entry point
public/
  index.html    App shell
  css/app.css   Dark cinematic UI
  js/api.js · js/app.js   Client API + hash-routed views
electron/
  main.js       Desktop shell: boots service, window, menu, folder picker
  preload.js    Narrow, sandboxed bridge
scripts/
  make-demo.js  Demo library + demo XMLTV generator
  make-icon.js  Renders build/icon.png with no image dependencies
build/
  icon.png                    Source icon (electron-builder makes .icns/.ico)
  entitlements.mac.plist      Hardened-runtime entitlements for the app
  entitlements.mac.inherit.plist   Entitlements for helpers, ffmpeg and ffprobe
  notarize.js                 afterSign hook: notarise the app, then staple the ticket
```

---

## Troubleshooting

**A movie/show got the wrong match.** Rename the file to `Title (Year).ext` or change the folder to `Show Name (Year)` and rescan. The TMDB response cache keeps rescans fast.

**Video won't play.** Check the play payload for an explanation: `GET /api/play/movie/<id>` reports `playback.mode` (`direct`, `transcode` or `unsupported`) and a human-readable `playback.reason`. `unsupported` means FFmpeg could not read the file at all (empty, corrupt, or still downloading) or conversion is switched off in Settings. If transcoded playback stutters, lower the maximum resolution or the encoder effort in **Settings → Playback**.

**Transcoding badge never goes away / playback is slow to start.** Every seek re-encodes from that point, and the first segment takes a second or two. On older machines 1080p HEVC sources are the heaviest case — cap the output at 720p. The badge's tooltip explains why the file is being converted.

**No artwork or logos.** Link TMDB in Settings — the card shows *Not linked* until a key passes verification. If a linked key stops working, the card shows the last request error inline (usually a revoked key or blocked network access to `api.themoviedb.org`); *Unlink* and link again with a fresh key.

**Guide is empty.** Add an XMLTV source in Settings and press *Refresh guide now*. A source may be a local `.xml` file or an `http(s)` URL. Check the error line under the sources if parsing fails.

**Subtitles don't appear.** The file must sit beside the video (or in a `Subs/`/`Subtitles/` subfolder) and share the video's exact base name, with an optional language suffix — e.g. `Show.S01E01.en.srt`, not `Show.S01E01.English.srt.bak` or a remote `subs/` folder elsewhere. The CC button only appears when at least one track was found. Only `.srt` and `.vtt` are supported; `.ass`/`.ssa` and embedded subtitle streams are not read.

**Port already in use.** ReelHouse automatically picks the next free port (8091, 8092, …) — the actual URL is printed on startup and used by the desktop app.

**Nothing scanned.** Confirm the folder is readable by your user and that extensions are video files (`.mp4 .m4v .mkv .mov .avi .webm .wmv .mpg .mpeg .ts .m2ts .mts .flv .ogv .vob .3gp .asf .rmvb .divx .f4v .mxf .m2v .ogm`). Settings lists any folder it could not find.

---

## Third-party components- **FFmpeg / ffprobe** (via `ffmpeg-static` and `@ffprobe-installer/ffprobe`) do the decoding and conversion.
 The bundled builds are GPL-licensed; if you redistribute ReelHouse, distribute the binary under the same terms. They run as local child processes and are never exposed to the browser.
- **hls.js** (Apache-2.0) plays the converted streams in the browser.
- Movie and TV metadata/artwork come from TMDB under their API terms.

---

## Privacy & security

- The service binds to `127.0.0.1` only; it is not reachable from your network.
- Browser requests from other origins are rejected by the API guard.
- The TMDB key never leaves the machine and is never returned to the browser (`hasApiKey` only).
- Artwork is cached on disk after first view, so your library works offline.
- ReelHouse only reads media; it never moves, renames or deletes your files. The one exception is its own cache/data directory.

TMDB metadata and images are supplied by [The Movie Database](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.
