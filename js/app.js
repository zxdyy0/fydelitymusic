// app.js
import { AudioEngine, extOf, isLosslessExt, UnsupportedOggError } from './audio-engine.js';
import { pickAndScanFolder, rescanFolder, canRescan, computeStorageStats, supportsFileSystemAccess, tryRestoreFolder, reconnectFolder } from './file-source.js';

const engine = new AudioEngine();

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let tracks = [];          // full scanned list, includes .ogg entries
let playableIndex = [];   // indices into `tracks` that are actually playable (excludes ogg)
let currentIdx = -1;      // index into `tracks`
let isPlaying = false;
let shuffleOn = false;
let repeatOn = false;
let rafId = null;

const ART_PALETTE = [
  ['#6B5636', '#241C12'], ['#4E5A4C', '#1B211A'], ['#4A4E63', '#191B24'],
  ['#63504A', '#241A17'], ['#5A4E63', '#1F1A24'], ['#4E5A63', '#1A2024'],
  ['#4A5A5A', '#182121'],
];
function artColorsFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ART_PALETTE[h % ART_PALETTE.length];
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// page / drawer navigation
// ---------------------------------------------------------------------------
const pages = {
  onboarding: document.getElementById('page-onboarding'),
  library: document.getElementById('page-library'),
  nowPlaying: document.getElementById('page-now-playing'),
  settings: document.getElementById('page-settings'),
  equalizer: document.getElementById('page-equalizer'),
};
function showPage(name) {
  Object.values(pages).forEach((p) => p.classList.remove('active'));
  pages[name].classList.add('active');
}
function syncTabs(tabName) {
  document.querySelectorAll('.tab-item').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll(`.tab-item[data-tab="${tabName}"]`).forEach((el) => el.classList.add('active'));
}
function syncDrawer(navName) {
  document.querySelectorAll('.drawer-item.enabled').forEach((el) => el.classList.remove('current'));
  const el = document.querySelector(`.drawer-item[data-nav="${navName}"]`);
  if (el) el.classList.add('current');
}
function goLibrary() { showPage('library'); syncTabs('library'); syncDrawer('library'); }
function goSettings() { renderSettings(); showPage('settings'); syncTabs('settings'); syncDrawer('settings'); }
function goEqualizer() { showPage('equalizer'); syncTabs(''); syncDrawer('equalizer'); }
function goNowPlaying() { showPage('nowPlaying'); }

const drawer = document.getElementById('drawer');
const drawerScrim = document.getElementById('drawer-scrim');
function openDrawer() { drawer.classList.add('show'); drawerScrim.classList.add('show'); }
function closeDrawer() { drawer.classList.remove('show'); drawerScrim.classList.remove('show'); }
document.querySelectorAll('.menu-btn').forEach((btn) => btn.addEventListener('click', openDrawer));
drawerScrim.addEventListener('click', closeDrawer);
document.querySelectorAll('.drawer-item.enabled').forEach((item) => {
  item.addEventListener('click', () => {
    const nav = item.dataset.nav;
    if (nav === 'library') goLibrary();
    if (nav === 'equalizer') goEqualizer();
    if (nav === 'settings') goSettings();
    closeDrawer();
  });
});
document.querySelectorAll('.tab-item[data-tab="settings"]').forEach((el) => el.addEventListener('click', goSettings));
document.querySelectorAll('.tab-item[data-tab="library"]').forEach((el) => el.addEventListener('click', goLibrary));
document.getElementById('mini-player').addEventListener('click', goNowPlaying);
document.getElementById('np-back').addEventListener('click', goLibrary);

// ---------------------------------------------------------------------------
// onboarding: real folder pick + scan
// ---------------------------------------------------------------------------
const onbCta = document.getElementById('onb-cta');
const onbNote = document.getElementById('onb-note');
const onbError = document.getElementById('onb-error');
const onbCopy = document.querySelector('.onb-copy');
const onbScan = document.getElementById('onb-scan');
const onbFill = document.getElementById('onb-scan-fill');
const onbPct = document.getElementById('onb-scan-pct');
const onbText = document.getElementById('onb-scan-text');

