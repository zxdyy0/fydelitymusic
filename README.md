# Fydelity — build v1

This is a working build, not just the UI mockup — folder picking, library
scanning, real playback (including FLAC and APE), a real 10-band EQ, and a
storage screen with real numbers are all wired up. Read this whole file
before packaging with HTML2App; there are two things (below) that need a
decision from you.

## How FLAC and APE playback actually works

Browsers/WebViews don't all agree on what they can decode natively, and APE
(Monkey's Audio) isn't decoded natively *anywhere* — no browser ships an APE
decoder. So Fydelity uses a hybrid strategy, implemented in
`public/js/audio-engine.js`:

| Format | Strategy |
|---|---|
| MP3, M4A, AAC, WAV | Native `<audio>` playback. Universally supported. |
| FLAC | Tries native `<audio>` first (`canPlayType`). Most current Chromium-based Android WebViews decode FLAC natively — if so, it plays instantly, no extra work. If not, falls back to the same path as APE. |
| APE | **Always** decoded via `ffmpeg.wasm`, entirely on-device, entirely offline. Nothing is uploaded anywhere. |
| OGG | Never decoded. The UI intercepts `.ogg` files before they ever reach the audio engine and shows the "not supported" alert instead. |

The `ffmpeg.wasm` decode path transcodes the file to WAV in-memory
(`ffmpeg.writeFile` → `ffmpeg.exec(['-i', ..., '-f', 'wav', ...])` →
`ffmpeg.readFile`), then hands the browser a Blob URL to play. Nothing is
written to the device's actual storage — the decoded audio lives in memory
for the session only, consistent with the "referenced, not copied" storage
model we designed in Settings. Decoded tracks are cached in memory per
session so replaying the same track doesn't re-decode it.

The `ffmpeg-core.wasm` binary is ~31 MB. It's loaded from a CDN (unpkg —
see `js/audio-engine.js`) rather than bundled in this repo, which keeps
every file here under GitHub's 25MB web-upload limit. It's only fetched the
*first* time a track actually needs it (first APE, or first
non-natively-playable FLAC) — if someone's whole library is
MP3/AAC/native-FLAC, it's never downloaded at all. After that first fetch,
`sw.js` caches it, so every use after that — including fully offline — is
served locally, same as if it had been bundled from the start. Settings →
Playback shows which path FLAC is actually taking on the current device
("Native (WebView)" vs "ffmpeg.wasm"), so you can verify this live once
it's running on a real phone.

## Folder access: two decisions HTML2App forces on us

**1. File System Access API vs. plain file input.**
`public/js/file-source.js` tries `window.showDirectoryPicker()` first (lets
Fydelity re-scan the same folder later without asking again — see the
"Re-scan linked folder" row in Settings). If the WebView doesn't support it,
it falls back to a plain `<input type="file" webkitdirectory>` picker, which
works everywhere but can't be silently re-opened — the user has to tap
"Choose Music Folder" again each time. **Which of these you actually get
depends entirely on the Chromium version inside HTML2App's WebView, and I
can't verify that from here** — Settings will tell you which mode is active
once it's running on your device (look at the "Referenced, not copied" vs
"Folder access, no persistence" card).

**2. Module Workers need to load over http(s), not `file://`.**
`ffmpeg.wasm` spins up a Web Worker, and Chromium blocks *module* workers
from loading under the `file://` scheme due to CORS. If HTML2App serves your
app's assets over `file://` directly, APE/fallback-FLAC decoding will fail
silently — check Settings → "APE decode path" and try playing an APE file as
your first real test. If it fails, the fix is on HTML2App's side: it needs
to serve local assets through a local origin (most WebView app-wrappers do
this via something like Android's `WebViewAssetLoader`, serving from
`https://appassets.androidplatform.net/...` instead of `file:///...`) —
check HTML2App's docs/settings for an option like "serve via local server"
or "use asset loader." Native-format playback (MP3/M4A/AAC/WAV/native-FLAC)
doesn't need a worker and will work fine either way.

## What's real vs. what's still a placeholder

Real: folder picking + recursive scan, native + ffmpeg.wasm playback
(including actual FLAC/APE decoding), the 10-band EQ (draggable, wired to
real `BiquadFilterNode`s), the VU meters (driven by an `AnalyserNode` reading
the actual decoded audio, not animated for show), next/prev/shuffle/repeat,
the storage screen (real per-format byte totals from your files, plus
`navigator.storage.estimate()` for the device-storage figure where the
WebView supports it), and the OGG alert.

