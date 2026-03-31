/**
 * Popup Script
 * Управляет интерфейсом расширения: список видео, выбор разрешения,
 * ввод имени файла, запуск загрузки и отображение прогресса.
 * Восстанавливает состояние загрузки при повторном открытии popup.
 */

(function () {
  'use strict';
 
  // Глобальный перехватчик ошибок для диагностики "захлопывания"
  window.onerror = function(message, source, lineno, colno, error) {
    console.error(`[GC Popup Error] ${message} at ${source}:${lineno}:${colno}`, error);
    // Не даем ошибке "уронить" попап, если это возможно
    return true;
  };

  // ---- DOM-элементы ----
  const states = {
    loading: document.getElementById('loading-state'),
    empty: document.getElementById('empty-state'),
    videoList: document.getElementById('video-list-state'),
    setup: document.getElementById('download-setup-state'),
    progress: document.getElementById('download-progress-state'),
    done: document.getElementById('done-state'),
    error: document.getElementById('error-state'),
  };
 
  // ---- Универсальный безопасный обработчик кликов ----
  const setupButton = (btn, handler) => {
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      console.log(`[GC Popup] CLICK зафиксирован на: ${btn.id || btn.className}`);
      handler(e);
    });
    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      console.log(`[GC Popup] MOUSEDOWN зафиксирован на: ${btn.id || btn.className}`);
    });
    // Защита от закрытия по правой кнопке
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log(`[GC Popup] CONTEXTMENU (правокулик) заблокирован на: ${btn.id || btn.className}`);
    });
  };

  // Глобальная блокировка контекстного меню для всего документа
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    console.log('[GC Popup] Глобальный CONTEXTMENU заблокирован.');
  });

  const loadingText = document.getElementById('loading-text');
  const loadingHint = document.getElementById('loading-hint');

  const videoListEl = document.getElementById('video-list');
  const resolutionListEl = document.getElementById('resolution-list');
  const btnDownload = document.getElementById('btn-download');
  const btnBack = document.getElementById('btn-back');
  const btnNewDownload = document.getElementById('btn-new-download');
  const btnRetry = document.getElementById('btn-retry');
  const btnCancel = document.getElementById('btn-cancel');

  // Progress elements
  const progressFilename = document.getElementById('progress-filename');
  const progressStatus = document.getElementById('progress-status');
  const progressBar = document.getElementById('progress-bar-fill');
  const progressBarContainer = document.querySelector('.progress-bar-container');
  const progressPercent = document.getElementById('progress-percent');
  const progressChunks = document.getElementById('progress-chunks');
  const progressSize = document.getElementById('progress-size');
  const progressThreads = document.getElementById('progress-threads');

  // Done/Error elements
  const doneFilename = document.getElementById('done-filename');
  const errorMessage = document.getElementById('error-message');

  // ---- Состояние ----
  let currentPlaylists = [];
  let selectedPlaylistIndex = -1;
  let selectedStreamUrl = null;
  let selectedResolution = null;

  // ---- Утилиты ----
  function showState(stateName) {
    Object.entries(states).forEach(([name, el]) => {
      el.classList.toggle('hidden', name !== stateName);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
  }

  /**
   * Парсинг мастер-плейлиста M3U8.
   */
  function parseMasterPlaylist(body) {
    if (!body || typeof body !== 'string') return [];
    const lines = body.split('\n').map(l => l.trim());
    const streams = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const info = lines[i];
        const nextLine = lines[i + 1];

        if (nextLine && nextLine.startsWith('https://')) {
          const resMatch = info.match(/RESOLUTION=(\d+x\d+)/);
          const bwMatch = info.match(/BANDWIDTH=(\d+)/);
          const pathwayMatch = info.match(/PATHWAY-ID="([^"]+)"/);

          const pathway = pathwayMatch ? pathwayMatch[1] : '';
          const resolution = resMatch ? resMatch[1] : 'unknown';
          const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
          const [width, height] = resolution.split('x').map(Number);

          const existing = streams.find(s => s.resolution === resolution);
          if (!existing) {
            streams.push({ resolution, bandwidth, url: nextLine, width, height, pathway });
          } else if (pathway === 'cdnvideo' && existing.pathway !== 'cdnvideo') {
            Object.assign(existing, { url: nextLine, pathway, bandwidth });
          }
        }
      }
    }

    streams.sort((a, b) => a.height - b.height);
    return streams;
  }

  // ---- Обновление прогресса в UI ----
  function updateProgressUI(data) {
    const { status, downloaded, total, fileName, sizeBytes, error,
            retryChunk, retryAttempt, retryMaxAttempts, retryDelaySec } = data;

    if (status === 'starting') {
      progressFilename.textContent = fileName || '';
      progressStatus.textContent = 'Начинаем загрузку...';
      progressBar.style.width = '0%';
      progressPercent.textContent = '0%';
      progressChunks.textContent = '0 / 0 чанков';
      progressSize.textContent = '0 МБ';
      progressThreads.textContent = data.concurrency ? `Потоков: ${data.concurrency}` : '';
      progressBarContainer.classList.add('active');
      showState('progress');

    } else if (status === 'downloading') {
      const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
      progressFilename.textContent = fileName || '';
      progressBar.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      progressChunks.textContent = `${downloaded} / ${total} чанков`;
      progressSize.textContent = formatBytes(sizeBytes || 0);
      progressThreads.textContent = data.concurrency ? `Потоков: ${data.concurrency}` : '';
      progressStatus.textContent = 'Загрузка чанков...';
      progressBarContainer.classList.add('active');
      showState('progress');

    } else if (status === 'retrying') {
      const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
      progressFilename.textContent = fileName || '';
      progressBar.style.width = percent + '%';
      progressPercent.textContent = percent + '%';
      progressChunks.textContent = `${downloaded} / ${total} чанков`;
      progressSize.textContent = formatBytes(sizeBytes || 0);
      progressThreads.textContent = data.concurrency ? `Потоков: ${data.concurrency}` : '';
      progressStatus.textContent = `Повтор чанка ${retryChunk} (попытка ${retryAttempt}/${retryMaxAttempts}, ожидание ${retryDelaySec}с)...`;
      progressBarContainer.classList.add('active');
      showState('progress');

    } else if (status === 'merging') {
      progressFilename.textContent = fileName || '';
      progressStatus.textContent = 'Объединение фрагментов...';
      progressBar.style.width = '100%';
      progressPercent.textContent = '100%';
      showState('progress');

    } else if (status === 'done') {
      progressBarContainer.classList.remove('active');
      doneFilename.textContent = fileName || '';
      showState('done');

    } else if (status === 'error') {
      progressBarContainer.classList.remove('active');
      errorMessage.textContent = error || 'Неизвестная ошибка';
      showState('error');

    } else if (status === 'cancelled') {
      progressBarContainer.classList.remove('active');
      loadPlaylists();
    }
  }

  // ---- Троттлинг обновлений прогресса ----
  let lastProgressUpdate = 0;
  let progressThrottleTimeout = null;
  let pendingProgressData = null;

  function throttleProgressUI(data) {
    pendingProgressData = data;
    const now = Date.now();
    const delay = 250; // Обновляем не чаще чем раз в 250мс

    if (now - lastProgressUpdate >= delay) {
      if (progressThrottleTimeout) clearTimeout(progressThrottleTimeout);
      updateProgressUI(pendingProgressData);
      lastProgressUpdate = now;
      pendingProgressData = null;
    } else if (!progressThrottleTimeout) {
      progressThrottleTimeout = setTimeout(() => {
        if (pendingProgressData) {
          updateProgressUI(pendingProgressData);
          lastProgressUpdate = Date.now();
          pendingProgressData = null;
        }
        progressThrottleTimeout = null;
      }, delay - (now - lastProgressUpdate));
    }
  }

  // ---- Инициализация ----
  async function init() {
    // Показываем экран загрузки сразу
    loadingText.textContent = 'Проверяю состояние...';
    loadingHint.textContent = '';
    showState('loading');

    // Проверяем, есть ли активная загрузка
    chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATE' }, (response) => {
      if (chrome.runtime.lastError) {
        loadPlaylists();
        return;
      }

      const state = response?.state;
      if (state && ['downloading', 'starting', 'merging', 'retrying'].includes(state.status)) {
        // Есть активная загрузка — восстанавливаем UI прогресса
        updateProgressUI(state);
      } else if (state && state.status === 'done') {
        updateProgressUI(state);
      } else if (state && state.status === 'error') {
        updateProgressUI(state);
      } else {
        // Нет активной загрузки — показываем список видео
        loadPlaylists();
      }
    });
  }

  // ---- Загрузка списка плейлистов ----
  let currentTabId = null;
  let videoTitles = {}; // url -> title

  async function loadPlaylists() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showState('empty');
      return;
    }
    currentTabId = tab.id;

    // Шаг 1: быстро узнаём количество обнаруженных URL
    chrome.runtime.sendMessage({ type: 'GET_MASTER_COUNT', tabId: tab.id }, (countResponse) => {
      console.log(`[GC Downloader] Попап (tab=${tab.id}) получил счетчик:`, countResponse);
      
      if (chrome.runtime.lastError) {
        console.error(`[GC Downloader] Ошибка GET_MASTER_COUNT:`, chrome.runtime.lastError);
        showState('empty');
        return;
      }

      const count = countResponse?.count || 0;

      if (count === 0) {
        showState('empty');
        return;
      }

      // Показываем статус: видео найдены, загружаем данные
      loadingText.textContent = `Обнаружено видео: ${count}`;
      loadingHint.textContent = 'Получаю ссылки на скачивание...';
      showState('loading');

      console.log(`[GC Downloader] Запрашиваю содержимое ${count} плейлистов...`);
      chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS', tabId: tab.id }, (response) => {
        console.log(`[GC Downloader] Ответ GET_PLAYLISTS получен:`, response);
        
        const playlists = response?.playlists || [];
        const hasError = response?.error;

        if (playlists.length === 0) {
          console.warn(`[GC Downloader] Плейлисты не загружены:`, hasError || 'пустой список');
          showState('empty');
          return;
        }

        currentPlaylists = playlists;

        // Шаг 3: запрашиваем названия видео из фонового хранилища
        chrome.runtime.sendMessage({ type: 'GET_VIDEO_TITLES' }, (titleResponse) => {
          if (!chrome.runtime.lastError && titleResponse?.titles) {
            Object.keys(titleResponse.titles).forEach(hash => {
              if (titleResponse.titles[hash]) {
                videoTitles[hash] = titleResponse.titles[hash];
              }
            });
          }
          renderVideoList();
        });
      });
    });
  }

  function renderVideoList() {
    console.log(`[GC Downloader] Отрисовка ${currentPlaylists.length} видео.`);
    videoListEl.innerHTML = '';

    currentPlaylists.forEach((playlist, index) => {
      if (!playlist || !playlist.body) return;
      
      const streams = parseMasterPlaylist(playlist.body);
      const maxRes = streams.length > 0 ? streams[streams.length - 1] : null;

      // Извлекаем хэш для поиска названия
      const hashMatch = playlist.url.match(/\/master\/([a-f0-9]+)/i);
      const hash = hashMatch ? hashMatch[1] : null;
      const title = videoTitles[hash] || videoTitles[playlist.url] || `Видео ${index + 1}`;

      if (!videoTitles[hash]) {
        console.log(`[GC Downloader] Название для хэша ${hash} пока не найдено.`);
      }

      const item = document.createElement('div');
      item.className = 'video-item';
      item.innerHTML = `
        <div class="video-item-icon">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M23 7l-7 5 7 5V7z" stroke="#00a8e8" stroke-width="1.5" stroke-linejoin="round"/>
            <rect x="1" y="5" width="15" height="14" rx="2" stroke="#00a8e8" stroke-width="1.5"/>
          </svg>
        </div>
        <div class="video-item-info">
          <div class="video-item-title">${escapeHtml(title)}</div>
          <div class="video-item-meta">${streams.length} разрешени${getResEnding(streams.length)}${maxRes ? ' · до ' + maxRes.resolution : ''}</div>
        </div>
        <div class="video-item-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      `;

      setupButton(item, () => openSetup(index));
      videoListEl.appendChild(item);
    });

    showState('videoList');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getResEnding(count) {
    if (count === 1) return 'е';
    if (count >= 2 && count <= 4) return 'я';
    return 'й';
  }

  // ---- Настройка загрузки ----
  function openSetup(playlistIndex) {
    selectedPlaylistIndex = playlistIndex;
    selectedStreamUrl = null;
    selectedResolution = null;

    const playlist = currentPlaylists[playlistIndex];
    const streams = parseMasterPlaylist(playlist.body);

    resolutionListEl.innerHTML = '';
    streams.forEach((stream) => {
      const btn = document.createElement('button');
      btn.className = 'resolution-btn';
      btn.innerHTML = `
        <span class="resolution-label">${stream.height}p</span>
        <span class="resolution-badge">${stream.resolution}</span>
      `;
      setupButton(btn, (e) => selectResolution(stream, btn, e));
      resolutionListEl.appendChild(btn);
    });

    // Автовыбор максимального разрешения
    if (streams.length > 0) {
      const lastBtn = resolutionListEl.lastElementChild;
      const lastStream = streams[streams.length - 1];
      selectResolution(lastStream, lastBtn);
    }

    updateDownloadButton();
    showState('setup');
  }

  function selectResolution(stream, btnEl, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      if (!btnEl) return;
      selectedStreamUrl = stream.url;
      selectedResolution = stream.resolution;

      // Гарантированно очищаем выделение у всех кнопок
      const buttons = resolutionListEl.querySelectorAll('.resolution-btn');
      buttons.forEach(b => b.classList.remove('selected'));
      
      // Выделяем текущую
      btnEl.classList.add('selected');

      updateDownloadButton();
    } catch (err) {
      console.error('[GC Popup] Ошибка при выборе разрешения:', err);
    }
  }

  function updateDownloadButton() {
    const hasResolution = selectedStreamUrl !== null;
    btnDownload.disabled = !hasResolution;
  }

  // ---- Запуск загрузки ----
  function startDownload(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      if (!selectedStreamUrl) return;

      const playlist = currentPlaylists[selectedPlaylistIndex];
      if (!playlist) return;

      // Автоматическое получение и очистка имени файла
      const hashMatch = playlist.url.match(/\/master\/([a-f0-9]+)/i);
      const hash = hashMatch ? hashMatch[1] : null;
      const rawTitle = videoTitles[hash] || videoTitles[playlist.url] || 'video';

      // Очистка от запрещенных символов: / \ : * ? " < > |
      const sanitizedTitle = rawTitle.replace(/[\\\/:*?"<>|]/g, '_').trim();
      const fileName = sanitizedTitle + '.mp4';

      updateProgressUI({ status: 'starting', fileName, downloaded: 0, total: 0, sizeBytes: 0 });

      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_VIDEO',
        streamUrl: selectedStreamUrl,
        fileName: fileName,
        playlistUrl: currentPlaylists[selectedPlaylistIndex].url
      }, (response) => {
        if (chrome.runtime.lastError) {
          updateProgressUI({ status: 'error', error: chrome.runtime.lastError.message, fileName });
          return;
        }
        if (response && response.error) {
          updateProgressUI({ status: 'error', error: response.error, fileName });
        }
      });
    } catch (err) {
      console.error('[GC Popup] Ошибка при запуске загрузки:', err);
    }
  }

  // ---- Отмена загрузки ----
  function cancelDownload(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    try {
      btnCancel.disabled = true;
      btnCancel.querySelector('span').textContent = 'Отменяю...';

      chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('Ошибка отмены:', chrome.runtime.lastError);
        }
        btnCancel.disabled = false;
        btnCancel.querySelector('span').textContent = 'Отменить загрузку';
        loadPlaylists();
      });
    } catch (err) {
      console.error('[GC Popup] Ошибка при отмене загрузки:', err);
    }
  }

  // ---- Обработка сообщений от background ----
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'DOWNLOAD_PROGRESS') {
      // Используем троттлинг для разгрузки UI при 15 потоках
      throttleProgressUI(message);
      return;
    }

    // Обнаружено новое видео — обновить список
    if (message.type === 'MASTER_URL_FOUND') {
      // Обновляем если показан экран «нет видео», загрузки или списка видео
      const onUpdatableScreen =
        !states.empty.classList.contains('hidden') ||
        !states.loading.classList.contains('hidden') ||
        !states.videoList.classList.contains('hidden');
      if (onUpdatableScreen) {
        loadPlaylists();
      }
    }

    // Пришло обновление названия конкретного видео
    if (message.type === 'VIDEO_TITLE_UPDATED') {
      const { hash, title } = message;
      videoTitles[hash] = title;

      // Обновляем список, если он виден
      if (!states.videoList.classList.contains('hidden')) {
        renderVideoList();
      }
    }
  });

  // ---- Обработчики событий ----
  setupButton(btnDownload, startDownload);
  setupButton(btnCancel, cancelDownload);

  setupButton(btnBack, (e) => {
    e.preventDefault();
    renderVideoList();
  });

  setupButton(btnNewDownload, (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_STATE' }, () => {
      loadPlaylists();
    });
  });

  setupButton(btnRetry, (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_STATE' }, () => {
      if (selectedPlaylistIndex >= 0 && currentPlaylists.length > 0) {
        openSetup(selectedPlaylistIndex);
      } else {
        loadPlaylists();
      }
    });
  });

  // ---- Запуск ----
  init();
})();
