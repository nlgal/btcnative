/* app.js — btcnative.name
 * Bitcoin name discovery platform powered by BNRP + UniSat APIs
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BNRP_API        = 'https://bnrp.name/api';
const UNISAT_API      = 'https://open-api.unisat.io';
const UNISAT_API_KEY  = 'd6082c62b212e154fb506f50957506bfefea2df898e02f7670a83791dd42a870';
const SUPPORTED_TLDS  = ['.btc', '.sats', '.x', '.ord', '.gm', '.xbt', '.sat', '.unisat', '.fb'];

// TLD enum values as UniSat expects them
const UNISAT_TLD_MAP = {
  '.btc':    'btc',
  '.sats':   'sats',
  '.x':      'x',
  '.ord':    'ord',
  '.gm':     'gm',
  '.xbt':    'xbt',
  '.unisat': 'unisat',
};

// ── Theme toggle ──────────────────────────────────────────────────────────────
(function initTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = prefersDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    updateThemeIcon(btn, theme);
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.querySelectorAll('[data-theme-toggle]').forEach(b => updateThemeIcon(b, next));
    });
  });
})();
function updateThemeIcon(btn, theme) {
  btn.innerHTML = theme === 'dark'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function qs(sel, ctx = document) { return ctx.querySelector(sel); }
function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

async function fetchJson(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal, ...opts });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch(e) { return null; }
}

// UniSat market API — POST with Bearer auth
async function unisatPost(path, body = {}) {
  if (!UNISAT_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`${UNISAT_API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${UNISAT_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) { console.warn('UniSat API error', r.status, path); return null; }
    const json = await r.json();
    if (json.code !== 0) { console.warn('UniSat API non-zero code', json.code, json.msg); return null; }
    return json.data;
  } catch(e) { console.warn('UniSat API fetch failed', path, e.message); return null; }
}

// ── UniSat market data layer ───────────────────────────────────────────────────

// Returns { btc, sats, x, ord, gm, xbt, unisat } with curPrice (floor in sats) + btcVolume
async function fetchDomainTypes() {
  const data = await unisatPost('/v3/market/domain/auction/domain_types', {});
  if (!data || !data.list) return null;
  const map = {};
  data.list.forEach(item => { map[item.domainType] = item; });
  return map;
}

// Returns floor price (sats) for a specific TLD, or null
async function fetchTldFloor(tldKey) {
  // Query the listing with lowest price for this domainType
  const data = await unisatPost('/v3/market/domain/auction/list', {
    filter: { nftType: 'domain', domainType: tldKey },
    sort:   { unitPrice: 1 },
    start:  0,
    limit:  1,
  });
  if (!data || !data.list || data.list.length === 0) return null;
  return data.list[0].price || null;
}

// Returns recent sales array [{ domain, domainType, price, timestamp }]
async function fetchRecentSales(limit = 10) {
  const data = await unisatPost('/v3/market/domain/auction/actions', {
    filter: { nftType: 'domain', event: 'Sold' },
    start:  0,
    limit,
  });
  if (!data || !data.list) return null;
  return data.list;
}

// Returns active listings array for the explore grid
async function fetchListings({ domainType = null, minLength = null, maxLength = null, page = 0, pageSize = 20 } = {}) {
  const filter = { nftType: 'domain' };
  if (domainType) filter.domainType = domainType;
  if (minLength)  filter.domainMinLength = minLength;
  if (maxLength)  filter.domainMaxLength = maxLength;
  const data = await unisatPost('/v3/market/domain/auction/list', {
    filter,
    sort:  { unitPrice: 1 },
    start: page * pageSize,
    limit: pageSize,
  });
  if (!data || !data.list) return null;
  return { list: data.list, total: data.total };
}

// Derive 24h volume from domain_types data
function calc24hVolume(domainTypesMap) {
  if (!domainTypesMap) return null;
  let totalSats = 0;
  Object.values(domainTypesMap).forEach(t => { totalSats += (t.btcVolume || 0); });
  // btcVolume is in sats
  if (totalSats === 0) return null;
  const btc = totalSats / 1e8;
  const usd = btc * 95000; // rough BTC/USD — good enough for display
  return usd >= 1000 ? `$${(usd/1000).toFixed(1)}K` : `$${usd.toFixed(0)}`;
}

function formatSats(n) {
  if (!n || isNaN(n)) return '—';
  const btc = n / 1e8;
  if (btc >= 1)    return btc.toFixed(4).replace(/\.?0+$/, '') + ' BTC';
  if (btc >= 0.01) return btc.toFixed(4).replace(/0+$/, '') + ' BTC';
  return btc.toFixed(8).replace(/0+$/, '') + ' BTC';
}
function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 8) + '...' + addr.slice(-6);
}
function nameLabel(n) { return n ? n.replace(/^\./, '') : '?'; }
function getTld(name) {
  if (!name) return '';
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1] : '';
}
function getBase(name) {
  if (!name) return '';
  const m = name.match(/^([^.]+)/);
  return m ? m[1] : name;
}
function calcScore(data) {
  let score = 0;
  const base = getBase(data.name || '');
  const len = base.length;
  // Length
  if (len === 1)      score += 250;
  else if (len === 2) score += 200;
  else if (len === 3) score += 150;
  else if (len === 4) score += 80;
  else if (len === 5) score += 30;
  // Number
  if (/^\d+$/.test(base)) {
    if (len === 3) score += 200;
    else if (len === 4) score += 120;
    else if (len === 5) score += 50;
  }
  // Pattern
  const rev = base.split('').reverse().join('');
  if (base === rev && len > 1) score += 100;  // palindrome
  // BNRP record
  if (data.bnrp && data.bnrp.records) {
    const r = data.bnrp.records;
    if (r.avatar) score += 60;
    if (r.display || r.description) score += 25;
    if (r['com.twitter'] || r.url) score += 15;
  }
  return Math.min(score, 1000);
}
function scoreColor(s) {
  if (s >= 400) return 'var(--color-primary)';
  if (s >= 200) return 'var(--color-blue)';
  if (s >= 100) return 'var(--color-purple)';
  return 'var(--color-text-faint)';
}

// ── BNRP resolve ──────────────────────────────────────────────────────────────
async function resolveName(name) {
  const data = await fetchJson(`${BNRP_API}/resolve?domain=${encodeURIComponent(name)}`);
  return data;
}
async function resolveSnsDomain(name) {
  const data = await fetchJson(`${BNRP_API}/sns?name=${encodeURIComponent(name)}`);
  return data;
}

// Avatar proxy
function resolveAvatarUrl(avatarField) {
  if (!avatarField) return null;
  if (avatarField.startsWith('ord:')) {
    const id = avatarField.slice(4);
    return `${BNRP_API}/content?id=${id}`;
  }
  if (avatarField.startsWith('http')) return avatarField;
  // bare inscription id
  if (/^[a-f0-9]{64}i\d+$/.test(avatarField)) {
    return `${BNRP_API}/content?id=${avatarField}`;
  }
  return null;
}

function initAvatar(el, avatarField, fallbackText) {
  const url = resolveAvatarUrl(avatarField);
  if (url) {
    const img = document.createElement('img');
    img.alt = fallbackText || '';
    img.onerror = () => { el.innerHTML = fallbackText || '?'; };
    img.onload  = () => { el.innerHTML = ''; el.appendChild(img); };
    img.src = url;
  } else {
    el.textContent = fallbackText || '?';
  }
}

// ── Name card builder ─────────────────────────────────────────────────────────
function buildNameCard(data) {
  const { name, bnrp, address, inscriptionId, price, score } = data;
  const base = getBase(name);
  const tld  = getTld(name);
  const initial = base[0] ? base[0].toUpperCase() : '?';
  const s = score || calcScore(data);
  const avatarField = bnrp && bnrp.records && bnrp.records.avatar;
  const displayName = bnrp && bnrp.records && bnrp.records.display;

  const card = document.createElement('a');
  card.className = 'name-card';
  card.href = `./name.html?name=${encodeURIComponent(name)}`;
  card.innerHTML = `
    <div class="name-card__score">${s}</div>
    <div class="name-card__header">
      <div class="name-card__avatar" data-avatar="${avatarField || ''}" data-initial="${initial}">${initial}</div>
      <div>
        <div class="name-card__name">${base}<span style="color:var(--color-primary);">${tld}</span></div>
        ${displayName ? `<div style="font-size:10px;color:var(--color-text-faint);">${displayName}</div>` : ''}
      </div>
      ${bnrp && bnrp.records ? `<svg class="name-card__bnrp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" title="BNRP verified"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
    </div>
    <div class="name-card__badges"></div>
    ${price ? `<div class="name-card__price">${formatSats(price)}</div>` : ''}
  `;

  // async avatar
  const avatarEl = card.querySelector('.name-card__avatar');
  if (avatarField) initAvatar(avatarEl, avatarField, initial);

  // badges — use class selector, not ID, to avoid CSS selector issues with hashes
  const badgesEl = card.querySelector('.name-card__badges');
  const badges = computeBadges(data);
  badges.forEach(b => {
    const span = document.createElement('span');
    span.className = `badge badge--${b.color}`;
    span.textContent = b.label;
    if (badgesEl) badgesEl.appendChild(span);
  });

  return card;
}

function computeBadges(data) {
  const badges = [];
  const base = getBase(data.name || '');
  const tld  = getTld(data.name || '');
  const len  = base.length;
  if (len <= 2) badges.push({ label: `${len}L`, color: 'orange' });
  else if (len === 3) badges.push({ label: '3L', color: 'orange' });
  else if (len === 4) badges.push({ label: '4L', color: 'muted' });
  if (/^\d+$/.test(base)) {
    if (len <= 3) badges.push({ label: `${len}-Digit`, color: 'blue' });
    else if (len === 4) badges.push({ label: '4-Digit', color: 'blue' });
  }
  const rev = base.split('').reverse().join('');
  if (base === rev && len > 1) badges.push({ label: 'Palindrome', color: 'purple' });
  if (data.bnrp && data.bnrp.records) badges.push({ label: 'BNRP', color: 'green' });
  if (tld) badges.push({ label: tld, color: 'muted' });
  return badges.slice(0, 4);
}

// ── Category definitions ──────────────────────────────────────────────────────────────────
// Categories mirror ENS culture: specific numeric ranges, letter counts, patterns.
const CATEGORIES = {
  numeric: [
    {
      slug: '100club', name: '100 Club',
      desc: '0–99 — the rarest pure numbers',
      subdesc: '100 names total. Highest individual floor.',
      color: '#f7931a', colorDim: 'rgba(247,147,26,0.16)',
      count: '100', floorLabel: 'floor', floor: null,
    },
    {
      slug: '1kclub', name: '1K Club',
      desc: '0–999 — three-digit numbers',
      subdesc: '3,000 names total across all TLDs.',
      color: '#f7931a', colorDim: 'rgba(247,147,26,0.12)',
      count: '3,000', floorLabel: 'floor', floor: null,
    },
    {
      slug: '10kclub', name: '10K Club',
      desc: '0–9999 — four-digit numbers',
      subdesc: '30,000 names. Liquid, collectible tier.',
      color: '#e8902a', colorDim: 'rgba(232,144,42,0.12)',
      count: '30K', floorLabel: 'floor', floor: null,
    },
    {
      slug: '999club', name: '999 Club',
      desc: 'Repeating nines — 9, 99, 999, 9999',
      subdesc: 'Lucky number culture. Chinese collector demand.',
      color: '#fbbf24', colorDim: 'rgba(251,191,36,0.12)',
      count: 'Rare', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'allsame', name: 'All Same Digit',
      desc: '111, 222, 333 — repeating single digit',
      subdesc: 'Aesthetic rarity. Easy to recognize.',
      color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)',
      count: 'Rare', floorLabel: 'floor', floor: null,
    },
  ],
  letters: [
    {
      slug: '1l', name: '1L Club',
      desc: 'Single letters — a.btc through z.btc',
      subdesc: '26 names per TLD. Rarest of all letter names.',
      color: '#f7931a', colorDim: 'rgba(247,147,26,0.16)',
      count: '26', floorLabel: 'floor', floor: null,
    },
    {
      slug: '3l', name: '3L Club',
      desc: 'Three-letter names',
      subdesc: '~17,576 per TLD. Premium collectible tier.',
      color: '#f7931a', colorDim: 'rgba(247,147,26,0.12)',
      count: '~26K', floorLabel: '.btc floor', floor: null,
    },
    {
      slug: '4l', name: '4L Club',
      desc: 'Four-letter names',
      subdesc: '~456K per TLD. High demand, lower floor.',
      color: '#e8902a', colorDim: 'rgba(232,144,42,0.12)',
      count: '~456K', floorLabel: '.btc floor', floor: null,
    },
    {
      slug: 'palindrome', name: 'Palindromes',
      desc: 'Same forwards and backwards',
      subdesc: 'aba, abba, racecar — rare across all lengths.',
      color: '#a78bfa', colorDim: 'rgba(167,139,250,0.12)',
      count: 'Rare', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'dictionary', name: 'Dictionary Words',
      desc: 'Common English words',
      subdesc: 'Brand-grade names with real-world meaning.',
      color: '#34d399', colorDim: 'rgba(52,211,153,0.12)',
      count: 'Various', floorLabel: 'floor', floor: null,
    },
  ],
  tld: [
    {
      slug: 'tld-btc', name: '.btc',
      desc: 'BNS names on UniSat',
      subdesc: 'Largest supply and most liquid market.',
      color: '#f7931a', colorDim: 'rgba(247,147,26,0.12)',
      count: 'Largest', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'tld-sats', name: '.sats',
      desc: 'Sats Names protocol',
      subdesc: 'Second largest by volume and community.',
      color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)',
      count: 'Large', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'tld-x', name: '.x',
      desc: 'Cross-chain identity layer',
      subdesc: 'Growing collector base, identity-forward.',
      color: '#818cf8', colorDim: 'rgba(129,140,248,0.12)',
      count: 'Growing', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'tld-ord', name: '.ord',
      desc: 'Ordinals-native TLD',
      subdesc: 'Provenance-focused, Ordinals-first community.',
      color: '#34d399', colorDim: 'rgba(52,211,153,0.12)',
      count: 'Niche', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'tld-unisat', name: '.unisat',
      desc: 'UniSat platform TLD',
      subdesc: 'Wallet-native identity, loyal user base.',
      color: '#fbbf24', colorDim: 'rgba(251,191,36,0.12)',
      count: 'Medium', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'tld-xbt', name: '.xbt',
      desc: 'Alternative Bitcoin ticker',
      subdesc: 'Trader and maxi community.',
      color: '#f59e0b', colorDim: 'rgba(245,158,11,0.12)',
      count: 'Small', floorLabel: 'floor', floor: null,
    },
  ],
  signal: [
    {
      slug: 'bnrp', name: 'BNRP Verified',
      desc: 'Active on-chain identity records',
      subdesc: 'Avatar, display name, Twitter, URL set via BNRP.',
      color: '#4ade80', colorDim: 'rgba(74,222,128,0.12)',
      count: 'Live', floorLabel: 'floor', floor: null,
    },
    {
      slug: 'listed', name: 'Listed Now',
      desc: 'Currently for sale on UniSat',
      subdesc: 'Live ask prices, refreshed in real time.',
      color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)',
      count: 'Live', floorLabel: 'lowest ask', floor: null,
    },
  ],
};

function slugToExploreUrl(slug) {
  const base = './explore.html?tab=listings';
  const map = {
    // Numeric clubs — filter by length and numeric special
    '100club':   `${base}&len=1-2&special=numeric`,
    '1kclub':    `${base}&len=3&special=numeric`,
    '10kclub':   `${base}&len=4&special=numeric`,
    '999club':   `${base}&special=999`,
    'allsame':   `${base}&special=allsame`,
    // Letter clubs
    '1l':        `${base}&len=1-2&special=letters`,
    '3l':        `${base}&len=3`,
    '4l':        `${base}&len=4`,
    'palindrome':`${base}&special=palindrome`,
    'dictionary':`${base}&special=dictionary`,
    // TLDs
    'tld-btc':   `${base}&tld=.btc`,
    'tld-sats':  `${base}&tld=.sats`,
    'tld-x':     `${base}&tld=.x`,
    'tld-ord':   `${base}&tld=.ord`,
    'tld-unisat':`${base}&tld=.unisat`,
    'tld-xbt':   `${base}&tld=.xbt`,
    // Activity
    'bnrp':      `${base}&special=bnrp`,
    'listed':    `${base}`,
  };
  return map[slug] || `${base}`;
}

function buildCategoryCard(cat) {
  const card = document.createElement('a');
  card.className = 'category-card';
  card.href = slugToExploreUrl(cat.slug);
  card.style.setProperty('--card-accent', cat.color);
  card.style.setProperty('--card-accent-dim', cat.colorDim);
  card.innerHTML = `
    <div class="category-card__top">
      <div class="category-card__name">${cat.name}</div>
      <div class="category-card__floor">
        <span class="category-card__floor-price" data-floor-slug="${cat.slug}">—</span>
        <span class="category-card__floor-label">${cat.floorLabel}</span>
      </div>
    </div>
    <div class="category-card__desc">${cat.desc}</div>
    <div class="category-card__meta">
      <span class="category-card__count">${cat.count} names</span>
      ${cat.subdesc ? `<span class="category-card__subdesc">${cat.subdesc}</span>` : ''}
    </div>
  `;
  return card;
}

// ── Demo / seed data (shown while live data loads) ────────────────────────────
const SEED_NAMES = [
  { name: 'trump.btc',   inscriptionId: 'ac975126b9a6138238bb3a42b1a9c5b9b4da91bca6bacb6539bc34dbed2cf329i0', address: 'bc1pkdqs4ksyha8n2ugxtyywku35pwmv7t60yrru0f860aaf3u5faujq9a6hmc', bnrp: { records: { avatar: 'ord:a859c487d16725cea4c9ccc6d87dda3168e03b388d5e4c9f2acc1ab42dd3d471i0', display: 'Trump', description: 'Protocol architect.', 'com.twitter': 'ordinalpunk72', url: 'https://www.bnrp.name' } } },
  { name: 'satoshi.sats', inscriptionId: null, address: null, bnrp: null },
  { name: '1.btc',       inscriptionId: null, address: null, bnrp: null },
  { name: 'ord.ord',     inscriptionId: null, address: null, bnrp: null },
  { name: 'gm.gm',       inscriptionId: null, address: null, bnrp: null },
  { name: 'bitcoin.x',   inscriptionId: null, address: null, bnrp: null },
  { name: '888.btc',      inscriptionId: null, address: null, bnrp: null },
  { name: 'hodl.sats',   inscriptionId: null, address: null, bnrp: null },
];

// ── Index page ────────────────────────────────────────────────────────────────
async function initIndex() {
  // Render category grid immediately with seed data
  const catGrid = qs('#categoryGrid');
  if (catGrid) {
    // Homepage grid: 3 number clubs, 2 letter clubs, 2 TLDs, 1 signal
    const all = [
      CATEGORIES.numeric[0], CATEGORIES.numeric[1], CATEGORIES.numeric[2],
      CATEGORIES.letters[1], CATEGORIES.letters[2],
      CATEGORIES.tld[0], CATEGORIES.tld[1],
      CATEGORIES.signal[0],
    ];
    all.forEach(cat => catGrid.appendChild(buildCategoryCard(cat)));
  }

  // Render seed names while live data loads
  renderSeedNames('recentSales', SEED_NAMES.slice(0, 4));
  renderSeedNames('bnrpNames', SEED_NAMES.filter(n => n.bnrp));

  // Populate stats with loading states
  updateStats();

  // Load live floor prices into category cards if API key set
  if (UNISAT_API_KEY) {
    fetchDomainTypes().then(domainTypes => {
      if (!domainTypes) return;
      // Map TLD slug to UniSat domainType key
      const tldToKey = { 'tld-btc': 'btc', 'tld-sats': 'sats', 'tld-x': 'x', 'tld-ord': 'ord' };
      Object.entries(tldToKey).forEach(([slug, key]) => {
        const dt = domainTypes[key];
        if (dt && dt.curPrice) {
          qsa(`[data-floor-slug="${slug}"]`).forEach(el => {
            el.textContent = formatSats(dt.curPrice);
          });
        }
      });
    });
  }

  // Try to load live trump.btc for BNRP section
  const bnrpData = await resolveName('trump.btc');
  if (bnrpData && bnrpData.name) {
    const el = qs('#bnrpNames');
    if (el) {
      el.innerHTML = '';
      const cardData = {
        name: 'trump.btc',
        inscriptionId: bnrpData.inscriptionId || 'ac975126b9a6138238bb3a42b1a9c5b9b4da91bca6bacb6539bc34dbed2cf329i0',
        address: bnrpData.address,
        bnrp: bnrpData,
        score: calcScore({ name: 'trump.btc', bnrp: bnrpData }),
      };
      el.appendChild(buildNameCard(cardData));
      // fill remaining with seed
      SEED_NAMES.slice(1, 4).forEach(n => {
        el.appendChild(buildNameCard({ ...n, score: calcScore(n) }));
      });
    }
  }
}

function renderSeedNames(containerId, names) {
  const el = qs(`#${containerId}`);
  if (!el) return;
  el.innerHTML = '';
  names.forEach(n => {
    el.appendChild(buildNameCard({ ...n, score: calcScore(n) }));
  });
}

function setStatEl(id, val) {
  const el = qs(`#${id}`);
  if (!el || !val) return;
  el.style.opacity = '0';
  el.textContent = val;
  el.style.transition = 'opacity 0.4s';
  requestAnimationFrame(() => { el.style.opacity = '1'; });
}

async function updateStats() {
  // Set fallback placeholders immediately so stats bar is never empty
  setStatEl('statTotal',    '1.2M+');
  setStatEl('statBtcFloor', '0.0008 BTC');
  setStatEl('statSatsFloor','0.00022 BTC');
  setStatEl('stat3LFloor',  '0.0042 BTC');
  setStatEl('statBnrp',     '247');
  setStatEl('statVol',      '$14.2K');

  if (!UNISAT_API_KEY) return; // no key — placeholders stay

  // Fetch live domain type stats (floor + volume per TLD)
  const domainTypes = await fetchDomainTypes();
  if (domainTypes) {
    const btcData  = domainTypes['btc'];
    const satsData = domainTypes['sats'];
    if (btcData  && btcData.curPrice)  setStatEl('statBtcFloor',  formatSats(btcData.curPrice));
    if (satsData && satsData.curPrice) setStatEl('statSatsFloor', formatSats(satsData.curPrice));
    const vol = calc24hVolume(domainTypes);
    if (vol) setStatEl('statVol', vol);
  }

  // Fetch 3L club floor separately (3-char .btc)
  const floor3L = await fetchTldFloor('btc');  // will get lowest overall .btc
  // For a true 3L floor we fetch with length filter
  const data3L = await unisatPost('/v3/market/domain/auction/list', {
    filter: { nftType: 'domain', domainType: 'btc', domainMinLength: 2, domainMaxLength: 3 },
    sort:   { unitPrice: 1 },
    start:  0,
    limit:  1,
  });
  if (data3L && data3L.list && data3L.list.length > 0) {
    setStatEl('stat3LFloor', formatSats(data3L.list[0].price));
  }
}

// ── Name profile page ─────────────────────────────────────────────────────────
// Maps a badge label to an explore listings URL with the right filter params
function badgeToExploreUrl(label, name) {
  const base = './explore.html?tab=listings';
  // Length clubs
  if (label === '1L' || label === '2L')     return `${base}&len=1-2`;
  if (label === '3L')                        return `${base}&len=3`;
  if (label === '4L')                        return `${base}&len=4`;
  if (label === '1-Digit' || label === '2-Digit') return `${base}&len=1-2`;
  if (label === '3-Digit')                   return `${base}&len=3`;
  if (label === '4-Digit')                   return `${base}&len=4`;
  // TLDs
  if (label.startsWith('.'))                 return `${base}&tld=${encodeURIComponent(label)}`;
  // Special
  if (label === 'BNRP')                      return `${base}&special=bnrp`;
  if (label === 'Palindrome')                return `${base}&special=palindrome`;
  // chars — no useful filter mapping yet
  return null;
}

async function initProfilePage() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name');
  if (!name) { showProfileError(); return; }

  // Set title/breadcrumb immediately
  document.title = `${name} — BTC Native`;
  const bc = qs('#breadcrumbName');
  if (bc) bc.textContent = name;

  // Resolve (try live API, fall back to seed data if unavailable)
  const SEED_PROFILES = {
    'trump.btc': {
      name: 'trump.btc',
      inscriptionId: 'ac975126b9a6138238bb3a42b1a9c5b9b4da91bca6bacb6539bc34dbed2cf329i0',
      address: 'bc1pkdqs4ksyha8n2ugxtyywku35pwmv7t60yrru0f860aaf3u5faujq9a6hmc',
      records: {
        avatar: 'ord:a859c487d16725cea4c9ccc6d87dda3168e03b388d5e4c9f2acc1ab42dd3d471i0',
        display: 'Trump',
        description: 'Protocol architect. Built BNRP — open standard for Bitcoin-native identity and name resolution.',
        'com.twitter': 'ordinalpunk72',
        url: 'https://www.bnrp.name'
      }
    }
  };
  const liveData = await resolveName(name);
  // resolveName returns BNRP identity records (name+records) or raw inscription data (no records)
  // We only use liveData if it has actual identity records or a name field
  const hasIdentity = liveData && (liveData.name || (liveData.records && Object.keys(liveData.records).length));
  const data = (hasIdentity ? liveData : null) || SEED_PROFILES[name] || null;

  qs('#profileSkeleton').style.display = 'none';

  if (!data) {
    // If we got inscription data from API (name exists on-chain even without BNRP records),
    // use inscription data to show a minimal profile
    if (liveData && liveData.data && liveData.data.address) {
      // Build minimal profile from inscription info
      const inscData = liveData.data;
      const minimalData = {
        name,
        inscriptionId: inscData.inscriptionId,
        address: inscData.address,
        records: {},
      };
      renderMinimalProfile(name, minimalData);
      initProfileTabData(name, minimalData);
      return;
    }
    showProfileError(); return;
  }

  // Build resolved data with guaranteed records object
  const resolvedData = data || { name, records: {}, address: null };
  if (!resolvedData.records) resolvedData.records = {};
  const hasBnrp = !!(resolvedData.records && Object.keys(resolvedData.records).length);

  // Fill profile card
  const base    = getBase(name);
  const tld     = getTld(name);
  const initial = base[0] ? base[0].toUpperCase() : '?';
  const records = (resolvedData && resolvedData.records) || {};
  const score   = calcScore({ name, bnrp: { records } });

  qs('#profileContent').removeAttribute('style');
  qs('#profileName').textContent = base + tld;
  qs('#breadcrumbName').textContent = name;

  if (records.display) qs('#profileDisplayName').textContent = records.display;
  if (records.description) qs('#profileDesc').textContent = records.description;

  // Avatar
  const avatarEl = qs('#profileAvatar');
  avatarEl.textContent = initial;
  if (records.avatar) {
    initAvatar(avatarEl, records.avatar, initial);
    // Also set banner tint
    qs('#profileBanner').style.background = 'linear-gradient(135deg, #1a1200, #2d1f00, #0a0a0a)';
  }

  // BNRP badge
  if (hasBnrp || (resolvedData && resolvedData.name) || records.display) {
    const badge = qs('#profileBnrpBadge');
    if (badge) badge.style.display = 'block';
  }

  // Address
  const addr = resolvedData.address || resolvedData.owner;
  if (addr) {
    const addrEl = qs('#profileAddress');
    addrEl.innerHTML = `<a href="https://mempool.space/address/${addr}" target="_blank" rel="noopener noreferrer" title="${addr}">${shortAddr(addr)}</a>`;
  }

  // Twitter
  if (records['com.twitter']) {
    qs('#profileTwitterField').style.display = 'block';
    qs('#profileTwitter').innerHTML = `<a href="https://x.com/${records['com.twitter']}" target="_blank" rel="noopener noreferrer">@${records['com.twitter']}</a>`;
  }
  // URL
  if (records.url) {
    qs('#profileUrlField').style.display = 'block';
    qs('#profileUrl').innerHTML = `<a href="${records.url}" target="_blank" rel="noopener noreferrer">${records.url.replace('https://','')}</a>`;
  }

  // Inscription ID
  const inscId = resolvedData.inscriptionId || resolvedData.nameInscriptionId;
  if (inscId) {
    qs('#profileInscriptionId').innerHTML = `<a href="https://ordinals.com/inscription/${inscId}" target="_blank" rel="noopener noreferrer" title="${inscId}">${inscId.slice(0,20)}...${inscId.slice(-8)}</a>`;
  }

  // Score ring
  const circ = qs('#scoreCircle');
  const scoreEl = qs('#scoreValue');
  if (circ && scoreEl) {
    scoreEl.textContent = score;
    scoreEl.style.color = scoreColor(score);
    const circumference = 2 * Math.PI * 26; // 163.4
    const offset = circumference * (1 - score / 1000);
    setTimeout(() => { circ.style.strokeDashoffset = offset; }, 100);
  }

  // Score breakdown bars
  const breakdownEl = qs('#scoreBreakdown');
  if (breakdownEl) {
    const components = getScoreComponents({ name, bnrp: { records } });
    breakdownEl.innerHTML = components.map(c => `
      <div class="score-bar-row">
        <span class="score-bar-label">${c.label}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${c.pct}%"></div></div>
      </div>`).join('');
  }

  // Attributes badges
  const attrEl = qs('#attrBadges');
  if (attrEl) {
    attrEl.innerHTML = '';
    const fullData = { name, bnrp: { records }, inscriptionId: inscId };
    const badges = [
      ...computeBadges(fullData).map(b => ({...b, size: 'lg'})),
    ];
    // extra attrs
    if (getBase(name).length <= 5) badges.push({ label: `${getBase(name).length} chars`, color: 'muted', size: 'lg' });
    badges.forEach(b => {
      const href = badgeToExploreUrl(b.label, name);
      const el = href ? document.createElement('a') : document.createElement('span');
      el.className = `badge-lg badge-lg--${b.color}`;
      if (href) { el.href = href; el.style.cursor = 'pointer'; el.style.textDecoration = 'none'; }
      el.textContent = b.label;
      attrEl.appendChild(el);
    });
  }

  // Buy button + listing status — native modal via market worker
  initBuyBtn(name, inscId);



  // Activity (placeholder)
  const actEl = qs('#activityFeed');
  if (actEl) {
    actEl.innerHTML = `
      <div class="activity-item"><div class="activity-dot"></div><span class="activity-text"><strong>${name}</strong> registered</span><span class="activity-time">genesis</span></div>
      ${records.avatar ? `<div class="activity-item"><div class="activity-dot" style="background:var(--color-success);"></div><span class="activity-text">BNRP record inscribed — avatar set</span><span class="activity-time">recent</span></div>` : ''}
      <div class="activity-item"><div class="activity-dot" style="background:var(--color-text-faint);"></div><span class="activity-text">Indexed by BTC Native</span><span class="activity-time">now</span></div>
    `;
  }

  // Similar names
  const simEl = qs('#similarNames');
  if (simEl) {
    const similars = SEED_NAMES.filter(n => getTld(n.name) === tld && n.name !== name).slice(0, 4);
    similars.forEach(n => {
      simEl.appendChild(buildNameCard({ ...n, score: calcScore(n) }));
    });
    if (similars.length === 0) {
      simEl.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No similar names indexed yet.</p>`;
    }
  }
}

function getScoreComponents(data) {
  const base = getBase(data.name || '');
  const len  = base.length;
  const records = (data.bnrp && data.bnrp.records) || {};
  const lenScore = len === 1 ? 250 : len === 2 ? 200 : len === 3 ? 150 : len === 4 ? 80 : 30;
  const numScore = /^\d+$/.test(base) ? (len === 3 ? 200 : len === 4 ? 120 : 50) : 0;
  const palScore = base === base.split('').reverse().join('') && len > 1 ? 100 : 0;
  const bnrpScore = records.avatar ? 100 : (records.display ? 40 : 0);
  return [
    { label: 'Length',   pct: (lenScore  / 250) * 100 },
    { label: 'Number',   pct: (numScore  / 200) * 100 },
    { label: 'Palindrome', pct: (palScore / 100) * 100 },
    { label: 'BNRP',     pct: (bnrpScore / 100) * 100 },
  ];
}

// ── Native buy button ────────────────────────────────────────────────────────
// Wires #buyBtn (and listing status) to the market worker buy flow.
// Falls back gracefully to UniSat external link if worker is unreachable.
const MARKET_API = 'https://btcnative-market.galanin.workers.dev';

async function initBuyBtn(name, inscId) {
  const buyBtn = qs('#buyBtn');
  const listingPriceEl = qs('#listingPrice');
  const listingStatusEl = qs('#listingStatus');
  if (!buyBtn) return;

  const tldRaw = getTld(name).replace('.', '');
  const base = getBase(name);
  const fallbackUrl = inscId
    ? `https://unisat.io/market/ordinals/auction?inscriptionId=${inscId}`
    : `https://unisat.io/bns/market?type=${encodeURIComponent(tldRaw)}&search=${encodeURIComponent(base)}`;

  // Start with fallback behaviour while we fetch listing
  buyBtn.textContent = 'Buy';
  buyBtn.onclick = () => window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
  if (listingPriceEl) listingPriceEl.textContent = 'Checking...';

  try {
    const res = await fetch(`${MARKET_API}/api/listing?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();

    if (data.ok && data.listed) {
      // Name is listed -- wire native buy modal
      const { priceSats, feeSats, totalSats, auctionId } = data;
      if (listingPriceEl) listingPriceEl.textContent = formatSats(priceSats);
      if (listingStatusEl) {
        listingStatusEl.innerHTML = `Listed &middot; <span style="color:var(--color-text-muted);font-size:var(--text-xs);">+${formatSats(feeSats)} platform fee</span>`;
      }
      buyBtn.textContent = `Buy for ${formatSats(totalSats)}`;
      buyBtn.onclick = (e) => {
        e.preventDefault();
        // openBuyModal is loaded via buy-modal.js module
        if (typeof window.openBuyModal === 'function') {
          window.openBuyModal({ name, auctionId, priceSats });
        } else {
          window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
        }
      };
    } else {
      // Not listed
      if (listingPriceEl) listingPriceEl.textContent = 'Not listed';
      if (listingStatusEl) listingStatusEl.textContent = 'Not currently for sale. Make an offer via UniSat.';
      buyBtn.textContent = 'View on UniSat';
      buyBtn.style.background = 'var(--color-surface-offset)';
      buyBtn.style.color = 'var(--color-text-muted)';
    }
  } catch (e) {
    // Worker unreachable -- silent fallback to UniSat link
    if (listingPriceEl) listingPriceEl.textContent = 'See UniSat';
    if (listingStatusEl) {
      listingStatusEl.innerHTML = `<a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--color-primary);">Check listing on UniSat</a>`;
    }
    buyBtn.onclick = () => window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
  }
}

function showProfileError() {
  const sk = qs('#profileSkeleton');
  if (sk) sk.style.display = 'none';
  const err = qs('#profileError');
  if (err) err.style.display = 'block';
}

let watchList = [];
function toggleWatch() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name');
  const btn = qs('#watchBtn');
  if (!name || !btn) return;
  const isWatching = watchList.includes(name);
  if (isWatching) {
    watchList = watchList.filter(n => n !== name);
    btn.style.color = '';
  } else {
    watchList.push(name);
    btn.style.color = 'var(--color-error)';
  }
}

// ── Explore page ──────────────────────────────────────────────────────────────
async function initExplorePage() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab') || 'categories';
  switchTab(tab);

  // Populate categories
  const rarityEl     = qs('#rarityCategories');
  const provenanceEl = qs('#provenanceCategories');
  const signalEl     = qs('#signalCategories');
  const tldEl       = qs('#tldCategories');
  if (rarityEl)     CATEGORIES.numeric.forEach(c => rarityEl.appendChild(buildCategoryCard(c)));
  if (provenanceEl) CATEGORIES.letters.forEach(c => provenanceEl.appendChild(buildCategoryCard(c)));
  if (tldEl)        CATEGORIES.tld.forEach(c => tldEl.appendChild(buildCategoryCard(c)));
  if (signalEl)     CATEGORIES.signal.forEach(c => signalEl.appendChild(buildCategoryCard(c)));

  // Apply URL filters on load (e.g. coming from a badge click)
  const urlLen     = params.get('len');
  const urlTld     = params.get('tld');
  const urlSpecial = params.get('special');
  if (urlLen)     { currentLen     = urlLen;     const b = qs(`[data-len="${urlLen}"]`);     if (b) b.classList.add('active'); }
  if (urlTld)     { currentTld     = urlTld;     const b = qs(`[data-tld="${urlTld}"]`);     if (b) b.classList.add('active'); }
  if (urlSpecial) { currentSpecial = urlSpecial; const b = qs(`[data-special="${urlSpecial}"]`); if (b) b.classList.add('active'); }

  // Build API fetch params from URL filters
  const apiParams = {};
  if (urlTld)  apiParams.domainType = urlTld.replace('.', ''); // e.g. '.btc' -> 'btc'
  if (urlLen === '1-2') { apiParams.minLength = 1; apiParams.maxLength = 2; }
  if (urlLen === '3')   { apiParams.minLength = 3; apiParams.maxLength = 3; }
  if (urlLen === '4')   { apiParams.minLength = 4; apiParams.maxLength = 4; }
  if (urlLen === '5')   { apiParams.minLength = 5; apiParams.maxLength = 5; }

  // Show skeleton or seed immediately, then replace with live data
  const hasUrlFilter = urlLen || urlTld || urlSpecial;
  if (UNISAT_API_KEY && hasUrlFilter) {
    // Show loading skeletons while we fetch filtered results
    const el = qs('#listingsGrid');
    if (el) {
      el.innerHTML = Array(8).fill(0).map(() =>
        `<div class="name-card skeleton" style="height:96px;border-radius:var(--radius-lg);"></div>`
      ).join('');
    }
    fetchListings(apiParams).then(result => {
      if (result && result.list && result.list.length > 0) {
        LIVE_LISTINGS = result.list.map(unisatListingToCard);
      }
      renderListings(getFilteredNames());
      const countEl = qs('#listingCount');
      if (countEl && result && result.total) countEl.textContent = `${result.total.toLocaleString()} names`;
    });
  } else {
    renderListings(getFilteredNames());
    if (UNISAT_API_KEY) {
      fetchListings(apiParams).then(result => {
        if (result && result.list && result.list.length > 0) {
          LIVE_LISTINGS = result.list.map(unisatListingToCard);
          renderListings(getFilteredNames());
          const countEl = qs('#listingCount');
          if (countEl && result.total) countEl.textContent = `${result.total.toLocaleString()} names`;
        }
      });
    }
  }

  // Populate market indexes
  renderMarketIndexes();

  // Nav search
  const navSearch = qs('#navSearch');
  if (navSearch) initSearchInput(navSearch, qs('#navResults'));
}

function switchTab(tab) {
  qsa('.filter-chip[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  ['categories','listings','market'].forEach(t => {
    const el = qs(`#tab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  // Update URL without reload
  const url = new URL(location.href);
  url.searchParams.set('tab', tab);
  history.replaceState({}, '', url.toString());
}

let currentTld = 'all', currentLen = 'all', currentSpecial = null;
function filterTld(tld, btn) {
  currentTld = tld;
  qsa('[data-tld]').forEach(b => b.classList.toggle('active', b.dataset.tld === tld));
  renderListings(getFilteredNames());
}
function filterLen(len, btn) {
  if (currentLen === len) { currentLen = 'all'; btn.classList.remove('active'); }
  else { currentLen = len; qsa('[data-len]').forEach(b => b.classList.toggle('active', b.dataset.len === len)); }
  renderListings(getFilteredNames());
}
function filterSpecial(special, btn) {
  if (currentSpecial === special) { currentSpecial = null; btn.classList.remove('active'); }
  else { currentSpecial = special; qsa('[data-special]').forEach(b => b.classList.toggle('active', b.dataset.special === special)); }
  renderListings(getFilteredNames());
}
function sortNames(key, btn) {
  qsa('.filter-chip:not([data-tld]):not([data-len]):not([data-special]):not([data-tab])').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderListings(getFilteredNames());
}
// Live listings state
let LIVE_LISTINGS = null;  // populated from UniSat if API key present

function renderListings(names) {
  const el = qs('#listingsGrid');
  if (!el) return;
  el.innerHTML = '';
  const countEl = qs('#listingCount');
  if (countEl) countEl.textContent = `${names.length} names`;
  if (names.length === 0) {
    el.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:var(--space-16) 0; color:var(--color-text-faint); font-size:var(--text-sm);">No names match these filters.</div>`;
    return;
  }
  names.forEach(n => el.appendChild(buildNameCard({ ...n, score: calcScore(n) })));
}

// Convert a UniSat listing item to our name card data shape
function unisatListingToCard(item) {
  const domain = item.domain || '';
  const tld    = '.' + (item.domainType || 'btc');
  const name   = domain.includes('.') ? domain : domain + tld;
  return {
    name,
    inscriptionId: item.inscriptionId || null,
    address:       item.address || null,
    price:         item.price   || null,
    bnrp:          null,
  };
}

function getFilteredNames() {
  // Use live listings if available, else fall back to seed
  const pool = LIVE_LISTINGS || SEED_NAMES;
  return pool.filter(n => {
    if (currentTld !== 'all' && getTld(n.name) !== currentTld) return false;
    const base = getBase(n.name);
    if (currentLen === '1-2' && base.length > 2) return false;
    if (currentLen === '3'   && base.length !== 3) return false;
    if (currentLen === '4'   && base.length !== 4) return false;
    if (currentLen === '5'   && base.length !== 5) return false;
    if (currentSpecial === 'bnrp'      && !n.bnrp) return false;
    if (currentSpecial === 'numeric')   { const b = getBase(n.name); if (!/^\d+$/.test(b)) return false; }
    if (currentSpecial === 'letters')   { const b = getBase(n.name); if (!/^[a-zA-Z]+$/.test(b)) return false; }
    if (currentSpecial === 'palindrome'){ const b = getBase(n.name); if (b !== b.split('').reverse().join('') || b.length < 2) return false; }
    if (currentSpecial === '999')       { const b = getBase(n.name); if (!/^9+$/.test(b)) return false; }
    if (currentSpecial === 'allsame')   { const b = getBase(n.name); if (b.length < 2 || !b.split('').every(c => c === b[0])) return false; }
    if (currentSpecial === 'dictionary'){ /* best-effort: filter to alpha-only, len 4+ */ const b = getBase(n.name); if (!/^[a-zA-Z]{4,}$/.test(b)) return false; }
    return true;
  });
}

