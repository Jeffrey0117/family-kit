# family-kit

Electron app 內的「姊妹 app 一鍵安裝」面板。零依賴（Node 內建 + 呼叫端注入 Electron `shell` / `ipcMain`）。

```
family.json（雲端一份）──► list() ──► 每個 app：已安裝？最新版？
                                   ├─ 已安裝 → 「開啟」（啟動 exe）
                                   ├─ 未安裝 → 「安裝 (12 MB)」→ 下載 GitHub release 安裝檔（進度）→ 啟動安裝程式
                                   └─ 離線   → 「前往下載」
```

重點：

- **偵測已安裝**：掃 Windows Uninstall 登錄檔（HKCU / HKLM / WOW6432Node），比對 electron-builder NSIS 的 `DisplayName = "<productName> <version>"`，從 `DisplayIcon` 拿 exe 路徑。已經裝的人不會一直被推銷。
- **清單放雲端一份**（本 repo 的 `family.json`）：三個 app 啟動時抓一次、本機快取 1 小時、抓不到用快取、再沒有用內建。以後多一個 app 或改文案不用三邊發版。
- **下載不經瀏覽器**：app 自己寫檔，不帶 Mark-of-the-Web，SmartScreen 的「未知發行者」紅牆不會跳（UAC 仍會問一次，那是 NSIS 的）。
- GitHub 匿名 API 每小時 60 次：release 查詢快取 1 小時，只在使用者打開面板時查。

## 安裝

```bash
npm i github:Jeffrey0117/family-kit
```

## 接線（Electron）

### 主進程

```js
const { app, ipcMain, shell, net } = require("electron");
const createFamily = require("family-kit");

const family = createFamily({
  selfId: "duckshot",                       // family.json 裡自己的 id（會從清單排除）
  cacheDir: path.join(app.getPath("userData"), "family-kit"),
  shell,                                    // openPath / openExternal
  fetch: (url, init) => net.fetch(url, init), // 走 Chromium 網路層（企業代理/TLS 攔截環境較穩）
  userAgent: `DuckShot/${app.getVersion()}`,
});

// 一次接好 family:list / family:install / family:open / family:page，進度走 family:progress
family.registerIpc(ipcMain, {
  prefix: "family",
  isTrusted: (sender) => sender === mainWindow.webContents || sender === settingsWindow?.webContents,
});
```

### preload

```js
contextBridge.exposeInMainWorld("familyKit", {
  list: (o) => ipcRenderer.invoke("family:list", o),
  install: (id) => ipcRenderer.invoke("family:install", id),
  open: (id) => ipcRenderer.invoke("family:open", id),
  page: (id) => ipcRenderer.invoke("family:page", id),
  onProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("family:progress", h);
    return () => ipcRenderer.removeListener("family:progress", h);
  },
});
```

### renderer

```html
<div id="family"></div>
<script src="../node_modules/family-kit/renderer.js"></script>
<script>
  FamilyKit.mount(document.getElementById("family"), window.familyKit, {
    title: "鴨鴨家族",
    subtitle: "同一家的工具，一鍵裝好",
  });
</script>
```

`mount()` 回傳 `{ refresh(), destroy() }`。面板的顏色用宿主的 CSS 變數（`--text-primary`、`--background-secondary`、`--primary-blue` …）加後備值，自動跟主題。

## API

| 方法 | 說明 |
|---|---|
| `list({ fresh?, withLatest? })` | 回 `[{ id, name, tagline, repo, homepage, icon, installed: {version, exe} \| null, latest: {version, asset} \| null, latestError, sizeLabel }]` |
| `install(id, { onProgress, signal })` | 下載最新安裝檔到 `cacheDir/installers/`，驗證大小，`shell.openPath` 啟動；同 id 併發只跑一次 |
| `open(id)` | 啟動已安裝的 exe |
| `openPage(id)` | 開 homepage（離線後備） |
| `detectInstalled(app)` / `latestRelease(app)` | 單步，給進階用 |
| `registerIpc(ipcMain, { prefix, isTrusted })` | 接 IPC |

純函式（可測試）：`parseRegDisplayNames`、`parseRegValues`、`matchInstalledEntry`、`exeFromDisplayIcon`、`pickAsset`、`selectApps`。

## family.json 欄位

```json
{ "id": "repic", "name": "RePic", "tagline": "…", "repo": "Jeffrey0117/RePic",
  "productName": "Repic", "appId": "com.repic.app", "homepage": "…", "icon": "https://…png" }
```

- `productName` 要跟該 app `package.json` 的 `build.productName` **完全一致**（登錄檔 DisplayName 就是它）。
- 安裝檔從 GitHub release 最新版的 assets 挑：Windows 優先 `*-Setup-*.exe`（electron-builder 預設命名），略過 `.blockmap`、`latest.yml`。

## 平台

目前只有 Windows 會偵測已安裝（登錄檔）；macOS / Linux 一律視為未安裝，但下載安裝檔（.dmg / .AppImage）照常可用。

## 測試 / 範例

```bash
npm test          # node:test，純邏輯 + 假 fetch 的 list/install
node example.js   # 真打 GitHub API，印出三個 app 的安裝狀態與最新版
```
