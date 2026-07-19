// file-source.js
// Picks music and scans it for playable files. Prefers the File System
// Access API (showDirectoryPicker) because it lets us re-scan later without
// asking the user to pick anything again — we keep the directory *handle*,
// not a copy of the files. Note that no mobile browser supports this API at
// all (Chrome/Firefox/Safari on Android and iOS all lack it) — it's
// currently desktop/ChromeOS-only, so on phones we always fall through to
// the picker below.
//
// The naive fallback would be <input type="file" webkitdirectory> (a whole-
// folder picker), but that attribute is unreliable specifically on mobile:
// Android browsers report support for it in feature detection, but actually
// selecting a folder silently fails in practice — no files come back and the
// "change" event never fires, which is exactly the "tap the button and
// nothing happens" bug this was rewritten to avoid. Directory selection from
// a file input has effectively zero real-world support on any mobile browser
// (desktop Chrome/Firefox/Edge/Safari are fine; phones are not).
//
// So on phones we instead ask for a batch of individual audio files
// (<input type="file" multiple accept="audio/*">, no webkitdirectory) —
// this is universally supported. Most Android file pickers still let you
// multi-select everything inside one folder in a couple of taps, so the
// practical experience is close to picking a folder, just without silent
// re-scanning later (the user re-picks files each time).

import { readTags } from './metadata.js';

const AUDIO_EXTS = new Set(['flac', 'wav', 'ape', 'mp3', 'm4a', 'aac', 'ogg']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function titleFromFilename(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || name;
}

export const supportsFileSystemAccess = typeof window.showDirectoryPicker === 'function';

let cachedDirHandle = null; // set once per session, and restored from IndexedDB on relaunch

// ---- tiny IndexedDB wrapper, just for persisting the one directory handle ----
// FileSystemDirectoryHandle is structured-cloneable, so IndexedDB (unlike
// localStorage, which is string-only) can store it directly. This is what
// makes "pick your folder once" survive closing and reopening the installed
// PWA — without this, cachedDirHandle would reset to null on every launch
// and the user would have to re-pick their folder every single time.
const IDB_NAME = 'fydelity';
const IDB_STORE = 'handles';
const IDB_KEY = 'musicFolder';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSaveHandle(handle) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) { /* IndexedDB unavailable — folder just won't survive relaunch, non-fatal */ }
}

async function idbLoadHandle() {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) { return null; }
}

/**
 * Called on app startup. If a folder was picked in a previous launch and
 * permission is still silently granted, re-scans it with no prompt at all —
 * the library just appears. If permission needs re-confirming (the browser
 * requires a user gesture for that), returns { needsPermission: true } so
 * the UI can show a one-tap "Reconnect folder" button instead of the full
 * first-run picker flow.
 */
export async function tryRestoreFolder(onProgress) {
  if (!supportsFileSystemAccess) return { restored: false };
  const handle = await idbLoadHandle();
  if (!handle) return { restored: false };

  const perm = await handle.queryPermission({ mode: 'read' });
  if (perm === 'granted') {
    cachedDirHandle = handle;
    const tracks = await scanDirHandle(handle, onProgress);
    return { restored: true, tracks };
  }
  // permission lapsed (browser requires a fresh user gesture to re-grant) —
  // stash the handle so a single tap can re-request it without a full re-pick
  cachedDirHandle = handle;
  return { restored: false, needsPermission: true };
}

/** One-tap reconnect: re-requests permission on the already-known folder handle. */
export async function reconnectFolder(onProgress) {
  if (!cachedDirHandle) throw new Error('No previously picked folder to reconnect.');
  const req = await cachedDirHandle.requestPermission({ mode: 'read' });
  if (req !== 'granted') throw new Error('Permission was not granted.');
  return scanDirHandle(cachedDirHandle, onProgress);
}

async function* walkDirHandle(dirHandle, path = '') {
  // Manually drives the async iterator (instead of `for await...of`) so a
  // failure partway through — e.g. a Windows-protected system folder like
  // "System Volume Information" or "$RECYCLE.BIN" when someone picks an
  // entire drive root rather than a specific Music folder — only skips that
  // one subtree. Without this, one unreadable subfolder anywhere in the
  // tree would abort the entire scan, which is what "Could not read that
  // folder" actually meant in practice: not that the whole folder was
  // unreadable, just some folder inside it.
  let iterator;
  try {
    iterator = dirHandle.entries();
  } catch (err) {
    console.warn(`Could not list "${path || dirHandle.name}":`, err.message);
    return;
  }

  while (true) {
    let result;
    try {
      result = await iterator.next();
    } catch (err) {
      console.warn(`Stopped reading "${path || dirHandle.name}" early (likely a permission-protected system folder):`, err.message);
      return;
    }
    if (result.done) return;

    const [name, handle] = result.value;
    const entryPath = path ? `${path}/${name}` : name;
    if (handle.kind === 'file') {
      yield { name, path: entryPath, handle };
    } else if (handle.kind === 'directory') {
      yield* walkDirHandle(handle, entryPath);
    }
  }
}

async function buildTrackFromFile(file, relativePath) {
  const ext = extOf(file.name);
  const tags = await readTags(file, ext); // real embedded tags where the format supports it; null falls back cleanly below
  return {
    key: `${relativePath}:${file.size}:${file.lastModified}`,
    name: file.name,
    path: relativePath,
    ext,
    sizeBytes: file.size,
    title: (tags && tags.title) || titleFromFilename(file.name),
    artist: (tags && tags.artist) || 'Unknown Artist',
    album: (tags && tags.album) || null,
    file, // File object (or resolved from a handle) — used directly by the audio engine
  };
}