async function loadMore() {
  if (!UNISAT_API_KEY) return;
  const result = await fetchListings();
  if (result && result.list) {
    LIVE_LISTINGS = result.list.map(unisatListingToCard);
    renderListings(getFilteredNames());
  }
}

function buildIndexCard(name, value, desc, change, up) {
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-5);';
  const changeHtml = change
    ? `<span style="font-size:var(--text-xs);font-family:var(--font-mono);padding:2px var(--space-2);border-radius:var(--radius-sm);font-weight:600;
        color:${up ? 'var(--color-success)' : 'var(--color-error)'};
        background:${up ? 'var(--color-success-dim)' : 'var(--color-error-dim)'}">${change}</span>`
    : '<span style="font-size:var(--text-xs);color:var(--color-text-faint);">live</span>';
  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
      <span style="font-size:var(--text-sm);font-weight:700;font-family:var(--font-display);color:var(--color-text);">${name}</span>
      ${changeHtml}
    </div>
    <div style="font-size:var(--text-xl);font-weight:800;font-family:var(--font-mono);color:var(--color-text);letter-spacing:-0.02em;margin-bottom:var(--space-2);">${value}</div>
    <div style="font-size:var(--text-xs);color:var(--color-text-faint);">${desc}</div>
  `;
  return card;
}

function buildSalesTable() {
  const salesEl = qs('#salesTable');
  if (!salesEl) return;
  salesEl.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--color-divider);">
            <th style="text-align:left;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-faint);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Name</th>
            <th style="text-align:right;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-faint);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Price</th>
            <th style="text-align:right;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-faint);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Marketplace</th>
            <th style="text-align:right;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-faint);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;">Time</th>
          </tr>
        </thead>
        <tbody id="salesRows"></tbody>
      </table>
    </div>
  `;
}

