// 地圖：Google 地圖、標點、在地圖上點一下指定位置。
// Google 地圖是非同步載入的，載好之前收到的標點要求先記著，載好再畫。
(function () {
  'use strict';

  var HOME = { lat: 25.0478, lng: 121.5075 }; // 台北市西區（萬華、大同一帶）
  var COLORS = { normal: '#0b6e69', red: '#b42318', office: '#b45309', start: '#18212b' };
  var READY_CALLBACK = '__routeMapReady';

  function showFallback(text) {
    var fallback = document.getElementById('map-fallback');
    if (text) fallback.textContent = text;
    fallback.hidden = false;
  }

  // 一個圓點標記。用 Google 地圖的自訂圖層做，不需要另外申請地圖樣式編號。
  function makeDotClass(google) {
    function Dot(point) {
      this.position = { lat: point.lat, lng: point.lng };
      this.color = point.color || (point.red ? COLORS.red : point.start ? COLORS.start : point.office ? COLORS.office : COLORS.normal);
      this.kind = point.kind || (point.start ? 'start' : 'stop'); // me 手機位置、current 目前這一站、done、later
      this.title = point.label;
      this.number = point.number === undefined || point.number === null ? null : String(point.number); // 順序號碼，起點是「起」
      this.div = null;
    }
    Dot.prototype = Object.create(google.maps.OverlayView.prototype);
    Dot.prototype.constructor = Dot;
    Dot.prototype.onAdd = function () {
      var div = document.createElement('div');
      div.className = 'map-dot kind-' + this.kind + (this.number ? ' numbered' : '');
      div.style.background = this.color;
      if (this.number) div.textContent = this.number;
      div.title = this.title;
      this.div = div;
      this.getPanes().overlayMouseTarget.appendChild(div);
    };
    Dot.prototype.draw = function () {
      var point = this.getProjection().fromLatLngToDivPixel(new google.maps.LatLng(this.position.lat, this.position.lng));
      if (point && this.div) {
        this.div.style.left = point.x + 'px';
        this.div.style.top = point.y + 'px';
      }
    };
    Dot.prototype.onRemove = function () {
      if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
      this.div = null;
    };
    return Dot;
  }

  function create() {
    // Google 地圖金鑰限定網址，直接點檔案打開時一定會被拒絕，所以不去載。
    if (window.location.protocol === 'file:') {
      document.getElementById('map-file-notice').hidden = false;
      return { setPoints: function () {}, fit: function () {}, pick: function () { return false; }, cancelPick: function () {} };
    }

    var map = null;
    var Dot = null;
    var dots = [];
    var pending = { points: null, fit: null };
    var clickListener = null;

    function setPoints(points) {
      if (!map) { pending.points = points; return; }
      dots.forEach(function (dot) { dot.setMap(null); });
      dots = points.map(function (point) {
        var dot = new Dot(point);
        dot.setMap(map);
        return dot;
      });
    }

    function fit(points) {
      if (!points.length) return;
      if (!map) { pending.fit = points; return; }
      if (points.length === 1) {
        map.setCenter({ lat: points[0].lat, lng: points[0].lng });
        map.setZoom(17);
        return;
      }
      var bounds = new window.google.maps.LatLngBounds();
      points.forEach(function (p) { bounds.extend({ lat: p.lat, lng: p.lng }); });
      map.fitBounds(bounds, 40);
    }

    function cancelPick() {
      if (!clickListener) return;
      clickListener.remove();
      clickListener = null;
      if (map) map.setOptions({ draggableCursor: null });
    }

    function pick(onPicked) {
      if (!map) return false;
      cancelPick();
      clickListener = map.addListener('click', function (event) {
        cancelPick();
        onPicked(event.latLng.lat(), event.latLng.lng());
      });
      map.setOptions({ draggableCursor: 'crosshair' });
      return true;
    }

    window[READY_CALLBACK] = function () {
      var google = window.google;
      Dot = makeDotClass(google);
      map = new google.maps.Map(document.getElementById('map'), {
        center: HOME,
        zoom: 15,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
        gestureHandling: 'greedy'
      });
      if (pending.points) setPoints(pending.points);
      if (pending.fit) fit(pending.fit);
      pending = { points: null, fit: null };
    };
    // Google 發現金鑰有問題（限制不符、沒啟用、帳單問題）時會呼叫這個名字。
    window.gm_authFailure = function () {
      showFallback('地圖金鑰有問題，地圖暫時用不了。請檢查 Google 後台的金鑰限制和帳單設定。清單仍然可以使用。');
    };

    var key = (window.ROUTE_CONFIG && window.ROUTE_CONFIG.googleMapsKey) || '';
    var script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
      '&callback=' + READY_CALLBACK + '&language=zh-TW&region=TW&loading=async&v=weekly';
    script.async = true;
    script.onerror = function () { showFallback(); };
    document.head.appendChild(script);

    return {
      setPoints: setPoints,
      fit: fit,
      pick: pick,
      cancelPick: cancelPick
    };
  }

  window.RouteMap = { create: create };
})();
