// Webview-preload: ловит события плеера Kodik (postMessage) и передаёт
// текущее время просмотра/окончание в renderer через sendToHost.
// Загружается в контексте player.html (внутри webview).
const { ipcRenderer } = require('electron');

let lastReport = 0;
let latestTime = null;
let latestDuration = null;

function readNumber(payload, names) {
  if (!payload || typeof payload !== 'object') return null;
  for (const name of names) {
    const value = Number(payload[name]);
    if (payload[name] != null && Number.isFinite(value) && value >= 0) return value;
  }
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const found = readNumber(value, names);
      if (found != null) return found;
    }
  }
  return null;
}

function isNearEnd(time, duration) {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration < 60) return false;
  return time >= 30 && time >= duration - Math.max(20, Math.min(45, duration * 0.08));
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  try {
    const key = String(d.key || d.event || d.type || '');
    const val = d.value != null ? d.value : d;
    const eventName = `${key} ${typeof d.event === 'string' ? d.event : ''} ${typeof d.type === 'string' ? d.type : ''}`;
    // Завершение рекламного ролика не означает, что закончилась серия.
    if (/\bad(?:s?\b|[_:-])|advert|preroll|pre-roll|vast|commercial|promo/i.test(eventName)) return;
    const time = typeof val === 'number' && /time|position/i.test(key)
      ? val
      : readNumber(val, ['time', 'currentTime', 'current_time', 'position']);
    const duration = typeof val === 'number' && /duration/i.test(key)
      ? val
      : readNumber(val, ['duration', 'totalDuration', 'total_duration']);
    if (time != null) latestTime = time;
    if (duration != null) latestDuration = duration;

    if (/end|finish|complete/i.test(eventName)) {
      if (isNearEnd(latestTime, latestDuration)) {
        ipcRenderer.sendToHost('kodik', { ended: true, time: Math.floor(latestTime), duration: Math.floor(latestDuration) });
      }
      return;
    }
    const now = Date.now();
    if (time != null && now - lastReport > 10000) {
      lastReport = now;
      ipcRenderer.sendToHost('kodik', { time: Math.floor(latestTime), duration: latestDuration == null ? null : Math.floor(latestDuration) });
    }
  } catch {}
});
