// 出發前畫面：檢查清單、地址找位置、標紅地址、併站、排路線。送貨中畫面在 deliver.js。
(function () {
  'use strict';

  var TYPE_LABEL = { home: '住家', office: '辦公室' };
  var FAR_METERS = 5000; // 離其他件的中間位置超過這個距離，就當成位置可疑
  var STATUS_TEXT = {
    pending: '查詢位置中…',
    house: '已定位',
    street: '已定位（只找到大概位置）',
    manual: '已定位（手動指定）',
    notfound: '找不到位置',
    failed: '查詢失敗，重開網頁會再試一次',
    limit: '今天的地址查詢次數已用完，明天重開網頁會再查，或先在地圖上手動指定',
    road: '路名對不上，地圖上的位置可能是錯的',
    far: '位置可疑：離其他件很遠'
  };
  var KEEP_MS = 30 * 24 * 60 * 60 * 1000; // Google 查到的位置最多留 30 天

  var items = window.TripStore.load();
  var settings = window.TripStore.loadSettings();
  var map = window.RouteMap.create();
  var inFlight = {};
  var pickingKey = null;
  var delivery = null; // 送貨中畫面，最下面建立
  var route = window.TripStore.loadRoute(); // { order: [站的比對字串], start: {lat,lng}, manual: 手動調過 }，還沒排過是 null

  var listEl = document.getElementById('item-list');
  var attentionSection = document.getElementById('attention');
  var attentionList = document.getElementById('attention-list');
  var attentionCount = document.getElementById('attention-count');
  var countEl = document.querySelector('[data-testid="item-count"]');
  var emptyEl = document.getElementById('empty-hint');
  var dialog = document.getElementById('item-dialog');
  var form = document.getElementById('item-form');
  var fAddress = document.getElementById('f-address');
  var addressError = document.getElementById('address-error');
  var dialogTitle = document.getElementById('dialog-title');
  var citySelect = document.getElementById('default-city');
  var pickBanner = document.getElementById('pick-banner');
  var pickText = document.getElementById('pick-text');
  var usageEl = document.getElementById('relay-usage');
  var planBtn = document.getElementById('plan-btn');
  var deliverBtn = document.getElementById('deliver-btn');
  var mapToggle = document.getElementById('map-toggle');
  var newTripBtn = document.getElementById('new-trip-btn');
  var planActions = document.getElementById('plan-actions');
  var startText = document.getElementById('start-text');
  var startChoiceText = document.getElementById('start-choice-text');
  var CONFIG = window.ROUTE_CONFIG || {};
  var STORE_NAME = CONFIG.startName || '智取店';
  var planStatus = document.getElementById('plan-status');
  var replanHint = document.getElementById('replan-hint');
  var startChoice = document.getElementById('start-choice');
  var lastStartBtn = document.getElementById('use-last-start');
  // 表單輸入框和一件的欄位怎麼對應，只寫在這裡。
  var FORM_FIELDS = {
    address: fAddress,
    type: document.getElementById('f-type'),
    timeWindow: document.getElementById('f-window'),
    orderNo: document.getElementById('f-order')
  };
  var editingId = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    var node = el('button', 'btn' + (className ? ' ' + className : ''), text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function persist() {
    var saved = window.TripStore.save(items);
    document.getElementById('save-warning').hidden = saved;
  }

  // ---- 位置判斷 ----

  function hasPosition(item) {
    return item.lat !== null && item.lng !== null;
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function metersBetween(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // 至少要有三件找到位置，才有「其他件」可以比。
  function farIds() {
    var located = items.filter(hasPosition);
    var far = {};
    if (located.length < 3) return far;
    var center = {
      lat: median(located.map(function (i) { return i.lat; })),
      lng: median(located.map(function (i) { return i.lng; }))
    };
    located.forEach(function (item) {
      if (item.geoStatus !== 'manual' && metersBetween(center, item) > FAR_METERS) far[item.id] = true;
    });
    return far;
  }

  function displayStatus(item, far) {
    if (far[item.id]) return 'far';
    if (roadDiff(item)) return 'road';
    return item.geoStatus;
  }

  // 路名跟 Google 認定的不一樣，而且使用者還沒按「路名沒錯」。
  // 只找到大概位置、Google 又沒給路名，多半是 Google 根本找不到這條路，點只是落在區裡某處。
  function roadDiff(item) {
    if (item.roadOk || (item.geoStatus !== 'house' && item.geoStatus !== 'street')) return null;
    if (item.geoStatus === 'street' && item.geoRoute === '') {
      return { missing: true, typed: window.RouteAddress.roadOf(item.address, settings.defaultCity) };
    }
    return window.RouteAddress.roadMismatch(item.address, settings.defaultCity, item.geoRoute);
  }

  function needsAttention(status) {
    return status === 'notfound' || status === 'failed' || status === 'limit' || status === 'far' || status === 'road';
  }

  // ---- 查位置 ----

  function locate(item) {
    var query = window.RouteAddress.buildQuery(item.address, settings.defaultCity);
    var key = item.id + '|' + query;
    if (inFlight[key]) return;
    inFlight[key] = true;
    window.RouteGeocoder.geocode(query).then(function (result) {
      apply(item.id, query, result ? { lat: result.lat, lng: result.lng, geoStatus: result.precision === 'house' ? 'house' : 'street', geoAt: Date.now(), geoRoute: result.route || '' }
        : { lat: null, lng: null, geoStatus: 'notfound', geoAt: null, geoRoute: '' });
    }, function (error) {
      apply(item.id, query, { lat: null, lng: null, geoStatus: error && error.limit ? 'limit' : 'failed', geoAt: null, geoRoute: '' });
    }).then(function () {
      delete inFlight[key];
    });
  }

  function apply(id, query, change) {
    var item = items.filter(function (i) { return i.id === id; })[0];
    // 查詢途中地址被改掉或刪掉，就不要套用舊的結果。
    if (!item || item.geoStatus !== 'pending' || window.RouteAddress.buildQuery(item.address, settings.defaultCity) !== query) return;
    item.lat = change.lat;
    item.lng = change.lng;
    item.geoStatus = change.geoStatus;
    item.geoAt = change.geoAt;
    item.geoRoute = change.geoRoute;
    persist();
    render();
    if (!items.some(function (i) { return i.geoStatus === 'pending'; }) && !(delivery && delivery.isActive())) map.fit(overviewPoints());
  }

  function keyOf(item) {
    return window.RouteAddress.stopKey(item.address, settings.defaultCity);
  }

  // 同一站已經手動指定過位置，新加進來的件直接用那個位置，不另外查。
  function locatePending() {
    var changed = false;
    items.forEach(function (item) {
      if (item.geoStatus !== 'pending') return;
      var manual = items.filter(function (other) { return other.geoStatus === 'manual' && keyOf(other) === keyOf(item); })[0];
      if (manual) {
        item.lat = manual.lat;
        item.lng = manual.lng;
        item.geoStatus = 'manual';
        item.geoAt = null;
        changed = true;
      } else {
        locate(item);
      }
    });
    if (changed) {
      persist();
      render();
    }
  }

  function resetPosition(item) {
    item.lat = null;
    item.lng = null;
    item.geoStatus = 'pending';
    item.geoAt = null;
    item.geoRoute = null;
    item.roadOk = false;
  }

  // 地址查詢找到的位置超過 30 天（或是舊版查的、沒有時間）就要重查。
  function tooOld(item) {
    if (item.geoStatus !== 'house' && item.geoStatus !== 'street') return false;
    if (item.geoRoute === null) return true; // 舊版查的，沒有路名可以比對
    return item.geoAt === null || Date.now() - item.geoAt > KEEP_MS;
  }

  // ---- 今天地址查詢用了幾次 ----

  function showUsage(info) {
    usageEl.hidden = false;
    usageEl.classList.toggle('used-up', info.used >= info.limit);
    usageEl.textContent = '今天地址查詢已用 ' + info.used + ' / ' + info.limit + ' 次';
  }

  function showUsageError() {
    usageEl.hidden = false;
    usageEl.classList.remove('used-up');
    usageEl.textContent = '今天地址查詢次數讀取不到，請確認網路連線';
  }

  window.addEventListener('route-usage', function (event) {
    if (event.detail) showUsage(event.detail);
  });

  // ---- 在地圖上指定位置 ----

  // 在地圖上點一下：顯示上方提示，點到之後交給 onPicked。地圖用不了回傳 false。
  function pickOnMap(key, text, onPicked) {
    var started = map.pick(function (lat, lng) {
      stopPicking();
      onPicked(lat, lng);
    });
    if (!started) {
      window.alert('地圖目前用不了，沒辦法在地圖上點。請從網址打開並確認網路連線。');
      return false;
    }
    pickingKey = key;
    pickText.textContent = text;
    pickBanner.hidden = false;
    document.querySelector('.map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  // 一站裡的每一件一起移到點的位置（併起來的站整站一起動）。
  function startPicking(stop) {
    var key = stop.key;
    pickOnMap(key, '在地圖上點一下「' + stop.title + '」的位置。', function (lat, lng) {
      var targets = items.filter(function (i) { return keyOf(i) === key; });
      if (!targets.length) return;
      targets.forEach(function (target) {
        target.lat = lat;
        target.lng = lng;
        target.geoStatus = 'manual';
        target.geoAt = null;
      });
      persist();
      render();
    });
  }

  function stopPicking() {
    map.cancelPick();
    pickingKey = null;
    pickBanner.hidden = true;
  }

  // ---- 畫面 ----

  function itemCard(item, withPosition, status) {
    var li = el('li', 'item' + (withPosition && needsAttention(status) ? ' attention' : ''));
    li.setAttribute('data-testid', 'item');
    if (withPosition) decorateStop(li, withPosition);
    li.appendChild(el('div', 'item-address', item.address));
    var typo = window.RouteAddress.suspicious(item.address);
    if (typo.length) {
      var note = el('div', 'typo-note', '地址可能有錯字：' + typo.join('、'));
      note.setAttribute('data-testid', 'typo-note');
      li.appendChild(note);
    }
    var road = roadNote(item);
    if (road) li.appendChild(road);
    var meta = el('div', 'item-meta');
    meta.appendChild(el('span', 'tag' + (item.type === 'office' ? ' office' : ''), TYPE_LABEL[item.type] || TYPE_LABEL.home));
    if (item.timeWindow) meta.appendChild(el('span', '', item.timeWindow));
    if (item.orderNo) meta.appendChild(el('span', 'order-no', item.orderNo));
    li.appendChild(meta);
    if (withPosition) li.appendChild(geoLine(status));
    var actions = el('div', 'item-actions');
    if (withPosition) addPositionButton(actions, withPosition, status);
    actions.appendChild(button('修改', '', function () { openForm(item); }));
    actions.appendChild(button('刪除', 'danger', function () { removeItem(item); }));
    li.appendChild(actions);
    return li;
  }

  function geoLine(status) {
    var geo = el('div', 'geo-status status-' + status, STATUS_TEXT[status]);
    geo.setAttribute('data-testid', 'geo-status');
    return geo;
  }

  function addPositionButton(actions, stop, status) {
    if (needsAttention(status)) {
      actions.appendChild(button('在地圖上指定', 'primary', function () { startPicking(stop); }));
    } else if (stop.position) {
      actions.appendChild(button('調整位置', '', function () { startPicking(stop); }));
    }
  }

  // 併起來的站：一個框，上面是站名、前後棟提醒、位置，裡面一件一件列出。
  function mergedCard(stop, status) {
    var li = el('li', 'stop' + (needsAttention(status) ? ' attention' : ''));
    li.setAttribute('data-testid', 'merged-stop');
    decorateStop(li, stop);
    li.appendChild(el('div', 'stop-title', stop.title + '（' + stop.items.length + ' 件）'));
    var note = el('p', 'stop-reminder', '同一個門牌 ' + stop.items.length + ' 件，可能分前後棟，到現場請確認');
    note.setAttribute('data-testid', 'stop-reminder');
    li.appendChild(note);
    li.appendChild(geoLine(status));
    var actions = el('div', 'item-actions');
    addPositionButton(actions, stop, status);
    if (actions.childNodes.length) li.appendChild(actions);
    var inner = el('ol', 'item-list stop-items');
    stop.items.forEach(function (item) { inner.appendChild(itemCard(item, null)); });
    li.appendChild(inner);
    return li;
  }

  // 依清單順序把同一站的件放在一起。
  function buildStops(far) {
    var stops = [];
    var byKey = {};
    items.forEach(function (item) {
      var key = keyOf(item);
      if (!byKey[key]) {
        byKey[key] = { key: key, items: [] };
        stops.push(byKey[key]);
      }
      byKey[key].items.push(item);
    });
    stops.forEach(function (stop) {
      var statuses = stop.items.map(function (item) { return displayStatus(item, far); });
      // 整站的狀態：有一件要處理就整站要處理，其次是還在查，否則看第一件。
      stop.status = statuses.filter(needsAttention)[0] ||
        (statuses.indexOf('pending') >= 0 ? 'pending' : statuses[0]);
      stop.position = stop.items.filter(hasPosition)[0] || null;
      stop.red = stop.items.some(function (item) { return far[item.id]; });
      stop.office = stop.items.some(function (item) { return item.type === 'office'; });
      stop.title = stop.items.length > 1
        ? window.RouteAddress.stopLabel(stop.items[0].address, settings.defaultCity)
        : stop.items[0].address;
    });
    return stops;
  }

  function render() {
    var far = farIds();
    var stops = buildStops(far);
    var sequence = arrange(stops);
    listEl.textContent = '';
    attentionList.textContent = '';
    var redCount = 0;
    sequence.list.forEach(function (stop) {
      var red = needsAttention(stop.status);
      if (red) redCount += stop.items.length;
      var node = stop.items.length > 1 ? mergedCard(stop, stop.status) : itemCard(stop.items[0], stop, stop.status);
      (red ? attentionList : listEl).appendChild(node);
    });
    attentionSection.hidden = redCount === 0;
    attentionCount.textContent = redCount ? '還有 ' + redCount + ' 件要處理' : '沒有要處理的地址';
    attentionCount.classList.toggle('has-attention', redCount > 0);
    attentionCount.hidden = items.length === 0;
    countEl.textContent = '共 ' + items.length + ' 件，' + stops.length + ' 站';
    emptyEl.hidden = items.length > 0;
    newTripBtn.hidden = items.length === 0;
    planActions.hidden = items.length === 0;
    var numberedCount = sequence.list.filter(function (stop) { return stop.number; }).length;
    deliverBtn.hidden = !numberedCount;
    deliverBtn.textContent = delivery && delivery.hasStarted() ? '繼續送貨' : '開始送貨';
    showStartSetting();
    replanHint.hidden = !sequence.changed;

    var points = stops.filter(function (stop) { return stop.position; }).map(function (stop) {
      return { lat: stop.position.lat, lng: stop.position.lng, red: stop.red, office: stop.office, number: stop.number, label: stop.title };
    });
    if (route && route.start) points.push({ lat: route.start.lat, lng: route.start.lng, start: true, number: '起', label: '起點' });
    if (delivery && delivery.isActive()) delivery.render();
    else map.setPoints(points);
  }

  // 出發前畫面的地圖要看到的點：所有有位置的站和起點。
  function overviewPoints() {
    var points = currentStops().filter(function (stop) { return stop.position; }).map(function (stop) { return stop.position; });
    if (route && route.start) points.push(route.start);
    return points;
  }

  // ---- 排路線 ----

  // 可以排進路線的站：有位置、而且不是標紅的。
  function routable(stop) {
    return Boolean(stop.position) && !needsAttention(stop.status);
  }

  // 決定清單順序和號碼。排過路線時照排好的順序，之後新出現的站接在最後面。
  // changed 表示排好之後清單有變動（多了或少了站），要提示可以重排。
  function arrange(stops) {
    stops.forEach(function (stop) { stop.number = null; });
    if (!route) return { list: stops, changed: false };
    var byKey = {};
    stops.forEach(function (stop) { byKey[stop.key] = stop; });
    var numbered = [];
    var removed = false;
    route.order.forEach(function (key) {
      var stop = byKey[key];
      if (stop && routable(stop)) numbered.push(stop);
      else removed = true;
    });
    var added = stops.filter(function (stop) { return routable(stop) && numbered.indexOf(stop) < 0; });
    numbered = numbered.concat(added);
    numbered.forEach(function (stop, index) {
      stop.number = index + 1;
      stop.total = numbered.length;
    });
    var rest = stops.filter(function (stop) { return numbered.indexOf(stop) < 0; });
    return { list: numbered.concat(rest), changed: removed || added.length > 0 };
  }

  function currentStops() {
    return buildStops(farIds());
  }

  function saveRoute() {
    window.TripStore.saveRoute(route);
  }

  function planFrom(start) {
    hideStartChoice();
    settings.lastStart = start;
    window.TripStore.saveSettings(settings);
    var stops = currentStops().filter(routable);
    var order = window.RoutePlanner.plan(start, stops.map(function (stop) {
      return { key: stop.key, lat: stop.position.lat, lng: stop.position.lng };
    }));
    route = { order: order, start: start, manual: false };
    saveRoute();
    planStatus.hidden = true;
    render();
    map.fit(stops.map(function (stop) { return stop.position; }).concat([start]));
  }

  function showStartChoice(text) {
    planStatus.hidden = true;
    startChoiceText.textContent = text;
    lastStartBtn.hidden = !settings.lastStart;
    startChoice.hidden = false;
  }

  function hideStartChoice() {
    startChoice.hidden = true;
  }

  function storeQuery() {
    return window.RouteAddress.buildQuery(CONFIG.startAddress || '', settings.defaultCity);
  }

  function showStartSetting() {
    var where = settings.storePoint ? '位置手動指定' :
      window.RouteAddress.stopLabel(CONFIG.startAddress || '', settings.defaultCity);
    startText.textContent = '出發點：' + STORE_NAME + '（' + where + '）';
  }

  // 從智取店出發：手動調整過就用調整的位置，否則查智取店的地址（查過的會記住）。
  function planFromStore() {
    var storeMissing = '找不到' + STORE_NAME + '的位置（可能是連線問題或今天查詢次數用完）。要從哪裡出發？';
    if (settings.storePoint) {
      planFrom(settings.storePoint);
      return;
    }
    if (!CONFIG.startAddress) {
      showStartChoice(storeMissing);
      return;
    }
    planStatus.textContent = '正在找' + STORE_NAME + '的位置…';
    planStatus.hidden = false;
    window.RouteGeocoder.geocode(storeQuery()).then(function (result) {
      if (result) planFrom({ lat: result.lat, lng: result.lng });
      else showStartChoice(storeMissing);
    }, function () {
      showStartChoice(storeMissing);
    });
  }

  function planFromHere() {
    var noGps = '拿不到手機的位置（可能沒開定位，或沒有允許這個網頁使用位置）。要從哪裡出發？';
    if (!navigator.geolocation) {
      showStartChoice(noGps);
      return;
    }
    planStatus.textContent = '正在取得你現在的位置…';
    planStatus.hidden = false;
    navigator.geolocation.getCurrentPosition(function (position) {
      planFrom({ lat: position.coords.latitude, lng: position.coords.longitude });
    }, function () {
      showStartChoice(noGps);
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  // fromHere 為 true 時從手機現在的位置出發，否則從智取店出發。
  function startPlanning(fromHere) {
    var stops = currentStops();
    var waiting = stops.filter(function (stop) { return stop.status === 'pending'; }).length;
    if (waiting) {
      window.alert('還有 ' + waiting + ' 站在查詢位置，請等查完再排路線。');
      return;
    }
    var red = stops.filter(function (stop) { return needsAttention(stop.status); })
      .reduce(function (sum, stop) { return sum + stop.items.length; }, 0);
    if (route && route.manual && !window.confirm('你手動調過順序，重新排會蓋掉，改回工具算的順序。\n確定要重新排嗎？')) return;
    if (red && !window.confirm('還有 ' + red + ' 件地址要處理（標紅的），這些件不會排進路線。\n要先排其他站嗎？')) return;
    if (!stops.some(routable)) {
      window.alert('還沒有找到位置的站，沒辦法排路線。');
      return;
    }
    hideStartChoice();
    if (fromHere === true) planFromHere();
    else planFromStore();
  }

  // 把一站移到新的位置（位置是號碼減一）。
  function moveStop(key, toIndex) {
    var numbered = arrange(currentStops()).list.filter(function (stop) { return stop.number; });
    var keys = numbered.map(function (stop) { return stop.key; });
    var from = keys.indexOf(key);
    if (from < 0 || toIndex < 0 || toIndex >= keys.length || from === toIndex) return;
    keys.splice(toIndex, 0, keys.splice(from, 1)[0]);
    route.order = keys;
    route.manual = true; // 手動調過，重新排之前要先確認
    saveRoute();
    render();
  }

  // 有號碼的站：左上角號碼、辦公室顏色、往上往下按鈕、拖曳把手。
  function decorateStop(li, stop) {
    if (stop.office) li.classList.add('office-stop');
    if (!stop.number) return;
    li.setAttribute('data-route-key', stop.key);
    var bar = el('div', 'order-bar');
    var badge = el('span', 'stop-number', String(stop.number));
    badge.setAttribute('data-testid', 'stop-number');
    bar.appendChild(badge);
    var tools = el('div', 'order-tools');
    var up = button('往上', 'small', function () { moveStop(stop.key, stop.number - 2); });
    up.disabled = stop.number === 1;
    var down = button('往下', 'small', function () { moveStop(stop.key, stop.number); });
    down.disabled = stop.number === stop.total;
    var handle = button('≡', 'small handle', function () {});
    handle.setAttribute('aria-label', '按住拖曳調整順序');
    handle.title = '按住拖曳調整順序';
    enableDrag(handle, li, stop.key);
    tools.appendChild(up);
    tools.appendChild(down);
    tools.appendChild(handle);
    bar.appendChild(tools);
    li.appendChild(bar);
  }

  // 按住把手上下拖，放開時移到手指所在的那一站的位置。
  function enableDrag(handle, li, key) {
    handle.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      li.classList.add('dragging');
      var target = null;
      function over(e) {
        // 拖到畫面上下邊緣時自動捲動，才拖得到畫面外的站。
        var edge = 70;
        var step = e.clientY < edge ? -14 : e.clientY > window.innerHeight - edge ? 14 : 0;
        if (step) {
          window.scrollBy(0, step);
          var panel = document.querySelector('.list-panel');
          if (panel) panel.scrollTop += step;
        }
        var hit = document.elementFromPoint(e.clientX, e.clientY);
        var row = hit && hit.closest ? hit.closest('#item-list > li[data-route-key]') : null;
        if (target && target !== row) target.classList.remove('drop-target');
        target = row && row !== li ? row : null;
        if (target) target.classList.add('drop-target');
      }
      function done() {
        handle.removeEventListener('pointermove', over);
        handle.removeEventListener('pointerup', done);
        handle.removeEventListener('pointercancel', cancel);
        li.classList.remove('dragging');
        if (!target) return;
        var rows = Array.prototype.slice.call(listEl.querySelectorAll(':scope > li[data-route-key]'));
        var toIndex = rows.indexOf(target);
        target.classList.remove('drop-target');
        moveStop(key, toIndex);
      }
      function cancel() {
        target = null;
        done();
      }
      handle.addEventListener('pointermove', over);
      handle.addEventListener('pointerup', done);
      handle.addEventListener('pointercancel', cancel);
    });
  }

  planBtn.addEventListener('click', function () { startPlanning(false); });
  document.getElementById('plan-here-btn').addEventListener('click', function () { startPlanning(true); });
  document.getElementById('replan-btn').addEventListener('click', function () { startPlanning(false); });
  document.getElementById('store-adjust').addEventListener('click', function () {
    pickOnMap('__store__', '在地圖上點一下' + STORE_NAME + '的位置。', function (lat, lng) {
      settings.storePoint = { lat: lat, lng: lng };
      window.TripStore.saveSettings(settings);
      showStartSetting();
    });
  });
  lastStartBtn.addEventListener('click', function () {
    if (settings.lastStart) planFrom(settings.lastStart);
  });
  document.getElementById('pick-start').addEventListener('click', function () {
    hideStartChoice();
    pickOnMap('__start__', '在地圖上點一下這一趟的起點。', function (lat, lng) {
      planFrom({ lat: lat, lng: lng });
    });
  });
  document.getElementById('start-cancel').addEventListener('click', hideStartChoice);

  // ---- 新增、修改、刪除 ----

  function removeItem(item) {
    if (!window.confirm('要刪除「' + item.address + '」這一件嗎？')) return;
    if (pickingKey === keyOf(item) && items.filter(function (o) { return keyOf(o) === pickingKey; }).length === 1) stopPicking();
    items = items.filter(function (other) { return other.id !== item.id; });
    persist();
    render();
  }

  function openForm(item) {
    form.reset();
    addressError.hidden = true;
    editingId = item ? item.id : null;
    dialogTitle.textContent = item ? '修改這一件' : '新增一件';
    if (item) {
      Object.keys(FORM_FIELDS).forEach(function (key) { FORM_FIELDS[key].value = item[key]; });
    }
    dialog.showModal();
    fAddress.focus();
  }

  document.getElementById('add-btn').addEventListener('click', function () { openForm(null); });
  document.getElementById('cancel-btn').addEventListener('click', function () { dialog.close(); });
  document.getElementById('pick-cancel').addEventListener('click', stopPicking);

  // ---- 地址錯字提醒 ----

  // 路名跟 Google 認定的不一樣（例如打成「凝範路」，Google 找到的是「寧範路」）時，卡片上標黃，給一個一按就改的按鈕。
  // 只差一個字（多半是同音打錯）才給「改成○○路」；差很多時 Google 多半是猜錯，只給修改。
  function roadNote(item) {
    var diff = roadDiff(item);
    if (!diff) return null;
    var text = diff.missing
      ? 'Google 找不到' + (diff.typed ? '「' + diff.typed + '」' : '') + '這條路，地圖上的位置可能是錯的'
      : diff.close
      ? 'Google 找到的是「' + diff.google + '」，你打的是「' + diff.typed + '」'
      : 'Google 找到的是「' + diff.google + '」，跟你打的「' + diff.typed + '」差很多，地圖上的位置可能是錯的';
    var note = el('div', 'typo-note road-note');
    note.setAttribute('data-testid', 'road-note');
    note.appendChild(el('span', '', text));
    var buttons = el('div', 'road-buttons');
    note.appendChild(buttons);
    buttons.appendChild(button(diff.missing ? '地址沒錯' : '路名沒錯', 'small', function () {
      item.roadOk = true;
      persist();
      render();
    }));
    if (diff.missing || !diff.close) {
      buttons.insertBefore(button('修改', 'small', function () { openForm(item); }), buttons.firstChild);
      return note;
    }
    buttons.insertBefore(button('改成' + diff.google, 'small', function () {
      if (item.address.indexOf(diff.typed) < 0) {
        openForm(item);
        return;
      }
      item.address = item.address.replace(diff.typed, diff.google);
      resetPosition(item);
      persist();
      render();
      locatePending();
    }), buttons.firstChild);
    return note;
  }

  var typoDialog = document.getElementById('typo-dialog');
  var skipTypoCheck = false;

  function showTypoWarning(address, reasons) {
    document.getElementById('typo-address').textContent = address;
    var list = document.getElementById('typo-reasons');
    list.textContent = '';
    reasons.forEach(function (reason) { list.appendChild(el('li', '', reason)); });
    typoDialog.showModal();
  }

  document.getElementById('typo-back').addEventListener('click', function () {
    typoDialog.close();
    fAddress.focus();
  });
  document.getElementById('typo-save').addEventListener('click', function () {
    typoDialog.close();
    skipTypoCheck = true;
    saveForm();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    skipTypoCheck = false;
    saveForm();
  });

  function saveForm() {
    var typed = {};
    Object.keys(FORM_FIELDS).forEach(function (key) { typed[key] = FORM_FIELDS[key].value; });
    var existing = items.filter(function (other) { return other.id === editingId; })[0];
    var newId = makeId();
    var values = window.TripStore.normalizeItem(typed, existing ? existing.id : newId);
    if (!values) {
      addressError.hidden = false;
      fAddress.focus();
      return;
    }
    var reasons = window.RouteAddress.suspicious(values.address);
    var unchanged = existing && existing.address === values.address;
    if (reasons.length && !skipTypoCheck && !unchanged) {
      showTypoWarning(values.address, reasons);
      return;
    }
    skipTypoCheck = false;
    if (existing && existing.address === values.address) {
      // 地址沒改，位置照舊。
      values.lat = existing.lat;
      values.lng = existing.lng;
      values.geoStatus = existing.geoStatus;
      values.geoAt = existing.geoAt;
      values.geoRoute = existing.geoRoute;
      values.roadOk = existing.roadOk;
    }
    if (existing) {
      items[items.indexOf(existing)] = values;
    } else {
      items.push(values);
    }
    persist();
    dialog.close();
    render();
    locatePending();
  }

  function makeId() {
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---- 匯入截圖 ----

  var importFile = document.getElementById('import-file');
  var importStatus = document.getElementById('import-status');
  var importProgress = document.getElementById('import-progress');
  var importResult = document.getElementById('import-result');
  var importing = false;

  function showImportProgress(text) {
    importStatus.hidden = false;
    importResult.hidden = true;
    importProgress.hidden = false;
    importProgress.textContent = text;
  }

  // 一張一張認字，全部認完再整理、加進清單。截圖只在這支手機上處理。
  function runImport(files) {
    if (!files.length || importing) return;
    importing = true;
    var pages = [];
    var emptyPages = [];
    var chain = Promise.resolve();
    files.forEach(function (file, index) {
      chain = chain.then(function () {
        var label = '正在認字：第 ' + (index + 1) + ' / ' + files.length + ' 張';
        showImportProgress(label);
        return window.RouteOCR.recognize(file, function (message) {
          if (!message || !message.status) return;
          if (/load|initializ/.test(message.status) && !/recogniz/.test(message.status)) {
            importProgress.textContent = label + '（第一次使用要下載認字資料，約 2 MB，請稍候）';
          } else if (/recogniz/.test(message.status) && typeof message.progress === 'number') {
            importProgress.textContent = label + '（' + Math.round(message.progress * 100) + '%）';
          }
        });
      }).then(function (text) {
        var cards = window.RouteImport.parse(text);
        if (!cards.length) emptyPages.push(index + 1);
        pages.push(cards);
      });
    });
    chain.then(function () {
      finishImport(pages, emptyPages);
    }, function () {
      showImportProgress('認字失敗，清單沒有變動。請確認網路連線後再試一次（第一次使用需要網路下載認字資料）。');
      importResult.hidden = false;
      importResult.textContent = '';
      importResult.appendChild(button('知道了', '', function () { importStatus.hidden = true; }));
    }).then(function () {
      importing = false;
    });
  }

  function finishImport(pages, emptyPages) {
    var merged = window.RouteImport.merge(pages);
    var added = 0;
    var skipped = 0;
    var typo = 0;
    merged.items.forEach(function (card) {
      var already = items.some(function (item) {
        return card.orderNo ? item.orderNo === card.orderNo : item.address === card.address;
      });
      if (already) {
        skipped += 1;
        return;
      }
      var values = window.TripStore.normalizeItem({
        address: card.address, type: card.type, timeWindow: card.timeWindow, orderNo: card.orderNo
      }, makeId());
      if (!values) return;
      items.push(values);
      added += 1;
      if (window.RouteAddress.suspicious(values.address).length) typo += 1;
    });
    persist();
    render();
    locatePending();

    importProgress.hidden = true;
    importResult.hidden = false;
    importResult.textContent = '';
    var count = el('p', 'import-count', '認出 ' + merged.items.length + ' 件，加進清單 ' + added + ' 件。請跟開櫃時看到的件數對照。');
    count.setAttribute('data-testid', 'import-count');
    importResult.appendChild(count);
    var notes = el('ul', 'import-notes');
    function note(text, warn) { notes.appendChild(el('li', warn ? 'warn' : '', text)); }
    if (merged.duplicates) note('重複截到的 ' + merged.duplicates + ' 件已自動去掉。');
    if (skipped) note('已經在清單裡的 ' + skipped + ' 件沒有重複加。');
    emptyPages.forEach(function (n) { note('第 ' + n + ' 張截圖沒認出任何一件，請確認是不是「待執行」清單。', true); });
    if (merged.noAddress.length) note('這些訂單認不出地址，請按「新增一件」手動補上：' + merged.noAddress.join('、'), true);
    if (merged.noOrder.length) note('這些件看不到訂單編號，請確認：' + merged.noOrder.join('、'), true);
    if (typo) note(typo + ' 件地址可能有錯字，已標黃色，請檢查。', true);
    if (notes.childNodes.length) importResult.appendChild(notes);
    importResult.appendChild(button('知道了', '', function () { importStatus.hidden = true; }));
  }

  document.getElementById('import-btn').addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    var files = Array.prototype.slice.call(importFile.files || []);
    importFile.value = '';
    runImport(files);
  });

  // ---- 開始新的一趟 ----

  // 清掉這一趟的清單、路線順序、送貨狀態。設定（預設城市、出發點）和查過的地址位置保留。
  function startNewTrip() {
    if (!window.confirm('要清掉這一趟的 ' + items.length + ' 件、路線順序和送貨狀態，開始新的一趟嗎？\n出發點、預設城市和查過的地址位置會保留。')) return;
    stopPicking();
    hideStartChoice();
    items = [];
    route = null;
    persist();
    saveRoute();
    delivery.reset();
    render();
  }

  // ---- 預設城市 ----

  citySelect.value = settings.defaultCity;
  if (citySelect.value !== settings.defaultCity) citySelect.value = '臺北市';
  citySelect.addEventListener('change', function () {
    settings.defaultCity = citySelect.value;
    window.TripStore.saveSettings(settings);
    // 沒寫縣市、也不是手動指定的件，用新的城市重查。
    items.forEach(function (item) {
      if (!window.RouteAddress.findCity(item.address) && item.geoStatus !== 'manual') resetPosition(item);
    });
    persist();
    render();
    locatePending();
  });

  // 上次查詢失敗、次數用完、找不到，或位置已超過 30 天的，重開時再問一次地址查詢。
  // 找不到的結果地址查詢會記住，所以 30 天內不會真的再送出去。
  items.forEach(function (item) {
    if (item.geoStatus === 'failed' || item.geoStatus === 'limit' || item.geoStatus === 'notfound' || tooOld(item)) resetPosition(item);
  });
  persist();
  if (location.protocol !== 'file:') {
    window.RouteGeocoder.usage().then(function (info) {
      if (info) showUsage(info);
    }, showUsageError);
  }
  // ---- 送貨中畫面、放大地圖 ----

  delivery = window.RouteDelivery.create({
    map: map,
    stops: function () {
      return arrange(currentStops()).list.filter(function (stop) { return stop.number; });
    },
    onNewTrip: function () { startNewTrip(); },
    onShow: function (show) {
      document.body.classList.toggle('delivering', show);
      if (!show) {
        render();
        map.fit(overviewPoints());
      }
    }
  });
  deliverBtn.addEventListener('click', function () { delivery.enter(); });
  document.getElementById('new-trip-btn').addEventListener('click', startNewTrip);

  mapToggle.addEventListener('click', function () {
    var full = !document.body.classList.contains('map-full');
    document.body.classList.toggle('map-full', full);
    mapToggle.textContent = full ? '縮小地圖' : '放大地圖';
    // 等版面換好再縮放到看得到所有點。
    window.setTimeout(function () {
      if (delivery.isActive()) delivery.fitAll();
      else map.fit(overviewPoints());
    }, 50);
  });

  render();
  map.fit(overviewPoints()); // 排過路線的話連起點一起看得到
  locatePending();
  delivery.resumeIfActive();
})();
