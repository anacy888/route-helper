# 中繼伺服器設定步驟

這份說明照 2026-10-13 實際操作的流程整理。Cloudflare 和 Google 的介面會改版，按鈕名稱可能略有不同，找不到就截圖問。

全程用免費方案，不需要買網域、不需要加購任何東西。

## 一、在 Google 建立地址查詢用的金鑰

1. 到 Google 地圖平台後台，左邊「金鑰和憑證」，上方「建立憑證」，選「API 金鑰」。
2. 進入這把新金鑰的編輯頁：
   - 名稱：送貨小幫手 地址查詢
   - 應用程式限制：選「無」。中繼伺服器沒有固定的網路位址，選「網站」會被 Google 擋掉。
   - API 限制：選「限制金鑰」，只勾 Geocoding API。清單裡找不到的話，先到「API 和服務」啟用 Geocoding API。
3. 儲存。
4. 金鑰清單裡應該有兩把：
   - Maps Platform API Key：限制寫「HTTP 參照網址、1 個 API」，給網頁顯示地圖用。
   - 送貨小幫手 地址查詢：限制寫「Geocoding API」，給中繼伺服器用。
5. 地址查詢這把不要貼到對話、GitHub、記事本或任何地方。第五步要用時，再回來按「顯示金鑰」複製。

## 二、註冊 Cloudflare

1. 到 https://dash.cloudflare.com/sign-up 用 email 註冊並收驗證信。
2. 登入後，主畫面中間的「Add a domain」「Protect your app」都不用按。
3. 到右上角人像圖示裡的帳號設定，開啟兩步驟驗證（Two-Factor Authentication）。

## 三、建立中繼伺服器

1. 主畫面按「Create app」。
2. 選 `Start with Hello World!` 這一項。不要選 Connect GitHub 或 Upload your static files。
3. Worker name 填：route-helper-relay
4. 下方的「Protect with Cloudflare Access」保持關閉。打開的話手機查地址時會被要求登入。
5. 按 Deploy。完成後網址是 https://route-helper-relay.（你的帳號名稱）.workers.dev
6. 在 Worker 頁面右上角按「Edit code」，點左邊的 worker.js，在編輯區全選刪掉，貼上這個專案 relay/worker.js 的全部內容，按右上角 Deploy。
7. 右邊預覽顯示「Forbidden」是正常的，代表它拒絕了不是從工具網址來的請求。

## 四、建立記次數的資料存放並連上

1. 在 Cloudflare 的搜尋框輸入 KV，打開 Workers KV，按 Create。
2. Namespace name 填：route-helper-counter，Data location 選 Standard，按 Create。
3. 回到 route-helper-relay，上方分頁選 Settings。
4. Bindings 那一區按「Add binding」，左邊清單選「KV namespace」，按 Add Binding。
5. Variable name 填 COUNTER（全大寫），KV namespace 選 route-helper-counter，按 Add Binding。
6. 出現黃色框「Update your Wrangler configuration」可以直接關掉，那是給用電腦指令部署的人看的。

## 五、存入地址查詢的金鑰

1. 同一個 Settings 頁，Runtime variables and secrets 那一區按「Add variable」。
2. Production 打勾，Previews 不用勾。
3. Key 填 GOOGLE_GEOCODING_KEY（全大寫）。
4. Value 貼上第一步那把地址查詢金鑰。
5. 右邊的 Secret 一定要打勾。
6. 按「Add variable and deploy」。
7. 清單裡應該顯示類型 Secret、值是「Value encrypted」。如果看得到金鑰明碼，代表沒勾 Secret，要刪掉重建，並到 Google 後台換一把新金鑰。

## 六、關掉紀錄（Logs）

1. 同一個 Settings 頁往下，Observability 那一區。
2. 把 Logs 的開關關掉。Traces、Issues 也保持關閉。
3. 原因：紀錄會保存每次請求的網址，而網址裡含有收件地址。關掉之後地址只會被轉送給 Google，不會留在 Cloudflare。
4. 之後如果出問題需要查原因，可以暫時打開，查完再關掉。

## 七、填網址並測試

1. 把中繼伺服器的網址填進這個專案 js/config.js 的 relayUrl（結尾不要加斜線），上傳到 GitHub。
2. 打開 https://anacy888.github.io/route-helper/relay-test.html
3. 上方應顯示「今天已用 0 / 300 次」。輸入一個地址按「查詢」，看到「找到門牌」和緯度經度，次數加一，就代表成功。
4. 每查一次都算進當天的 300 次，臺灣時間午夜重新計算。
