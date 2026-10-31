
/* CAMB-BRIDGE v1 — Cambridge <-> toan.b-media.vn: login sync + progress/stars sync.
 *
 * Inlined into the hub and every lesson by bridge/inject_bridge.py (marked block).
 * Dependency-free, defensive: it NEVER throws into the page. If the platform API
 * is unreachable (e.g. the standalone GitHub Pages origin, where /api/* does not
 * exist), the bridge stays dormant and the pages behave exactly as before
 * (localStorage-only progress). One console note maximum.
 *
 * How the token arrives (localStorage is per-origin):
 *   (a) same origin — Cambridge served from the platform server's
 *       public/cambridge/: the platform app already stored the session in
 *       localStorage key "toanlop4_auth_v1"; the bridge just reads it.
 *   (b) fragment handoff — the platform links to Cambridge with #token=<token>
 *       (the pattern its own OAuth flow uses): the bridge stores it under the
 *       same key, in the platform's own storage shape, and strips the fragment.
 *   (c) no token — guest/local mode.
 *
 * API base: relative "/api/..." by default, so it works on ANY origin that is
 * served by / tunnelled to the platform server (toan.b-media.vn/cambridge/,
 * or cambridge.b-media.vn once the tunnel points it at the same server).
 * Set window.CAMB_API_BASE before this script only for exotic setups.
 *
 * Sync model (no lesson rewrites): the bridge OBSERVES the lessons' existing
 * localStorage records — summaries "camb:sum:..." and the battle wallet
 * "camb:wallet" — and reports changes to the platform:
 *   summary change -> POST /api/saga/progress {module, lessonId, pct, q, maxOpen}
 *       pct = combined steps+exercises completion % of the summary;
 *       q   = best quiz fraction (summary q / qt);
 *       maxOpen = the lesson's 1-based position in its book (Science 1 map
 *       embedded below; server only ever raises it).
 *   lesson opened  -> POST /api/saga/theory (once per lesson)
 *   new wallet.botWins[code]  -> POST /api/solo-result, mode "bot"
 *   new wallet.bossWins[key]  -> POST /api/solo-result, mode "boss"
 * The wallet records only THAT a duel/boss was won, never the score, so battle
 * reports encode the win minimally: bot = the duel's 4 questions completed,
 * botId "easy", playerScore 1 / botScore 0 (the win flag); boss = 5/8 correct,
 * bossTier "easy" (5/8 is the smallest score the server's own 60% easy
 * threshold accepts as the win the wallet recorded). The server stays the
 * authority: it recomputes stars and applies its daily caps regardless.
 * Failed posts go to a retry queue in localStorage ("camb:bridge-queue-v1"),
 * flushed on `online`, on load and on visibility return — the same approach
 * (and the same accepted duplicate risk for solo-result) as the platform's
 * own offline queue.
 */
