// audio-engine.js
// Handles playback across formats. Strategy:
//   - MP3 / M4A / AAC / WAV: always native <audio> playback (universally supported).
//   - FLAC: try native <audio> first (Chromium-based WebViews decode FLAC natively
//     in most current Android builds). If canPlayType() says no, fall back to the
//     ffmpeg.wasm decode path below.
//   - APE (Monkey's Audio): no browser/WebView on earth decodes this natively, so
//     it ALWAYS goes through the ffmpeg.wasm decode path.
//   - OGG: intentionally never decoded. Caller is expected to check
//     isOggUnsupported() before calling loadTrack() and show the alert instead.
//
// The ffmpeg.wasm core (~31MB) is only fetched the first time a file actually
// needs it — if someone's whole library is MP3/M4A/FLAC-with-native-support,
// the wasm core is never downloaded at all.

import { FFmpeg } from '../vendor/ffmpeg/ffmpeg/index.js';
import { fetchFile, toBlobURL } from '../vendor/ffmpeg/util/index.js';

const EQ_BANDS_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const MIME_BY_EXT = {
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ape: 'audio/x-ape', // not a registered mime, canPlayType will always say "" — that's expected
  ogg: 'audio/ogg',
};

export class UnsupportedOggError extends Error {
  constructor() { super('OGG is not supported by Fydelity'); this.name = 'UnsupportedOggError'; }
}

export function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

export function isLosslessExt(ext) {
  return ext === 'flac' || ext === 'wav' || ext === 'ape';
}

export class AudioEngine {
  constructor() {
    this.audioEl = new Audio();
    this.audioEl.preload = 'metadata';
    this.audioEl.crossOrigin = 'anonymous';

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = 256;
    this.analyserR.fftSize = 256;

    const splitter = this.ctx.createChannelSplitter(2);
    const merger = this.ctx.createChannelMerger(2);

    this.source = this.ctx.createMediaElementSource(this.audioEl);
    this.eqFilters = EQ_BANDS_HZ.map((freq) => {
      const f = this.ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });
    this.preampGain = this.ctx.createGain();
    this.preampGain.gain.value = 1;

    // source -> eq chain -> preamp -> splitter -> [analyserL, analyserR] -> merger -> destination
    let node = this.source;
    for (const f of this.eqFilters) { node.connect(f); node = f; }
    node.connect(this.preampGain);
    this.preampGain.connect(splitter);
    splitter.connect(this.analyserL, 0);
    splitter.connect(this.analyserR, 1);
    this.preampGain.connect(this.ctx.destination);

    this._ffmpeg = null;
    this._ffmpegLoading = null;
    this._objectUrlCache = new Map(); // key -> objectURL
    this.decodedBytesTotal = 0; // sum of ffmpeg-decoded PCM/WAV bytes held in memory this session
    this.onDecodeProgress = null; // (ratio 0..1) => void, set by UI
  }

  resume() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setBandGainDb(index, db) {
    if (this.eqFilters[index]) this.eqFilters[index].gain.value = db;
  }

  setPreampDb(db) {
    this.preampGain.gain.value = Math.pow(10, db / 20);
  }