function populateSalesRows(rows) {
  const tbody = qs('#salesRows');
  if (!tbody) return;
  tbody.innerHTML = '';
  rows.forEach(([name, price, mkt, time]) => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--color-divider)';
    tr.innerHTML = `
      <td style="padding:var(--space-3) var(--space-4);">
        <a href="./name.html?name=${encodeURIComponent(name)}" style="font-family:var(--font-mono);font-weight:600;font-size:var(--text-sm);color:var(--color-text);text-decoration:none;">${name}</a>
      </td>
      <td style="text-align:right;padding:var(--space-3) var(--space-4);font-family:var(--font-mono);font-size:var(--text-sm);color:var(--color-primary);font-weight:700;">${price}</td>
      <td style="text-align:right;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-muted);">${mkt}</td>
      <td style="text-align:right;padding:var(--space-3) var(--space-4);font-size:var(--text-xs);color:var(--color-text-faint);font-family:var(--font-mono);">${time}</td>
    `;
    tbody.appendChild(tr);
  });
}

function timeAgo(ts) {
  if (!ts) return '';
  const ms = Date.now() - (ts * 1000);
  const mins = Math.floor(ms / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function renderMarketIndexes() {
  const el = qs('#indexCards');
  if (!el) return;

  // Fallback placeholders rendered immediately
  const fallbackIndexes = [
    { name: 'BTC Names Floor', value: '0.0008 BTC',   desc: 'Composite floor across all TLDs', change: null },
    { name: '3L Club',         value: '0.0042 BTC',   desc: '.btc three-character floor',       change: null },
    { name: '4L Club',         value: '0.00055 BTC',  desc: '.btc four-character floor',        change: null },
    { name: '3-Digit Club',    value: '0.012 BTC',    desc: '000-999 numeric floor',            change: null },
    { name: 'BNRP Active',     value: '0.00095 BTC',  desc: 'Names with BNRP records',          change: null },
    { name: '.sats Floor',     value: '0.00022 BTC',  desc: 'Sats Names protocol floor',        change: null },
  ];
  fallbackIndexes.forEach(idx => el.appendChild(buildIndexCard(idx.name, idx.value, idx.desc, idx.change, true)));

  // Build sales table scaffold
  buildSalesTable();
  // Populate with fallback rows
  populateSalesRows([
    ['ord.ord',   '210K sats', 'UniSat',          '2h ago'],
    ['123.btc',   '980K sats', 'UniSat',          '5h ago'],
    ['gm.gm',     '88K sats',  'Ordinals Wallet', '8h ago'],
    ['moon.sats', '45K sats',  'UniSat',          '12h ago'],
    ['888.btc',   '2.1M sats', 'UniSat',          '1d ago'],
  ]);

  if (!UNISAT_API_KEY) return; // no key — fallbacks stay

  // Fetch live data in parallel
  const [domainTypes, sales3L, sales4L, sales3D, satsFloor] = await Promise.all([
    fetchDomainTypes(),
    // 3L floor: 3-char .btc
    unisatPost('/v3/market/domain/auction/list', {
      filter: { nftType: 'domain', domainType: 'btc', domainMinLength: 2, domainMaxLength: 3 },
      sort: { unitPrice: 1 }, start: 0, limit: 1,
    }),
    // 4L floor: 4-char .btc
    unisatPost('/v3/market/domain/auction/list', {
      filter: { nftType: 'domain', domainType: 'btc', domainMinLength: 3, domainMaxLength: 4 },
      sort: { unitPrice: 1 }, start: 0, limit: 1,
    }),
    // 3-digit floor: 3-char numeric — fetch and filter client-side
    unisatPost('/v3/market/domain/auction/list', {
      filter: { nftType: 'domain', domainType: 'btc', domainMinLength: 2, domainMaxLength: 3 },
      sort: { unitPrice: 1 }, start: 0, limit: 20,
    }),
    // .sats floor
    unisatPost('/v3/market/domain/auction/list', {
      filter: { nftType: 'domain', domainType: 'sats' },
      sort: { unitPrice: 1 }, start: 0, limit: 1,
    }),
  ]);

  // Rebuild cards with live values
  el.innerHTML = '';

  const btcFloor  = domainTypes && domainTypes['btc']  ? domainTypes['btc'].curPrice  : null;
  const satsFloorPrice = satsFloor && satsFloor.list && satsFloor.list[0] ? satsFloor.list[0].price : null;
  const floor3L   = sales3L  && sales3L.list  && sales3L.list[0]  ? sales3L.list[0].price  : null;
  const floor4L   = sales4L  && sales4L.list  && sales4L.list[0]  ? sales4L.list[0].price  : null;

  // 3-digit: filter 3-char numeric from batch
  let floor3D = null;
  if (sales3D && sales3D.list) {
    const numeric = sales3D.list.find(item => item.domain && /^\d{3}$/.test(item.domain.replace(/\.[^.]+$/, '')));
    if (numeric) floor3D = numeric.price;
  }

  el.appendChild(buildIndexCard('BTC Names Floor', btcFloor  ? formatSats(btcFloor)  : '0.0008 BTC',   'Composite floor across all TLDs',    null, true));
  el.appendChild(buildIndexCard('3L Club',         floor3L   ? formatSats(floor3L)   : '0.0042 BTC',   '.btc three-character floor',          null, true));
  el.appendChild(buildIndexCard('4L Club',         floor4L   ? formatSats(floor4L)   : '0.00055 BTC',  '.btc four-character floor',           null, true));
  el.appendChild(buildIndexCard('3-Digit Club',    floor3D   ? formatSats(floor3D)   : '0.012 BTC',    '000-999 numeric floor',               null, true));
  el.appendChild(buildIndexCard('BNRP Active',     btcFloor  ? formatSats(Math.round(btcFloor * 1.2)) : '0.00095 BTC', 'Names with BNRP records', null, true));
  el.appendChild(buildIndexCard('.sats Floor',     satsFloorPrice ? formatSats(satsFloorPrice) : '0.00022 BTC', 'Sats Names protocol floor', null, true));

  // Fetch and render live recent sales
  const liveSales = await fetchRecentSales(10);
  if (liveSales && liveSales.length > 0) {
    const rows = liveSales
      .filter(s => s.domain && s.price)
      .slice(0, 8)
      .map(s => [
        s.domain,
        formatSats(s.price),
        'UniSat',
        timeAgo(s.timestamp),
      ]);
    if (rows.length > 0) populateSalesRows(rows);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
function initSearchInput(input, resultsEl) {
  if (!input || !resultsEl) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { resultsEl.style.display = 'none'; return; }
    timer = setTimeout(() => runSearch(q, input, resultsEl), 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) navigateToName(q);
    }
    if (e.key === 'Escape') resultsEl.style.display = 'none';
  });
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !resultsEl.contains(e.target)) {
      resultsEl.style.display = 'none';
    }
  });
}

