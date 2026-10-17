// 送貨中畫面：一次一站、導航、下一站、待補送、復原、進度、待補送重排、手機位置藍點。
// 由 app.js 建立，透過 ctx 拿到排好的站和地圖：
//   ctx.map           地圖（setPoints、fit）
//   ctx.stops()       排好號碼的站，照號碼順序：[{ key, number, title, items, position, office }]
//   ctx.onShow(show)  送貨中畫面打開或關上時通知 app.js 切換版面
//   ctx.onNewTrip()   按「開始新的一趟」
(function () {
  'use strict';

  var STATE_KEY = 'shopee-route.delivery.v1';
  var UNDO_MS = 5000;
  var TYPE_LABEL = { home: '住家', office: '辦公室' };
  var COLORS = { current: '#0b6e69', stop: '#5f9ea0', office: '#b45309', done: '#9aa0a6', later: '#7c3aed', me: '#1a73e8' };

  function load() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STATE_KEY));
      if (saved && typeof saved === 'object') {
        return {
          active: saved.active === true,
          started: saved.started === true,
          status: saved.status && typeof saved.status === 'object' ? saved.status : {},
          laterOrder: Array.isArray(saved.laterOrder) ? saved.laterOrder : null,
          declined: saved.declined === true
        };
      }
    } catch (error) {
      // 讀不到就從頭開始。
    }
    return { active: false, started: false, status: {}, laterOrder: null, declined: false };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function create(ctx) {
    var state = load();
    var me = null; // 手機位置，不存起來
    var watchId = null;
    var wakeLock = null;
    var undo = null; // { key, before, timer }
    var lastCurrent = null;
    var fittedWithMe = false;

    var root = document.getElementById('deliver');
    var progressBtn = document.getElementById('deliver-progress');
    var body = document.getElementById('deliver-body');
    var navLink = document.getElementById('nav-link');
    var nextBtn = document.getElementById('next-btn');
    var laterBtn = document.getElementById('later-btn');
    var actions = document.getElementById('deliver-actions');
    var toast = document.getElementById('undo-toast');
    var toastText = document.getElementById('undo-text');
    var allDialog = document.getElementById('all-stops');
    var allList = document.getElementById('all-stop-list');

    function save() {
      try {
        window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch (error) {
        // 存不進去就算了，畫面照常。
      }
    }

    // ---- 目前到哪一站 ----

    function sequence() {
      var stops = ctx.stops();
      var byKey = {};
      stops.forEach(function (stop) { byKey[stop.key] = stop; });
      if (!state.laterOrder) return stops;
      var first = state.laterOrder.map(function (key) { return byKey[key]; }).filter(Boolean);
      return first.concat(stops.filter(function (stop) { return first.indexOf(stop) < 0; }));
    }

    function statusOf(stop) {
      return state.status[stop.key] || 'pending';
    }

    function counts(stops) {
      var c = { done: 0, later: 0, pending: 0 };
      stops.forEach(function (stop) { c[statusOf(stop)] += 1; });
      return c;
    }

    function currentStop() {
      return sequence().filter(function (stop) { return statusOf(stop) === 'pending'; })[0] || null;
    }

    // ---- 畫面 ----

    function itemBlock(item) {
      var li = el('li', 'deliver-item');
      li.appendChild(el('div', 'deliver-address', item.address));
      var meta = el('div', 'deliver-meta');
      meta.appendChild(el('span', 'tag' + (item.type === 'office' ? ' office' : ''), TYPE_LABEL[item.type] || TYPE_LABEL.home));
      if (item.timeWindow) meta.appendChild(el('span', 'deliver-window', item.timeWindow));
      li.appendChild(meta);
      if (item.orderNo) li.appendChild(el('div', 'deliver-order', item.orderNo));
      return li;
    }

    function stopCard(stop) {
      var box = el('section', 'current-stop' + (stop.office ? ' office-stop' : ''));
      box.setAttribute('data-testid', 'current-stop');
      var head = el('div', 'current-head');
      head.appendChild(el('span', 'current-number', '第 ' + stop.number + ' 站'));
      head.appendChild(el('span', 'current-count', stop.items.length + ' 件'));
      box.appendChild(head);
      box.appendChild(el('h2', 'current-title', stop.title));
      if (stop.items.length > 1) {
        box.appendChild(el('p', 'stop-reminder', '同一個門牌 ' + stop.items.length + ' 件，可能分前後棟，到現場請確認'));
      }
      var list = el('ol', 'deliver-items');
      stop.items.forEach(function (item) { list.appendChild(itemBlock(item)); });
      box.appendChild(list);
      return box;
    }

    function laterPrompt(n) {
      var box = el('section', 'later-prompt');
      box.setAttribute('data-testid', 'later-prompt');
      box.appendChild(el('p', '', '主要路線送完了，還有 ' + n + ' 站待補送，要從你現在的位置重新排嗎？'));
      var row = el('div', 'start-actions');
      row.appendChild(button('重新排', 'primary', replanLater));
      row.appendChild(button('先不要', '', function () {
        state.declined = true;
        save();
        render();
      }));
      box.appendChild(row);
      return box;
    }

    function doneCard(n) {
      var box = el('section', 'trip-done');
      box.setAttribute('data-testid', 'trip-done');
      box.appendChild(el('h2', '', '這一趟送完了'));
      if (n) {
        box.appendChild(el('p', '', '還有 ' + n + ' 站待補送。'));
        box.appendChild(button('補送待補送的站', 'primary', replanLater));
      }
      box.appendChild(button('開始新的一趟', 'primary', function () { ctx.onNewTrip(); }));
      box.appendChild(button('回到清單', '', exit));
      return box;
    }

    function button(text, className, onClick) {
      var node = el('button', 'btn' + (className ? ' ' + className : ''), text);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    }

    function render() {
      if (!state.active) return;
      var stops = ctx.stops();
      var c = counts(stops);
      progressBtn.textContent = '已送 ' + c.done + ' 站｜還剩 ' + c.pending + ' 站' + (c.later ? '｜待補送 ' + c.later + ' 站' : '') + ' ›';
      var current = currentStop();
      body.textContent = '';
      if (current) {
        body.appendChild(stopCard(current));
      } else if (c.later && !state.declined) {
        body.appendChild(laterPrompt(c.later));
      } else {
        body.appendChild(doneCard(c.later));
      }
      actions.classList.toggle('idle', !current);
      nextBtn.disabled = !current;
      laterBtn.disabled = !current;
      if (current && current.position) {
        navLink.href = 'https://www.google.com/maps/dir/?api=1&destination=' +
          current.position.lat + ',' + current.position.lng + '&travelmode=two-wheeler&dir_action=navigate';
        navLink.removeAttribute('aria-disabled');
      } else {
        navLink.removeAttribute('href');
        navLink.setAttribute('aria-disabled', 'true');
      }
      drawMap(stops, current);
      var key = current ? current.key : null;
      if (key !== lastCurrent) {
        lastCurrent = key;
        fitToCurrent(current);
      }
      if (!allDialog.hidden && allDialog.open) fillAll();
    }

    function drawMap(stops, current) {
      var points = stops.filter(function (stop) { return stop.position; }).map(function (stop) {
        var status = statusOf(stop);
        var kind = current && stop.key === current.key ? 'current' : status === 'pending' ? 'stop' : status;
        var color = kind === 'current' ? COLORS.current : kind === 'stop' ? (stop.office ? COLORS.office : COLORS.stop) : COLORS[kind];
        return { lat: stop.position.lat, lng: stop.position.lng, number: stop.number, label: stop.title, kind: kind, color: color };
      });
      if (me) points.push({ lat: me.lat, lng: me.lng, kind: 'me', color: COLORS.me, label: '你的位置' });
      ctx.map.setPoints(points);
    }

    function fitToCurrent(current) {
      if (!current || !current.position) return;
      var near = me && distance(me, current.position) < 5000;
      ctx.map.fit(near ? [current.position, me] : [current.position]);
    }

    function fitAll() {
      var points = ctx.stops().filter(function (stop) { return stop.position; }).map(function (stop) { return stop.position; });
      if (me) points.push(me);
      ctx.map.fit(points);
    }

    function distance(a, b) {
      return window.RoutePlanner.meters(a, b);
    }

    // ---- 按鈕 ----

    function mark(status) {
      var current = currentStop();
      if (!current) return;
      var before = state.status[current.key];
      state.status[current.key] = status;
      save();
      showUndo(current, before, status);
      render();
    }

    function showUndo(stop, before, status) {
      clearUndo();
      toastText.textContent = (status === 'done' ? '已記成送達：' : '已移到待補送：') + stop.title;
      toast.hidden = false;
      undo = {
        key: stop.key,
        before: before,
        timer: window.setTimeout(clearUndo, UNDO_MS)
      };
    }

    function clearUndo() {
      if (undo) window.clearTimeout(undo.timer);
      undo = null;
      toast.hidden = true;
    }

    document.getElementById('undo-btn').addEventListener('click', function () {
      if (!undo) return;
      if (undo.before) state.status[undo.key] = undo.before;
      else delete state.status[undo.key];
      save();
      clearUndo();
      render();
    });

    nextBtn.addEventListener('click', function () { mark('done'); });
    laterBtn.addEventListener('click', function () { mark('later'); });

    // 待補送的站從現在的位置重新排；拿不到位置就用最後送達那一站的位置。
    function replanLater() {
      var laterStops = ctx.stops().filter(function (stop) { return statusOf(stop) === 'later' && stop.position; });
      if (!laterStops.length) return;
      whereAmI(function (here) {
        if (!here) {
          var lastDone = sequence().filter(function (stop) { return statusOf(stop) === 'done' && stop.position; }).pop();
          here = lastDone ? lastDone.position : laterStops[0].position;
        }
        state.laterOrder = window.RoutePlanner.plan(here, laterStops.map(function (stop) {
          return { key: stop.key, lat: stop.position.lat, lng: stop.position.lng };
        }));
        laterStops.forEach(function (stop) { delete state.status[stop.key]; });
        state.declined = false;
        save();
        render();
      });
    }

    function whereAmI(done) {
      if (!navigator.geolocation) {
        done(me);
        return;
      }
      navigator.geolocation.getCurrentPosition(function (position) {
        me = { lat: position.coords.latitude, lng: position.coords.longitude };
        done(me);
      }, function () {
        done(me);
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
    }

    // ---- 全部站 ----

    var STATUS_TEXT = { pending: '未送達', done: '已送達', later: '待補送' };

    function fillAll() {
      allList.textContent = '';
      ctx.stops().forEach(function (stop) {
        var status = statusOf(stop);
        var li = el('li', 'all-stop status-' + status);
        li.setAttribute('data-testid', 'all-stop');
        li.appendChild(el('span', 'all-number', String(stop.number)));
        var text = el('div', 'all-text');
        text.appendChild(el('div', 'all-title', stop.title));
        text.appendChild(el('div', 'all-status', STATUS_TEXT[status]));
        li.appendChild(text);
        if (status !== 'pending') {
          li.appendChild(button('改回未送達', 'small', function () {
            delete state.status[stop.key];
            save();
            render();
            fillAll();
          }));
        }
        allList.appendChild(li);
      });
    }

    progressBtn.addEventListener('click', function () {
      fillAll();
      allDialog.hidden = false;
      if (allDialog.showModal) allDialog.showModal();
    });
    document.getElementById('all-close').addEventListener('click', function () {
      if (allDialog.close) allDialog.close();
    });

    // ---- 進出送貨中畫面 ----

    function startWatching() {
      if (!navigator.geolocation || watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(function (position) {
        me = { lat: position.coords.latitude, lng: position.coords.longitude };
        var stops = ctx.stops();
        drawMap(stops, currentStop());
        if (!fittedWithMe) {
          fittedWithMe = true;
          fitToCurrent(currentStop());
        }
      }, function () {
        // 拿不到位置就不顯示藍點，其他照常。
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }

    function stopWatching() {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }

    // 送貨中盡量不讓螢幕自動關掉（Android 的 Chrome 支援）。
    function keepScreenOn() {
      if (!state.active || !navigator.wakeLock || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
      }, function () {
        wakeLock = null;
      });
    }

    function releaseScreen() {
      if (wakeLock) wakeLock.release().catch(function () {});
      wakeLock = null;
    }

    document.addEventListener('visibilitychange', keepScreenOn);

    function enter() {
      state.active = true;
      state.started = true;
      save();
      root.hidden = false;
      ctx.onShow(true);
      lastCurrent = undefined;
      fittedWithMe = false;
      startWatching();
      keepScreenOn();
      render();
      window.scrollTo(0, 0);
    }

    function exit() {
      state.active = false;
      save();
      clearUndo();
      stopWatching();
      releaseScreen();
      root.hidden = true;
      ctx.onShow(false);
    }

    document.getElementById('deliver-exit').addEventListener('click', exit);

    return {
      enter: enter,
      exit: exit,
      render: render,
      fitAll: fitAll,
      isActive: function () { return state.active; },
      hasStarted: function () { return state.started; },
      resumeIfActive: function () { if (state.active) enter(); },
      // 開始新的一趟：送貨狀態全部清掉，回到出發前畫面。
      reset: function () {
        if (state.active) exit();
        state = { active: false, started: false, status: {}, laterOrder: null, declined: false };
        save();
      }
    };
  }

  window.RouteDelivery = { create: create };
})();