Known simplification for this version: track title/artist come from the
filename, not from embedded tags (ID3/Vorbis comments/APE tags). Album art
is a generated color placeholder, not extracted cover art. Both are natural
next steps — happy to build a tag-reading pass next if you want real
metadata instead of filenames.

## PWA: a third way to install this, no Cordova/HTML2App needed

The app is now also a real installable Progressive Web App
(`manifest.json` + `sw.js` + `icons/`). If you just host this
`public/` folder on any real HTTPS server, people can open it in a mobile
browser and install it straight from there — no APK, no app store, no
wrapper tool at all. This sidesteps the whole `file://` vs `https://` CORS
issue from the FLAC/APE section above entirely, since a PWA only ever runs
from a real https origin in the first place.

What's actually wired up:

- **Installable** — `manifest.json` gives it a name, icon set (including
  Android's maskable adaptive-icon variants), and `display: standalone` so
  it opens full-screen with no browser chrome, matching the app frame we
  designed. Chromium-based browsers will offer to install it automatically;
  there's also an in-app "Install App" button on the onboarding screen that
  triggers the native install prompt directly (`beforeinstallprompt`).
  Safari/iOS doesn't support that prompt, so on iOS the same banner instead
  shows a plain-language nudge: *"tap the Share icon, then Add to Home
  Screen."*
- **Offline app shell** — `sw.js` precaches the actual UI (html/css/js/icons)
  on install, so reopening Fydelity works even with zero signal. The ~31 MB
  ffmpeg core isn't part of that — it's loaded from a CDN (not bundled in
  this repo, to stay under GitHub's 25MB per-file upload limit) and only
  gets cached the first time a track actually needs it (first APE, or
  first FLAC without native decode support), so a library that's all
  MP3/AAC never pays that download at all. After that first time, it's
  served from cache — offline decoding just works from then on.
- **The music folder itself now survives closing the app.** This is the
  direct fix for the earlier "will my library disappear when I close the
  app?" concern. When you pick a folder, its handle is saved into
  IndexedDB (`js/file-source.js`, `tryRestoreFolder()` /
  `reconnectFolder()`). Next time Fydelity opens, it silently checks that
  saved handle and, if the browser still has permission granted, jumps
  straight into the library with **no re-pick, no prompt at all**. If the
  browser's dropped permission (this can happen after enough time has
  passed, browser-dependent), Fydelity shows a one-tap "Reconnect Music
  Folder" button instead of the full first-run flow — it already remembers
  *which* folder, it just needs a fresh tap to re-confirm access, which
  browsers require a real user gesture for. Either way, nothing about your
  files themselves is ever copied into this storage — only the *permission
  handle* is persisted, consistent with the "referenced, not copied" model
  from Settings.

One limitation worth knowing: this handle-persistence trick relies on the
File System Access API, so it behaves the same way it does elsewhere in this
project — Chromium-based mobile browsers support it, Safari/iOS does not.
On iOS, folder access falls back to the plain file input, which means
re-picking the folder each time is currently unavoidable there.

## Packaging: three options

This exact `public/` folder can be shipped three different ways — pick
whichever fits:

1. **PWA (see section above)** — easiest. Host `public/` on any HTTPS
   server, done. No wrapper, no build step, no app store review.
2. **Cordova** — for a real installable APK from an app-store-style
   listing. This same `public/` folder is duplicated into `www/` inside the
   separate `fydelity-cordova/` project; see `README-cordova.md` there for
   build steps (`npx cordova platform add android && npx cordova build
   android`). Cordova serves `www/` over `https://localhost` by default
   rather than raw `file://`, which is exactly what avoids the
   module-Worker CORS problem described above — no extra config needed,
   it's just how cordova-android ≥ 8.0 works.
3. **A different WebView wrapper** (HTML2App or similar) — same rule
   applies: check whether it serves local assets over `file://` or over a
   local http(s) origin. `file://` will break the ffmpeg.wasm decode path
   (APE, and FLAC on WebViews without native FLAC support); a local origin
   won't.

This repo itself is now tiny (well under 1 MB — the ffmpeg core is fetched
from a CDN at runtime, not bundled, see above). The ~31 MB only shows up on
a user's device the first time they actually play an APE file or a FLAC
file their WebView can't decode natively — that's the real, unavoidable
cost of genuine on-device APE decoding, there isn't a lighter option that
still covers Monkey's Audio. One consideration for the Cordova/WebView
wrapper routes specifically: they need network access on first launch (or
at least the first APE/fallback-FLAC play) to fetch that CDN file — after
that it's cached and works fully offline.