// Folder-handle picking (File System Access) only exists on desktop/ChromeOS
// browsers — no mobile browser supports it. On phones, adjust the copy so
// it accurately says "files" rather than promising folder selection that
// isn't actually available there.
if (!supportsFileSystemAccess) {
  onbCopy.textContent = 'Select the music files already on your device. Nothing gets copied or moved — we just read them.';
  const ctaLabel = onbCta.lastChild;
  if (ctaLabel) ctaLabel.textContent = 'Choose Music Files';
  onbText.textContent = 'Scanning files…';
}

function showOnbError(message) {
  onbError.textContent = message;
  onbError.classList.add('show');
}
function hideOnbError() {
  onbError.classList.remove('show');
}

async function runFolderPick() {
  hideOnbError();
  onbCta.style.display = 'none';
  onbNote.style.display = 'none';
  onbScan.classList.add('show');
  onbFill.style.width = '4%';
  onbPct.textContent = '…';
  onbText.textContent = supportsFileSystemAccess ? 'Waiting for folder selection…' : 'Waiting for file selection…';

  try {
    const found = await pickAndScanFolder((matched, checked) => {
      onbFill.style.width = Math.min(96, 8 + checked * 0.5) + '%';
      onbPct.textContent = String(matched);
      onbText.textContent = checked > matched
        ? `Scanning… ${matched} tracks found (${checked} files checked)`
        : `Scanning… ${matched} found`;
    });
    tracks = found;
    onbFill.style.width = '100%';
    onbText.textContent = `${tracks.length} files found`;
    setTimeout(() => {
      renderLibrary();
      goLibrary();
      // reset onboarding chrome in case the user re-opens it later (e.g. re-pick)
      onbCta.style.display = '';
      onbNote.style.display = '';
      onbScan.classList.remove('show');
    }, 450);
  } catch (err) {
    console.error(err);
    onbScan.classList.remove('show');
    onbCta.style.display = '';
    onbNote.style.display = '';
    if (err && err.name === 'AbortError') {
      // user backed out of the picker on purpose — not an error, no alarming message needed
    } else {
      showOnbError(
        supportsFileSystemAccess
          ? 'Could not read that folder. Try again, or pick a different one.'
          : 'Could not read those files. Try again — if it keeps happening, try selecting fewer files at once.'
      );
    }
  }
}
onbCta.addEventListener('click', runFolderPick);


// ---------------------------------------------------------------------------
// library rendering
// ---------------------------------------------------------------------------
const trackListEl = document.getElementById('track-list');
const trackCountEl = document.getElementById('track-count');

function fmtChipHtml(ext) {
  const label = ext.toUpperCase();
  if (ext === 'ogg') {
    return `<div class="fmt-chip unsupported"><span class="fmt-name">OGG</span><span class="fmt-detail">N/A</span></div>`;
  }
  const cls = isLosslessExt(ext) ? 'lossless' : '';
  const detail = isLosslessExt(ext) ? 'LOSSLESS' : label;
  return `<div class="fmt-chip ${cls}"><span class="fmt-name">${label}</span><span class="fmt-detail">${detail}</span></div>`;
}