(function () {
  "use strict";
  var AUTH_KEY = "toanlop4_auth_v1";
  var QUEUE_KEY = "camb:bridge-queue-v1";
  var SENT_KEY = "camb:bridge-sent-v1";
  var API_BASE = (typeof window !== "undefined" && window.CAMB_API_BASE) || "";
  var noted = false;
  function note(msg) { if (!noted) { noted = true; try { console.info("[camb-bridge] " + msg); } catch (e) {} } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function parseJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  /* ---------- token intake ---------- */
  function storeToken(token) {
    var cur = parseJson(lsGet(AUTH_KEY) || "null") || {};
    cur.token = token;
    if (!("user" in cur)) cur.user = null;
    cur.savedAt = Date.now();
    lsSet(AUTH_KEY, JSON.stringify(cur));
  }
  (function intakeFragment() {
    try {
      var h = window.location.hash || "";
      var m = h.match(/token=([^&]+)/);
      if (m) {
        storeToken(decodeURIComponent(m[1]));
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }
    } catch (e) {}
  })();
  function getToken() {
    var raw = lsGet(AUTH_KEY);
    if (!raw) return null;
    if (raw.charAt(0) === "{") { var o = parseJson(raw); return (o && o.token) || null; }
    return raw; // tolerate a bare token string
  }

  /* ---------- small state ---------- */
  var token = getToken();
  var user = null;          // window.CAMB_USER once profile loads
  var apiDown = false;      // network-level failure seen (standalone origin etc.)
  function loadSent() { return parseJson(lsGet(SENT_KEY) || "null") || { sums: {}, bot: {}, boss: {}, theory: {} }; }
  function saveSent(s) { lsSet(SENT_KEY, JSON.stringify(s)); }
  function loadQueue() { var q = parseJson(lsGet(QUEUE_KEY) || "null"); return Array.isArray(q) ? q : []; }
  function saveQueue(q) { lsSet(QUEUE_KEY, JSON.stringify(q.slice(-80))); }
  function queuePost(url, body, meta) {
    var q = loadQueue();
    var sig = url + "|" + JSON.stringify(body);
    for (var i = 0; i < q.length; i++) if (q[i].url + "|" + JSON.stringify(q[i].body) === sig) return;
    q.push({ url: url, body: body, at: Date.now(), meta: meta || null });
    saveQueue(q);
  }

  /* ---------- API ---------- */
  function api(path, method, body, keepalive) {
    return new Promise(function (resolve, reject) {
      var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
      var headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = "Bearer " + token;
      fetch(API_BASE + path, {
        method: method || "GET",
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl ? ctl.signal : undefined,
        keepalive: !!keepalive
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (txt) {
          var data = parseJson(txt || "null");
          if (!res.ok) { var err = new Error("HTTP " + res.status); err.status = res.status; err.data = data; throw err; }
          resolve(data);
        });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
  }
  // POST that queues on network failure; resolves true when the server took it.
  function post(path, body, meta, keepalive) {
    return api(path, "POST", body, keepalive).then(function (data) {
      if (data && typeof data.stars === "number" && user) { user.stars = data.stars; renderHubAccount(); }
      return true;
    }).catch(function (e) {
      if (e && e.status === 401) { onUnauthorized(); return false; }
      if (!e || !e.status) { apiDown = true; note("platform API unreachable — staying in local mode, will retry."); }
      queuePost(path, body, meta);
      return false;
    });
  }
  function onUnauthorized() {
    token = null; user = null; window.CAMB_USER = null;
    lsDel(AUTH_KEY);
    note("session expired or invalid — signed out locally.");
    renderHubAccount();
  }

  /* ---------- hub account chip (hub only: lessons have no #starVl) ---------- */
  function platformOrigin() {
    if (typeof window !== "undefined" && window.CAMB_PLATFORM_ORIGIN) return window.CAMB_PLATFORM_ORIGIN;
    return window.location.hostname === "toan.b-media.vn" ? window.location.origin : "https://toan.b-media.vn";
  }
  function renderHubAccount() {
    try {
      var pill = document.getElementById("starVl");
      if (!pill || !pill.parentNode) return; // not the hub — stay invisible
      var chip = document.getElementById("cambAcct");
      if (!chip) {
        chip = document.createElement("div");
        chip.id = "cambAcct";
        chip.style.cssText = "font-size:11px;font-weight:700;color:#fff;background:rgba(255,255,255,.22);" +
          "border-radius:999px;padding:5px 10px;text-align:right;line-height:1.35;max-width:230px";
        pill.parentNode.insertBefore(chip, pill);
      }
      if (user) {
        chip.innerHTML = "";
        var s1 = document.createElement("span");
        s1.textContent = "👤 " + user.username + " · ⭐ " + user.stars;
        chip.appendChild(s1);
      } else if (token && !apiDown) {
        chip.textContent = "…";
      } else if (token && apiDown) {
        chip.textContent = "Chưa nối được máy chủ — tiến trình lưu trên máy này";
      } else {
        chip.innerHTML = "";
        var t = document.createElement("span");
        t.textContent = "Chưa đăng nhập — tiến trình chỉ lưu trên máy này ";
        var a = document.createElement("a");
        a.href = platformOrigin() + "/";
        a.textContent = "Đăng nhập";
        a.style.cssText = "color:#fff;text-decoration:underline;font-weight:800";
        chip.appendChild(t); chip.appendChild(a);
      }
    } catch (e) {}
  }

  /* ---------- sync: summaries -> saga/progress ---------- */
  var SCI1_ORDER = ["1-1","1-2","1-3","1-4","2-1","2-2","2-3","3-1","3-2","3-3","3-4",
    "4-1","4-2","4-3","4-4","5-1","5-2","5-3","5-4","6-1","6-2","6-3","6-4","6-5"];
  function maxOpenFor(module, lessonId) {
    if (module === "sci1") { var i = SCI1_ORDER.indexOf(lessonId); return i >= 0 ? i + 1 : 0; }
    return 0;
  }
  function currentLesson() {
    var m = (window.location.pathname || "").match(/(sci|math)(\d+)-(\d+)-(\d+)-/);
    if (!m) return null;
    return { module: m[1] + m[2], lessonId: m[3] + "-" + m[4], code: m[3] + "." + m[4] };
  }
  function syncSummaries(keepalive) {
    if (!token || !user) return Promise.resolve();
    var sent = loadSent();
    var jobs = [];
    var keys = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf("camb:sum:") === 0) keys.push(k); } } catch (e) {}
    keys.forEach(function (key) {
      var sm = parseJson(lsGet(key) || "null");
      if (!sm) return;
      var idm = key.slice("camb:sum:".length).match(/^(sci|math)(\d+)-(\d+)-(\d+)$/);
      if (!idm) return;
      var module = idm[1] + idm[2], lessonId = idm[3] + "-" + idm[4];
      var s = +sm.s || 0, st = +sm.st || 0, e2 = +sm.e || 0, et = +sm.et || 0, q = +sm.q || 0, qt = +sm.qt || 0;
      if (s + e2 + q <= 0) return; // nothing achieved yet — don't create empty entries
      var hash = [s, st, e2, et, q, qt].join("/");
      if (sent.sums[key] === hash) return;
      var pct = (st + et) > 0 ? Math.round(100 * (s + e2) / (st + et)) : 0;
      var body = { module: module, lessonId: lessonId, pct: pct, q: qt > 0 ? q / qt : 0, maxOpen: maxOpenFor(module, lessonId) };
      jobs.push(post("/api/saga/progress", body, { sumKey: key, hash: hash }, keepalive).then(function (ok) {
        if (ok) { var s2 = loadSent(); s2.sums[key] = hash; saveSent(s2); }
      }));
    });
    return Promise.all(jobs);
  }

  /* ---------- sync: wallet -> solo-result (bot / boss) ---------- */
  function syncWallet(keepalive) {
    if (!token || !user) return Promise.resolve();
    var w = parseJson(lsGet("camb:wallet") || "null");
    if (!w) return Promise.resolve();
    var sent = loadSent();
    var jobs = [];
    var here = currentLesson();
    Object.keys(w.botWins || {}).forEach(function (code) {
      if (!w.botWins[code] || sent.bot[code]) return;
      var pm = String(code).match(/^(\d+)\.(\d+)$/);
      if (!pm) return;
      var module = here ? here.module : "sci1"; // wallet codes carry no book; only sci1 exists today
      var lessonId = pm[1] + "-" + pm[2];
      var body = { score: 4, correct: 4, total: 4, bonus: 0, subject: "science",
        moduleId: module, lessonId: lessonId, lessonTitle: code, mode: "bot",
        botId: "easy", playerScore: 1, botScore: 0, botModule: module, botLesson: lessonId };
      jobs.push(post("/api/solo-result", body, { botCode: code }, keepalive).then(function (ok) {
        if (ok) { var s2 = loadSent(); s2.bot[code] = 1; saveSent(s2); }
      }));
    });
    Object.keys(w.bossWins || {}).forEach(function (bkey) {
      if (!w.bossWins[bkey] || sent.boss[bkey]) return;
      var bm = String(bkey).match(/^(sci|math)(\d+)-u(\d+)$/);
      if (!bm) return;
      var module = bm[1] + bm[2], unitId = "u" + bm[3];
      var body = { score: 5, correct: 5, total: 8, bonus: 0, subject: "science",
        moduleId: module, lessonId: unitId, lessonTitle: "Boss Unit " + bm[3], mode: "boss",
        bossTier: "easy", bossModule: module, bossLesson: unitId };
      jobs.push(post("/api/solo-result", body, { bossKey: bkey }, keepalive).then(function (ok) {
        if (ok) { var s2 = loadSent(); s2.boss[bkey] = 1; saveSent(s2); }
      }));
    });
    return Promise.all(jobs);
  }

  /* ---------- sync: lesson opened -> saga/theory (once) ---------- */
  function syncTheory(keepalive) {
    if (!token || !user) return Promise.resolve();
    var here = currentLesson();
    if (!here) return Promise.resolve();
    var key = here.module + "/" + here.lessonId;
    var sent = loadSent();
    if (sent.theory[key]) return Promise.resolve();
    return post("/api/saga/theory", { module: here.module, lessonId: here.lessonId }, { theoryKey: key }, keepalive)
      .then(function (ok) { if (ok) { var s2 = loadSent(); s2.theory[key] = 1; saveSent(s2); } });
  }

  /* ---------- offline queue flush ---------- */
  function flushQueue() {
    if (!token || !user) return Promise.resolve();
    var q = loadQueue();
    if (!q.length) return Promise.resolve();
    saveQueue([]);
    var chain = Promise.resolve();
    q.forEach(function (item) {
      chain = chain.then(function () {
        return api(item.url, "POST", item.body).then(function (data) {
          if (data && typeof data.stars === "number" && user) { user.stars = data.stars; renderHubAccount(); }
          var meta = item.meta || {};
          var s2 = loadSent(), dirty = false;
          if (meta.sumKey && meta.hash) { s2.sums[meta.sumKey] = meta.hash; dirty = true; }
          if (meta.botCode) { s2.bot[meta.botCode] = 1; dirty = true; }
          if (meta.bossKey) { s2.boss[meta.bossKey] = 1; dirty = true; }
          if (meta.theoryKey) { s2.theory[meta.theoryKey] = 1; dirty = true; }
          if (dirty) saveSent(s2);
        }).catch(function (e) {
          if (e && e.status === 401) { onUnauthorized(); return; }
          queuePost(item.url, item.body, item.meta); // still failing — requeue
        });
      });
    });
    return chain;
  }

  function syncAll(keepalive) {
    if (!token || !user) return;
    syncTheory(keepalive)
      .then(function () { return syncSummaries(keepalive); })
      .then(function () { return syncWallet(keepalive); })
      .catch(function () {});
  }

  /* ---------- boot ---------- */
  function boot() {
    renderHubAccount();
    if (!token) { note("no platform session — guest/local mode."); return; }
    api("/api/profile", "GET").then(function (p) {
      if (!p || !p.username) { apiDown = true; renderHubAccount(); return; }
      user = { username: p.username, stars: p.stars || 0, testBypass: !!p.testBypass };
      window.CAMB_USER = user;
      if (p.testBypass || String(p.username).toLowerCase() === "congtuth") lsSet("camb:test-bypass", "1");
      else lsDel("camb:test-bypass");
      renderHubAccount();
      flushQueue().then(function () { syncAll(false); });
    }).catch(function (e) {
      if (e && e.status === 401) { onUnauthorized(); return; }
      apiDown = true; // standalone origin / server down: keep token, stay silent
      note("platform API unreachable — staying in local mode, will retry.");
      renderHubAccount();
    });
    setInterval(function () { if (user) syncAll(false); }, 5000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && user) { flushQueue().then(function () { syncAll(false); }); } });
    window.addEventListener("beforeunload", function () { if (user) syncAll(true); });
    window.addEventListener("storage", function () { if (user) syncAll(false); });
    window.addEventListener("online", function () { if (user) flushQueue().then(function () { syncAll(false); }); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

