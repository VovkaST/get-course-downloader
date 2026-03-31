/**
 * Background Service Worker
 * Использует chrome.webRequest для перехвата URL мастер-плейлистов.
 * Хранит данные в chrome.storage.session (переживает перезапуск воркера).
 * Поддерживает отмену загрузки и ретрай при обрыве связи.
 * Параллельная загрузка чанков (пул из CONCURRENCY воркеров).
 */

// --- Настройки ---
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;

// --- Модульные переменные (живут пока воркер активен) ---
let currentAbortController = null;
let cancelRequested = false;
let videoTitlesCache = {}; // Кэш названий во время работы service worker
let masterUrlsCache = {};  // Кэш ссылок на мастер-плейлисты { tabId: [{url, body}] }
let currentStorageId = null; // ID текущей загрузки в IDB (для очистки при отмене)
let currentChunkCount = 0;   // Количество записанных чанков (для очистки при отмене)

// Инициализация кэшей из хранилища
chrome.storage.session.get(['videoTitles', 'masterUrls']).then(res => {
  if (res.videoTitles) videoTitlesCache = res.videoTitles;
  if (res.masterUrls) masterUrlsCache = res.masterUrls;
});

// --- Утилиты UI ---
function updateBadge(tabId) {
  const count = masterUrlsCache[tabId] ? masterUrlsCache[tabId].length : 0;
  const text = count > 0 ? count.toString() : '';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#00a8e8' }); // GetCourse Blue
}

// --- Работа с IndexedDB (кэшированное соединение) ---
let dbInstance = null;

function getDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('GC_DOWNLOADER_DB', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks');
      }
    };
    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      // Сбрасываем кэш при закрытии БД (например, при versionchange)
      dbInstance.onclose = () => { dbInstance = null; };
      resolve(dbInstance);
    };
    request.onerror = () => reject(request.error);
  });
}

async function saveToDB(id, data, index = null) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const storageKey = index !== null ? `${id}_chunk_${index}` : id;
    const putReq = store.put(data, storageKey);
    putReq.onsuccess = () => resolve();
    putReq.onerror = () => reject(putReq.error);
  });
}

async function clearChunksFromDB(storageId, count) {
  if (!storageId || count <= 0) return;
  try {
    const db = await getDB();
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    for (let i = 0; i < count; i++) {
      store.delete(`${storageId}_chunk_${i}`);
    }
    console.log(`[GC Downloader] Удалено ${count} чанков из IDB (storageId=${storageId})`);
  } catch (err) {
    console.warn('[GC Downloader] Ошибка очистки IDB:', err);
  }
}

// --- Утилиты для Offscreen Document ---
async function downloadWithOffscreen(storageId, fileName, totalChunks) {
  // Проверяем, существует ли уже документ
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Сборка скачанного видео из фрагментов через Blob API'
    });
  }

  // Отправляем и ждём ответа от Offscreen
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'START_DOWNLOAD_OFFSCREEN',
      target: 'offscreen',
      storageId,
      fileName,
      totalChunks
    }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.ok) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Offscreen: неизвестная ошибка'));
      }
    });
  });
}

// ==========================================================
//  Хранилище на основе chrome.storage.session
// ==========================================================

async function getMasterUrls() {
  const result = await chrome.storage.session.get('masterUrls');
  return result.masterUrls || {};
}

// --- Работа с хранилищем (MV3 session storage) ---
async function saveMasterUrls(urlsMap) {
  await chrome.storage.session.set({ masterUrls: urlsMap });
}

async function getDownloadState() {
  const result = await chrome.storage.session.get('downloadState');
  return result.downloadState || null;
}

async function saveDownloadState(state) {
  await chrome.storage.session.set({ downloadState: state });
}

async function clearDownloadState() {
  await chrome.storage.session.remove('downloadState');
}

async function saveVideoTitles(titles) {
  videoTitlesCache = titles;
  await chrome.storage.session.set({ videoTitles: titles });
}

// ==========================================================
//  Перехват запросов через webRequest API
// ==========================================================

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const { tabId, url } = details;
    if (tabId < 0) return;
    
    if (url.includes('/master/')) {
      if (!masterUrlsCache[tabId]) masterUrlsCache[tabId] = [];
      const existing = masterUrlsCache[tabId].find(item => item.url === url);
      if (existing) return;

      masterUrlsCache[tabId].push({ url, body: null });
      saveMasterUrls(masterUrlsCache);
      updateBadge(tabId);
    }
  },
  {
    urls: [
      "*://*/*/master/*",
      "*://*/master/*"
    ]
  }
);