function renderLibrary() {
  playableIndex = tracks.map((t, i) => i).filter((i) => tracks[i].ext !== 'ogg');
  trackCountEl.textContent = `${tracks.length} TRACK${tracks.length === 1 ? '' : 'S'}`;

  if (tracks.length === 0) {
    trackListEl.innerHTML = `
      <div class="lib-empty">
        <div class="lib-empty-title">No music yet</div>
        <div class="lib-empty-sub">Go to Settings → Re-scan, or reopen the app to add your music.</div>
      </div>`;
    return;
  }

  trackListEl.innerHTML = tracks.map((t, i) => {
    const [a, b] = artColorsFor(t.key);
    const isOgg = t.ext === 'ogg';
    return `
      <div class="track-row ${isOgg ? 'disabled' : ''} ${i === currentIdx ? 'playing' : ''}" data-idx="${i}">
        <div class="track-art" style="--art-a:${a};--art-b:${b}">${i === currentIdx && isPlaying ? '<div class="eq-bars"><span></span><span></span><span></span></div>' : ''}</div>
        <div class="track-meta">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(t.artist)} · ${fmtBytes(t.sizeBytes)}</div>
        </div>
        ${fmtChipHtml(t.ext)}
      </div>`;
  }).join('');

  trackListEl.querySelectorAll('.track-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = Number(row.dataset.idx);
      const t = tracks[idx];
      if (t.ext === 'ogg') { showOggAlert(); return; }
      playTrackAt(idx);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const oggScrim = document.getElementById('ogg-scrim');
function showOggAlert() { oggScrim.classList.add('show'); }
document.getElementById('ogg-dismiss').addEventListener('click', () => oggScrim.classList.remove('show'));
oggScrim.addEventListener('click', (e) => { if (e.target === oggScrim) oggScrim.classList.remove('show'); });

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------
const decodeOverlay = document.getElementById('decode-overlay');
const decodeLabel = document.getElementById('decode-label');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npFmt = document.getElementById('np-fmt');
const npDetail = document.getElementById('np-detail');
const npUpnext = document.getElementById('np-upnext');
const playBtn = document.getElementById('play-btn');
const playIcon = document.getElementById('play-icon');
const miniPlayer = document.getElementById('mini-player');
const miniTitle = document.getElementById('mini-title');
const miniSub = document.getElementById('mini-sub');
const miniPlayPauseIcon = document.getElementById('mini-playpause-icon');
const miniProgressFill = document.getElementById('mini-progress-fill');
const scrubEl = document.getElementById('scrub');
const npTimeCur = document.getElementById('np-time-cur');
const npTimeRem = document.getElementById('np-time-rem');

// build the 56 scrub bars once; recolored on progress updates
const SCRUB_BAR_COUNT = 56;
for (let i = 0; i < SCRUB_BAR_COUNT; i++) {
  const h = 4 + Math.round(Math.abs(Math.sin(i * 0.5)) * 18 + Math.random() * 4);
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.height = h + 'px';
  bar.style.background = 'var(--hairline)';
  scrubEl.appendChild(bar);
}
scrubEl.addEventListener('click', (e) => {
  const rect = scrubEl.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  if (isFinite(engine.audioEl.duration)) engine.seekTo(ratio * engine.audioEl.duration);
});

const PLAY_SVG = '<path d="M8 5v14l11-7z"/>';
const PAUSE_SVG = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';

function setPlayIcon(playing) {
  playIcon.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  miniPlayPauseIcon.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

async function playTrackAt(idx) {
  currentIdx = idx;
  const t = tracks[idx];
  const [a, b] = artColorsFor(t.key);
  document.getElementById('np-art').style.setProperty('--art-a', a);
  document.getElementById('np-art').style.setProperty('--art-b', b);

  npTitle.textContent = t.title;
  npArtist.textContent = t.album ? `${t.artist} — ${t.album}` : t.artist;
  npFmt.textContent = t.ext.toUpperCase();
  npDetail.textContent = fmtBytes(t.sizeBytes);
  miniTitle.textContent = t.title;
  miniSub.textContent = t.artist;
  miniPlayer.style.display = 'flex';

  const nextIdx = nextPlayableIndex(1);
  npUpnext.textContent = 'UP NEXT: ' + (nextIdx >= 0 ? tracks[nextIdx].title.toUpperCase() : '—');

  goNowPlaying();
  renderLibrary();

  const willDecode = t.ext === 'ape' || (t.ext === 'flac' && !engine.canPlayNative('flac'));
  if (willDecode) {
    decodeLabel.textContent = t.ext === 'ape'
      ? 'Decoding APE (Monkey\'s Audio) via ffmpeg.wasm…'
      : 'Decoding FLAC via ffmpeg.wasm…';
    decodeOverlay.classList.add('show');
    engine.onDecodeProgress = (p) => {
      decodeLabel.textContent = `Decoding… ${Math.round(p * 100)}%`;
    };
  }

  try {
    await engine.loadTrack({ key: t.key, file: t.file, ext: t.ext });
    decodeOverlay.classList.remove('show');
    await engine.play();
    isPlaying = true;
    setPlayIcon(true);
    startVisualLoop();
  } catch (err) {
    decodeOverlay.classList.remove('show');
    console.error('Playback failed', err);
    decodeLabel.textContent = '';
    npDetail.textContent = 'Could not decode this file';
  }
}

function nextPlayableIndex(direction) {
  if (playableIndex.length === 0) return -1;
  const pos = playableIndex.indexOf(currentIdx);
  if (shuffleOn) {
    const others = playableIndex.filter((i) => i !== currentIdx);
    return others.length ? others[Math.floor(Math.random() * others.length)] : currentIdx;
  }
  let nextPos = (pos === -1 ? 0 : pos + direction);
  if (nextPos < 0) nextPos = repeatOn ? playableIndex.length - 1 : 0;
  if (nextPos >= playableIndex.length) nextPos = repeatOn ? 0 : playableIndex.length - 1;
  return playableIndex[nextPos];
}

playBtn.addEventListener('click', async () => {
  if (currentIdx === -1) return;
  if (isPlaying) {
    engine.pause();
    isPlaying = false;
    setPlayIcon(false);
  } else {
    await engine.play();
    isPlaying = true;
    setPlayIcon(true);
    startVisualLoop();
  }
});
document.getElementById('mini-playpause').addEventListener('click', (e) => { e.stopPropagation(); playBtn.click(); });

document.getElementById('np-next').addEventListener('click', () => {
  const i = nextPlayableIndex(1);
  if (i >= 0) playTrackAt(i);
});
document.getElementById('np-prev').addEventListener('click', () => {
  if (engine.audioEl.currentTime > 3) { engine.seekTo(0); return; }
  const i = nextPlayableIndex(-1);
  if (i >= 0) playTrackAt(i);
});
document.getElementById('np-shuffle').addEventListener('click', (e) => {
  shuffleOn = !shuffleOn;
  e.currentTarget.classList.toggle('on', shuffleOn);
});
document.getElementById('np-repeat').addEventListener('click', (e) => {
  repeatOn = !repeatOn;
  e.currentTarget.classList.toggle('on', repeatOn);
});

engine.audioEl.addEventListener('ended', () => {
  const i = nextPlayableIndex(1);
  if (i >= 0 && (repeatOn || i !== currentIdx)) playTrackAt(i);
  else { isPlaying = false; setPlayIcon(false); }
});

function startVisualLoop() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    updateProgressUI();
    updateVuMeters();
    if (isPlaying) rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function updateProgressUI() {
  const { currentTime, duration } = engine.audioEl;
  const ratio = isFinite(duration) && duration > 0 ? currentTime / duration : 0;
  miniProgressFill.style.width = (ratio * 100) + '%';
  npTimeCur.textContent = fmtTime(currentTime);
  npTimeRem.textContent = '-' + fmtTime((duration || 0) - currentTime);

  const filledBars = Math.round(ratio * SCRUB_BAR_COUNT);
  const bars = scrubEl.children;
  for (let i = 0; i < bars.length; i++) {
    bars[i].style.background = i < filledBars ? 'var(--amber)' : 'var(--hairline)';
  }
}

const needleL = document.getElementById('needle-l');
const needleR = document.getElementById('needle-r');
needleL.style.animation = 'none';
needleR.style.animation = 'none';

// Real VU meters respond to loudness on a logarithmic (dB) scale with fast
// attack / slow decay ballistics — that's what makes the needle look like
// it's "dancing" with the music instead of either sitting flat (linear
// scale is too insensitive at normal listening levels) or slamming to max
// and staying there (which is what a raw linear RMS mapping did before:
// typical music RMS is well within the range where `rms * 2.2` clips to 1
// almost immediately, pinning the needle instead of moving with it).
let vuStateL = 0; // smoothed 0..1 deflection, persists across frames
let vuStateR = 0;

function rmsToDeflection(rms) {
  const db = 20 * Math.log10(Math.max(rms, 0.0008)); // ~-62dB floor for near-silence
  const MIN_DB = -40; // needle rests near center-low around typical quiet passages
  const MAX_DB = -4;  // needle nears full swing before true digital clipping — music rarely sits at 0dBFS RMS
  return Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

function updateVuMeters() {
  const { l, r } = engine.readLevels();
  const targetL = rmsToDeflection(l);
  const targetR = rmsToDeflection(r);

  const ATTACK = 0.55; // rises quickly on transients
  const DECAY = 0.10;  // falls off more gradually, like real meter inertia
  vuStateL += (targetL - vuStateL) * (targetL > vuStateL ? ATTACK : DECAY);
  vuStateR += (targetR - vuStateR) * (targetR > vuStateR ? ATTACK : DECAY);

  const angle = (deflection) => -32 + deflection * 64; // -32deg..+32deg
  needleL.setAttribute('transform', `rotate(${angle(vuStateL)} 40 40)`);
  needleR.setAttribute('transform', `rotate(${angle(vuStateR)} 40 40)`);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
const storageUsedEl = document.getElementById('storage-used');
const storageTotalEl = document.getElementById('storage-total');
const storageBarEl = document.getElementById('storage-bar');
const storageLegendEl = document.getElementById('storage-legend');
const setTrackCountEl = document.getElementById('set-track-count');
const flacDecodePathEl = document.getElementById('flac-decode-path');
const oggCountValueEl = document.getElementById('ogg-count-value');
const cacheSizeValueEl = document.getElementById('cache-size-value');
const storageModeLabelEl = document.getElementById('storage-mode-label');
const storageModeDescEl = document.getElementById('storage-mode-desc');
const storageModeSwitchEl = document.getElementById('storage-mode-switch');

async function renderSettings() {
  setTrackCountEl.textContent = `${tracks.length} TRACKS`;
  flacDecodePathEl.textContent = engine.canPlayNative('flac') ? 'Native (WebView)' : 'ffmpeg.wasm';
  oggCountValueEl.textContent = `${tracks.filter((t) => t.ext === 'ogg').length} found`;
  cacheSizeValueEl.textContent = fmtBytes(engine.decodedBytesTotal || 0);

  if (supportsFileSystemAccess) {
    storageModeLabelEl.textContent = 'Referenced, not copied';
    storageModeDescEl.textContent = 'Fydelity links to your files in place instead of duplicating them — no extra space used.';
    storageModeSwitchEl.style.opacity = '1';
  } else {
    storageModeLabelEl.textContent = 'Folder access, no persistence';
    storageModeDescEl.textContent = 'This WebView can\'t keep a folder handle between launches, so you\'ll re-pick the folder each time Fydelity opens. Files still aren\'t copied.';
    storageModeSwitchEl.style.opacity = '0.35';
  }

  const stats = await computeStorageStats(tracks);
  storageUsedEl.textContent = fmtBytes(stats.totalUsed);
  storageTotalEl.textContent = stats.quota
    ? `of ~${fmtBytes(stats.quota)} available (browser estimate)`
    : 'across your linked library';

  let losslessBytes = 0, compressedBytes = 0;
  for (const [ext, bytes] of Object.entries(stats.byExt)) {
    if (ext === 'ogg') continue;
    if (isLosslessExt(ext)) losslessBytes += bytes; else compressedBytes += bytes;
  }
  const total = losslessBytes + compressedBytes || 1;
  storageBarEl.innerHTML = `
    <div class="seg lossless" style="width:${(losslessBytes / total) * 100}%"></div>
    <div class="seg compressed" style="width:${(compressedBytes / total) * 100}%"></div>`;

  const rows = Object.entries(stats.byExt)
    .filter(([ext]) => ext !== 'ogg')
    .sort((a, b) => b[1] - a[1]);
  const maxBytes = rows.length ? rows[0][1] : 1;
  storageLegendEl.innerHTML = rows.map(([ext, bytes]) => {
    const lossless = isLosslessExt(ext);
    return `
      <div class="legend-row">
        <span class="legend-dot ${lossless ? 'lossless' : 'compressed'}"></span>
        <span class="legend-fmt">${ext.toUpperCase()}</span>
        <span class="legend-track"><span class="fill ${lossless ? 'lossless' : 'compressed'}" style="width:${(bytes / maxBytes) * 100}%"></span></span>
        <span class="legend-size">${fmtBytes(bytes)}</span>
      </div>`;
  }).join('') || '<div class="legend-row"><span class="legend-fmt" style="width:auto;color:var(--cream-faint);">No tracks scanned yet</span></div>';
}

document.getElementById('rescan-row').addEventListener('click', async () => {
  const valueEl = document.getElementById('rescan-row').querySelector('.set-row-value');
  const original = valueEl.textContent;
  valueEl.textContent = '…';
  try {
    tracks = canRescan() ? await rescanFolder() : await pickAndScanFolder();
    renderLibrary();
    renderSettings();
  } catch (err) {
    console.error(err);
  } finally {
    valueEl.textContent = original;
  }
});

document.getElementById('clear-cache-row').addEventListener('click', () => {
  engine.clearDecodeCache();
  renderSettings();
});

// ---------------------------------------------------------------------------
// equalizer
// ---------------------------------------------------------------------------
const EQ_FREQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const EQ_PRESETS = {
  Flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Audiophile: [1, 1, 0.5, 0, 0, 0, 0.5, 1, 1.5, 1],
  'Bass Boost': [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
  Vocal:      [-2, -1, 1, 3, 4, 3, 2, 0, -1, -2],
  Jazz:       [2, 1.5, 0.5, 0.5, -1, -1, 0, 1, 1.5, 2],
  Rock:       [4, 3, 1, 0, -1, 0, 1, 2, 3, 3],
};
let eqGains = [...EQ_PRESETS.Flat];
let eqEnabled = true;
let preampDb = 0;

const eqPresetRow = document.getElementById('eq-preset-row');
eqPresetRow.innerHTML = [...Object.keys(EQ_PRESETS), 'Custom'].map((name) =>
  `<div class="eq-preset" data-preset="${name}">${name}</div>`).join('');

const eqBandPanel = document.getElementById('eq-band-panel');
function renderEqBands() {
  eqBandPanel.innerHTML = EQ_FREQ_LABELS.map((hz, i) => `
    <div class="eq-band">
      <div class="eq-db" id="eq-db-${i}"></div>
      <div class="eq-fader-track" data-band="${i}">
        <div class="eq-fader-mid"></div>
        <div class="eq-fader-fill" id="eq-fill-${i}"></div>
        <div class="eq-fader-thumb" id="eq-thumb-${i}"></div>
      </div>
      <div class="eq-hz">${hz}</div>
    </div>`).join('');
  EQ_FREQ_LABELS.forEach((_, i) => updateBandVisual(i));
  wireFaderDrag();
}

function updateBandVisual(i) {
  const v = eqGains[i];
  const pct = Math.min(50, (Math.abs(v) / 12) * 50);
  const positive = v >= 0;
  document.getElementById(`eq-db-${i}`).textContent = (v > 0 ? '+' : '') + v.toFixed(1);
  document.getElementById(`eq-fill-${i}`).style.cssText = positive
    ? `bottom:50%; height:${pct}%;` : `bottom:${50 - pct}%; height:${pct}%;`;
  document.getElementById(`eq-thumb-${i}`).style.bottom = (positive ? 50 + pct : 50 - pct) + '%';
}

function applyEqToEngine() {
  eqGains.forEach((v, i) => engine.setBandGainDb(i, eqEnabled ? v : 0));
}

function markCustom() {
  document.querySelectorAll('.eq-preset').forEach((p) => p.classList.remove('active'));
  document.querySelector('.eq-preset[data-preset="Custom"]').classList.add('active');
}

function wireFaderDrag() {
  document.querySelectorAll('.eq-fader-track').forEach((track) => {
    const band = Number(track.dataset.band);
    let dragging = false;
    const setFromClientY = (clientY) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height)); // 0 bottom .. 1 top
      const db = (ratio - 0.5) * 24; // -12..+12
      eqGains[band] = Math.round(db * 10) / 10;
      updateBandVisual(band);
      applyEqToEngine();
      markCustom();
    };
    track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); setFromClientY(e.clientY); });
    track.addEventListener('pointermove', (e) => { if (dragging) setFromClientY(e.clientY); });
    track.addEventListener('pointerup', () => { dragging = false; });
    track.addEventListener('pointercancel', () => { dragging = false; });
  });
}