  /** RMS-ish level 0..1 per channel, sampled from the analyser. Cheap, real-time. */
  readLevels() {
    const bufL = new Uint8Array(this.analyserL.frequencyBinCount);
    const bufR = new Uint8Array(this.analyserR.frequencyBinCount);
    this.analyserL.getByteTimeDomainData(bufL);
    this.analyserR.getByteTimeDomainData(bufR);
    const rms = (buf) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length);
    };
    return { l: rms(bufL), r: rms(bufR) };
  }

  async _ensureFfmpeg() {
    if (this._ffmpeg) return this._ffmpeg;
    if (this._ffmpegLoading) return this._ffmpegLoading;

    this._ffmpegLoading = (async () => {
      const ffmpeg = new FFmpeg();
      // Loaded from a CDN rather than bundled locally — the core is ~31MB,
      // over GitHub's 25MB web-upload limit, and there's no real downside to
      // fetching it from a CDN instead: it's still cached by the service
      // worker's runtime cache after the first successful load (see sw.js),
      // so repeat visits and offline use work exactly the same either way.
      const base = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/';
      await ffmpeg.load({
        coreURL: await toBlobURL(base + 'ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL(base + 'ffmpeg-core.wasm', 'application/wasm'),
      });
      this._ffmpeg = ffmpeg;
      return ffmpeg;
    })();

    return this._ffmpegLoading;
  }

  canPlayNative(ext) {
    const mime = MIME_BY_EXT[ext] || '';
    if (!mime) return false;
    return this.audioEl.canPlayType(mime) !== '';
  }

  /**
   * Decode a file that the WebView can't play natively (always true for APE,
   * sometimes true for FLAC) down to WAV using ffmpeg.wasm, entirely on-device.
   * Returns an object URL. Nothing is written to disk — decoded audio lives in
   * memory for the session only, matching the "referenced, not copied" storage
   * model: we're not duplicating the user's library, just transcoding one track
   * at a time as it's played.
   */
  async _decodeWithFfmpeg(file, ext) {
    const ffmpeg = await this._ensureFfmpeg();
    const inName = `in.${ext}`;
    const outName = 'out.wav';

    const progressHandler = ({ progress }) => {
      if (this.onDecodeProgress) this.onDecodeProgress(Math.max(0, Math.min(1, progress)));
    };
    ffmpeg.on('progress', progressHandler);

    try {
      await ffmpeg.writeFile(inName, await fetchFile(file));
      // -f wav forces WAV container; PCM16 output is universally <audio>-playable
      // and keeps decode time reasonable even for long lossless tracks.
      await ffmpeg.exec(['-i', inName, '-f', 'wav', outName]);
      const data = await ffmpeg.readFile(outName);
      this.decodedBytesTotal += data.buffer.byteLength;
      return URL.createObjectURL(new Blob([data.buffer], { type: 'audio/wav' }));
    } finally {
      ffmpeg.off('progress', progressHandler);
      try { await ffmpeg.deleteFile(inName); } catch (_) {}
      try { await ffmpeg.deleteFile(outName); } catch (_) {}
    }
  }

  /**
   * Load + prep a track for playback. Does not start playback (caller calls play()).
   * `track` = { key, file, ext } where `file` is a File (or FileSystemFileHandle-resolved File).
   */
  async loadTrack(track) {
    const { key, file, ext } = track;

    if (ext === 'ogg') throw new UnsupportedOggError();

    let url = this._objectUrlCache.get(key);
    if (!url) {
      const useNative = ext !== 'ape' && this.canPlayNative(ext);
      url = useNative
        ? URL.createObjectURL(file)
        : await this._decodeWithFfmpeg(file, ext);
      this._objectUrlCache.set(key, url);
    }

    this.audioEl.src = url;
    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(this.audioEl.error); };
      const cleanup = () => {
        this.audioEl.removeEventListener('loadedmetadata', onReady);
        this.audioEl.removeEventListener('error', onError);
      };
      this.audioEl.addEventListener('loadedmetadata', onReady);
      this.audioEl.addEventListener('error', onError);
    });
  }

  wasDecoded(ext) {
    // true if this ext, as loaded, definitely went through ffmpeg (used for UI badges)
    return ext === 'ape' || (ext === 'flac' && !this.canPlayNative('flac'));
  }

  play() { this.resume(); return this.audioEl.play(); }
  pause() { this.audioEl.pause(); }
  seekTo(seconds) { this.audioEl.currentTime = seconds; }

  /** Revoke every decoded/native object URL held in memory and reset the byte counter. */
  clearDecodeCache() {
    const currentSrc = this.audioEl.src;
    for (const url of this._objectUrlCache.values()) {
      if (url !== currentSrc) URL.revokeObjectURL(url);
    }
    this._objectUrlCache.clear();
    this.decodedBytesTotal = 0;
  }

  destroy() {
    for (const url of this._objectUrlCache.values()) URL.revokeObjectURL(url);
    this._objectUrlCache.clear();
    if (this._ffmpeg) this._ffmpeg.terminate();
  }
}
