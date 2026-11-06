---
name: family-kit
description: Electron app 要「推薦並一鍵安裝同一家的其他桌面 app」（互相導流、方便下載、已裝就變開啟鈕）時用。偵測 Windows 已安裝、抓 GitHub release、下載進度、啟動安裝、雲端 family.json 清單。
---

# family-kit 打法

## 何時觸發
- 使用者說「讓用的人兩個都裝」「互相打廣告」「方便下載姊妹 app」「鴨鴨家族」。
- 任何 Jeffrey0117 的 Electron 桌面 app（DuckShot / RePic / ReVid / ShotBoard…）要加「其他工具」區塊。

## 接線三步（10 分鐘）
1. `npm i github:Jeffrey0117/family-kit`。
2. 主進程 `createFamily({ selfId, cacheDir, shell, fetch: net.fetch })` + `registerIpc(ipcMain, { isTrusted })`；preload 照 README 暴露 `familyKit`。
3. renderer 放一個容器，`FamilyKit.mount(el, window.familyKit, { title })`。

## 放哪裡
- **設定頁最底下**「關於 / 家族」區：主要入口。
- **空狀態**（新使用者第一眼）：一張小卡。
- **不要**放在成功彈窗、通知這種打斷使用者的地方。

## 新增一個 app
只改本 repo 的 `family.json`（push 後所有 app 一小時內看到），不用各 app 發版。欄位 `productName` 必須等於該 app `build.productName`，release 安裝檔要是 `*-Setup-*.exe` 命名。

## 地雷
- `selfId` 要填，否則清單會把自己列進去。
- `cacheDir` 放 `app.getPath("userData")` 底下，別放 app 目錄（asar 唯讀）。
- `isTrusted` 一定要給：install 會寫檔並啟動安裝程式，不能讓任意 webContents 觸發。
- GitHub 匿名 API 60 次/小時：不要在啟動時自動 `list()`，等使用者打開面板。
- 安裝檔未簽章：UAC 會問一次（NSIS 本身），SmartScreen 不會（app 自己寫檔無 MotW）。