// Очистка при закрытии вкладки или навигации
function clearTabData(tabId) {
  if (masterUrlsCache[tabId]) {
    delete masterUrlsCache[tabId];
    saveMasterUrls(masterUrlsCache);
    updateBadge(tabId); // Сбрасываем счетчик
    console.log(`[GC Downloader] Данные вкладки ${tabId} очищены.`);
  }
}

chrome.tabs.onRemoved.addListener(clearTabData);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearTabData(tabId);
  }
});

// ==========================================================
//  Обработка сообщений от popup
// ==========================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  const tabId = message.tabId || (sender.tab ? sender.tab.id : null);

  // --- Быстрый счётчик обнаруженных URL ---
  if (message.type === 'GET_MASTER_COUNT') {
    if (!tabId) return sendResponse({ count: 0 });
    const urls = masterUrlsCache[tabId] || [];
    console.log(`[GC Downloader] Попап запросил счетчик для вкладки ${tabId}. Найдено: ${urls.length}`);
    sendResponse({ count: urls.length });
    return true;
  }

  // --- Загрузка содержимого плейлистов (Отказоустойчивая версия) ---
  if (message.type === 'GET_PLAYLISTS') {
    if (!tabId) return sendResponse({ playlists: [] });
    const items = masterUrlsCache[tabId] || [];
    
    (async () => {
      try {
        const results = await Promise.allSettled(
          items.map(async (item) => {
            if (item.body) return { url: item.url, body: item.body };
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 3000);
              const response = await fetch(item.url, { signal: controller.signal });
              clearTimeout(timeout);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const body = await response.text();
              item.body = body;
              saveMasterUrls(masterUrlsCache);
              return { url: item.url, body };
            } catch (err) {
              return null;
            }
          })
        );
        const playlists = results
          .filter(r => r.status === 'fulfilled' && r.value !== null)
          .map(r => r.value);
        sendResponse({ playlists });
      } catch (e) {
        sendResponse({ playlists: [], error: e.message });
      }
    })();
    return true;
  }

  // --- Сообщение от инжектора: перехвачен плейлист с телом ---
  if (message.type === 'GC_MASTER_PLAYLIST') {
    const { url, body } = message;
    if (!tabId || !url || !body) return true;

    if (!masterUrlsCache[tabId]) masterUrlsCache[tabId] = [];

    const existing = masterUrlsCache[tabId].find(item => item.url === url);
    if (existing) {
      if (!existing.body) {
        existing.body = body;
        saveMasterUrls(masterUrlsCache);
        console.log(`[GC Downloader] Обновлено тело для: ${url.substring(0, 60)}...`);
      }
    } else {
      masterUrlsCache[tabId].push({ url, body });
      saveMasterUrls(masterUrlsCache);
      console.log(`[GC Downloader] СОХРАНЕН новый плейлист для вкладки ${tabId}: ${url.substring(0, 60)}...`);
      updateBadge(tabId);
      chrome.runtime.sendMessage({ type: 'MASTER_URL_FOUND', tabId, url }).catch(() => {});
    }
    return true;
  }

  // --- Текущее состояние загрузки ---
  if (message.type === 'GET_DOWNLOAD_STATE') {
    getDownloadState().then((state) => {
      sendResponse({ state });
    });
    return true;
  }

  // --- Получить накопленные названия видео ---
  if (message.type === 'GET_VIDEO_TITLES') {
    sendResponse({ titles: videoTitlesCache });
    return true;
  }

  // --- Сообщение от контент-скрипта: найдено название видео ---
  if (message.type === 'VIDEO_TITLE_FOUND') {
    const { hash, title } = message;
    if (hash && title && videoTitlesCache[hash] !== title) {
      console.log(`[GC Downloader] Новое название: hash=${hash}, title="${title}"`);
      videoTitlesCache[hash] = title;
      saveVideoTitles(videoTitlesCache); // Сохраняем в фоне
      // Уведомляем открытый попап, если он виден
      chrome.runtime.sendMessage({ type: 'VIDEO_TITLE_UPDATED', hash, title }).catch(() => { });
    }
    sendResponse({ ok: true });
    return true;
  }

  // --- Запуск загрузки видео ---
  if (message.type === 'DOWNLOAD_VIDEO') {
    cancelRequested = false;
    handleDownload(message)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // --- Отмена загрузки ---
  if (message.type === 'CANCEL_DOWNLOAD') {
    console.log('[GC Downloader] Получен запрос на отмену загрузки');
    cancelRequested = true;

    if (currentAbortController) {
      currentAbortController.abort();
    }

    // Чистим чанки из IDB, если были записаны
    const sid = currentStorageId;
    const cnt = currentChunkCount;
    currentStorageId = null;
    currentChunkCount = 0;

    clearDownloadState().then(async () => {
      if (sid && cnt > 0) {
        await clearChunksFromDB(sid, cnt);
      }
      broadcastProgress({ status: 'cancelled', fileName: '' });
      sendResponse({ success: true });
    });
    return true;
  }

  // --- Сброс состояния (после показа done/error) ---
  if (message.type === 'CLEAR_DOWNLOAD_STATE') {
    clearDownloadState().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  // --- Сообщение от Offscreen: Blob URL готов к скачиванию ---
  if (message.type === 'OFFSCREEN_BLOB_READY') {
    const { url, fileName } = message;
    console.log('[GC Downloader] Получен Blob URL от Offscreen, запускаю скачивание:', fileName);

    chrome.downloads.download({
      url: url,
      filename: fileName,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[GC Downloader] Ошибка при старте скачивания Blob:', chrome.runtime.lastError);
      } else {
        console.log('[GC Downloader] Скачивание успешно запущено:', downloadId);
      }
    });
    return true;
  }
});

