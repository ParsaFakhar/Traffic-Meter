'use strict';

/* =====================================================================
   Traffic Meter - background script
   Each "rule" is one card: a host pattern + optional port filter +
   optional container filter. Only requests that match a rule are
   touched at all (no filter is attached to anything else).
   ===================================================================== */

const HISTORY_LEN = 60; // seconds of sparkline history
const URLS = { urls: ['<all_urls>'] };

const S = { recording: false, countMode: 'exact', rules: [], totals: {} };
const history = {};   // ruleId -> [bytes/s, ...]
const lastTotal = {}; // ruleId -> total at previous sample
const reqs = new Map(); // requestId -> in-flight request info
let dirty = false;

/* ---------- persistence ---------- */

function ensureRule(id) {
  S.totals[id] ||= { down: 0, up: 0 };
  history[id] ||= [];
  lastTotal[id] ??= S.totals[id].down + S.totals[id].up;
}

browser.storage.local
  .get(['recording', 'countMode', 'rules', 'totals'])
  .then((d) => {
    S.recording = !!d.recording;
    S.countMode = d.countMode === 'headers' ? 'headers' : 'exact';
    S.rules = Array.isArray(d.rules) ? d.rules : [];
    S.totals = d.totals || {};
    S.rules.forEach((r) => ensureRule(r.id));
    updateBadge();
  });

function save() {
  dirty = false;
  return browser.storage.local.set({
    recording: S.recording,
    countMode: S.countMode,
    rules: S.rules,
    totals: S.totals,
  });
}

setInterval(() => { if (dirty) save(); }, 2000);

function updateBadge() {
  browser.browserAction.setBadgeText({ text: S.recording ? 'REC' : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: '#d93025' });
}

/* ---------- matching ---------- */

function defaultPort(protocol) {
  switch (protocol) {
    case 'https:': case 'wss:': return 443;
    case 'http:': case 'ws:': return 80;
    case 'ftp:': return 21;
    default: return 0;
  }
}

function matchRules(url, cookieStoreId) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (!/^(https?|wss?|ftp):$/.test(u.protocol)) return [];

  const host = u.hostname.toLowerCase();
  const port = u.port ? Number(u.port) : defaultPort(u.protocol);
  const store = cookieStoreId || 'firefox-default';
  const out = [];

  for (const r of S.rules) {
    if (!host.includes(r.pattern)) continue;

    if (r.ports.length) {
      const listed = r.ports.includes(port);
      if (r.portMode === 'exclude' ? listed : !listed) continue;
    }
    if (r.containers.length) {
      const listed = r.containers.includes(store);
      if (r.containerMode === 'exclude' ? listed : !listed) continue;
    }
    out.push(r.id);
  }
  return out;
}

/* ---------- counting ---------- */

function addBytes(ids, down, up) {
  for (const id of ids) {
    const t = S.totals[id];
    if (!t) continue;
    t.down += down;
    t.up += up;
  }
  dirty = true;
}

function headerList(list) {
  let n = 2; // trailing CRLF
  for (const h of list || []) {
    n += h.name.length + 2 + (h.value ? h.value.length : 0) + 2;
  }
  return n;
}

function hdr(list, name) {
  const h = (list || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : null;
}

function flush(req) {
  if (req.pending && !req.skip) addBytes(req.ids, req.pending, 0);
  req.pending = 0;
}

// Move streamed bytes into the totals twice a second so rates are "live".
setInterval(() => { for (const req of reqs.values()) flush(req); }, 500);

/* ---------- webRequest wiring ---------- */

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!S.recording) return {};
    const ids = matchRules(details.url, details.cookieStoreId);
    if (!ids.length) return {};

    // Redirect chains reuse the requestId: bank what the previous hop counted.
    const prev = reqs.get(details.requestId);
    if (prev) flush(prev);

    const req = {
      ids,
      pending: 0,
      skip: false,        // served from cache -> costs no traffic
      filtered: false,
      useCL: S.countMode === 'headers',
      contentLength: 0,
    };
    reqs.set(details.requestId, req);

    if (S.countMode === 'exact' && details.type !== 'websocket') {
      try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        req.filtered = true;
        filter.ondata = (e) => {
          if (!req.useCL) req.pending += e.data.byteLength;
          filter.write(e.data);
        };
        filter.onstop = () => filter.close();
        filter.onerror = () => { try { filter.disconnect(); } catch { /* ignore */ } };
      } catch {
        req.useCL = true; // cannot stream-count this request, fall back to headers
      }
    }
    return {};
  },
  URLS,
  ['blocking']
);

// Upload: request line + request headers + Content-Length (estimate).
browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    const req = reqs.get(d.requestId);
    if (!req) return;
    let n = headerList(d.requestHeaders);
    try {
      const u = new URL(d.url);
      n += d.method.length + 1 + u.pathname.length + u.search.length + 11;
    } catch { /* ignore */ }
    n += parseInt(hdr(d.requestHeaders, 'content-length'), 10) || 0;
    addBytes(req.ids, 0, n);
  },
  URLS,
  ['requestHeaders']
);

