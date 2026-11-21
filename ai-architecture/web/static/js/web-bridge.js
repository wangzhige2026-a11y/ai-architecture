/* ============================================================
 * web-bridge.js —— 浏览器版桥接层
 * ============================================================
 * 作用：在浏览器里伪造出 window.workspace 对象，
 *       让原本为 Electron 写的前端代码一行都不用改。
 *
 * 桌面版： preload.js 通过 contextBridge 暴露 window.workspace
 * Web 版： 本文件用 fetch + SSE 实现同样的接口面
 *
 * 必须在 api.js 之前加载。
 * ============================================================ */
"use strict";

(function () {
  const API = "";              // 同源部署，留空即可
  const listeners = [];

  /* ---------- SSE：接收后端事件流 ---------- */
  let es = null;
  let retryDelay = 1000;

  function connect() {
    es = new EventSource(API + "/api/events");

    es.onmessage = function (e) {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      retryDelay = 1000;                 // 收到数据说明连接健康，重置退避
      listeners.forEach(function (cb) {
        try { cb(ev); } catch (err) { console.error("事件处理出错", err); }
      });
    };

    es.onerror = function () {
      // 浏览器会自动重连，这里做指数退避兜底，避免后端重启时疯狂刷请求
      if (es) { es.close(); es = null; }
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };
  }

  connect();

  /* ---------- 伪造 window.workspace ---------- */
  window.workspace = {
    /* 发送指令到后端（与桌面版签名一致） */
    invoke: function (cmd, payload) {
      payload = payload || {};
      // 请求级 AI 配置：payload 里若带 ai_override，提升到 body 顶层，
      // 供服务端 set_ai_override 用（用完即弃，不回传、不落盘）
      const body = { cmd: cmd, payload: payload };
      if (payload.ai_override) {
        body.ai_override = payload.ai_override;
        // 从 payload 里移除，避免下游把配置当成业务字段
        delete payload.ai_override;
      }
      return fetch(API + "/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (reply) {
          if (reply && reply.event) {
            listeners.forEach(function (cb) { try { cb(reply.event); } catch (err) { console.error("记录事件处理失败", err); } });
          }
          return reply;
        })
        .catch(function (err) {
          return { ok: false, error: String(err) };
        });
    },

    /* 订阅后端事件 */
    onEvent: function (cb) {
      if (typeof cb === "function") listeners.push(cb);
    },

    /* 读取分析报告 */
    readReportFile: function () {
      return fetch(API + "/api/report")
        .then(function (r) { return r.json(); })
        .catch(function () { return null; });
    },

    /* 列出产出文件 */
    listOutputFiles: function () {
      return fetch(API + "/api/files")
        .then(function (r) { return r.json(); })
        .catch(function () { return []; });
    },

    /* 桌面版是"在资源管理器中显示"，Web 版降级为下载 */
    openPath: function (p) {
      if (!p) return Promise.resolve();
      const name = String(p).split(/[\\/]/).pop();
      window.open(API + "/api/download/" + encodeURIComponent(name), "_blank");
      return Promise.resolve();
    },

    /* 打开外部链接：浏览器原生支持 */
    openExternal: function (url) {
      if (/^https?:\/\//.test(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      return Promise.resolve();
    },

    /* 浏览器无法选择本地目录，返回 null，前端会自动跳过 */
    pickDir: function () {
      return Promise.resolve(null);
    },

    /* Web 版默认开启演示模式，避免评委并发访问打爆知乎 API 配额 */
    isDemo: function () {
      return true;
    },
  };

  console.log("[知筑] Web 桥接已就绪，运行模式：浏览器");
})();
