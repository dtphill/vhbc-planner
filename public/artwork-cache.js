// Only public BGG image addresses are persisted, never member/account data.
const KEY = 'vhbc-artwork-v2';
const WEEK = 7 * 86400000;
const MAX = 300;
const images = new Map();
let writeTimer;
export function safeImage(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try { const u = new URL(value.startsWith('//') ? 'https:' + value : value); return u.protocol === 'https:' && u.hostname === 'cf.geekdo-images.com' && !u.username && !u.password && !u.port && !u.hash ? u.href : null; } catch { return null; }
}
try {
  const raw = localStorage.getItem(KEY);
  const saved = raw && raw.length < 800000 ? JSON.parse(raw) : [];
  if (Array.isArray(saved)) for (const row of saved.slice(0, MAX)) {
    if (Array.isArray(row) && Number.isSafeInteger(row[0]) && row[0] > 0 && safeImage(row[1]) && Number.isFinite(row[2]) && row[2] <= Date.now() && Date.now() - row[2] < WEEK) images.set(row[0], {url: safeImage(row[1]), savedAt: row[2]});
  }
} catch { /* Restricted browser storage must not break the catalogue. */ }
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify([...images].filter(([,v]) => Date.now()-v.savedAt < WEEK).slice(-MAX).map(([id,v]) => [id,v.url,v.savedAt]))); } catch {}
  }, 250);
}
export function rememberArtwork(id, value) {
  const url = safeImage(value);
  if (!Number.isSafeInteger(id) || id < 1 || !url) return false;
  images.delete(id); images.set(id, {url, savedAt: Date.now()});
  while (images.size > MAX) images.delete(images.keys().next().value);
  persist(); return true;
}
export function cachedArtwork(id) {
  const saved = images.get(Number(id));
  return saved && Date.now()-saved.savedAt < WEEK ? saved.url : null;
}
export function forgetArtwork(id) { images.delete(Number(id)); persist(); }
