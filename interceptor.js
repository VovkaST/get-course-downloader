/**
 * Interceptor Script (MAIN world)
 * Перехватывает fetch и XMLHttpRequest для поиска мастер-плейлистов.
 * Отправляет найденные данные в Isolated World через window.postMessage.
 */

(function () {
  'use strict';
  
  const loc = window.location.href;
  const isIframe = window.self !== window.top;
  console.log(`[GC Downloader] ${isIframe ? 'IFRAME' : 'MAIN'} ИНЖЕКТОР: ${loc}`);

  // --- Перехват fetch ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0].url;
    
    const response = await originalFetch.apply(this, args);

    if (url && url.includes('/master/')) {
      const clone = response.clone();
      clone.text().then(body => {
        window.postMessage({
          type: 'GC_VIDEO_DOWNLOADER_MASTER_FOUND',
          url: url,
          body: body
        }, '*');
      }).catch(() => {});
    }
    return response;
  };

  // --- Перехват XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState === 4 && xhr._url && xhr._url.includes('/master/')) {
        window.postMessage({
          type: 'GC_VIDEO_DOWNLOADER_MASTER_FOUND',
          url: xhr._url,
          body: xhr.responseText
        }, '*');
      }
    });
    return originalSend.apply(this, arguments);
  };

  console.log(`[GC Downloader] Сетевой перехватчик активен на ${window.location.hostname} (${isIframe ? 'IFRAME' : 'MAIN'}).`);
})();