eqPresetRow.addEventListener('click', (e) => {
  const item = e.target.closest('.eq-preset');
  if (!item) return;
  document.querySelectorAll('.eq-preset').forEach((p) => p.classList.remove('active'));
  item.classList.add('active');
  const name = item.dataset.preset;
  if (EQ_PRESETS[name]) {
    eqGains = [...EQ_PRESETS[name]];
    EQ_FREQ_LABELS.forEach((_, i) => updateBandVisual(i));
    applyEqToEngine();
  }
});

const eqEnableSwitch = document.getElementById('eq-enable-switch');
eqEnableSwitch.addEventListener('click', () => {
  eqEnabled = !eqEnabled;
  eqEnableSwitch.classList.toggle('on', eqEnabled);
  eqEnableSwitch.style.opacity = eqEnabled ? '1' : '0.4';
  applyEqToEngine();
});

const preampTrack = document.getElementById('preamp-track');
const preampFill = document.getElementById('preamp-fill');
const preampValueEl = document.getElementById('preamp-value');
function updatePreampVisual() {
  const pct = ((preampDb + 12) / 24) * 100;
  preampFill.style.width = pct + '%';
  preampValueEl.textContent = (preampDb >= 0 ? '+' : '') + preampDb.toFixed(1) + ' dB';
}
(function wirePreampDrag() {
  let dragging = false;
  const setFromClientX = (clientX) => {
    const rect = preampTrack.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    preampDb = Math.round((ratio * 24 - 12) * 10) / 10;
    updatePreampVisual();
    engine.setPreampDb(preampDb);
  };
  preampTrack.addEventListener('pointerdown', (e) => { dragging = true; preampTrack.setPointerCapture(e.pointerId); setFromClientX(e.clientX); });
  preampTrack.addEventListener('pointermove', (e) => { if (dragging) setFromClientX(e.clientX); });
  preampTrack.addEventListener('pointerup', () => { dragging = false; });
})();

