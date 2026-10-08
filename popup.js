'use strict';

const $ = (s) => document.querySelector(s);
const send = (msg) => browser.runtime.sendMessage(msg);

let state = null;
let containers = []; // [{id, name}] from Firefox
let lastSig = '';
const expanded = new Set(); // card ids whose options panel is open
const isWindow = new URLSearchParams(location.search).has('window');

/* ---------- helpers ---------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  }
  return el;
}

function makeSpark() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 60 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.appendChild(document.createElementNS(NS, 'polyline'));
  return svg;
}

function fmtBytes(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function allContainers() {
  return [
    { id: 'firefox-default', name: 'Default' },
    ...containers,
    { id: 'firefox-private', name: 'Private' },
  ];
}

function containerName(id) {
  const c = allContainers().find((x) => x.id === id);
  return c ? c.name : id;
}

const portLabel = (r) =>
  r.ports.length ? r.ports.map((p) => (r.portMode === 'exclude' ? '~' : '') + p).join(', ') : 'ALL';

const contLabel = (r) =>
  r.containers.length
    ? r.containers.map((id) => (r.containerMode === 'exclude' ? '~' : '') + containerName(id)).join(', ')
    : 'ALL';

async function act(msg) {
  state = await send(msg);
  render(true);
}

/* ---------- card building ---------- */

function buildPanel(r) {
  const upd = (patch) => act({ type: 'updateRule', id: r.id, patch });

  const hostInput = h('input', {
    type: 'text',
    value: r.pattern,
    spellcheck: 'false',
    onchange: (e) => upd({ pattern: e.target.value }),
  });

  const portMode = h('select', { onchange: (e) => upd({ portMode: e.target.value }) },
    h('option', { value: 'include', selected: r.portMode === 'include' }, 'Only these ports'),
    h('option', { value: 'exclude', selected: r.portMode === 'exclude' }, 'Everything except'));

  const portInput = h('input', {
    type: 'text',
    value: r.ports.join(', '),
    placeholder: 'e.g. 8080, 80',
    spellcheck: 'false',
    onchange: (e) =>
      upd({ ports: e.target.value.split(/[\s,;]+/).filter(Boolean).map(Number) }),
  });

  const contMode = h('select', { onchange: (e) => upd({ containerMode: e.target.value }) },
    h('option', { value: 'include', selected: r.containerMode === 'include' }, 'Only these containers'),
    h('option', { value: 'exclude', selected: r.containerMode === 'exclude' }, 'Everything except'));

  const list = h('div', { class: 'clist' },
    allContainers().map((c) =>
      h('label', { class: 'cb' },
        h('input', {
          type: 'checkbox',
          value: c.id,
          checked: r.containers.includes(c.id),
          onchange: () =>
            upd({ containers: [...list.querySelectorAll('input:checked')].map((i) => i.value) }),
        }),
        c.name)));

  return h('div', { class: 'panel' },
    h('div', { class: 'row' },
      h('label', { class: 'lbl' }, 'Domain / IP'),
      h('div', { class: 'stack' }, hostInput,
        h('span', { class: 'hint' }, 'Matches any host containing this text.'))),
    h('div', { class: 'row' },
      h('label', { class: 'lbl' }, 'Ports'),
      h('div', { class: 'stack' }, portMode, portInput,
        h('span', { class: 'hint' }, 'Empty = all ports. Default ports count as 80 / 443.'))),
    h('div', { class: 'row' },
      h('label', { class: 'lbl' }, 'Containers'),
      h('div', { class: 'stack' }, contMode, list,
        h('span', { class: 'hint' }, 'None ticked = all containers.'))),
    h('div', { class: 'btns' },
      h('button', { onclick: () => act({ type: 'resetRule', id: r.id }) }, 'Reset counter'),
      h('button', {
        class: 'danger',
        onclick: () => { expanded.delete(r.id); act({ type: 'deleteRule', id: r.id }); },
      }, 'Delete')));
}

function buildCard(r) {
  const open = expanded.has(r.id);
  return h('div', { class: 'card', 'data-id': r.id },
    h('div', { class: 'main' },
      h('div', { class: 'chips' },
        h('span', { class: 'chip host', title: r.pattern }, r.pattern),
        h('span', { class: 'chip', title: 'Ports' }, portLabel(r)),
        h('span', { class: 'chip', title: 'Containers' }, contLabel(r))),
      h('div', { class: 'right' },
        h('span', { class: 'total' }, '0 B'),
        h('button', {
          class: 'gear',
          title: 'Ports / containers / delete',
          onclick: () => {
            expanded.has(r.id) ? expanded.delete(r.id) : expanded.add(r.id);
            render(true);
          },
        }, open ? '▴' : '⚙'))),
    h('div', { class: 'live' },
      makeSpark(),
      h('span', { class: 'rate' }, '0 B/s')),
    open ? buildPanel(r) : null);
}

/* ---------- live updates ---------- */

function updateLive(r) {
  const card = $(`#cards [data-id="${r.id}"]`);
  if (!card) return;
  const t = state.totals[r.id] || { down: 0, up: 0 };
  const total = card.querySelector('.total');
  total.textContent = fmtBytes(t.down + t.up);
  total.title = `Down ${fmtBytes(t.down)}  /  Up ${fmtBytes(t.up)}`;

  const hist = state.history[r.id] || [];
  card.querySelector('.rate').textContent = `${fmtBytes(hist.length ? hist[hist.length - 1] : 0)}/s`;

  const max = Math.max(1, ...hist);
  const off = 60 - hist.length;
  const pts = hist
    .map((v, i) => `${off + i},${(23 - (v / max) * 21).toFixed(1)}`)
    .join(' ');
  card.querySelector('polyline').setAttribute('points', pts);
}

function render(force) {
  if (!state) return;
  const tog = $('#toggle');
  tog.textContent = state.recording ? '■ Stop' : '● Start';
  tog.className = state.recording ? 'rec' : 'start';
  $('#countMode').value = state.countMode;

  const sig = JSON.stringify([state.rules, [...expanded], containers]);
  if (force || sig !== lastSig) {
    lastSig = sig;
    $('#cards').replaceChildren(...state.rules.map(buildCard));
  }
  $('#empty').hidden = state.rules.length > 0;
  state.rules.forEach(updateLive);
}

async function refresh() {
  state = await send({ type: 'getState' });
  render(false);
}

/* ---------- wiring ---------- */

$('#toggle').addEventListener('click', () =>
  act({ type: state.recording ? 'stop' : 'start' }));

$('#reset').addEventListener('click', () => act({ type: 'resetAll' }));

$('#countMode').addEventListener('change', (e) =>
  act({ type: 'setCountMode', value: e.target.value }));

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addInput');
  if (!input.value.trim()) return;
  await act({ type: 'addRule', input: input.value });
  input.value = '';
});

if (isWindow) {
  document.body.classList.add('win');
  $('#popout').hidden = true;
} else {
  $('#popout').addEventListener('click', async () => {
    await browser.windows.create({
      url: browser.runtime.getURL('popup.html?window=1'),
      type: 'popup',
      width: 440,
      height: 680,
    });
    window.close();
  });
}

(async function init() {
  try {
    containers = (await browser.contextualIdentities.query({})).map((c) => ({
      id: c.cookieStoreId,
      name: c.name,
    }));
  } catch {
    containers = []; // containers disabled in about:preferences
  }
  await refresh();
  setInterval(refresh, 1000);
})();