// ==========================================================
//  Параллельная загрузка: настройки
// ==========================================================

const CONCURRENCY = 15; // Количество параллельных потоков

// ==========================================================
//  Загрузка одного чанка с ретраями
// ==========================================================

async function fetchChunkWithRetry(url, signal, chunkIndex, totalChunks, fileName, completedCount) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    if (cancelRequested) {
      throw new DOMException('Загрузка отменена пользователем', 'AbortError');
    }

    console.log(`[GC Downloader] >>> Попытка ${attempt}/${RETRY_MAX_ATTEMPTS} для чанка ${chunkIndex + 1}...`);

    try {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (err) {
      if (err.name === 'AbortError' || cancelRequested) {
        throw new DOMException('Загрузка отменена пользователем', 'AbortError');
      }

      lastError = err;
      console.warn(`[GC Downloader] !!! ОШИБКА [${err.name}] чанка ${chunkIndex + 1} (Попытка ${attempt}/${RETRY_MAX_ATTEMPTS}):`, err.message);
      
      // Уведомляем попап о ретрае (синхронно с именами в popup.js)
      broadcastProgress({
        status: 'retrying',
        retryChunk: chunkIndex + 1,
        retryAttempt: attempt,
        retryMaxAttempts: RETRY_MAX_ATTEMPTS,
        retryDelaySec: Math.pow(2, attempt - 1),
        downloaded: completedCount, 
        total: totalChunks,
        fileName
      });

      console.log(`[GC Downloader] Ожидание перед повтором ${RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)}мс...`);

      if (attempt < RETRY_MAX_ATTEMPTS) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);

        // Ждём с проверкой отмены каждые 500мс
        const waitEnd = Date.now() + delay;
        while (Date.now() < waitEnd) {
          if (cancelRequested) {
            throw new DOMException('Загрузка отменена пользователем', 'AbortError');
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(500, waitEnd - Date.now())));
        }
      }
    }
  }

  throw new Error(`Чанк ${chunkIndex + 1}/${totalChunks}: все ${RETRY_MAX_ATTEMPTS} попыток исчерпаны. ${lastError?.message}`);
}

// ==========================================================
//  Пул воркеров для параллельной загрузки
// ==========================================================

/**
 * Запускает CONCURRENCY воркеров, каждый из которых берёт
 * следующий чанк из общей очереди, скачивает и кладёт результат
 * по индексу в массив results.
 */
