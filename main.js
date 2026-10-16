const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Конфигурация API (вытащено из AniXart Premium 9.0b11) ───────────────────
const API_BASE = 'https://api-s.anixsekai.com';
const USER_AGENT =
  'AnixartApp/9.0b11-1000 (Android 13; SDK 33; arm64-v8a; Samsung SM-G991B; ru)';

// Куда складываем локальные данные (избранное, история, аккаунт)
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const providerCookies = new Map();

const DEFAULT_STORE = { favorites: [], history: [], playerPositions: {}, settings: { token: '', adblock: true, playerMode: 'source', playerSpeed: 1, playerResize: 'contain', autoNext: true }, profile: null };

let store = DEFAULT_STORE;
function loadStore() {
  try {
    store = Object.assign({}, DEFAULT_STORE, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
    store.settings = Object.assign({ token: '', adblock: true, playerMode: 'source', playerSpeed: 1, playerResize: 'contain', autoNext: true }, store.settings || {});
  } catch {
    store = JSON.parse(JSON.stringify(DEFAULT_STORE));
  }
  return store;
}
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}
function token() { return (store.settings && store.settings.token) || ''; }

// ── Прокси-запросы к API (в main-процессе: обход CORS, User-Agent, токен) ────
async function apiRequest(pathname, { method = 'GET', body = null, form = null, auth = true } = {}) {
  let url = API_BASE + pathname;
  if (auth && token()) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token());

  const opts = { method, headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } };
  if (form != null) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    opts.body = new URLSearchParams(form).toString();
  } else if (body != null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!text) return { code: -1, _empty: true, _status: res.status };
    try { return JSON.parse(text); }
    catch { return { code: -1, _raw: text.slice(0, 500) }; }
  } catch (e) {
    return { code: -1, _error: String(e && e.message || e) };
  }
}