/**
 * Opens a folder picker (desktop/ChromeOS, via File System Access) or a
 * multi-file audio picker (everywhere else, including all mobile browsers)
 * and returns a flat list of track objects for every recognized audio file
 * found (including .ogg — those are kept in the list so the library can
 * show them, just flagged as unsupported; nothing decodes them).
 */
export async function pickAndScanFolder(onProgress) {
  if (supportsFileSystemAccess) {
    const dirHandle = await window.showDirectoryPicker({ id: 'fydelity-music', mode: 'read' });
    cachedDirHandle = dirHandle;
    idbSaveHandle(dirHandle); // fire-and-forget; non-fatal if it fails
    return scanDirHandle(dirHandle, onProgress);
  }
  return scanViaInputFallback(onProgress);
}

/** Re-scan the previously granted folder (File System Access only). */
export async function rescanFolder(onProgress) {
  if (!cachedDirHandle) throw new Error('No folder handle to re-scan — pick a folder first.');
  const perm = await cachedDirHandle.queryPermission({ mode: 'read' });
  if (perm !== 'granted') {
    const req = await cachedDirHandle.requestPermission({ mode: 'read' });
    if (req !== 'granted') throw new Error('Permission to re-read the folder was denied.');
  }
  return scanDirHandle(cachedDirHandle, onProgress);
}

export function canRescan() {
  return !!cachedDirHandle;
}

// Cloud-synced folders (OneDrive/Google Drive/Dropbox "files on demand" /
// "online only" placeholders) can make handle.getFile() hang indefinitely —
// the OS tries to silently download the real content first, and if that's
// slow or the file was never actually synced, the read just never resolves.
// A hard per-file timeout means one bad file skips instead of freezing the
// entire scan forever.
const GET_FILE_TIMEOUT_MS = 8000;
function getFileWithTimeout(handle) {
  return Promise.race([
    handle.getFile(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out reading file (possibly a cloud-only placeholder)')), GET_FILE_TIMEOUT_MS)
    ),
  ]);
}

async function scanDirHandle(dirHandle, onProgress) {
  const tracks = [];
  let checked = 0;  // every entry visited, audio or not — keeps progress visibly moving
  let matched = 0;  // audio files actually added to the library
  for await (const entry of walkDirHandle(dirHandle)) {
    checked++;
    const ext = extOf(entry.name);
    if (AUDIO_EXTS.has(ext)) {
      try {
        const file = await getFileWithTimeout(entry.handle);
        tracks.push(await buildTrackFromFile(file, entry.path));
        matched++;
      } catch (err) {
        console.warn(`Skipped unreadable file "${entry.path}":`, err.message);
      }
    }
    if (onProgress) onProgress(matched, checked);
  }
  return tracks;
}

function scanViaInputFallback(onProgress) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // No webkitdirectory here — see the file header comment for why.
    // audio/* plus explicit extensions since some mobile pickers don't
    // register proper mime types for flac/ape.
    input.accept = 'audio/*,.flac,.ape,.wav,.mp3,.m4a,.aac,.ogg';
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('focus', onWindowFocus);
      if (input.parentNode) document.body.removeChild(input);
    };
    const cancelled = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('No files were selected'), { name: 'AbortError' }));
    };

    input.addEventListener('change', async () => {
      if (settled) return;
      const files = Array.from(input.files || []);
      if (files.length === 0) { cancelled(); return; }
      settled = true;
      try {
        const tracks = [];
        let matched = 0;
        let checked = 0;
        for (const file of files) {
          checked++;
          const ext = extOf(file.name);
          if (AUDIO_EXTS.has(ext)) {
            tracks.push(await buildTrackFromFile(file, file.webkitRelativePath || file.name));
            matched++;
          }
          if (onProgress) onProgress(matched, checked);
        }
        cleanup();
        resolve(tracks);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }, { once: true });

    // Chrome 113+ fires a real "cancel" event when the picker is dismissed
    // with nothing chosen — use it directly where available.
    input.addEventListener('cancel', cancelled, { once: true });

    // Safety net for browsers/WebViews that don't support the "cancel"
    // event above: when the window regains focus (the system picker UI
    // closed) and no files ended up selected, treat that as a cancel too.
    // Without this, dismissing the picker on those browsers would leave
    // Fydelity waiting on a "change" event that will never arrive — stuck
    // on the onboarding screen forever instead of a clean reset.
    const onWindowFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) cancelled();
      }, 400);
    };
    window.addEventListener('focus', onWindowFocus);

    input.click();
  });
}

/**
 * Storage snapshot for the Settings screen. Uses the real per-format byte
 * totals from the scanned library, plus navigator.storage.estimate() where
 * available for an honest device-storage figure (browser-reported, not a
 * true OS-level total — we label it as such in the UI).
 */
export async function computeStorageStats(tracks) {
  const byExt = {};
  for (const t of tracks) {
    byExt[t.ext] = (byExt[t.ext] || 0) + t.sizeBytes;
  }
  const totalUsed = Object.values(byExt).reduce((a, b) => a + b, 0);

  let quota = null;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quota = est.quota || null;
    } catch (_) { /* not available in this WebView */ }
  }

  return { byExt, totalUsed, quota };
}

export { extOf, titleFromFilename, AUDIO_EXTS };
