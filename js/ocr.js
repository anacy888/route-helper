// 認字：給它一張圖片（使用者選的截圖檔），交回認出來的文字。這一塊可以整塊換掉。
// 用 tesseract.js 在手機瀏覽器裡直接認，截圖不會傳到任何伺服器。
// 第一次使用時下載認字程式（jsDelivr）和繁體中文字庫（放在本網站 ocr 資料夾），之後存在手機裡。
(function () {
  'use strict';

  var SCRIPT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var workerPromise = null;
  var onProgress = null;

  function loadScript() {
    return new Promise(function (resolve, reject) {
      if (window.Tesseract) {
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = SCRIPT;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('認字程式載入失敗')); };
      document.head.appendChild(script);
    });
  }

  function worker() {
    if (!workerPromise) {
      workerPromise = loadScript().then(function () {
        return window.Tesseract.createWorker('chi_tra', 1, {
          langPath: new URL('ocr', document.baseURI).href,
          logger: function (message) {
            if (onProgress) onProgress(message);
          }
        });
      }).then(function (w) {
        // 4：一欄由上往下的文字，跟蝦皮清單的版面最合（實測錯字最少）。
        return w.setParameters({ tessedit_pageseg_mode: '4' }).then(function () { return w; });
      });
      workerPromise.catch(function () { workerPromise = null; });
    }
    return workerPromise;
  }

  // progress(訊息)：{ status, progress }，status 例如 'loading language traineddata'、'recognizing text'。
  function recognize(file, progress) {
    onProgress = progress || null;
    return worker().then(function (w) {
      return w.recognize(file);
    }).then(function (result) {
      return result.data.text;
    });
  }

  window.RouteOCR = { recognize: recognize };
})();