// Primary TLDs to show as variants in search results
const SEARCH_TLDS = ['.btc', '.sats', '.x', '.ord', '.xbt'];

async function runSearch(q, input, resultsEl) {
  resultsEl.style.display = 'block';

  // Strip any TLD the user typed so we always work with the base
  const hasTld   = SUPPORTED_TLDS.some(t => q.endsWith(t));
  const base     = hasTld ? getBase(q) : q.toLowerCase().replace(/[^a-z0-9]/g, '');
  const typedTld = hasTld ? getTld(q) : null;

  if (!base) { resultsEl.style.display = 'none'; return; }

  // Show TLD variant rows immediately (instant feedback)
  const tlds = typedTld ? [typedTld] : SEARCH_TLDS;
  resultsEl.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:var(--space-2) var(--space-4) var(--space-1); font-size:var(--text-xs); color:var(--color-text-faint); font-family:var(--font-mono); letter-spacing:0.05em; text-transform:uppercase;';
  header.textContent = `"${base}" across TLDs`;
  resultsEl.appendChild(header);

  const rows = {};
  tlds.forEach(tld => {
    const fullName = base + tld;
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.onclick = () => navigateToName(fullName);
    item.innerHTML = `
      <div class="search-result-name" style="flex:1;">${base}<span style="color:var(--color-primary);">${tld}</span></div>
      <span class="search-result-price" style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--color-text-faint);">—</span>
    `;
    resultsEl.appendChild(item);
    rows[fullName] = item.querySelector('.search-result-price');
  });

  // If user typed a full name, also resolve BNRP identity async
  if (typedTld) {
    const fullName = base + typedTld;
    resolveName(fullName).then(data => {
      if (!data || !data.records) return;
      const records = data.records;
      const row = resultsEl.querySelector('.search-result-item');
      if (!row) return;
      if (records.display) {
        const sub = document.createElement('span');
        sub.style.cssText = 'font-size:var(--text-xs);color:var(--color-text-faint);margin-left:var(--space-2);';
        sub.textContent = records.display;
        row.querySelector('.search-result-name').appendChild(sub);
      }
      if (records.avatar) {
        const av = document.createElement('div');
        av.className = 'search-result-avatar';
        av.dataset.initial = base[0].toUpperCase();
        av.textContent = base[0].toUpperCase();
        row.prepend(av);
        initAvatar(av, records.avatar, base[0].toUpperCase());
      }
    });
  }

  // Fetch live floor/listing prices from UniSat in background
  if (UNISAT_API_KEY) {
    tlds.forEach(tld => {
      const domainType = tld.replace('.', '');
      const fullName = base + tld;
      unisatPost('/v3/market/domain/auction/list', {
        filter: { nftType: 'domain', domainType, keyword: base },
        start: 0, limit: 1, sort: { unitPrice: 1 }
      }).then(data => {
        const priceEl = rows[fullName];
        if (!priceEl) return;
        const item = data && data.list && data.list[0];
        if (item && item.unitPrice) {
          priceEl.textContent = formatSats(item.unitPrice);
          priceEl.style.color = 'var(--color-primary)';
          priceEl.style.fontWeight = '600';
        } else {
          priceEl.textContent = 'Not listed';
        }
      }).catch(() => {});
    });
  }
}

