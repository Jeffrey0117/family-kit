const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const create = require("../index");
const { parseRegDisplayNames, parseRegValues, matchInstalledEntry, exeFromDisplayIcon, pickAsset, selectApps } = create;

const REG_OUT = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\53850cc5-f1d1-5de4-99ef-480ede9da1f9
    DisplayName    REG_SZ    DuckShot 1.1.2

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AAAA}
    DisplayName    REG_SZ    DuckShotter Pro

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{BBBB}
    DisplayName    REG_SZ    Repic 0.6.0

End of search: 3 match(es) found.
`;

test("parseRegDisplayNames：key 與 DisplayName 配對", () => {
  const entries = parseRegDisplayNames(REG_OUT);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].displayName, "DuckShot 1.1.2");
  assert.match(entries[0].key, /53850cc5/);
});

test("matchInstalledEntry：productName 開頭比對，不會誤抓 DuckShotter", () => {
  const entries = parseRegDisplayNames(REG_OUT);
  assert.equal(matchInstalledEntry(entries, "DuckShot").displayName, "DuckShot 1.1.2");
  assert.equal(matchInstalledEntry(entries, "repic").displayName, "Repic 0.6.0"); // 不分大小寫
  assert.equal(matchInstalledEntry(entries, "ReVid"), null);
});

test("parseRegValues 與 exeFromDisplayIcon", () => {
  const out = `
HKEY_CURRENT_USER\\...\\53850cc5
    DisplayName    REG_SZ    DuckShot 1.1.2
    DisplayVersion    REG_SZ    1.1.2
    DisplayIcon    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\DuckShot\\DuckShot.exe,0
    EstimatedSize    REG_DWORD    0x1000
`;
  const v = parseRegValues(out);
  assert.equal(v.DisplayVersion, "1.1.2");
  assert.equal(exeFromDisplayIcon(v.DisplayIcon), "C:\\Users\\u\\AppData\\Local\\Programs\\DuckShot\\DuckShot.exe");
  assert.equal(exeFromDisplayIcon('"C:\\x\\a.exe"'), "C:\\x\\a.exe");
});

test("pickAsset：Windows 挑 -Setup-.exe，略過 blockmap 與 latest.yml", () => {
  const assets = [
    { name: "latest.yml" },
    { name: "Repic-Setup-0.6.0.exe.blockmap" },
    { name: "Repic-Setup-0.6.0.exe", browser_download_url: "u", size: 5 },
  ];
  assert.equal(pickAsset(assets, "win32").name, "Repic-Setup-0.6.0.exe");
  assert.equal(pickAsset(assets, "darwin"), null);
  assert.equal(pickAsset([{ name: "App-1.0.0.dmg" }], "darwin").name, "App-1.0.0.dmg");
});

test("selectApps：遠端 > 快取 > 內建，且排除自己", () => {
  const bundled = { apps: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(selectApps({ remote: null, cached: null, bundled, selfId: "a" }).map((x) => x.id), ["b"]);
  assert.deepEqual(selectApps({ remote: { apps: [{ id: "a" }, { id: "c" }] }, bundled, selfId: "a" }).map((x) => x.id), ["c"]);
  assert.deepEqual(selectApps({ remote: { apps: [] }, cached: { apps: [{ id: "d" }] }, bundled, selfId: "a" }).map((x) => x.id), ["d"]);
});

function fakeFetch(routes) {
  return async (url) => {
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) throw new Error("no route " + url);
    const r = hit[1];
    return { ok: true, status: 200, headers: new Map([["content-length", String(r.bytes ? r.bytes.length : 0)]]), json: async () => r.json, body: r.bytes ? (async function* () { yield r.bytes; })() : null };
  };
}

test("list()：合併已安裝狀態與最新 release；遠端清單寫入快取", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-"));
  const remote = { apps: [{ id: "duckshot", name: "DuckShot", productName: "DuckShot", repo: "J/DuckShot" }, { id: "repic", name: "RePic", productName: "Repic", repo: "J/RePic" }] };
  const fetch = fakeFetch({
    "https://remote/family.json": { json: remote },
    "https://api.github.com/repos/J/RePic/releases/latest": { json: { tag_name: "v0.6.0", assets: [{ name: "Repic-Setup-0.6.0.exe", browser_download_url: "https://dl/x.exe", size: 1234567 }] } },
  });
  const exec = async (cmd, args) => (args.includes("/v") ? REG_OUT : "    DisplayVersion    REG_SZ    1.1.2\n    DisplayIcon    REG_SZ    " + process.execPath + ",0\n");
  const fam = create({ selfId: "duckshot", remoteUrl: "https://remote/family.json", cacheDir, fetch, exec, platform: "win32", bundled: { apps: [] } });

  const apps = await fam.list();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, "repic");
  assert.equal(apps[0].installed.version, "1.1.2"); // 假登錄檔說 Repic 有裝
  assert.equal(apps[0].installed.exe, process.execPath);
  assert.equal(apps[0].latest.version, "0.6.0");
  assert.equal(apps[0].sizeLabel, "1.2 MB");
  assert.ok(fs.existsSync(path.join(cacheDir, "family.json")));
});

test("install()：下載到 cacheDir/installers 並呼叫 shell.openPath，進度有回報", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fk-"));
  const bytes = Buffer.alloc(2048, 1);
  const fetch = fakeFetch({
    "https://api.github.com/repos/J/ReVid/releases/latest": { json: { tag_name: "v0.7.0", assets: [{ name: "ReVid-Setup-0.7.0.exe", browser_download_url: "https://dl/revid.exe", size: 2048 }] } },
    "https://dl/revid.exe": { bytes },
  });
  const opened = [];
  const fam = create({ selfId: "duckshot", remoteUrl: null, cacheDir, fetch, platform: "linux", bundled: { apps: [{ id: "revid", name: "ReVid", repo: "J/ReVid" }] }, shell: { openPath: async (p) => { opened.push(p); return ""; } } });
  const progress = [];
  // 模擬 win32 的 asset 挑選：linux 平台挑不到 .exe，所以這裡直接用 win32
  const famWin = create({ selfId: "duckshot", remoteUrl: null, cacheDir, fetch, platform: "win32", bundled: { apps: [{ id: "revid", name: "ReVid", repo: "J/ReVid" }] }, shell: { openPath: async (p) => { opened.push(p); return ""; } }, exec: async () => "" });

  await assert.rejects(fam.install("revid"), /沒有這個平台的安裝檔/);
  const r = await famWin.install("revid", { onProgress: (p) => progress.push(p) });
  assert.equal(path.basename(r.file), "ReVid-Setup-0.7.0.exe");
  assert.equal(fs.readFileSync(r.file).length, 2048);
  assert.deepEqual(opened, [r.file]);
  assert.equal(progress.at(-1).received, 2048);
});
