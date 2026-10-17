// 排順序：從起點出發，每一站走到一次，走完最後一站就結束，不回起點。
// 只用直線距離，全部在手機上算，不連網路。
// plan(起點 {lat,lng}, 站 [{ key, lat, lng }]) 交回排好的 key 陣列。
(function (root) {
  'use strict';

  function meters(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function length(start, path) {
    var total = 0;
    var here = start;
    path.forEach(function (stop) {
      total += meters(here, stop);
      here = stop;
    });
    return total;
  }

  // 第一步：每次走去最近、還沒去過的站。
  function nearestFirst(start, stops) {
    var left = stops.slice();
    var path = [];
    var here = start;
    while (left.length) {
      var best = 0;
      for (var i = 1; i < left.length; i += 1) {
        if (meters(here, left[i]) < meters(here, left[best])) best = i;
      }
      here = left.splice(best, 1)[0];
      path.push(here);
    }
    return path;
  }

  // 第二步：把中間某一段倒過來走，如果比較短就換掉，直到再也改不短。
  // 最後一站之後不用回起點，所以倒過來的那段可以一路到最後。
  function untangle(start, path) {
    var points = [start].concat(path);
    var improved = true;
    var rounds = 0;
    while (improved && rounds < 50) {
      improved = false;
      rounds += 1;
      for (var i = 0; i < points.length - 2; i += 1) {
        for (var j = i + 2; j < points.length; j += 1) {
          var a = points[i];
          var b = points[i + 1];
          var c = points[j];
          var d = points[j + 1];
          var before = meters(a, b) + (d ? meters(c, d) : 0);
          var after = meters(a, c) + (d ? meters(b, d) : 0);
          if (after + 0.01 < before) {
            var middle = points.slice(i + 1, j + 1).reverse();
            points = points.slice(0, i + 1).concat(middle, points.slice(j + 1));
            improved = true;
          }
        }
      }
    }
    return points.slice(1);
  }

  function plan(start, stops) {
    if (!stops.length) return [];
    var path = untangle(start, nearestFirst(start, stops));
    return path.map(function (stop) { return stop.key; });
  }

  var api = { plan: plan, length: length, meters: meters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RoutePlanner = api;
})(this);
