/**
 * Content Script (ISOLATED world)
 */

(function () {
  'use strict';

  const reportedHashes = new Set();

  function getVideoTitle(videoHash) {
    if (!videoHash) return null;

    const videoEl = document.querySelector(`[data-video-hash="${videoHash}"]`);
    if (!videoEl) return null;

    const blockEl = videoEl.closest('[data-block-id]');
    if (!blockEl) return null;

    const blockId = blockEl.getAttribute('data-block-id');

    // Поднимаемся до самого внешнего родителя с таким же blockId
    let outerBlock = blockEl;
    let parent = blockEl.parentElement;
    while (parent) {
      const nextOuter = parent.closest(`[data-block-id="${blockId}"]`);
      if (nextOuter) {
        outerBlock = nextOuter;
        parent = outerBlock.parentElement;
      } else {
        break;
      }
    }

    const current = outerBlock.previousElementSibling;
    let titleEl = null;

    if (current && current.hasAttribute('data-block-id')) {
      titleEl = current;
    } else {
      // Ищем ближайший блок выше, если предыдущий сосед не он
      let search = outerBlock.previousElementSibling;
      while (search) {
        if (search.hasAttribute('data-block-id')) {
          titleEl = search;
          break;
        }
        search = search.previousElementSibling;
      }
    }

    if (!titleEl) return null;

    const title = titleEl.innerText.trim().split('\n')[0].replace(/\s+/g, ' ');
    console.log('[GC Downloader] Найдено название:', title);
    return title || null;
  }

  function scanAndReport() {
    const videoElements = document.querySelectorAll('[data-video-hash]');
    videoElements.forEach(el => {
      const hash = el.getAttribute('data-video-hash');
      if (hash && !reportedHashes.has(hash)) {
        const title = getVideoTitle(hash);
        if (title) {
          reportedHashes.add(hash);
          chrome.runtime.sendMessage({
            type: 'VIDEO_TITLE_FOUND',
            hash,
            title
          }).catch(() => {});
        }
      }
    });
  }

  scanAndReport();
  setTimeout(scanAndReport, 1000);
  setTimeout(scanAndReport, 3000);

  const observer = new MutationObserver(scanAndReport);
  observer.observe(document.body, { childList: true, subtree: true });

  // 3. Слушаем сообщения от interceptor.js (из Main World)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'GC_VIDEO_DOWNLOADER_MASTER_FOUND') return;

    const { url, body } = event.data;
    chrome.runtime.sendMessage({
      type: 'GC_MASTER_PLAYLIST',
      url,
      body
    }).catch(() => {});
  });

  console.log('[GC Downloader] Контент-скрипт готов.');
})();
