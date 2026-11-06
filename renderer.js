// family-kit renderer：把「姊妹 app」面板畫進任一容器。純 DOM、無框架、無外部 CSS。
// 用法：FamilyKit.mount(container, api, options)
//   api = { list(), install(id), open(id), page(id), onProgress(cb) }（由 preload / ipcRenderer 包成 Promise）
//   options = { title, subtitle, installLabel, openLabel }
// 顏色全部用 CSS 變數（--text-primary 等）加後備值，自動跟隨宿主主題。
(function (global) {
  const STYLE_ID = "family-kit-style";
  const CSS = `
.fk-wrap{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC",sans-serif;color:var(--text-primary,#222)}
.fk-head{display:flex;align-items:baseline;gap:8px;margin:0 0 8px}
.fk-title{font-size:14px;font-weight:600;margin:0}
.fk-sub{font-size:12px;color:var(--text-secondary,#777)}
.fk-list{display:flex;flex-direction:column;gap:8px}
.fk-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;background:var(--background-secondary,var(--bg-primary,#f6f6f6))}
.fk-icon{width:36px;height:36px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;background:var(--background-tertiary,#e8e8e8);font-weight:700;font-size:16px;overflow:hidden}
.fk-icon img{width:100%;height:100%;object-fit:contain;display:block}
.fk-body{flex:1;min-width:0}
.fk-name{font-weight:600}
.fk-tag{font-size:12px;color:var(--text-secondary,#777);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fk-ver{font-size:11px;color:var(--text-tertiary,#999);margin-left:6px}
.fk-btn{flex:none;padding:6px 12px;border-radius:6px;border:1px solid var(--border-color,#ccc);background:transparent;color:var(--text-primary,#222);cursor:pointer;font-size:12px;min-width:92px}
.fk-btn.primary{background:var(--primary-blue,var(--primary-color,#0080ff));border-color:transparent;color:#fff}
.fk-btn:disabled{opacity:.6;cursor:default}
.fk-bar{height:4px;border-radius:2px;background:var(--background-tertiary,#e2e2e2);margin-top:6px;overflow:hidden}
.fk-bar>i{display:block;height:100%;width:0;background:var(--primary-blue,var(--primary-color,#0080ff));transition:width .15s}
.fk-msg{font-size:11px;color:var(--text-secondary,#777);margin-top:4px}
.fk-msg.err{color:#d33}
`;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mount(container, api, options = {}) {
    ensureStyle();
    const o = {
      title: options.title || "鴨鴨家族",
      subtitle: options.subtitle || "同一家的工具，一鍵裝好",
      installLabel: options.installLabel || "安裝",
      openLabel: options.openLabel || "開啟",
      pageLabel: options.pageLabel || "前往下載",
      installingLabel: options.installingLabel || "下載中…",
    };
    container.innerHTML = "";
    const wrap = el("div", "fk-wrap");
    const head = el("div", "fk-head");
    head.appendChild(el("h4", "fk-title", o.title));
    head.appendChild(el("span", "fk-sub", o.subtitle));
    const listEl = el("div", "fk-list");
    wrap.appendChild(head);
    wrap.appendChild(listEl);
    container.appendChild(wrap);

    const rows = new Map(); // id -> { bar, msg, btn }
    const unsub = api.onProgress
      ? api.onProgress((p) => {
          const r = rows.get(p.id);
          if (!r) return;
          const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
          r.bar.style.display = "";
          r.bar.firstChild.style.width = pct + "%";
          r.msg.textContent = p.total ? `${o.installingLabel} ${pct}%` : o.installingLabel;
        })
      : null;

    function renderRow(app) {
      const row = el("div", "fk-row");
      const icon = el("div", "fk-icon", (app.name || "?").slice(0, 1).toUpperCase());
      if (app.icon) {
        const img = document.createElement("img");
        img.alt = "";
        img.onload = () => { icon.textContent = ""; icon.appendChild(img); };
        img.src = app.icon;
      }
      const body = el("div", "fk-body");
      const name = el("div", "fk-name", app.name);
      const ver = el("span", "fk-ver");
      if (app.installed) ver.textContent = `已安裝 ${app.installed.version || ""}`.trim();
      else if (app.latest) ver.textContent = `v${app.latest.version}`;
      name.appendChild(ver);
      body.appendChild(name);
      body.appendChild(el("div", "fk-tag", app.tagline || ""));
      const bar = el("div", "fk-bar");
      bar.appendChild(el("i"));
      bar.style.display = "none";
      const msg = el("div", "fk-msg");
      body.appendChild(bar);
      body.appendChild(msg);

      const btn = el("button", "fk-btn");
      const canInstall = !app.installed && app.latest && app.latest.asset;
      if (app.installed && app.installed.exe) {
        btn.textContent = o.openLabel;
        btn.onclick = async () => {
          btn.disabled = true;
          try { await api.open(app.id); } catch (e) { msg.className = "fk-msg err"; msg.textContent = e.message || String(e); }
          btn.disabled = false;
        };
      } else if (canInstall) {
        btn.className = "fk-btn primary";
        btn.textContent = app.sizeLabel ? `${o.installLabel} (${app.sizeLabel})` : o.installLabel;
        btn.onclick = async () => {
          btn.disabled = true;
          msg.className = "fk-msg";
          msg.textContent = o.installingLabel;
          try {
            await api.install(app.id);
            msg.textContent = "安裝程式已啟動，照指示完成即可";
            btn.textContent = "已啟動安裝";
          } catch (e) {
            msg.className = "fk-msg err";
            msg.textContent = e.message || String(e);
            btn.disabled = false;
          }
        };
      } else {
        // 沒網路 / 沒 release：退回開網頁
        btn.textContent = o.pageLabel;
        btn.onclick = () => api.page(app.id);
        if (app.latestError) { msg.textContent = "無法取得最新版本（離線？）"; }
      }
      row.appendChild(icon);
      row.appendChild(body);
      row.appendChild(btn);
      rows.set(app.id, { bar, msg, btn });
      return row;
    }

    async function refresh(opts) {
      listEl.innerHTML = "";
      rows.clear();
      const loading = el("div", "fk-msg", "讀取中…");
      listEl.appendChild(loading);
      try {
        const apps = await api.list(opts || {});
        listEl.innerHTML = "";
        if (!apps.length) listEl.appendChild(el("div", "fk-msg", "目前沒有其他 app"));
        for (const app of apps) listEl.appendChild(renderRow(app));
      } catch (e) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", "fk-msg err", "讀取失敗：" + (e.message || e)));
      }
    }

    refresh();
    return { refresh, destroy: () => { if (unsub) unsub(); container.innerHTML = ""; } };
  }

  global.FamilyKit = { mount };
})(typeof window !== "undefined" ? window : globalThis);