async function downloadChunksParallel(storageId, chunkUrls, signal, fileName) {
  const totalChunks = chunkUrls.length;
  let nextIndex = 0;           // Следующий чанк для взятия из очереди
  let completedCount = 0;      // Завершённых чанков
  let totalSize = 0;           // Суммарный размер в байтах (оценочно)
  let firstError = null;       // Первая ошибка (если есть)

  /**
   * Один воркер: берёт чанки из очереди пока есть работа.
   */
  async function worker() {
    while (true) {
      // Берём следующий индекс атомарно
      const idx = nextIndex++;
      if (idx >= totalChunks) return; // Работа закончилась

      if (cancelRequested || firstError) return;

      try {
        const buffer = await fetchChunkWithRetry(
          chunkUrls[idx], signal, idx, totalChunks, fileName, completedCount
        );

        // СРАЗУ СОХРАНЯЕМ В БД И ВЫГРУЖАЕМ ИЗ RAM
        await saveToDB(storageId, buffer, idx);
        
        completedCount++;
        currentChunkCount = completedCount; // Для очистки при отмене
        totalSize += buffer.byteLength;

        // Отправляем прогресс
        const progressState = {
          status: 'downloading',
          downloaded: completedCount,
          total: totalChunks,
          fileName,
          sizeBytes: totalSize
        };
        broadcastProgress(progressState);

        // Сохраняем состояние каждые 20 завершённых чанков (неблокирующе)
        if (completedCount % 20 === 0 || completedCount === totalChunks) {
          saveDownloadState(progressState).catch(err => console.error('[GC] Ошибка автосохранения:', err));
        }

      } catch (err) {
        if (!firstError) {
          firstError = err;
        }
        return; // Воркер останавливается при ошибке
      }
    }
  }

  // Запускаем пул воркеров
  const workerCount = Math.min(CONCURRENCY, totalChunks);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }

  // Ждём завершения всех воркеров
  await Promise.all(workers);

  // Если была ошибка — пробрасываем
  if (firstError) {
    throw firstError;
  }

  return { totalSize };
}

// ==========================================================
//  Основная функция загрузки
// ==========================================================

async function handleDownload({ fileName, streamUrl }) {
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;
  cancelRequested = false;

  try {
    // Инициализируем состояние
    const initialState = {
      status: 'starting',
      downloaded: 0,
      total: 0,
      fileName,
      sizeBytes: 0,
    };
    await saveDownloadState(initialState);
    broadcastProgress(initialState);

    // 1. Получить плейлист с чанками
    const response = await fetch(streamUrl, { signal });
    if (!response.ok) {
      throw new Error(`Ошибка загрузки плейлиста чанков: ${response.status}`);
    }
    const playlistText = await response.text();

    // 2. Парсинг URL чанков
    const chunkUrls = playlistText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('https://'));

    if (chunkUrls.length === 0) {
      throw new Error('Не найдено ни одного чанка в плейлисте');
    }

    const totalChunks = chunkUrls.length;
    console.log(`[GC Downloader] Найдено ${totalChunks} чанков, запуск ${Math.min(CONCURRENCY, totalChunks)} параллельных потоков`);

    const dlState = {
      status: 'downloading',
      downloaded: 0,
      total: totalChunks,
      fileName,
      sizeBytes: 0
    };
    await saveDownloadState(dlState);
    broadcastProgress(dlState);

    // 3. Параллельная загрузка чанков (с поблочной записью в БД)
    const storageId = `video_${Date.now()}`;
    currentStorageId = storageId;
    currentChunkCount = 0;

    const { totalSize } = await downloadChunksParallel(
      storageId, chunkUrls, signal, fileName
    );

    // 4. Переход к этапу сборки (теперь через Offscreen, поблочно)
    const mergeState = {
      status: 'merging',
      downloaded: totalChunks,
      total: totalChunks,
      fileName,
      sizeBytes: totalSize
    };
    await saveDownloadState(mergeState);
    broadcastProgress(mergeState);

    console.log(`[GC Downloader] Все чанки в IDB, вызываем Offscreen для сборки...`);
    await downloadWithOffscreen(storageId, fileName, totalChunks);
    // ↑ теперь ждём ответа — done/error выставляем только после

    console.log(`[GC Downloader] Сборка завершена Offscreen, файл готов к скачиванию`);
    currentStorageId = null;
    currentChunkCount = 0;

    const doneState = {
      status: 'done',
      downloaded: totalChunks,
      total: totalChunks,
      fileName,
      sizeBytes: totalSize
    };
    await saveDownloadState(doneState);
    broadcastProgress(doneState);

    return { success: true };

  } catch (err) {
    if (err.name === 'AbortError' || cancelRequested) {
      console.log('[GC Downloader] Загрузка отменена');
      await clearDownloadState();
      currentAbortController = null;
      cancelRequested = false;
      return { cancelled: true };
    }

    const errorState = {
      status: 'error',
      error: err.message,
      fileName
    };
    await saveDownloadState(errorState);
    broadcastProgress(errorState);
    throw err;

  } finally {
    currentAbortController = null;
  }
}

// ==========================================================
//  Рассылка прогресса
// ==========================================================

function broadcastProgress(data) {
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    concurrency: CONCURRENCY,
    ...data
  }).catch(() => {
    // Popup может быть закрыт — игнорируем
  });
}
