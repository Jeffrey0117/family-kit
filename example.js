// node example.js — 純 Node（不需 Electron）跑一遍：抓遠端清單、偵測已安裝、查最新 release。
// 不會真的下載安裝檔；shell 用假的，只印出會開什麼。
const os = require("os");
const path = require("path");
const create = require("./index");

(async () => {
  const family = create({
    selfId: "duckshot", // 自己是誰，清單裡會排除
    cacheDir: path.join(os.tmpdir(), "family-kit-example"),
    shell: {
      openPath: async (p) => { console.log("[shell.openPath]", p); return ""; },
      openExternal: async (u) => console.log("[shell.openExternal]", u),
    },
    log: console.log,
  });

  const apps = await family.list();
  for (const app of apps) {
    console.log(
      `${app.name.padEnd(18)} installed=${app.installed ? app.installed.version + " @ " + app.installed.exe : "no"}  latest=${app.latest ? app.latest.version + " (" + app.sizeLabel + ")" : "n/a " + (app.latestError || "")}`
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
