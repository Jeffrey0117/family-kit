// ============================================================================
// family-kit — Electron app 內「姊妹 app 一鍵安裝」面板（主進程端核心）
// ----------------------------------------------------------------------------
// 零依賴（node 內建）。factory pattern；Electron 的 shell / ipcMain 由呼叫端注入，
// 純邏輯（登錄檔解析、挑安裝檔、清單合併）全部可在純 Node 下測試。
//
// 流程：list() → 每個姊妹 app 的 { installed, latest }
//       install(id) → 下載 GitHub release 最新安裝檔（進度回報）→ shell.openPath 啟動安裝程式
//       open(id)    → 啟動已安裝的 exe
// ============================================================================
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_REMOTE_URL =
  "https://raw.githubusercontent.com/Jeffrey0117/family-kit/master/family.json";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 清單與 release 都快取 1 小時（GitHub 匿名 API 每小時 60 次）
const GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// 純函式（可測試）
// ---------------------------------------------------------------------------

// 解析 `reg query <root>\Uninstall /s /v DisplayName` 的輸出 → [{ key, displayName }]
function parseRegDisplayNames(output) {
  const entries = [];
  let currentKey = null;
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      currentKey = line.trim();
      continue;
    }
    const m = line.match(/^\s+DisplayName\s+REG_SZ\s+(.*)$/i);
    if (m && currentKey) entries.push({ key: currentKey, displayName: m[1].trim() });
  }
  return entries;
}

// 解析 `reg query <key>` 的輸出（單一 key 的所有值）→ { DisplayVersion, DisplayIcon, ... }
function parseRegValues(output) {
  const values = {};
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const m = rawLine.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/);
    if (m) values[m[1]] = m[3].trim();
  }
  return values;
}

// electron-builder NSIS 的 DisplayName 是「<productName> <version>」；比對 productName 開頭（不分大小寫）
function matchInstalledEntry(entries, productName) {
  const want = String(productName || "").trim().toLowerCase();
  if (!want) return null;
  return (
    entries.find((e) => {
      const n = e.displayName.toLowerCase();
      return n === want || n.startsWith(want + " ");
    }) || null
  );
}

// DisplayIcon 常是 "C:\...\App.exe,0" → 去掉 ",index" 與引號
function exeFromDisplayIcon(icon) {
  if (!icon) return "";
  return String(icon).replace(/,-?\d+$/, "").replace(/^"|"$/g, "").trim();
}

// 從 release assets 挑這個平台的安裝檔
function pickAsset(assets, platform = process.platform) {
  const list = Array.isArray(assets) ? assets : [];
  const tests = {
    win32: (n) => /\.exe$/i.test(n) && !/\.blockmap$/i.test(n),
    darwin: (n) => /\.dmg$/i.test(n),
    linux: (n) => /\.AppImage$/i.test(n),
  };
  const ok = tests[platform] || tests.win32;
  // 優先 "-Setup-" 命名的（electron-builder NSIS 預設）
  const setup = list.find((a) => ok(a.name) && /setup/i.test(a.name));
  return setup || list.find((a) => ok(a.name)) || null;
}

