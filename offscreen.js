/**
 * Offscreen JS (Full DOM World)
 * Собирает видео из чанков в IndexedDB, создаёт Blob и передаёт URL обратно.
 */

(function () {
  'use strict';

  // --- Кэшированное соединение с IndexedDB ---
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
        dbInstance.onclose = () => { dbInstance = null; };
        resolve(dbInstance);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getChunkFromDB(storageId, index) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const key = `${storageId}_chunk_${index}`;
      const getReq = store.get(key);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function clearChunksFromDB(storageId, totalChunks) {
    try {
      const db = await getDB();
      const tx = db.transaction('chunks', 'readwrite');
      const store = tx.objectStore('chunks');
      for (let i = 0; i < totalChunks; i++) {
        store.delete(`${storageId}_chunk_${i}`);
      }
    } catch (err) {
      console.warn('[GC Offscreen] Ошибка очистки IDB:', err);
    }
  }

  // Слушатель сообщений от background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== 'offscreen') return;

    if (message.type === 'START_DOWNLOAD_OFFSCREEN') {
      handleDownload(message).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: err.message })
      );
      return true; 
    }
  });

  async function handleDownload(message) {
    const { storageId, fileName, totalChunks } = message;
    console.log(`[GC Offscreen] Начало сборки: ${fileName} (${totalChunks} чанков)`);

    // Батчевая сборка Blob — не держим все чанки в RAM одновременно
    const BATCH_SIZE = 200;
    const partBlobs = [];

    for (let start = 0; start < totalChunks; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, totalChunks);
      const batch = [];

      for (let i = start; i < end; i++) {
        const buffer = await getChunkFromDB(storageId, i);
        if (!buffer) {
          throw new Error(`Чанк ${i} не найден в IndexedDB. Сборка невозможна.`);
        }
        batch.push(buffer);
      }

      // Создаём промежуточный Blob из батча — batch[] выходит из скоупа → GC может освободить
      partBlobs.push(new Blob(batch));

      if (start % (BATCH_SIZE * 5) === 0) {
        console.log(`[GC Offscreen] Собрано: ${end}/${totalChunks} чанков`);
      }
    }

    console.log('[GC Offscreen] Все данные получены, создаю финальный Blob...');
    const blob = new Blob(partBlobs, { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);

    console.log('[GC Offscreen] Blob URL создан, отправляю в background...');

    // ОТПРАВЛЯЕМ НАЗАД В BACKGROUND (т.к. chrome.downloads недоступен в offscreen)
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_BLOB_READY',
      url: url,
      fileName: fileName
    });

    // Очистка ресурсов через минуту (чтобы загрузка успела начаться)
    setTimeout(() => {
      URL.revokeObjectURL(url);
      clearChunksFromDB(storageId, totalChunks);
    }, 60000);
  }

  console.log('[GC Offscreen] Скрипт активен');
})();