// Decide how the body will be measured.
browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    const req = reqs.get(d.requestId);
    if (!req) return;

    const bodyless = d.statusCode === 204 || d.statusCode === 304 || d.method === 'HEAD';
    let cl = bodyless ? 0 : parseInt(hdr(d.responseHeaders, 'content-length'), 10);
    if (!Number.isFinite(cl)) cl = null; // chunked / unknown
    req.contentLength = cl;

    // The stream filter sees DECODED bytes. For compressed responses that
    // have a Content-Length, the header value is the real wire size, so use it.
    const enc = (hdr(d.responseHeaders, 'content-encoding') || '').toLowerCase();
    if (enc && enc !== 'identity' && cl != null) req.useCL = true;
  },
  URLS,
  ['responseHeaders']
);

browser.webRequest.onResponseStarted.addListener(
  (d) => {
    const req = reqs.get(d.requestId);
    if (!req) return;
    if (d.fromCache) { req.skip = true; req.pending = 0; return; }

    let down = (d.statusLine || '').length + 2 + headerList(d.responseHeaders);
    if (req.useCL) down += req.contentLength || 0;
    addBytes(req.ids, down, 0);
  },
  URLS,
  ['responseHeaders']
);

browser.webRequest.onBeforeRedirect.addListener(
  (d) => {
    const req = reqs.get(d.requestId);
    if (!req || d.fromCache) return;
    addBytes(req.ids, (d.statusLine || '').length + 2 + headerList(d.responseHeaders), 0);
  },
  URLS,
  ['responseHeaders']
);

function finish(d) {
  const req = reqs.get(d.requestId);
  if (!req) return;
  if (d.fromCache) { req.skip = true; req.pending = 0; }
  flush(req);
  reqs.delete(d.requestId);
}
browser.webRequest.onCompleted.addListener(finish, URLS);
browser.webRequest.onErrorOccurred.addListener(finish, URLS);

/* ---------- sampling for rate + sparkline ---------- */

setInterval(() => {
  for (const r of S.rules) {
    ensureRule(r.id);
    const total = S.totals[r.id].down + S.totals[r.id].up;
    const h = history[r.id];
    h.push(Math.max(0, total - lastTotal[r.id]));
    if (h.length > HISTORY_LEN) h.shift();
    lastTotal[r.id] = total;
  }
}, 1000);

/* ---------- rule helpers ---------- */

function parseTarget(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[\/?#]/)[0];                      // path
  s = s.replace(/^.*@/, '');                     // user:pass@
  let port = null;
  const m = s.match(/^(.*):(\d{1,5})$/);
  if (m && !m[1].includes(':')) { s = m[1]; port = Number(m[2]); }
  s = s.replace(/\*/g, '');
  return { pattern: s, port };
}

function cleanPorts(list) {
  const out = [];
  for (const p of list || []) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  }
  return out;
}

function snapshot() {
  return {
    recording: S.recording,
    countMode: S.countMode,
    rules: S.rules,
    totals: S.totals,
    history,
  };
}

function resetRule(id) {
  S.totals[id] = { down: 0, up: 0 };
  history[id] = [];
  lastTotal[id] = 0;
}

/* ---------- message API (used by the popup) ---------- */

browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg.type) {
    case 'getState':
      return snapshot();

    case 'start':
      S.recording = true;
      updateBadge();
      break;

    case 'stop':
      S.recording = false;
      updateBadge();
      break;

    case 'resetAll':
      S.rules.forEach((r) => resetRule(r.id));
      break;

    case 'setCountMode':
      S.countMode = msg.value === 'headers' ? 'headers' : 'exact';
      break;

    case 'addRule': {
      const t = parseTarget(msg.input);
      if (!t.pattern) return snapshot();
      const rule = {
        id: crypto.randomUUID().slice(0, 8),
        pattern: t.pattern,
        ports: t.port ? [t.port] : [],
        portMode: 'include',
        containers: [],
        containerMode: 'include',
      };
      S.rules.push(rule);
      ensureRule(rule.id);
      break;
    }

    case 'updateRule': {
      const r = S.rules.find((x) => x.id === msg.id);
      const p = msg.patch || {};
      if (!r) break;
      if ('pattern' in p) {
        const t = parseTarget(p.pattern);
        if (t.pattern) {
          r.pattern = t.pattern;
          if (t.port && !r.ports.includes(t.port)) r.ports.push(t.port);
        }
      }
      if ('ports' in p) r.ports = cleanPorts(p.ports);
      if ('portMode' in p) r.portMode = p.portMode === 'exclude' ? 'exclude' : 'include';
      if ('containers' in p) r.containers = (p.containers || []).filter((x) => typeof x === 'string');
      if ('containerMode' in p) r.containerMode = p.containerMode === 'exclude' ? 'exclude' : 'include';
      break;
    }

    case 'resetRule':
      if (S.totals[msg.id]) resetRule(msg.id);
      break;

    case 'deleteRule':
      S.rules = S.rules.filter((r) => r.id !== msg.id);
      delete S.totals[msg.id];
      delete history[msg.id];
      delete lastTotal[msg.id];
      break;
  }
  await save();
  return snapshot();
});