renderEqBands();
updatePreampVisual();
applyEqToEngine();

// ---------------------------------------------------------------------------
// PWA: service worker registration + install prompt
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed (app still works, just without offline caching):', err);
    });
  });
}

const installBanner = document.getElementById('pwa-install-banner');
const installBtn = document.getElementById('pwa-install-btn');
const installText = document.getElementById('pwa-install-text');
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// Chromium (Android): the browser tells us install is possible via this event.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone()) installBanner.classList.add('show');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBanner.classList.remove('show');
});

window.addEventListener('appinstalled', () => {
  installBanner.classList.remove('show');
});

// iOS Safari has no beforeinstallprompt — it only supports "Add to Home
// Screen" from the share sheet, so we just point people at that manually.
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (isIos && !isStandalone()) {
  installText.textContent = 'On iPhone: tap the Share icon, then "Add to Home Screen"';
  installBanner.classList.add('show');
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
(async function boot() {
  onbText.textContent = 'Checking for a previously linked folder…';
  onbScan.classList.add('show');
  onbFill.style.width = '30%';
  onbCta.style.display = 'none';
  onbNote.style.display = 'none';

  try {
    const result = await tryRestoreFolder((matched, checked) => {
      onbFill.style.width = Math.min(96, 30 + checked * 0.4) + '%';
      onbText.textContent = checked > matched
        ? `Reopening your library… ${matched} tracks found (${checked} checked)`
        : `Reopening your library… ${matched} found`;
    });

    if (result.restored) {
      tracks = result.tracks;
      renderLibrary();
      goLibrary();
      return; // skip onboarding entirely — straight into the library, as promised
    }

    if (result.needsPermission) {
      // We know which folder it was, we just need one tap to re-confirm —
      // browsers require a fresh user gesture for this, an automatic
      // re-request isn't allowed even though we already have the handle.
      onbText.textContent = '';
      onbScan.classList.remove('show');
      onbCta.style.display = '';
      onbNote.style.display = '';
      onbCta.querySelector('svg')?.remove();
      onbCta.textContent = 'Reconnect Music Folder';
      onbNote.textContent = 'Fydelity remembers your last folder — just needs permission again';
      onbCta.removeEventListener('click', runFolderPick);
      const onReconnectClick = async () => {
        onbCta.style.display = 'none';
        onbNote.style.display = 'none';
        onbScan.classList.add('show');
        try {
          tracks = await reconnectFolder((matched, checked) => {
            onbFill.style.width = Math.min(96, 8 + checked * 0.5) + '%';
            onbText.textContent = checked > matched
              ? `Reopening your library… ${matched} tracks found (${checked} checked)`
              : `Reopening your library… ${matched} found`;
          });
          onbFill.style.width = '100%';
          renderLibrary();
          setTimeout(goLibrary, 350);
        } catch (err) {
          console.error(err);
          onbScan.classList.remove('show');
          onbCta.textContent = 'Choose Music Folder';
          onbCta.style.display = '';
          onbCta.removeEventListener('click', onReconnectClick);
          onbCta.addEventListener('click', runFolderPick);
          if (!(err && err.name === 'AbortError')) {
            showOnbError('Could not reconnect — pick the folder manually below.');
          }
        }
      };
      onbCta.addEventListener('click', onReconnectClick, { once: true });
      return;
    }
  } catch (err) {
    console.warn('Folder restore check failed, falling back to first-run picker', err);
  }

  // no previous folder (first-ever launch, or unsupported browser) — show
  // the normal "Choose Music Folder" first-run screen
  onbText.textContent = '';
  onbScan.classList.remove('show');
  onbCta.style.display = '';
  onbNote.style.display = '';
  renderLibrary();
})();