// 遠端清單優先；遠端抓不到用快取；再沒有用內建。回傳的 apps 一律排除 selfId
function selectApps({ remote, cached, bundled, selfId }) {
  const source = remote?.apps?.length ? remote : cached?.apps?.length ? cached : bundled;
  const apps = Array.isArray(source?.apps) ? source.apps : [];
  return apps.filter((a) => a && a.id && a.id !== selfId);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------
module.exports = function create(opts = {}) {
  const selfId = opts.selfId || "";
  const bundled = opts.bundled || require("./family.json");
  const remoteUrl = opts.remoteUrl === null ? null : opts.remoteUrl || DEFAULT_REMOTE_URL;
  const cacheDir = opts.cacheDir; // 必填：放清單快取與下載的安裝檔
  const fetchImpl = opts.fetch || globalThis.fetch;
  const shell = opts.shell; // Electron shell（openPath / openExternal），純 Node 範例可傳假的
  const platform = opts.platform || process.platform;
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const userAgent = opts.userAgent || "family-kit";
  const log = opts.log || (() => {});
  const run = opts.exec || defaultExec;

  if (!cacheDir) throw new Error("family-kit: opts.cacheDir is required");
  if (!fetchImpl) throw new Error("family-kit: no fetch available, pass opts.fetch");

  const listCachePath = path.join(cacheDir, "family.json");
  const installersDir = path.join(cacheDir, "installers");
  let remoteMemo = null; // { at, data }
  const releaseMemo = new Map(); // id -> { at, release }
  const installedMemo = new Map(); // id -> { at, info }
  const inflightInstall = new Map(); // id -> Promise

  async function readJson(file) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async function fetchJson(url, extraHeaders = {}) {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": userAgent, ...extraHeaders },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  // 遠端清單：記憶體 → 磁碟快取（未過期）→ 抓遠端（寫回磁碟）→ 過期快取 → 內建
  async function loadApps({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && remoteMemo && now - remoteMemo.at < ttlMs) {
      return selectApps({ remote: remoteMemo.data, bundled, selfId });
    }
    const cached = await readJson(listCachePath);
    const cachedFresh = cached && typeof cached.fetchedAt === "number" && now - cached.fetchedAt < ttlMs;
    if (!fresh && cachedFresh) {
      remoteMemo = { at: cached.fetchedAt, data: cached };
      return selectApps({ remote: cached, bundled, selfId });
    }
    let remote = null;
    if (remoteUrl) {
      try {
        remote = await fetchJson(remoteUrl);
        remote.fetchedAt = now;
        remoteMemo = { at: now, data: remote };
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(listCachePath, JSON.stringify(remote));
      } catch (e) {
        log("family-kit: remote list failed, falling back:", e.message);
      }
    }
    return selectApps({ remote, cached, bundled, selfId });
  }

  function findApp(apps, id) {
    const app = apps.find((a) => a.id === id);
    if (!app) throw new Error(`family-kit: unknown app "${id}"`);
    return app;
  }

  // Windows：掃 Uninstall 登錄檔（HKCU 與 HKLM 兩邊；electron-builder perMachine:false 寫在 HKCU）
  async function detectInstalled(app) {
    const memo = installedMemo.get(app.id);
    if (memo && Date.now() - memo.at < 60 * 1000) return memo.info;
    let info = null;
    if (platform === "win32") {
      const roots = [
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      ];
      for (const root of roots) {
        let out = "";
        try {
          out = await run("reg", ["query", root, "/s", "/v", "DisplayName"]);
        } catch {
          continue; // 沒有該根鍵或無權限
        }
        const entry = matchInstalledEntry(parseRegDisplayNames(out), app.productName || app.name);
        if (!entry) continue;
        let values = {};
        try {
          values = parseRegValues(await run("reg", ["query", entry.key]));
        } catch {}
        const exe = exeFromDisplayIcon(values.DisplayIcon);
        info = {
          version: values.DisplayVersion || entry.displayName.replace(/^\S+\s*/, "") || "",
          exe: exe && fs.existsSync(exe) ? exe : "",
          installLocation: values.InstallLocation || "",
        };
        break;
      }
    }
    installedMemo.set(app.id, { at: Date.now(), info });
    return info;
  }

  async function latestRelease(app) {
    const memo = releaseMemo.get(app.id);
    if (memo && Date.now() - memo.at < ttlMs) return memo.release;
    const data = await fetchJson(`${GITHUB_API}/repos/${app.repo}/releases/latest`, {
      Accept: "application/vnd.github+json",
    });
    const asset = pickAsset(data.assets, platform);
    const release = {
      version: String(data.tag_name || "").replace(/^v/i, ""),
      tag: data.tag_name || "",
      page: data.html_url || `https://github.com/${app.repo}/releases/latest`,
      asset: asset
        ? { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 }
        : null,
    };
    releaseMemo.set(app.id, { at: Date.now(), release });
    return release;
  }

  // 清單 + 安裝狀態 + 最新版本（release 查詢失敗不影響其他欄位）
  async function list(options = {}) {
    const apps = await loadApps(options);
    return Promise.all(
      apps.map(async (app) => {
        const [installed, latest] = await Promise.all([
          detectInstalled(app).catch(() => null),
          options.withLatest === false ? null : latestRelease(app).catch((e) => ({ error: e.message })),
        ]);
        return {
          id: app.id,
          name: app.name,
          tagline: app.tagline || "",
          repo: app.repo,
          homepage: app.homepage || `https://github.com/${app.repo}`,
          icon: app.icon || "",
          installed,
          latest: latest && !latest.error ? latest : null,
          latestError: latest && latest.error ? latest.error : null,
          sizeLabel: latest && latest.asset ? formatBytes(latest.asset.size) : "",
        };
      })
    );
  }

  // 下載安裝檔（串流 + 進度）→ 啟動安裝程式。同一個 app 同時只跑一次。
  async function install(id, { onProgress, signal } = {}) {
    if (inflightInstall.has(id)) return inflightInstall.get(id);
    const task = (async () => {
      const apps = await loadApps();
      const app = findApp(apps, id);
      const release = await latestRelease(app);
      if (!release.asset) throw new Error(`${app.name} 的最新版本沒有這個平台的安裝檔`);
      await fsp.mkdir(installersDir, { recursive: true });
      const safeName = path.basename(release.asset.name).replace(/[^\w.\-]+/g, "_");
      const file = path.join(installersDir, safeName);
      const partial = file + ".part";

      const res = await fetchImpl(release.asset.url, {
        headers: { "User-Agent": userAgent },
        signal,
        redirect: "follow",
      });
      if (!res.ok || !res.body) throw new Error(`下載失敗 HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || release.asset.size || 0;
      let received = 0;
      const out = fs.createWriteStream(partial);
      try {
        for await (const chunk of res.body) {
          received += chunk.length;
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          if (onProgress) onProgress({ id, received, total });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      } catch (e) {
        out.destroy();
        await fsp.unlink(partial).catch(() => {});
        throw e;
      }
      if (total && received !== total) {
        await fsp.unlink(partial).catch(() => {});
        throw new Error(`下載不完整（${received}/${total} bytes）`);
      }
      await fsp.rename(partial, file);
      installedMemo.delete(id); // 裝完後下次 list 重新偵測
      if (shell && shell.openPath) {
        const err = await shell.openPath(file);
        if (err) throw new Error(`無法啟動安裝程式：${err}`);
      }
      return { id, file, version: release.version };
    })();
    inflightInstall.set(id, task);
    try {
      return await task;
    } finally {
      inflightInstall.delete(id);
    }
  }

  async function open(id) {
    const apps = await loadApps();
    const app = findApp(apps, id);
    const info = await detectInstalled(app);
    if (!info || !info.exe) throw new Error(`${app.name} 尚未安裝`);
    if (!shell || !shell.openPath) throw new Error("family-kit: shell.openPath not available");
    const err = await shell.openPath(info.exe);
    if (err) throw new Error(err);
    return { id, exe: info.exe };
  }

  async function openPage(id) {
    const apps = await loadApps();
    const app = findApp(apps, id);
    const url = app.homepage || `https://github.com/${app.repo}/releases/latest`;
    if (shell && shell.openExternal) await shell.openExternal(url);
    return url;
  }

  // Electron IPC 一次接好：list / install（進度用 `${prefix}:progress` 推回去）/ open / page
  function registerIpc(ipcMain, { prefix = "family", isTrusted } = {}) {
    const guard = (event) => {
      if (isTrusted && !isTrusted(event.sender)) throw new Error("family-kit: untrusted sender");
    };
    ipcMain.handle(`${prefix}:list`, async (event, options) => {
      guard(event);
      return list(options || {});
    });
    ipcMain.handle(`${prefix}:install`, async (event, id) => {
      guard(event);
      const sender = event.sender;
      return install(String(id), {
        onProgress: (p) => {
          try {
            if (!sender.isDestroyed()) sender.send(`${prefix}:progress`, p);
          } catch {}
        },
      });
    });
    ipcMain.handle(`${prefix}:open`, async (event, id) => {
      guard(event);
      return open(String(id));
    });
    ipcMain.handle(`${prefix}:page`, async (event, id) => {
      guard(event);
      return openPage(String(id));
    });
  }

  return { list, install, open, openPage, detectInstalled, latestRelease, registerIpc };
};

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    // windowsHide：Electron 主進程沒有 console，不加會閃黑窗
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout || ""))
    );
  });
}

module.exports.parseRegDisplayNames = parseRegDisplayNames;
module.exports.parseRegValues = parseRegValues;
module.exports.matchInstalledEntry = matchInstalledEntry;
module.exports.exeFromDisplayIcon = exeFromDisplayIcon;
module.exports.pickAsset = pickAsset;
module.exports.selectApps = selectApps;
module.exports.formatBytes = formatBytes;
module.exports.DEFAULT_REMOTE_URL = DEFAULT_REMOTE_URL;