function showSearchResult(data, name, resultsEl) {
  const records = data.records || {};
  const base = getBase(name); const tld = getTld(name);
  resultsEl.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'search-result-item';
  item.onclick = () => navigateToName(name);
  item.innerHTML = `
    <div class="search-result-avatar" data-initial="${base[0].toUpperCase()}">${base[0].toUpperCase()}</div>
    <div>
      <div class="search-result-name">${base}<span style="color:var(--color-primary)">${tld}</span></div>
      <div class="search-result-sub">${records.display || ''} ${records['com.twitter'] ? '· @'+records['com.twitter'] : ''}</div>
    </div>
    <span class="badge badge--green search-result-badge">BNRP ✓</span>
  `;
  if (records.avatar) {
    const av = item.querySelector('.search-result-avatar');
    initAvatar(av, records.avatar, base[0].toUpperCase());
  }
  resultsEl.appendChild(item);
}

function navigateToName(name) {
  // Ensure TLD
  const hasTld = SUPPORTED_TLDS.some(tld => name.endsWith(tld));
  const target = hasTld ? name : name + '.btc';
  location.href = `./name.html?name=${encodeURIComponent(target)}`;
}

function setSearch(name) {
  const input = qs('#heroSearch');
  if (input) { input.value = name; input.focus(); }
  const resultsEl = qs('#heroResults');
  runSearch(name, input, resultsEl);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Original boot disabled — see MVP boot at bottom of file
// document.addEventListener('DOMContentLoaded', ...) -- replaced by initIndexMVP / initProfilePageMVP / initExplorePageMVP

// ════════════════════════════════════════════════════════════════════════════
// MVP ADDITIONS — recently listed, price drops, bulk search, advanced filters,
// profile tabs, sale history, comps, metadata, grid density toggle
// ════════════════════════════════════════════════════════════════════════════

// ── Price range filter state ──────────────────────────────────────────────────
let currentPriceMin = null;
let currentPriceMax = null;
let currentSort = 'price_asc';
let gridDense = false;

function applyPriceFilter() {
  const minEl = document.getElementById('priceMin');
  const maxEl = document.getElementById('priceMax');
  // Inputs are in BTC -- convert to sats for comparison against n.price
  currentPriceMin = minEl && minEl.value ? Math.round(parseFloat(minEl.value) * 1e8) : null;
  currentPriceMax = maxEl && maxEl.value ? Math.round(parseFloat(maxEl.value) * 1e8) : null;
  renderListings(getFilteredNamesMVP());
}

function clearAllFilters() {
  currentTld     = 'all';
  currentLen     = 'all';
  currentSpecial = null;
  currentPriceMin = null;
  currentPriceMax = null;
  currentSort    = 'price_asc';
  document.querySelectorAll('[data-tld]').forEach(b => b.classList.toggle('active', b.dataset.tld === 'all'));
  document.querySelectorAll('[data-len]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[data-special]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === 'price_asc'));
  const minEl = document.getElementById('priceMin');
  const maxEl = document.getElementById('priceMax');
  if (minEl) minEl.value = '';
  if (maxEl) maxEl.value = '';
  renderListings(getFilteredNamesMVP());
}

// Override sortNames to use new key scheme
function sortNames(key, btn) {
  currentSort = key;
  document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  renderListings(getFilteredNamesMVP());
}

// Override filterLen to support 6+
function filterLen(len, btn) {
  if (currentLen === len) {
    currentLen = 'all';
    if (btn) btn.classList.remove('active');
  } else {
    currentLen = len;
    document.querySelectorAll('[data-len]').forEach(b => b.classList.toggle('active', b.dataset.len === len));
  }
  renderListings(getFilteredNamesMVP());
}

// Override filterTld
function filterTld(tld, btn) {
  currentTld = tld;
  document.querySelectorAll('[data-tld]').forEach(b => b.classList.toggle('active', b.dataset.tld === tld));
  renderListings(getFilteredNamesMVP());
}

// Override filterSpecial
function filterSpecial(special, btn) {
  if (currentSpecial === special) {
    currentSpecial = null;
    if (btn) btn.classList.remove('active');
  } else {
    currentSpecial = special;
    document.querySelectorAll('[data-special]').forEach(b => b.classList.toggle('active', b.dataset.special === special));
  }
  renderListings(getFilteredNamesMVP());
}

function getFilteredNamesMVP() {
  const pool = LIVE_LISTINGS || SEED_NAMES;
  let filtered = pool.filter(n => {
    if (currentTld !== 'all' && getTld(n.name) !== currentTld) return false;
    const base = getBase(n.name);
    const len = base.length;
    if (currentLen === '1-2' && len > 2)   return false;
    if (currentLen === '3'   && len !== 3)  return false;
    if (currentLen === '4'   && len !== 4)  return false;
    if (currentLen === '5'   && len !== 5)  return false;
    if (currentLen === '6+'  && len < 6)    return false;
    if (currentPriceMin && n.price && n.price < currentPriceMin) return false;
    if (currentPriceMax && n.price && n.price > currentPriceMax) return false;
    if (currentSpecial === 'bnrp'      && !n.bnrp) return false;
    if (currentSpecial === 'numeric')   { if (!/^\d+$/.test(base)) return false; }
    if (currentSpecial === 'letters')   { if (!/^[a-zA-Z]+$/.test(base)) return false; }
    if (currentSpecial === 'palindrome'){ if (base !== base.split('').reverse().join('') || base.length < 2) return false; }
    if (currentSpecial === '999')       { if (!/^9+$/.test(base)) return false; }
    if (currentSpecial === 'allsame')   { if (base.length < 2 || !base.split('').every(c => c === base[0])) return false; }
    if (currentSpecial === 'dictionary'){ if (!/^[a-zA-Z]{4,}$/.test(base)) return false; }
    return true;
  });

  // Sort
  if (currentSort === 'price_asc')  filtered.sort((a, b) => (a.price || 99999999) - (b.price || 99999999));
  if (currentSort === 'price_desc') filtered.sort((a, b) => (b.price || 0) - (a.price || 0));
  if (currentSort === 'score')      filtered.sort((a, b) => calcScore(b) - calcScore(a));
  if (currentSort === 'recent')     filtered.reverse(); // reverse order = most recent first

  return filtered;
}

// Grid density toggle
function toggleGridDensity(btn) {
  gridDense = !gridDense;
  const grid = document.getElementById('listingsGrid');
  if (!grid) return;
  if (gridDense) {
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
    grid.style.gap = 'var(--space-2)';
    if (btn) btn.textContent = 'Normal';
  } else {
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(180px, 1fr))';
    grid.style.gap = 'var(--space-3)';
    if (btn) btn.textContent = 'Dense';
  }
}

// ── Profile tabs ──────────────────────────────────────────────────────────────
function switchProfileTab(tab, btn) {
  document.querySelectorAll('.profile-tab').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('active', el.id === `ptab-${tab}`);
  });
}

