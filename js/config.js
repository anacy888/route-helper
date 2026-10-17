// 設定只寫在這裡。
// googleMapsKey：地圖顯示用的 Google 金鑰。它一定會出現在網頁裡，所以在 Google 後台
// 限定只有 https://anacy888.github.io 能用、只能用在 Maps JavaScript API。
// 地址查詢用的金鑰不放在這裡，它只存在中繼伺服器上。
// relayUrl：中繼伺服器的網址（第 09 張設定好 Cloudflare 後填入），結尾不要加斜線。
// startName、startAddress：每一趟出發的智取店。排路線時從這裡出發。
window.ROUTE_CONFIG = {
  startName: '漢中智取店',
  startAddress: '108臺北市萬華區萬壽里漢中街2號1樓',
  relayUrl: 'https://route-helper-relay.anacyk88.workers.dev',
  googleMapsKey: 'AIzaSyBrRHfM5LKz6oCw_oyjW3I1h83xEHKuZ7o'
};