// Перенос SibnetParser из AniXart APK: взять src со страницы и разрешить
// цепочку перенаправлений с referer страницы-источника.
async function resolveSibnetStream(input) {
  let pageUrl;
  try { pageUrl = new URL(input); } catch { return { error: 'Некорректная ссылка серии.' }; }
  if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== 'video.sibnet.ru') return { error: 'Для этого провайдера разбор пока не перенесён.' };
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Accept: 'text/html,application/xhtml+xml,*/*' };
  try {
    const page = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(20000) });
    if (!page.ok) return { error: `Sibnet вернул HTTP ${page.status}.` };
    const html = await page.text();
    const match = html.match(/src\s*:\s*["']([^"']+)["']/i);
    if (!match) return { error: 'Не удалось найти видео-ссылку на странице Sibnet.' };
    let streamUrl = new URL(match[1].replace(/\\\//g, '/'), 'https://video.sibnet.ru').href;
    for (let i = 0; i < 6; i++) {
      const response = await fetch(streamUrl, { headers: { ...headers, Referer: pageUrl.href }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        if (!response.ok) return { error: `Не удалось открыть видеопоток (HTTP ${response.status}).` };
        return { streams: [{ quality: 'Default', url: streamUrl }] };
      }
      streamUrl = new URL(location, streamUrl).href;
      const next = new URL(streamUrl);
      if (next.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(next.hostname)) return { error: 'Sibnet вернул небезопасный адрес потока.' };
    }
    return { error: 'Слишком много перенаправлений при поиске потока.' };
  } catch (error) {
    return { error: `Ошибка разбора Sibnet: ${String(error && error.message || error)}` };
  }
}

const PROVIDER_HOSTS = new Set([
  'myvi.top', 'www.myvi.top', 'secvideo1.online', 'csst.online', 'sstrge.online', 'sovetromantica.com', 'rutube.ru', 'www.rutube.ru', 'ok.ru', 'm.ok.ru',
  'anilibria.tv', 'new.anilib.one', 'anixart.libria.fun', 'anilibria.top', 'studiomir.club', 'api.studiomir.club', 'my.mail.ru', 'vk.com', 'vkvideo.ru',
]);
async function resolveAdditionalStream(input) {
  let pageUrl;
  try { pageUrl = new URL(input); } catch { return { error: 'Некорректная ссылка серии.' }; }
  if (pageUrl.protocol !== 'https:' || !PROVIDER_HOSTS.has(pageUrl.hostname)) return { error: 'Для этого провайдера разбор пока не перенесён.' };
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Accept: 'text/html,application/xhtml+xml,*/*' };
  const safeStream = (value, base) => {
    try { const u = new URL(value, base); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
  };
  try {
    if (pageUrl.hostname === 'vk.com' || pageUrl.hostname === 'vkvideo.ru') {
      const mobileAgent = 'com.vk.vkvideo.prod/822 (iPhone, iOS 16.7.7, iPhone10,4, Scale/2.0) SAK/1.119';
      const decoded = decodeURIComponent(pageUrl.href);
      const videoPattern = /(?:video|clip)(-?\d+)_(\d+)(?:_([a-f0-9]+))?/i;
      const embed = decoded.match(/[?&]oid=(-?\d+).*?[?&]id=(\d+)(?:.*?[?&]hash=([a-f0-9]+))?/i);
      const standard = decoded.match(videoPattern);
      const zValue = pageUrl.searchParams.get('z');
      const fromZ = zValue && decodeURIComponent(zValue).match(videoPattern);
      const parsed = embed || standard || fromZ;
      if (!parsed) return { error: 'Не удалось извлечь ID видеозаписи VK.' };
      const owner = parsed[1], videoId = parsed[2], accessKey = parsed[3];
      const deviceId = require('crypto').randomUUID().toUpperCase();
      const tokenUrl = new URL('https://oauth.vk.com/oauth/get_anonym_token');
      tokenUrl.searchParams.set('client_id', '51552953');
      tokenUrl.searchParams.set('client_secret', 'qgr0yWwXCrsxA1jnRtRX');
      tokenUrl.searchParams.set('device_id', deviceId);
      const tokenResponse = await fetch(tokenUrl, { headers: { 'User-Agent': mobileAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!tokenResponse.ok) return { error: `VK OAuth вернул HTTP ${tokenResponse.status}.` };
      const tokenData = await tokenResponse.json();
      if (!tokenData.token) return { error: tokenData.error_description || 'VK не выдал анонимный токен.' };
      const form = new URLSearchParams({ anonymous_token: tokenData.token, device_id: deviceId, lang: 'en', v: '5.244', videos: `${owner}_${videoId}${accessKey ? `_${accessKey}` : ''}` });
      const videoResponse = await fetch('https://api.vk.com/method/video.get', { method: 'POST', headers: { 'User-Agent': mobileAgent, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(20000) });
      if (!videoResponse.ok) return { error: `VK video.get вернул HTTP ${videoResponse.status}.` };
      const data = await videoResponse.json();
      if (data.error) return { error: data.error.error_msg || 'VK API не смог открыть видео.' };
      const item = data.response?.items?.[0];
      if (!item) return { error: 'VK не вернул видеозапись.' };
      if (item.restriction) return { error: item.restriction.title || 'VK ограничил доступ к этому видео.' };
      const streams = [2160, 1440, 1080, 720, 480, 360].map((quality) => ({ quality: `${quality}p`, url: safeStream(item.files?.[`mp4_${quality}`], pageUrl) })).filter((stream) => stream.url);
      return { streams, error: streams.length ? undefined : 'VK не вернул доступные MP4-варианты.' };
    }
    if (pageUrl.hostname === 'my.mail.ru') {
      const videoId = pageUrl.pathname.match(/\/embed\/(\d+)/)?.[1];
      if (!videoId) return { error: 'Не удалось распознать ID видео Mail.ru.' };
      const metaResponse = await fetch(`https://my.mail.ru/+/video/meta/${videoId}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!metaResponse.ok) return { error: `Mail.ru вернул HTTP ${metaResponse.status}.` };
      const cookieValues = metaResponse.headers.getSetCookie ? metaResponse.headers.getSetCookie() : [metaResponse.headers.get('set-cookie') || ''];
      const cookie = cookieValues.map((value) => value.split(';')[0]).filter(Boolean).join('; ');
      const metadata = await metaResponse.json();
      const videos = metadata.videos || metadata.meta?.videos || [];
      const qualities = { '2160': '2160p', '1440': '1440p', '1080': '1080p', '720': '720p', '480': '480p', '360': '360p' };
      const streams = videos.map((video) => {
        const rawUrl = String(video.url || '');
        const url = safeStream(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl, pageUrl);
        if (url && cookie) providerCookies.set(new URL(url).host, cookie);
        return { quality: Object.entries(qualities).find(([key]) => String(video.key).includes(key))?.[1] || String(video.key || 'Default'), url };
      }).filter((stream) => stream.url);
      return { streams, error: streams.length ? undefined : 'Mail.ru не вернул доступные варианты видео.' };
    }
    if (['anilibria.tv', 'new.anilib.one', 'anixart.libria.fun', 'anilibria.top'].includes(pageUrl.hostname)) {
      const releaseId = pageUrl.searchParams.get('id'), ordinal = Number(pageUrl.searchParams.get('ep'));
      if (!releaseId || !Number.isInteger(ordinal)) return { error: 'В URL AniLibria отсутствуют ID релиза или номер серии.' };
      const apiResponse = await fetch(`https://anilibria.top/api/v1/anime/releases/${encodeURIComponent(releaseId)}`, { headers, signal: AbortSignal.timeout(20000) });
      if (!apiResponse.ok) return { error: `AniLibria вернул HTTP ${apiResponse.status}.` };
      const data = await apiResponse.json();
      const episode = (data.episodes || []).find((item) => Number(item.ordinal) === ordinal);
      if (!episode) return { error: 'AniLibria не нашёл эту серию.' };
      const streams = [1080, 720, 480].map((height) => ({ quality: `${height}p`, url: safeStream(episode[`hls_${height}`], pageUrl) })).filter((stream) => stream.url);
      return { streams, error: streams.length ? undefined : 'AniLibria не вернул HLS-варианты для серии.' };
    }
    if (['studiomir.club', 'api.studiomir.club'].includes(pageUrl.hostname)) {
      const animeId = pageUrl.searchParams.get('ani'), episodeNo = Number(pageUrl.searchParams.get('ep'));
      if (!animeId || !Number.isInteger(episodeNo)) return { error: 'В URL StudioMir отсутствуют ID релиза или номер серии.' };
      const apiUrl = new URL('https://api.studiomir.club/api');
      apiUrl.searchParams.set('ani', animeId);
      apiUrl.searchParams.set('apikey', '80b2d3e9c4ff27eb2e924c4d38f7daec');
      const apiResponse = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (!apiResponse.ok) return { error: `StudioMir вернул HTTP ${apiResponse.status}.` };
      const data = await apiResponse.json();
      const candidates = data[0]?.players?.tsm?.filter((item) => Number(item.episode) === episodeNo) || [];
      const episode = candidates.find((item) => item.type === 'TV') || candidates.find((item) => item.type !== 'TR') || candidates[0];
      if (!episode) return { error: 'StudioMir не нашёл эту серию.' };
      const streams = [
        { quality: '2160p', url: safeStream(episode.hls?.hls2160, pageUrl) },
        { quality: '1080p', url: safeStream(episode.hls?.hls1080, pageUrl) },
        { quality: '720p', url: safeStream(episode.hls?.hls720, pageUrl) },
        { quality: 'Default', url: safeStream(episode.url, pageUrl) },
      ].filter((stream) => stream.url);
      return { streams, error: streams.length ? undefined : 'StudioMir не вернул доступный видеопоток.' };
    }
    if (pageUrl.hostname.endsWith('rutube.ru')) {
      const id = pageUrl.href.match(/rutube\.ru\/(?:video\/private\/|video\/|play\/embed\/|shorts\/)([a-f0-9]{32})/i)?.[1];
      const privateKey = pageUrl.searchParams.get('p');
      if (!id) return { error: 'Не удалось распознать ID видео Rutube.' };
      const apiUrl = new URL(`https://rutube.ru/api/play/options/${id}/?no_404=true&referer&pver=v2`);
      if (privateKey) apiUrl.searchParams.set('p', privateKey);
      const apiResponse = await fetch(apiUrl, { headers: { ...headers, Referer: 'https://rutube.ru/' }, signal: AbortSignal.timeout(20000) });
      if (!apiResponse.ok) return { error: `Rutube вернул HTTP ${apiResponse.status}.` };
      const options = await apiResponse.json();
      if (options.detail && options.detail.type === 'blocking_rule') return { error: 'Rutube ограничил это видео для вашего региона.' };
      const manifest = options.video_balancer?.m3u8 || options.videoBalancer?.m3u8;
      if (!manifest) return { error: 'Rutube не предоставил HLS-плейлист этого видео.' };
      const playlistUrl = safeStream(manifest, 'https://rutube.ru/');
      if (!playlistUrl) return { error: 'Rutube вернул некорректный URL плейлиста.' };
      const playlistResponse = await fetch(playlistUrl, { headers: { ...headers, Referer: 'https://rutube.ru/' }, signal: AbortSignal.timeout(20000) });
      if (!playlistResponse.ok) return { error: `Не удалось загрузить качества Rutube (HTTP ${playlistResponse.status}).` };
      const playlist = await playlistResponse.text();
      const lines = playlist.split(/\r?\n/), streams = [];
      for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const height = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
        const variant = lines.slice(i + 1).find((line) => line && !line.startsWith('#'));
        const url = variant && safeStream(variant, playlistUrl);
        if (!height || !url) continue;
        const edge = Math.max(Number(height[1]), Number(height[2]));
        const quality = edge >= 3840 ? '2160p' : edge >= 2560 ? '1440p' : edge >= 1920 ? '1080p' : edge >= 1280 ? '720p' : edge >= 854 ? '480p' : edge >= 640 ? '360p' : null;
        if (quality) streams.push({ quality, url });
      }
      return { streams: streams.length ? streams : [{ quality: 'Default', url: playlistUrl }] };
    }
    const response = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) return { error: `Источник вернул HTTP ${response.status}.` };
    const html = await response.text();
    if (pageUrl.hostname === 'ok.ru' || pageUrl.hostname === 'm.ok.ru') {
      const match = html.match(/data-options="([^"]+)"/i);
      if (!match) return { error: 'Не найдены параметры видео OK.ru.' };
      const jsonText = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\u0026/g, '&').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (!jsonText.includes('"provider":"UPLOADED_ODKL"') || jsonText.includes('"is_live":true')) return { error: 'Встроенный разбор доступен для загруженных записей OK.ru.' };
      const qualities = { low: '360p', sd: '480p', hd: '720p', full: '1080p', quad: '1440p', ultra: '2160p' };
      const streams = [...jsonText.matchAll(/"name":"(\w+)".*?"url":"(.*?)"/gs)].filter((video) => qualities[video[1]] && /^https?:\/\//i.test(video[2]) && !video[2].includes('disallowed')).map((video) => ({ quality: qualities[video[1]], url: video[2].replace(/\\u0026/g, '&').replace(/\\\//g, '/') }));
      return { streams: streams.length ? streams : [], error: streams.length ? undefined : 'OK.ru не вернул доступные варианты видео.' };
    }
    if (pageUrl.hostname.endsWith('myvi.top')) {
      const match = html.match(/CreatePlayer\("v=(.*?)\\u0026/i);
      const url = match && safeStream(decodeURIComponent(match[1].replace(/\\u0026/g, '&')), pageUrl);
      return url ? { streams: [{ quality: 'Default', url }] } : { error: 'Не удалось извлечь поток Myvi.' };
    }
    if (['secvideo1.online', 'csst.online', 'sstrge.online'].includes(pageUrl.hostname)) {
      const match = html.match(/file\s*:\s*["']([^"']+)["']/i);
      if (!match) return { error: 'Не удалось найти видео-ссылку на странице источника.' };
      const file = match[1].replace(/\\\//g, '/');
      const variants = [...file.matchAll(/\[(\d{3,4}p)\]([^,\s]+)/gi)];
      if (!variants.length) {
        const url = safeStream(file, pageUrl);
        return url ? { streams: [{ quality: 'Default', url }] } : { error: 'Источник вернул некорректный URL потока.' };
      }
      const streams = variants.map((m) => ({ quality: m[1], url: safeStream(m[2], pageUrl) })).filter((s) => s.url);
      return streams.length ? { streams } : { error: 'Ссылки вариантов качества некорректны.' };
    }
    const fileMatch = html.match(/["']file["']\s*:\s*["']([^"']+)["']/i);
    if (!fileMatch) return { error: 'Не удалось найти HLS-ссылку SovetRomantica.' };
    const playlistUrl = safeStream(fileMatch[1].replace(/\\\//g, '/'), pageUrl);
    if (!playlistUrl) return { error: 'SovetRomantica вернул некорректный URL.' };
    const playlistResponse = await fetch(playlistUrl, { headers: { ...headers, Referer: pageUrl.href }, signal: AbortSignal.timeout(20000) });
    if (!playlistResponse.ok) return { error: `Не удалось загрузить список качества (HTTP ${playlistResponse.status}).` };
    const playlist = await playlistResponse.text();
    const streams = [];
    const lines = playlist.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const height = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
      const variant = lines.slice(i + 1).find((line) => line && !line.startsWith('#'));
      const url = variant && safeStream(variant, playlistUrl);
      if (height && url) streams.push({ quality: `${height[1]}p`, url });
    }
    return { streams: streams.length ? streams : [{ quality: 'Default', url: playlistUrl }] };
  } catch (error) {
    return { error: `Ошибка разбора источника: ${String(error && error.message || error)}` };
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  // — Каталог / поиск / релиз —
  ipcMain.handle('api:filter', (_e, { page, filter }) =>
    apiRequest(`/filter/${page}`, { method: 'POST', body: filter || {} }));
  ipcMain.handle('api:search', (_e, { page, query }) =>
    apiRequest(`/search/releases/${page}`, { method: 'POST', body: { query, searchBy: 0 } }));
  ipcMain.handle('api:release', (_e, { id }) => apiRequest(`/release/${id}`));
  ipcMain.handle('api:randomRelease', () => apiRequest(`/release/random`));

  // — Серии —
  ipcMain.handle('player:resolve', async (_e, { url }) => {
    let host = ''; try { host = new URL(url).hostname; } catch {}
    if (host === 'video.sibnet.ru') return resolveSibnetStream(url);
    return resolveAdditionalStream(url);
  });
  ipcMain.handle('player:selectSubtitle', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите файл субтитров',
      properties: ['openFile'],
      filters: [{ name: 'Субтитры', extensions: ['srt', 'vtt'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return null;
    try {
      const filePath = result.filePaths[0];
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { error: 'Файл субтитров должен быть меньше 10 МБ.' };
      const extension = path.extname(filePath).toLowerCase();
      if (!['.srt', '.vtt'].includes(extension)) return { error: 'Поддерживаются только файлы SRT и WebVTT.' };
      return { name: path.basename(filePath), format: extension.slice(1), text: fs.readFileSync(filePath, 'utf8') };
    } catch (error) {
      return { error: `Не удалось прочитать файл субтитров: ${String(error && error.message || error)}` };
    }
  });
  ipcMain.handle('api:episodeTypes', (_e, { id }) => apiRequest(`/episode/${id}`));
  ipcMain.handle('api:episodeSources', (_e, { id, typeId }) => apiRequest(`/episode/${id}/${typeId}`));
  ipcMain.handle('api:episodes', (_e, { id, typeId, sourceId }) =>
    apiRequest(`/episode/${id}/${typeId}/${sourceId}`));

  // — Аккаунт —
  ipcMain.handle('auth:signIn', async (_e, { login, password }) => {
    const res = await apiRequest(`/auth/signIn`, { method: 'POST', form: { login, password }, auth: false });
    if (res && res.code === 0 && res.profileToken) {
      const tok = res.profileToken.token || res.profileToken;
      store.settings.token = tok;
      store.profile = res.profile || null;
      saveStore();
    }
    return res;
  });
  ipcMain.handle('auth:logout', () => {
    store.settings.token = '';
    store.profile = null;
    saveStore();
    return true;
  });
  ipcMain.handle('auth:me', () => ({ token: token(), profile: store.profile }));
  ipcMain.handle('api:profile', (_e, { id }) => apiRequest(`/profile/${id}`));

  // — Синхронизация (требуют токен). ВАЖНО: эти мутации в AniXart — GET, не POST! —
  ipcMain.handle('api:favoriteAdd', (_e, { id }) => apiRequest(`/favorite/add/${id}`));
  ipcMain.handle('api:favoriteDelete', (_e, { id }) => apiRequest(`/favorite/delete/${id}`));
  ipcMain.handle('api:favoritesList', (_e, { page }) => apiRequest(`/favorite/all/${page}`));
  ipcMain.handle('api:historyList', (_e, { page }) => apiRequest(`/history/${page}`));
  ipcMain.handle('api:historyAdd', (_e, { rId, sId, position }) =>
    apiRequest(`/history/add/${rId}/${sId}/${position || 0}`));
  ipcMain.handle('api:historyDelete', (_e, { id }) => apiRequest(`/history/delete/${id}`));
  // Отметить серию просмотренной / снять отметку
  ipcMain.handle('api:episodeWatch', (_e, { rId, sId, position }) =>
    apiRequest(`/episode/watch/${rId}/${sId}${position != null ? '/' + position : ''}`));
  ipcMain.handle('api:episodeUnwatch', (_e, { rId, sId, position }) =>
    apiRequest(`/episode/unwatch/${rId}/${sId}${position != null ? '/' + position : ''}`));

  // — Списки профиля (Смотрю / В планах / Просмотрено / Отложено / Брошено) —
  ipcMain.handle('api:profileList', (_e, { status, page }) =>
    apiRequest(`/profile/list/all/${status}/${page}`));
  ipcMain.handle('api:profileListAdd', (_e, { status, id }) =>
    apiRequest(`/profile/list/add/${status}/${id}`));
  ipcMain.handle('api:profileListDelete', (_e, { status, id }) =>
    apiRequest(`/profile/list/delete/${status}/${id}`));

  // — Обзор —
  ipcMain.handle('api:discoverInteresting', () => apiRequest(`/discover/interesting`));
  ipcMain.handle('api:discoverWatching', (_e, { page }) => apiRequest(`/discover/watching/${page}`));

  // — Оценка релиза —
  ipcMain.handle('api:voteAdd', (_e, { id, vote }) => apiRequest(`/release/vote/add/${id}/${vote}`));
  ipcMain.handle('api:voteDelete', (_e, { id }) => apiRequest(`/release/vote/delete/${id}`));

  // — Коллекции (избранные пользователем) —
  ipcMain.handle('api:collectionFavorites', (_e, { page }) => apiRequest(`/collectionFavorite/all/${page}`));
  ipcMain.handle('api:collectionReleases', (_e, { id, page }) => apiRequest(`/collection/${id}/releases/${page}`));

  // — Комментарии к релизу —
  ipcMain.handle('api:comments', (_e, { id, page }) =>
    apiRequest(`/release/comment/all/${id}/${page}`));

  // — Действия с комментариями —
  ipcMain.handle('api:commentVote', (_e, { id, vote }) => apiRequest(`/release/comment/vote/${id}/${vote}`));
  ipcMain.handle('api:commentAdd', (_e, { releaseId, message, spoiler, parentId }) =>
    apiRequest(`/release/comment/add/${releaseId}`, { method: 'POST', body: { message, spoiler: !!spoiler, parentCommentId: parentId || null } }));
  ipcMain.handle('api:commentReplies', (_e, { id, page }) => apiRequest(`/release/comment/replies/${id}/${page}`));
  ipcMain.handle('api:searchProfiles', (_e, { page, query }) => apiRequest(`/search/profiles/${page}`, { method: 'POST', body: { query } }));

  // — Друзья —
  ipcMain.handle('api:friends', (_e, { id, page }) => apiRequest(`/profile/friend/all/${id}/${page}`));
  ipcMain.handle('api:friendRecs', () => apiRequest(`/profile/friend/recommendations`));
  ipcMain.handle('api:friendRequestsIn', (_e, { page }) => apiRequest(`/profile/friend/requests/in/${page}`));
  ipcMain.handle('api:friendRequestsOut', (_e, { page }) => apiRequest(`/profile/friend/requests/out/${page}`));
  ipcMain.handle('api:friendRequestSend', (_e, { id }) => apiRequest(`/profile/friend/request/send/${id}`));
  ipcMain.handle('api:friendRequestRemove', (_e, { id }) => apiRequest(`/profile/friend/request/remove/${id}`));
  ipcMain.handle('api:friendRequestHide', (_e, { id }) => apiRequest(`/profile/friend/request/hide/${id}`));
  ipcMain.handle('api:friendDelete', (_e, { id }) => apiRequest(`/friend/delete/${id}`));
  ipcMain.handle('api:blockList', (_e, { page }) => apiRequest(`/blocklist/all/${page}`));
  ipcMain.handle('api:blockAdd', (_e, { id }) => apiRequest(`/blocklist/add/${id}`));
  ipcMain.handle('api:blockRemove', (_e, { id }) => apiRequest(`/blocklist/remove/${id}`));
  ipcMain.handle('api:notifications', (_e, { page }) => apiRequest(`/notification/all/${page}`));
  ipcMain.handle('api:notificationCategory', (_e, { category, page }) => {
    const allowed = new Set(['articles', 'episodes', 'friends', 'releaseComments', 'article/comments', 'related/release', 'release/all']);
    return allowed.has(category) ? apiRequest(`/notification/${category}/${page}`) : { code: -1, _error: 'Unsupported notification category' };
  });
  ipcMain.handle('api:notificationRead', () => apiRequest(`/notification/read`));
  ipcMain.handle('api:releaseNotifications', (_e, { page }) => apiRequest(`/notification/release/all/${page}`));
  ipcMain.handle('api:latest', (_e, { page }) => apiRequest(`/latest/all/${page}`));
  ipcMain.handle('api:releaseUpdates', (_e, { id, page }) => apiRequest(`/updates/${id}/${page}`));
  ipcMain.handle('api:videoReleaseInfo', (_e, { id }) => apiRequest(`/video/release/${id}`));
  ipcMain.handle('api:videoRelease', (_e, { id, page }) => apiRequest(`/video/release/${id}/${page}`));
  ipcMain.handle('api:videoReleaseCategory', (_e, { id, categoryId, page }) => apiRequest(`/video/release/${id}/category/${categoryId}/${page}`));
  ipcMain.handle('api:videoCategories', () => apiRequest(`/video/release/categories`));
  ipcMain.handle('api:randomFromList', (_e, { pid, status }) => apiRequest(`/release/random/profile/list/${pid}/${status}`));

  // — Настройки аккаунта —
  ipcMain.handle('api:prefMy', () => apiRequest(`/profile/preference/my`));
  ipcMain.handle('api:socialEdit', (_e, b) => apiRequest(`/profile/preference/social/edit`, { method: 'POST', body: b }));
  ipcMain.handle('api:privacyEdit', (_e, { kind, value }) => apiRequest(`/profile/preference/privacy/${kind}/edit`, { method: 'POST', body: { value } }));
  ipcMain.handle('api:loginChange', (_e, { login }) => apiRequest(`/profile/preference/login/change`, { method: 'POST', body: { login } }));
  ipcMain.handle('api:passwordChange', (_e, { oldPassword, newPassword }) => apiRequest(`/profile/preference/password/change`, { method: 'POST', body: { old_password: oldPassword, new_password: newPassword } }));

  // — Редактирование статуса профиля —
  ipcMain.handle('api:statusEdit', (_e, { status }) =>
    apiRequest(`/profile/preference/status/edit`, { method: 'POST', body: { status } }));

  // — Лента / каналы —
  ipcMain.handle('api:channelSubs', (_e, { page }) => apiRequest(`/channel/subscription/all/${page}`));
  ipcMain.handle('api:channelRecs', (_e, { page }) => apiRequest(`/channel/recommendations/${page}`));
  ipcMain.handle('api:channel', (_e, { id }) => apiRequest(`/channel/${id}`));
  ipcMain.handle('api:channelArticles', (_e, { id, page }) => apiRequest(`/channel/${id}/article/all/${page}`));
  ipcMain.handle('api:channelSubscribers', (_e, { id, page }) => apiRequest(`/channel/${id}/subscribers/${page}`));
  ipcMain.handle('api:channelSubscribe', (_e, { id, on }) => apiRequest(`/channel/${on ? 'subscribe' : 'unsubscribe'}/${id}`));
  ipcMain.handle('api:feed', (_e, { page }) => apiRequest(`/article/all/${page}`, { method: 'POST', body: {} }));

  // — Комментарии статей —
  ipcMain.handle('api:articleComments', (_e, { id, page }) => apiRequest(`/article/comment/all/${id}/${page}`));
  ipcMain.handle('api:articleReposts', (_e, { id, page }) => apiRequest(`/article/reposts/${id}/${page}`));
  // — Ред./удаление своих комментариев релиза —
  ipcMain.handle('api:commentEdit', (_e, { id, message, spoiler }) => apiRequest(`/release/comment/edit/${id}`, { method: 'POST', body: { message, spoiler: !!spoiler } }));
  ipcMain.handle('api:commentDelete', (_e, { id }) => apiRequest(`/release/comment/delete/${id}`));

  // — Комментарии статей: постинг —
  ipcMain.handle('api:articleCommentAdd', (_e, { articleId, message }) => apiRequest(`/article/comment/add/${articleId}`, { method: 'POST', body: { message } }));
  // — Стена профиля (блог) —
  ipcMain.handle('api:blogGet', (_e, { pid }) => apiRequest(`/channel/blog/${pid}`));
  ipcMain.handle('api:blogCreate', () => apiRequest(`/channel/blog/create`, { method: 'POST', body: {} }));
  ipcMain.handle('api:articleCreate', (_e, { cid, text }) => apiRequest(`/article/create/${cid}`, { method: 'POST', body: { payload: { time: Date.now(), blocks: [{ type: 'paragraph', data: { text } }], version: '2.28.2' }, repost_article_id: null } }));

  // — Смена почты —
  ipcMain.handle('api:emailChange', (_e, { email, password }) => apiRequest(`/profile/preference/email/change`, { method: 'POST', body: { email, password } }));

  // — Смена аватара (файловый диалог + multipart) —
  ipcMain.handle('api:avatarUpload', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Выберите аватар', properties: ['openFile'], filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
    try {
      const fp = r.filePaths[0];
      const buf = fs.readFileSync(fp);
      const ext = path.extname(fp).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const fd = new FormData();
      fd.append('avatar', new Blob([buf], { type: mime }), 'avatar' + ext);
      const res = await fetch(API_BASE + '/profile/preference/avatar/edit?token=' + encodeURIComponent(token()), { method: 'POST', headers: { 'User-Agent': USER_AGENT }, body: fd });
      const txt = await res.text(); try { return JSON.parse(txt); } catch { return { code: -1, _raw: txt.slice(0, 200) }; }
    } catch (e) { return { code: -1, _error: String(e && e.message || e) }; }
  });

  // — Управление окном (безрамочное) —
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('win:minimize', (e) => { const w = winOf(e); if (w) w.minimize(); });
  ipcMain.handle('win:maximize', (e) => { const w = winOf(e); if (!w) return; if (w.isMaximized()) w.unmaximize(); else w.maximize(); });
  ipcMain.handle('win:close', (e) => { const w = winOf(e); if (w) w.close(); });
  ipcMain.handle('win:isMaximized', (e) => { const w = winOf(e); return w ? w.isMaximized() : false; });
  ipcMain.handle('win:setFullScreen', (e, { flag }) => { const w = winOf(e); if (w) w.setFullScreen(!!flag); });

  // — Открыть ссылку во внешнем браузере —
  ipcMain.handle('app:openExternal', (_e, { url }) => { if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) shell.openExternal(url); });

  // — Локальное хранилище (избранное/история без входа) —
  ipcMain.handle('store:get', () => store);
  ipcMain.handle('store:set', (_e, next) => { store = Object.assign(store, next); saveStore(); return true; });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 940, minHeight: 600,
    backgroundColor: '#0e0f13', title: 'Kyu',
    icon: path.join(__dirname, 'src', 'icon.png'),
    frame: false, // безрамочное окно — свои кнопки управления
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      webviewTag: true, // нужен для встроенного плеера
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Сообщаем рендереру о смене maximize/fullscreen (для иконки кнопки)
  const sendState = () => win.webContents.send('win:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
  win.on('maximize', sendState); win.on('unmaximize', sendState);
  win.on('enter-full-screen', sendState); win.on('leave-full-screen', sendState);
}

// Рекламные сети (preroll/VAST в плеерах kodik/sibnet и т.п.)
const AD_HOSTS = [
  'yandex.ru', 'yandex.net', 'yandex.com', 'yastatic.net', 'webvisor.org', 'yandexadexchange.net', 'yandexadexchange.com',
  'an.yandex.ru', 'yabs.yandex', 'bs.yandex', 'awaps.yandex', 'adfox.ru', 'ads.adfox.ru', 'adfox.net',
  'adriver.ru', 'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'imasdk.googleapis.com', 'pagead2.googlesyndication.com', 'ad.mail.ru', 'rs.mail.ru',
  'top-fwz1.mail.ru', 'mradar.mail.ru', 'mc.yandex.ru', 'mc.admetrica.ru', 'ads.adfox',
  'smi2.ru', 'smi2.net', 'mgid.com', 'marketgid.com', 'buzzoola.com', 'betweendigital.com',
  'getshop.tv', 'otm-r.com', 'sape.ru', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'moatads.com', 'adsafeprotected.com', 'relap.io', 'hybrid.ai',
  'adloox.com', 'luckyads', 'adspire', 'vidoomy', 'aniview.com', 'springserve.com',
  'rtb.com', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'innovid.com',
  'serving-sys.ru', 'bs.serving-sys.ru', 'ad.mail.ru', 'adsrvr.org', 'adform.net',
];
const AD_URL_MARKERS = /(?:^|[/?&=._-])(?:ad|ads|vast|vpaid|preroll|pre-roll|instream|adfox|adserver|adservice|adsystem|yandexad|doubleclick|adnxs|advert|advertising|commercial|sponsor|impression)(?:$|[/?&=._-])/i;
const AD_HOST_LABEL = /(?:^|[.-])(?:ads?|adserver|adfox|advert|advertising|vast|vpaid|prebid|tracker|tracking|impression)(?:[.-]|$)/i;
function isAdUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (AD_HOSTS.some((d) => host === d || host.endsWith('.' + d))) return true;
  if (AD_HOST_LABEL.test(host)) return true;
  return AD_URL_MARKERS.test(parsed.pathname + parsed.search);
}

app.whenReady().then(() => {
  loadStore();

  // Адблокер: режем запросы к рекламным сетям (можно отключить в Настройках)
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    if (store.settings && store.settings.adblock === false) return cb({});
    if (isAdUrl(details.url)) return cb({ cancel: true });
    cb({});
  });

  // Встроенный плеер.
  // Kodik проверяет реферер при встраивании — подменяем на разрешённый домен AniXart.
  // Sibnet, наоборот, требует СВОЙ реферер (хотлинк-защита видеофайла) —
  // его НЕ трогаем, чтобы плеер использовал естественный реферер video.sibnet.ru.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    let requestHost = ''; try { requestHost = new URL(details.url).host; } catch {}
    if (providerCookies.has(requestHost)) h['Cookie'] = providerCookies.get(requestHost);
    if (/sibnet/i.test(details.url)) {
      h['Referer'] = 'https://video.sibnet.ru/';
    } else if (/rutube\.ru/i.test(details.url)) {
      h['Referer'] = 'https://rutube.ru/';
    } else if (/ok\.ru/i.test(details.url)) {
      h['Referer'] = 'https://ok.ru/';
    } else if (/kodik|anixmirai|aniqit/i.test(details.url)) {
      h['Referer'] = 'https://anixart-app.com/';
      h['Origin'] = 'https://anixart-app.com';
    }
    cb({ requestHeaders: h });
  });

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