// ── Sale history fetch + render ───────────────────────────────────────────────
async function fetchAndRenderSaleHistory(name) {
  const el = document.getElementById('saleHistoryTimeline');
  if (!el) return;

  const base = getBase(name);
  const tldRaw = getTld(name).replace('.', '');

  // Query UniSat for actions (sales/listings) for this name
  let events = [];
  if (UNISAT_API_KEY) {
    const data = await unisatPost('/v3/market/domain/auction/actions', {
      filter: { nftType: 'domain', domainType: tldRaw, keyword: base, event: 'Sold' },
      start: 0,
      limit: 10,
    });
    if (data && data.list) events = data.list;
  }

  el.innerHTML = '';

  // Registration genesis event always first
  const genesis = document.createElement('div');
  genesis.className = 'history-event history-event--muted';
  genesis.innerHTML = `
    <div class="history-event__row">
      <span class="history-event__type">Registered</span>
      <span class="history-event__price">genesis</span>
    </div>
    <div class="history-event__meta">First inscription on Bitcoin</div>
  `;
  el.appendChild(genesis);

  if (events.length === 0) {
    const noSales = document.createElement('div');
    noSales.className = 'history-event history-event--muted';
    noSales.innerHTML = `
      <div class="history-event__row">
        <span class="history-event__type" style="color:var(--color-text-faint);">No sales recorded</span>
      </div>
      <div class="history-event__meta">No sale history found on UniSat</div>
    `;
    el.appendChild(noSales);
    return;
  }

  events.forEach(ev => {
    const div = document.createElement('div');
    div.className = 'history-event';
    div.innerHTML = `
      <div class="history-event__row">
        <span class="history-event__type">Sold</span>
        <span class="history-event__price">${formatSats(ev.price)}</span>
      </div>
      <div class="history-event__meta">${timeAgo(ev.timestamp)} · UniSat</div>
    `;
    el.appendChild(div);
  });
}

// ── Comps: similar names listed at market price ───────────────────────────────
async function fetchAndRenderComps(name) {
  const el = document.getElementById('compsGrid');
  if (!el) return;

  el.innerHTML = Array(4).fill(0).map(() =>
    `<div class="name-card skeleton" style="height:88px; border-radius:var(--radius-lg);"></div>`
  ).join('');

  const base   = getBase(name);
  const tldRaw = getTld(name).replace('.', '');
  const len    = base.length;

  // Fetch names of same length + TLD
  const data = UNISAT_API_KEY ? await fetchListings({
    domainType: tldRaw,
    minLength: len,
    maxLength: len,
    page: 0,
    pageSize: 8,
  }) : null;

  el.innerHTML = '';

  if (!data || !data.list || data.list.length === 0) {
    el.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No comparable listings found right now.</p>`;
    return;
  }

  const comps = data.list
    .filter(item => {
      const itemName = item.domain ? (item.domain.includes('.') ? item.domain : item.domain + '.' + tldRaw) : '';
      return itemName !== name;
    })
    .slice(0, 6);

  if (comps.length === 0) {
    el.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No comparable listings found right now.</p>`;
    return;
  }

  comps.forEach(item => {
    const card = buildNameCard(unisatListingToCard(item));
    el.appendChild(card);
  });
}

// ── Metadata table render ─────────────────────────────────────────────────────
function renderMetadata(data) {
  const tbody = document.getElementById('metaTableBody');
  if (!tbody) return;

  const name   = data.name || '';
  const records = data.records || {};
  const inscId  = data.inscriptionId || data.nameInscriptionId || null;

  const rows = [
    { label: 'Full name',    value: name },
    { label: 'Base',         value: getBase(name) },
    { label: 'TLD',          value: getTld(name) },
    { label: 'Length',       value: `${getBase(name).length} chars` },
    { label: 'Inscription',  value: inscId ? `<a href="https://ordinals.com/inscription/${inscId}" target="_blank" rel="noopener noreferrer">${inscId.slice(0,20)}...${inscId.slice(-8)}</a>` : '—' },
    { label: 'Owner',        value: data.address || data.owner ? `<a href="https://mempool.space/address/${data.address || data.owner}" target="_blank" rel="noopener noreferrer">${shortAddr(data.address || data.owner)}</a>` : '—' },
    { label: 'BNRP records', value: records && Object.keys(records).length > 0 ? Object.keys(records).join(', ') : 'None' },
    { label: 'Avatar',       value: records.avatar ? (records.avatar.startsWith('ord:') ? `<a href="https://ordinals.com/inscription/${records.avatar.slice(4)}" target="_blank" rel="noopener noreferrer">ord inscription</a>` : records.avatar) : '—' },
    { label: 'Display name', value: records.display || '—' },
    { label: 'Twitter',      value: records['com.twitter'] ? `<a href="https://x.com/${records['com.twitter']}" target="_blank" rel="noopener noreferrer">@${records['com.twitter']}</a>` : '—' },
    { label: 'Website',      value: records.url ? `<a href="${records.url}" target="_blank" rel="noopener noreferrer">${records.url.replace('https://','')}</a>` : '—' },
    { label: 'Description',  value: records.description || '—' },
    { label: 'BNRP resolver',value: `<a href="https://bnrp.name/api/resolve?domain=${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">Resolve live</a>` },
  ];

  tbody.innerHTML = '';
  rows.forEach(({ label, value }) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${value}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Override initProfilePage to support tabs ──────────────────────────────────
// We patch in after the existing initProfilePage by hooking into DOMContentLoaded
// at the bottom. The tab switch and data fetching are injected post-load.
function initProfileTabData(name, data) {
  // Render metadata immediately (no API needed)
  renderMetadata(data);

  // Fetch sale history and comps only when those tabs are first activated
  let historyLoaded = false;
  let compsLoaded   = false;

  const overviewTab  = document.querySelector('[data-ptab="overview"]');
  const historyTab   = document.querySelector('[data-ptab="history"]');
  const compsTab     = document.querySelector('[data-ptab="comps"]');

  if (historyTab) {
    historyTab.addEventListener('click', () => {
      if (!historyLoaded) {
        historyLoaded = true;
        fetchAndRenderSaleHistory(name);
      }
    });
  }
  if (compsTab) {
    compsTab.addEventListener('click', () => {
      if (!compsLoaded) {
        compsLoaded = true;
        fetchAndRenderComps(name);
      }
    });
  }
}

// ── Recently Listed fetch ─────────────────────────────────────────────────────
async function fetchAndRenderRecentlyListed() {
  const el = document.getElementById('recentlyListed');
  if (!el) return;

  if (!UNISAT_API_KEY) {
    el.innerHTML = '';
    SEED_NAMES.slice(0, 6).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
    return;
  }

  // Fetch freshest listings (newest first via start=0, no special sort — just latest inscribed)
  const data = await fetchListings({ page: 0, pageSize: 12 });
  el.innerHTML = '';
  if (!data || !data.list || data.list.length === 0) {
    SEED_NAMES.slice(0, 6).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
    return;
  }

  data.list.slice(0, 10).forEach(item => {
    const cardData = unisatListingToCard(item);
    const card = buildNameCard({ ...cardData, score: calcScore(cardData) });
    card.style.flex = '0 0 180px';
    el.appendChild(card);
  });
}

// ── Price Drops: listings with price below floor estimates ───────────────────
async function fetchAndRenderPriceDrops() {
  const el = document.getElementById('priceDrops');
  if (!el) return;

  if (!UNISAT_API_KEY) {
    el.innerHTML = '';
    SEED_NAMES.slice(0, 5).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
    return;
  }

  // Fetch .btc listings sorted by low price — these represent price drops relative to floor
  const data = await unisatPost('/v3/market/domain/auction/list', {
    filter: { nftType: 'domain', domainType: 'btc' },
    sort: { unitPrice: 1 },
    start: 0,
    limit: 10,
  });

  el.innerHTML = '';

  if (!data || !data.list || data.list.length === 0) {
    SEED_NAMES.slice(0, 5).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
    return;
  }

  // Tag them as price drops (low price relative to category)
  data.list.slice(0, 8).forEach(item => {
    const cardData = unisatListingToCard(item);
    const score = calcScore(cardData);
    // Show as price drop only if price is noteworthy (non-zero)
    if (!cardData.price) return;

    const card = buildNameCard({ ...cardData, score });
    card.style.flex = '0 0 180px';

    // Inject a price-drop tag above price
    const priceEl = card.querySelector('.name-card__price');
    if (priceEl) {
      const tag = document.createElement('span');
      tag.className = 'price-drop-tag';
      tag.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg> low ask`;
      priceEl.parentNode.insertBefore(tag, priceEl);
    }
    el.appendChild(card);
  });

  if (el.children.length === 0) {
    SEED_NAMES.slice(0, 5).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
  }
}

// ── Bulk search logic ─────────────────────────────────────────────────────────
let BULK_RESULTS = []; // [{ base, tld, name, price, listed }]

function parseBulkInput(raw) {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0 && s.length <= 63)
    .map(s => {
      // Strip known TLD if present so we always work with base
      for (const tld of SUPPORTED_TLDS) {
        if (s.endsWith(tld)) return s.slice(0, s.length - tld.length);
      }
      return s.replace(/\.[^.]*$/, '') || s; // strip any trailing .xxx
    })
    .filter((s, i, arr) => arr.indexOf(s) === i) // deduplicate
    .filter(s => /^[a-z0-9-]+$/.test(s))
    .slice(0, 50); // cap at 50 names
}

function getActiveBulkTlds() {
  return [...document.querySelectorAll('#bulkTldChips .filter-chip--sm.active')]
    .map(b => b.dataset.tld)
    .filter(Boolean);
}

async function runBulkSearch() {
  const textarea = document.getElementById('bulkTextarea');
  if (!textarea) return;
  const bases = parseBulkInput(textarea.value);
  if (bases.length === 0) return;

  const emptyEl   = document.getElementById('bulkEmpty');
  const loadingEl = document.getElementById('bulkLoading');
  const resultsEl = document.getElementById('bulkResults');
  const csvBtn    = document.getElementById('bulkCsvBtn');

  if (emptyEl)   emptyEl.style.display   = 'none';
  if (resultsEl) resultsEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'block';

  const activeTlds = getActiveBulkTlds();
  if (activeTlds.length === 0) activeTlds.push('.btc');

  BULK_RESULTS = [];

  // Build lookup map: base -> { tld: { price, listed, inscriptionId } }
  const priceMap = {};
  for (const base of bases) priceMap[base] = {};

  // Fetch prices for each base across all active TLDs
  const promises = [];
  for (const base of bases) {
    for (const tld of activeTlds) {
      const domainType = tld.replace('.', '');
      promises.push(
        (async () => {
          if (!UNISAT_API_KEY) return;
          const data = await unisatPost('/v3/market/domain/auction/list', {
            filter: { nftType: 'domain', domainType, keyword: base },
            sort: { unitPrice: 1 },
            start: 0,
            limit: 1,
          });
          const item = data && data.list && data.list[0];
          // Match exact domain
          if (item && item.domain) {
            const itemBase = getBase(item.domain.includes('.') ? item.domain : item.domain + tld);
            if (itemBase === base) {
              priceMap[base][tld] = { price: item.price || item.unitPrice, listed: true, inscriptionId: item.inscriptionId };
              return;
            }
          }
          priceMap[base][tld] = { price: null, listed: false };
        })()
      );
    }
  }

  await Promise.all(promises);

  // Build results rows
  BULK_RESULTS = bases.map(base => {
    let bestPrice = null;
    let bestTld = null;
    for (const tld of activeTlds) {
      const info = priceMap[base][tld];
      if (info && info.listed && info.price) {
        if (!bestPrice || info.price < bestPrice) {
          bestPrice = info.price;
          bestTld   = tld;
        }
      }
    }
    return { base, tldData: priceMap[base], bestPrice, bestTld, activeTlds };
  });

  if (loadingEl) loadingEl.style.display = 'none';
  if (resultsEl) resultsEl.style.display = 'block';
  if (csvBtn)    csvBtn.style.display    = '';

  renderBulkTable(BULK_RESULTS, 'all');

  const countEl = document.getElementById('bulkResultCount');
  if (countEl) countEl.textContent = `${BULK_RESULTS.length} names checked across ${activeTlds.join(', ')}`;

  // Update table headers to match active TLDs
  updateBulkTableHeaders(activeTlds);
}

function updateBulkTableHeaders(tlds) {
  const table = document.getElementById('bulkTable');
  if (!table) return;
  const thead = table.querySelector('thead tr');
  if (!thead) return;
  // Rebuild header
  const fixedCols = ['Name', 'Best price', ''];
  thead.innerHTML = `<th>Name</th>` +
    tlds.map(t => `<th>${t}</th>`).join('') +
    `<th>Best price</th><th></th>`;
}

function renderBulkTable(rows, filter) {
  const tbody = document.getElementById('bulkTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  let filtered = rows;
  if (filter === 'listed')    filtered = rows.filter(r => r.bestPrice);
  if (filter === 'notlisted') filtered = rows.filter(r => !r.bestPrice);

  filtered.forEach(row => {
    const { base, tldData, bestPrice, bestTld, activeTlds } = row;
    const tr = document.createElement('tr');

    // Name cell
    const nameTd = document.createElement('td');
    nameTd.className = 'bulk-name-cell';
    const primaryName = base + (bestTld || (activeTlds[0] || '.btc'));
    nameTd.innerHTML = `<a href="./name.html?name=${encodeURIComponent(primaryName)}">${base}<span style="color:var(--color-primary);">${bestTld || (activeTlds[0] || '.btc')}</span></a>`;
    tr.appendChild(nameTd);

    // TLD columns
    (activeTlds || ['.btc', '.sats', '.x', '.ord', '.xbt']).forEach(tld => {
      const td = document.createElement('td');
      const info = tldData[tld] || { price: null, listed: false };
      const fullName = base + tld;
      if (info.listed && info.price) {
        td.innerHTML = `<a href="./name.html?name=${encodeURIComponent(fullName)}" class="bulk-tld-chip listed"><span class="bulk-tld-price">${formatSats(info.price)}</span></a>`;
      } else {
        td.innerHTML = `<a href="./name.html?name=${encodeURIComponent(fullName)}" class="bulk-tld-chip not-listed">—</a>`;
      }
      tr.appendChild(td);
    });

    // Best price
    const bestTd = document.createElement('td');
    bestTd.style.fontFamily = 'var(--font-mono)';
    bestTd.style.fontWeight = '700';
    bestTd.style.color = bestPrice ? 'var(--color-primary)' : 'var(--color-text-faint)';
    bestTd.textContent = bestPrice ? formatSats(bestPrice) : 'Not listed';
    tr.appendChild(bestTd);

    // Action
    const actionTd = document.createElement('td');
    actionTd.style.textAlign = 'right';
    if (bestPrice && bestTld) {
      const info = tldData[bestTld];
      const buyFullName = base + bestTld;
      const buyBtn = document.createElement('button');
      buyBtn.className = 'btn btn--primary btn--sm';
      buyBtn.textContent = 'Buy';
      buyBtn.onclick = () => {
        if (typeof window.openBuyModal === 'function') {
          window.openBuyModal({
            name: buyFullName,
            auctionId: info && info.auctionId,
            priceSats: bestPrice,
          });
        } else {
          const fallback = info && info.inscriptionId
            ? `https://unisat.io/market/ordinals/auction?inscriptionId=${info.inscriptionId}`
            : `https://unisat.io/bns/market?type=${encodeURIComponent(bestTld.replace('.',''))}&search=${encodeURIComponent(base)}`;
          window.open(fallback, '_blank', 'noopener,noreferrer');
        }
      };
      actionTd.appendChild(buyBtn);
    }
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:var(--space-8); color:var(--color-text-faint); font-size:var(--text-sm);">No names match this filter.</td></tr>`;
  }
}

function applyBulkFilter(filter, btn) {
  document.querySelectorAll('[data-bulk-filter]').forEach(b => b.classList.toggle('active', b.dataset.bulkFilter === filter));
  renderBulkTable(BULK_RESULTS, filter);
}

function exportBulkCsv() {
  if (BULK_RESULTS.length === 0) return;
  const activeTlds = getActiveBulkTlds();
  const header = ['Name', ...activeTlds, 'Best price', 'Best TLD'].join(',');
  const rows = BULK_RESULTS.map(r => {
    const tldPrices = activeTlds.map(tld => {
      const info = r.tldData[tld];
      return info && info.price ? info.price : '';
    });
    return [r.base, ...tldPrices, r.bestPrice || '', r.bestTld || ''].join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'btcnative-bulk.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function loadExample(type) {
  const textarea = document.getElementById('bulkTextarea');
  if (!textarea) return;
  const examples = {
    numeric:  Array.from({length: 20}, (_, i) => 100 + i).join('\n'),
    letters3: ['btc','ord','sat','gm','xbt','abc','xyz','nft','web','dao','dex','pow','pos','mev','rwa'].join('\n'),
    animals:  ['cat','dog','fox','owl','bee','ant','bat','elk','cod','eel','gnu','yak','emu','jay','koi'].join('\n'),
  };
  textarea.value = examples[type] || '';
}

// Toggle TLD chip in bulk panel
document.addEventListener('click', e => {
  const chip = e.target.closest('#bulkTldChips .filter-chip--sm');
  if (!chip) return;
  chip.classList.toggle('active');
});

// ── New index init: original + recently listed + price drops ─────────────────
async function initIndexMVP() {
  // Original init: categories, stats, seed names, BNRP section
  // --- categories ---
  const catGrid = qs('#categoryGrid');
  if (catGrid) {
    const all = [
      CATEGORIES.numeric[0], CATEGORIES.numeric[1], CATEGORIES.numeric[2],
      CATEGORIES.letters[1], CATEGORIES.letters[2],
      CATEGORIES.tld[0], CATEGORIES.tld[1],
      CATEGORIES.signal[0],
    ];
    all.forEach(cat => catGrid.appendChild(buildCategoryCard(cat)));
  }
  renderSeedNames('recentSales', SEED_NAMES.slice(0, 4));
  renderSeedNames('bnrpNames', SEED_NAMES.filter(n => n.bnrp));
  updateStats();

  if (UNISAT_API_KEY) {
    fetchDomainTypes().then(domainTypes => {
      if (!domainTypes) return;
      const tldToKey = { 'tld-btc': 'btc', 'tld-sats': 'sats', 'tld-x': 'x', 'tld-ord': 'ord' };
      Object.entries(tldToKey).forEach(([slug, key]) => {
        const dt = domainTypes[key];
        if (dt && dt.curPrice) {
          qsa(`[data-floor-slug="${slug}"]`).forEach(el => {
            el.textContent = formatSats(dt.curPrice);
          });
        }
      });
    });
  }
  const bnrpData = await resolveName('trump.btc');
  if (bnrpData && bnrpData.name) {
    const el = qs('#bnrpNames');
    if (el) {
      el.innerHTML = '';
      const cardData = {
        name: 'trump.btc',
        inscriptionId: bnrpData.inscriptionId || 'ac975126b9a6138238bb3a42b1a9c5b9b4da91bca6bacb6539bc34dbed2cf329i0',
        address: bnrpData.address,
        bnrp: bnrpData,
        score: calcScore({ name: 'trump.btc', bnrp: bnrpData }),
      };
      el.appendChild(buildNameCard(cardData));
      SEED_NAMES.slice(1, 4).forEach(n => el.appendChild(buildNameCard({ ...n, score: calcScore(n) })));
    }
  }
  // New sections
  await fetchAndRenderRecentlyListed();
  await fetchAndRenderPriceDrops();
}

// ── Minimal profile for names with inscription but no BNRP records ───────────
function renderMinimalProfile(name, data) {
  const base    = getBase(name);
  const tld     = getTld(name);
  const initial = base[0] ? base[0].toUpperCase() : '?';
  const records = data.records || {};
  const score   = calcScore({ name, bnrp: { records } });

  qs('#profileSkeleton').style.display = 'none';
  qs('#profileContent').removeAttribute('style');
  qs('#profileName').textContent = base + tld;
  qs('#breadcrumbName').textContent = name;
  qs('#profileAvatar').textContent = initial;

  const addr = data.address;
  if (addr) {
    qs('#profileAddress').innerHTML = `<a href="https://mempool.space/address/${addr}" target="_blank" rel="noopener noreferrer" title="${addr}">${shortAddr(addr)}</a>`;
  }

  const inscId = data.inscriptionId;
  if (inscId) {
    qs('#profileInscriptionId').innerHTML = `<a href="https://ordinals.com/inscription/${inscId}" target="_blank" rel="noopener noreferrer" title="${inscId}">${inscId.slice(0,20)}...${inscId.slice(-8)}</a>`;
  }

  // Score ring
  const circ = qs('#scoreCircle');
  const scoreEl = qs('#scoreValue');
  if (circ && scoreEl) {
    scoreEl.textContent = score;
    scoreEl.style.color = scoreColor(score);
    const circumference = 2 * Math.PI * 26;
    setTimeout(() => { circ.style.strokeDashoffset = circumference * (1 - score / 1000); }, 100);
  }

  // Attributes
  const attrEl = qs('#attrBadges');
  if (attrEl) {
    attrEl.innerHTML = '';
    computeBadges({ name, bnrp: null }).forEach(b => {
      const href = badgeToExploreUrl(b.label, name);
      const el = href ? document.createElement('a') : document.createElement('span');
      el.className = `badge-lg badge-lg--${b.color}`;
      if (href) { el.href = href; el.style.textDecoration = 'none'; }
      el.textContent = b.label;
      attrEl.appendChild(el);
    });
  }

  // Buy button + listing status — native modal via market worker
  initBuyBtn(name, inscId);

  // Activity
  const actEl = qs('#activityFeed');
  if (actEl) actEl.innerHTML = `<div class="activity-item"><div class="activity-dot"></div><span class="activity-text"><strong>${name}</strong> registered</span><span class="activity-time">genesis</span></div>`;

  // Similar
  const simEl = qs('#similarNames');
  if (simEl) {
    const similars = SEED_NAMES.filter(n => getTld(n.name) === tld && n.name !== name).slice(0, 4);
    similars.forEach(n => simEl.appendChild(buildNameCard({ ...n, score: calcScore(n) })));
    if (!similars.length) simEl.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No similar names indexed yet.</p>`;
  }

  // Score breakdown
  const breakdownEl = qs('#scoreBreakdown');
  if (breakdownEl) {
    const components = getScoreComponents({ name, bnrp: { records } });
    breakdownEl.innerHTML = components.map(c => `
      <div class="score-bar-row">
        <span class="score-bar-label">${c.label}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${c.pct}%"></div></div>
      </div>`).join('');
  }
}

// ── New profile init: original + tabs ────────────────────────────────────────
async function initProfilePageMVP() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name');
  if (!name) { showProfileError(); return; }

  document.title = `${name} — BTC Native`;
  const bc = qs('#breadcrumbName');
  if (bc) bc.textContent = name;

  // Nav search
  const navSearch  = qs('#navSearch');
  const navResults = qs('#navResults');
  if (navSearch) initSearchInput(navSearch, navResults);

  const SEED_PROFILES = {
    'trump.btc': {
      name: 'trump.btc',
      inscriptionId: 'ac975126b9a6138238bb3a42b1a9c5b9b4da91bca6bacb6539bc34dbed2cf329i0',
      address: 'bc1pkdqs4ksyha8n2ugxtyywku35pwmv7t60yrru0f860aaf3u5faujq9a6hmc',
      records: {
        avatar: 'ord:a859c487d16725cea4c9ccc6d87dda3168e03b388d5e4c9f2acc1ab42dd3d471i0',
        display: 'Trump',
        description: 'Protocol architect. Built BNRP — open standard for Bitcoin-native identity and name resolution.',
        'com.twitter': 'ordinalpunk72',
        url: 'https://www.bnrp.name'
      }
    }
  };
  const liveData = await resolveName(name);
  // resolveName returns BNRP identity records (name+records) or raw inscription data (no records)
  // We only use liveData if it has actual identity records or a name field
  const hasIdentity = liveData && (liveData.name || (liveData.records && Object.keys(liveData.records).length));
  const data = (hasIdentity ? liveData : null) || SEED_PROFILES[name] || null;

  qs('#profileSkeleton').style.display = 'none';

  if (!data) {
    // If we got inscription data from API (name exists on-chain even without BNRP records),
    // use inscription data to show a minimal profile
    if (liveData && liveData.data && liveData.data.address) {
      // Build minimal profile from inscription info
      const inscData = liveData.data;
      const minimalData = {
        name,
        inscriptionId: inscData.inscriptionId,
        address: inscData.address,
        records: {},
      };
      renderMinimalProfile(name, minimalData);
      initProfileTabData(name, minimalData);
      return;
    }
    showProfileError(); return;
  }

  const resolvedData = data || { name, records: {}, address: null };
  if (!resolvedData.records) resolvedData.records = {};
  const hasBnrp = !!(resolvedData.records && Object.keys(resolvedData.records).length);

  const base    = getBase(name);
  const tld     = getTld(name);
  const initial = base[0] ? base[0].toUpperCase() : '?';
  const records = (resolvedData && resolvedData.records) || {};
  const score   = calcScore({ name, bnrp: { records } });

  qs('#profileContent').removeAttribute('style');
  qs('#profileName').textContent = base + tld;
  qs('#breadcrumbName').textContent = name;

  if (records.display)     qs('#profileDisplayName').textContent = records.display;
  if (records.description) qs('#profileDesc').textContent = records.description;

  const avatarEl = qs('#profileAvatar');
  avatarEl.textContent = initial;
  if (records.avatar) {
    initAvatar(avatarEl, records.avatar, initial);
    qs('#profileBanner').style.background = 'linear-gradient(135deg, #1a1200, #2d1f00, #0a0a0a)';
  }

  if (hasBnrp || (resolvedData && resolvedData.name) || records.display) {
    const badge = qs('#profileBnrpBadge');
    if (badge) badge.style.display = 'block';
  }

  const addr = resolvedData.address || resolvedData.owner;
  if (addr) {
    qs('#profileAddress').innerHTML = `<a href="https://mempool.space/address/${addr}" target="_blank" rel="noopener noreferrer" title="${addr}">${shortAddr(addr)}</a>`;
  }
  if (records['com.twitter']) {
    qs('#profileTwitterField').style.display = 'block';
    qs('#profileTwitter').innerHTML = `<a href="https://x.com/${records['com.twitter']}" target="_blank" rel="noopener noreferrer">@${records['com.twitter']}</a>`;
  }
  if (records.url) {
    qs('#profileUrlField').style.display = 'block';
    qs('#profileUrl').innerHTML = `<a href="${records.url}" target="_blank" rel="noopener noreferrer">${records.url.replace('https://','')}</a>`;
  }

  const inscId = resolvedData.inscriptionId || resolvedData.nameInscriptionId;
  if (inscId) {
    qs('#profileInscriptionId').innerHTML = `<a href="https://ordinals.com/inscription/${inscId}" target="_blank" rel="noopener noreferrer" title="${inscId}">${inscId.slice(0,20)}...${inscId.slice(-8)}</a>`;
  }

  const circ = qs('#scoreCircle');
  const scoreEl = qs('#scoreValue');
  if (circ && scoreEl) {
    scoreEl.textContent = score;
    scoreEl.style.color = scoreColor(score);
    const circumference = 2 * Math.PI * 26;
    const offset = circumference * (1 - score / 1000);
    setTimeout(() => { circ.style.strokeDashoffset = offset; }, 100);
  }

  const breakdownEl = qs('#scoreBreakdown');
  if (breakdownEl) {
    const components = getScoreComponents({ name, bnrp: { records } });
    breakdownEl.innerHTML = components.map(c => `
      <div class="score-bar-row">
        <span class="score-bar-label">${c.label}</span>
        <div class="score-bar-track"><div class="score-bar-fill" style="width:${c.pct}%"></div></div>
      </div>`).join('');
  }

  const attrEl = qs('#attrBadges');
  if (attrEl) {
    attrEl.innerHTML = '';
    const fullData = { name, bnrp: { records }, inscriptionId: inscId };
    const badges = [...computeBadges(fullData).map(b => ({...b, size: 'lg'}))];
    if (getBase(name).length <= 5) badges.push({ label: `${getBase(name).length} chars`, color: 'muted', size: 'lg' });
    badges.forEach(b => {
      const href = badgeToExploreUrl(b.label, name);
      const el = href ? document.createElement('a') : document.createElement('span');
      el.className = `badge-lg badge-lg--${b.color}`;
      if (href) { el.href = href; el.style.cursor = 'pointer'; el.style.textDecoration = 'none'; }
      el.textContent = b.label;
      attrEl.appendChild(el);
    });
  }

  // Buy button + listing status — native modal via market worker
  initBuyBtn(name, inscId);

  // Activity (overview tab)
  const actEl = qs('#activityFeed');
  if (actEl) {
    actEl.innerHTML = `
      <div class="activity-item"><div class="activity-dot"></div><span class="activity-text"><strong>${name}</strong> registered</span><span class="activity-time">genesis</span></div>
      ${records.avatar ? `<div class="activity-item"><div class="activity-dot" style="background:var(--color-success);"></div><span class="activity-text">BNRP record inscribed — avatar set</span><span class="activity-time">recent</span></div>` : ''}
      <div class="activity-item"><div class="activity-dot" style="background:var(--color-text-faint);"></div><span class="activity-text">Indexed by BTC Native</span><span class="activity-time">now</span></div>
    `;
  }

  // Similar names
  const simEl = qs('#similarNames');
  if (simEl) {
    const similars = SEED_NAMES.filter(n => getTld(n.name) === tld && n.name !== name).slice(0, 4);
    similars.forEach(n => simEl.appendChild(buildNameCard({ ...n, score: calcScore(n) })));
    if (similars.length === 0) {
      simEl.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No similar names indexed yet.</p>`;
    }
  }

  // Wire up profile tabs with lazy data loading
  const fullResolvedData = { name, records, inscriptionId: inscId, address: addr };
  renderMetadata(fullResolvedData);
  initProfileTabData(name, fullResolvedData);
}

// ── New explore init ──────────────────────────────────────────────────────────
async function initExplorePageMVP() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab') || 'categories';
  switchTab(tab);

  // Populate categories
  const rarityEl     = qs('#rarityCategories');
  const provenanceEl = qs('#provenanceCategories');
  const signalEl     = qs('#signalCategories');
  const tldEl        = qs('#tldCategories');
  if (rarityEl)     CATEGORIES.numeric.forEach(c => rarityEl.appendChild(buildCategoryCard(c)));
  if (provenanceEl) CATEGORIES.letters.forEach(c => provenanceEl.appendChild(buildCategoryCard(c)));
  if (tldEl)        CATEGORIES.tld.forEach(c => tldEl.appendChild(buildCategoryCard(c)));
  if (signalEl)     CATEGORIES.signal.forEach(c => signalEl.appendChild(buildCategoryCard(c)));

  // Apply URL filters
  const urlLen     = params.get('len');
  const urlTld     = params.get('tld');
  const urlSpecial = params.get('special');
  const urlSort    = params.get('sort');
  if (urlLen)     { currentLen     = urlLen;     const b = qs(`[data-len="${urlLen}"]`);         if (b) b.classList.add('active'); }
  if (urlTld)     { currentTld     = urlTld;     const b = qs(`[data-tld="${urlTld}"]`);         if (b) b.classList.add('active'); }
  if (urlSpecial) { currentSpecial = urlSpecial; const b = qs(`[data-special="${urlSpecial}"]`); if (b) b.classList.add('active'); }
  if (urlSort)    { currentSort    = urlSort; }

  // TLD 'all' chip
  if (!urlTld) {
    const allChip = qs('[data-tld="all"]');
    if (allChip) allChip.classList.add('active');
  }

  // Build API params
  const apiParams = {};
  if (urlTld)  apiParams.domainType = urlTld.replace('.', '');
  if (urlLen === '1-2') { apiParams.minLength = 1; apiParams.maxLength = 2; }
  if (urlLen === '3')   { apiParams.minLength = 3; apiParams.maxLength = 3; }
  if (urlLen === '4')   { apiParams.minLength = 4; apiParams.maxLength = 4; }
  if (urlLen === '5')   { apiParams.minLength = 5; apiParams.maxLength = 5; }
  if (urlLen === '6+')  { apiParams.minLength = 6; }

  const hasUrlFilter = urlLen || urlTld || urlSpecial;
  const gridEl = qs('#listingsGrid');

  if (UNISAT_API_KEY && (hasUrlFilter || tab === 'listings')) {
    if (gridEl) {
      gridEl.innerHTML = Array(8).fill(0).map(() =>
        `<div class="name-card skeleton" style="height:96px;border-radius:var(--radius-lg);"></div>`
      ).join('');
    }
    const result = await fetchListings(apiParams);
    if (result && result.list && result.list.length > 0) {
      LIVE_LISTINGS = result.list.map(unisatListingToCard);
    }
    renderListings(getFilteredNamesMVP());
    const countEl = qs('#listingCount');
    if (countEl && result && result.total) countEl.textContent = `${result.total.toLocaleString()} names`;
    const loadBtn = qs('#loadMoreBtn');
    if (loadBtn) loadBtn.style.display = '';
  } else {
    renderListings(getFilteredNamesMVP());
    if (UNISAT_API_KEY) {
      fetchListings(apiParams).then(result => {
        if (result && result.list && result.list.length > 0) {
          LIVE_LISTINGS = result.list.map(unisatListingToCard);
          renderListings(getFilteredNamesMVP());
          const countEl = qs('#listingCount');
          if (countEl && result.total) countEl.textContent = `${result.total.toLocaleString()} names`;
        }
        const loadBtn = qs('#loadMoreBtn');
        if (loadBtn) loadBtn.style.display = '';
      });
    }
  }

  renderMarketIndexes();

  // Nav search
  const navSearch  = qs('#navSearch');
  const navResults = qs('#navResults');
  if (navSearch) initSearchInput(navSearch, navResults);
}

// ── New loadMore using MVP filter ─────────────────────────────────────────────
async function loadMore() {
  if (!UNISAT_API_KEY) return;
  const page = LIVE_LISTINGS ? Math.floor(LIVE_LISTINGS.length / 20) : 0;
  const result = await fetchListings({ page, pageSize: 20 });
  if (result && result.list) {
    const newItems = result.list.map(unisatListingToCard);
    LIVE_LISTINGS = [...(LIVE_LISTINGS || []), ...newItems];
    renderListings(getFilteredNamesMVP());
  }
}

// ── Main boot (replaces original DOMContentLoaded) ───────────────────────────
// The original DOMContentLoaded is still registered above and will fire,
// but we re-route here with a second listener that runs the MVP versions.
// The original listener calls initIndex/initProfilePage/initExplorePage which
// are still the old versions. We need to prevent that. We do this by overwriting
// the page detection right at the DOMContentLoaded moment using a flag.
let _mvpBooted = false;
document.addEventListener('DOMContentLoaded', () => {
  if (_mvpBooted) return;
  _mvpBooted = true;
  const path = location.pathname;
  const isIndex   = path.endsWith('index.html') || path.endsWith('index') || path.endsWith('/') || path === '';
  const isProfile = path.includes('name.html') || path.endsWith('/name');
  const isExplore = path.includes('explore.html') || path.endsWith('/explore');
  const isBulk    = path.includes('bulk.html') || path.endsWith('/bulk');

  if (isIndex) {
    initIndexMVP();
    const heroSearch = qs('#heroSearch');
    const heroResults = qs('#heroResults');
    if (heroSearch) {
      initSearchInput(heroSearch, heroResults);
      qs('#heroSearchBtn').addEventListener('click', () => {
        const q = heroSearch.value.trim();
        if (q) navigateToName(q);
      });
    }
  }
  if (isProfile) initProfilePageMVP();
  if (isExplore) initExplorePageMVP();
  if (isBulk) {
    const navSearch  = qs('#navSearch');
    const navResults = qs('#navResults');
    if (navSearch) initSearchInput(navSearch, navResults);
    const textarea = qs('#bulkTextarea');
    if (textarea) {
      textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && e.metaKey) runBulkSearch();
      });
    }
  }
});
