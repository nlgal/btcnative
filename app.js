/* app.js — btcnative.name
 * Bitcoin name discovery platform powered by BNRP + UniSat APIs
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BNRP_API        = 'https://bnrp.name/api';
const UNISAT_API      = 'https://open-api.unisat.io';
const UNISAT_API_KEY  = '';  // ← paste your key from unisat.io/open-api
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
  if (n >= 1e8) return (n / 1e8).toFixed(4) + ' BTC';
  return n.toLocaleString() + ' sats';
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

// ── Category definitions ──────────────────────────────────────────────────────
const CATEGORIES = {
  rarity: [
    { slug: '3l',       name: '3L Club',       icon: '🔤', desc: 'Three-character names', color: '#f7931a', colorDim: 'rgba(247,147,26,0.12)', count: '~26K', floorLabel: '.btc floor', floor: null },
    { slug: '4l',       name: '4L Club',       icon: '✦',  desc: 'Four-character names',  color: '#e8902a', colorDim: 'rgba(232,144,42,0.12)', count: '~676K', floorLabel: '.btc floor', floor: null },
    { slug: 'number3',  name: '3-Digit',       icon: '💯', desc: '000-999 numeric names', color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)', count: '3,000', floorLabel: 'floor', floor: null },
    { slug: 'number4',  name: '4-Digit',       icon: '🔢', desc: '0000-9999 numeric',     color: '#818cf8', colorDim: 'rgba(129,140,248,0.12)', count: '30K', floorLabel: 'floor', floor: null },
    { slug: 'palindrome', name: 'Palindromes', icon: '🔁', desc: 'Same forwards & back',  color: '#a78bfa', colorDim: 'rgba(167,139,250,0.12)', count: 'Rare', floorLabel: 'floor', floor: null },
    { slug: 'cultural', name: 'Cultural',      icon: '🌐', desc: 'First names, OG culture', color: '#34d399', colorDim: 'rgba(52,211,153,0.12)', count: 'Various', floorLabel: 'floor', floor: null },
  ],
  provenance: [
    { slug: 'sub1k',    name: 'Sub-1K',        icon: '⚡', desc: 'First 1,000 inscriptions', color: '#fbbf24', colorDim: 'rgba(251,191,36,0.12)', count: '1,000', floorLabel: 'floor', floor: null },
    { slug: 'sub10k',   name: 'Sub-10K',       icon: '🌟', desc: 'First 10,000 inscriptions', color: '#f59e0b', colorDim: 'rgba(245,158,11,0.12)', count: '10K', floorLabel: 'floor', floor: null },
    { slug: 'tld-btc',  name: '.btc',          icon: '₿',  desc: 'BNS names on UniSat',   color: '#f7931a', colorDim: 'rgba(247,147,26,0.12)', count: 'Largest', floorLabel: 'floor', floor: null },
    { slug: 'tld-sats', name: '.sats',         icon: '⚡', desc: 'Sats Names protocol',   color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)', count: 'Large', floorLabel: 'floor', floor: null },
    { slug: 'tld-x',    name: '.x',            icon: '✗',  desc: 'Cross-chain identity',  color: '#a78bfa', colorDim: 'rgba(167,139,250,0.12)', count: 'Growing', floorLabel: 'floor', floor: null },
    { slug: 'tld-ord',  name: '.ord',          icon: '📜', desc: 'Ordinals-native',        color: '#34d399', colorDim: 'rgba(52,211,153,0.12)', count: 'Niche', floorLabel: 'floor', floor: null },
  ],
  signal: [
    { slug: 'bnrp',     name: 'BNRP Verified', icon: '✓',  desc: 'Active BNRP identity records', color: '#4ade80', colorDim: 'rgba(74,222,128,0.12)', count: 'Live', floorLabel: 'floor', floor: null },
    { slug: 'listed',   name: 'Listed Now',    icon: '🏷',  desc: 'Currently for sale',    color: '#60a5fa', colorDim: 'rgba(96,165,250,0.12)', count: 'Live', floorLabel: 'lowest ask', floor: null },
    { slug: 'dictionary', name: 'Dictionary', icon: '📖',  desc: 'Common English words',  color: '#f59e0b', colorDim: 'rgba(245,158,11,0.12)', count: 'Various', floorLabel: 'floor', floor: null },
  ],
};

function buildCategoryCard(cat) {
  const card = document.createElement('a');
  card.className = 'category-card';
  card.href = `./explore.html?category=${cat.slug}`;
  card.style.setProperty('--card-accent', cat.color);
  card.style.setProperty('--card-accent-dim', cat.colorDim);
  card.innerHTML = `
    <div class="category-card__icon">${cat.icon}</div>
    <div>
      <div class="category-card__name">${cat.name}</div>
      <div class="category-card__count">${cat.count} names</div>
    </div>
    <div class="category-card__floor">
      <span class="category-card__floor-price" data-floor-slug="${cat.slug}">—</span>
      <span class="category-card__floor-label">${cat.floorLabel}</span>
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
    const all = [...CATEGORIES.rarity, ...CATEGORIES.provenance.slice(0,2), ...CATEGORIES.signal.slice(0,2)];
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
  setStatEl('statBtcFloor', '80K sats');
  setStatEl('statSatsFloor','22K sats');
  setStatEl('stat3LFloor',  '420K sats');
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
  const data = liveData || SEED_PROFILES[name] || null;

  qs('#profileSkeleton').style.display = 'none';

  if (!data && !SEED_PROFILES[name]) { showProfileError(); return; }

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
      const span = document.createElement('span');
      span.className = `badge-lg badge-lg--${b.color}`;
      span.textContent = b.label;
      attrEl.appendChild(span);
    });
  }

  // Buy link
  const buyBtn = qs('#buyBtn');
  if (buyBtn && inscId) {
    buyBtn.href = `https://unisat.io/market/ordinals/auction?inscriptionId=${inscId}`;
  }

  // Listing status — check live UniSat data if API key set
  qs('#listingPrice').textContent = 'Checking...';
  qs('#listingStatus').textContent = '';
  if (inscId && UNISAT_API_KEY) {
    unisatPost('/v3/market/domain/auction/inscription_info', { inscriptionId: inscId }).then(info => {
      if (info && info.price && !info.notOnSale) {
        qs('#listingPrice').textContent = formatSats(info.price);
        qs('#listingStatus').innerHTML = `Listed on UniSat &middot; <a href="https://unisat.io/market/ordinals/auction?inscriptionId=${inscId}" target="_blank" rel="noopener noreferrer" style="color:var(--color-primary);">Buy now</a>`;
        if (buyBtn) buyBtn.href = `https://unisat.io/market/ordinals/auction?inscriptionId=${inscId}`;
      } else {
        qs('#listingPrice').textContent = 'Not listed';
        qs('#listingStatus').textContent = 'Not currently for sale. Make an offer via UniSat.';
      }
    });
  } else {
    qs('#listingPrice').textContent = 'Not listed';
    qs('#listingStatus').textContent = 'This name is not currently listed for sale. Make an offer via UniSat.';
  }

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
  if (rarityEl)     CATEGORIES.rarity.forEach(c => rarityEl.appendChild(buildCategoryCard(c)));
  if (provenanceEl) CATEGORIES.provenance.forEach(c => provenanceEl.appendChild(buildCategoryCard(c)));
  if (signalEl)     CATEGORIES.signal.forEach(c => signalEl.appendChild(buildCategoryCard(c)));

  // Populate listings with seed immediately, then replace with live data
  renderListings(SEED_NAMES);
  if (UNISAT_API_KEY) {
    fetchListings().then(result => {
      if (result && result.list && result.list.length > 0) {
        LIVE_LISTINGS = result.list.map(unisatListingToCard);
        renderListings(getFilteredNames());
        const countEl = qs('#listingCount');
        if (countEl && result.total) countEl.textContent = `${result.total.toLocaleString()} names`;
      }
    });
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
function getFilteredNames() {
  return SEED_NAMES.filter(n => {
    if (currentTld !== 'all' && getTld(n.name) !== currentTld) return false;
    const base = getBase(n.name);
    if (currentLen === '1-2' && base.length > 2) return false;
    if (currentLen === '3'   && base.length !== 3) return false;
    if (currentLen === '4'   && base.length !== 4) return false;
    if (currentLen === '5'   && base.length !== 5) return false;
    if (currentSpecial === 'bnrp' && !n.bnrp) return false;
    return true;
  });
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
    if (currentSpecial === 'bnrp' && !n.bnrp) return false;
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
    { name: 'BTC Names Floor', value: '80K sats',  desc: 'Composite floor across all TLDs', change: null },
    { name: '3L Club',         value: '420K sats', desc: '.btc three-character floor',       change: null },
    { name: '4L Club',         value: '55K sats',  desc: '.btc four-character floor',        change: null },
    { name: '3-Digit Club',    value: '1.2M sats', desc: '000-999 numeric floor',            change: null },
    { name: 'BNRP Active',     value: '95K sats',  desc: 'Names with BNRP records',         change: null },
    { name: '.sats Floor',     value: '22K sats',  desc: 'Sats Names protocol floor',       change: null },
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

  el.appendChild(buildIndexCard('BTC Names Floor', btcFloor  ? formatSats(btcFloor)  : '80K sats',  'Composite floor across all TLDs',    null, true));
  el.appendChild(buildIndexCard('3L Club',         floor3L   ? formatSats(floor3L)   : '420K sats', '.btc three-character floor',          null, true));
  el.appendChild(buildIndexCard('4L Club',         floor4L   ? formatSats(floor4L)   : '55K sats',  '.btc four-character floor',           null, true));
  el.appendChild(buildIndexCard('3-Digit Club',    floor3D   ? formatSats(floor3D)   : '1.2M sats', '000-999 numeric floor',               null, true));
  el.appendChild(buildIndexCard('BNRP Active',     btcFloor  ? formatSats(Math.round(btcFloor * 1.2)) : '95K sats', 'Names with BNRP records', null, true));
  el.appendChild(buildIndexCard('.sats Floor',     satsFloorPrice ? formatSats(satsFloorPrice) : '22K sats', 'Sats Names protocol floor', null, true));

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

async function runSearch(q, input, resultsEl) {
  resultsEl.innerHTML = `<div class="search-result-loading">Resolving ${q}...</div>`;
  resultsEl.style.display = 'block';

  // Determine if it looks like a full name with TLD
  const hasTld = SUPPORTED_TLDS.some(tld => q.endsWith(tld));
  const name = hasTld ? q : null;

  if (name) {
    const data = await resolveName(name);
    if (data) {
      showSearchResult(data, name, resultsEl);
    } else {
      resultsEl.innerHTML = `
        <div class="search-result-item" onclick="navigateToName('${name}')">
          <div class="search-result-avatar">${getBase(name)[0].toUpperCase()}</div>
          <div>
            <div class="search-result-name">${name}</div>
            <div class="search-result-sub">No BNRP record · View profile</div>
          </div>
          <span class="badge badge--muted search-result-badge">Unverified</span>
        </div>`;
    }
  } else {
    // Show suggestions
    const matches = SEED_NAMES.filter(n => n.name.includes(q.toLowerCase()));
    if (matches.length > 0) {
      resultsEl.innerHTML = '';
      matches.slice(0, 5).forEach(n => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.onclick = () => navigateToName(n.name);
        const base = getBase(n.name); const tld = getTld(n.name);
        const records = (n.bnrp && n.bnrp.records) || {};
        item.innerHTML = `
          <div class="search-result-avatar" data-avatar="${records.avatar||''}" data-initial="${base[0].toUpperCase()}">${base[0].toUpperCase()}</div>
          <div>
            <div class="search-result-name">${base}<span style="color:var(--color-primary)">${tld}</span></div>
            <div class="search-result-sub">${records.display || 'No BNRP record'}</div>
          </div>
          ${records.avatar ? `<span class="badge badge--green search-result-badge">BNRP</span>` : ''}
        `;
        if (records.avatar) {
          const av = item.querySelector('.search-result-avatar');
          initAvatar(av, records.avatar, base[0].toUpperCase());
        }
        resultsEl.appendChild(item);
      });
    } else {
      // Try resolving with .btc suffix
      const withBtc = q + '.btc';
      const data = await resolveName(withBtc);
      if (data) {
        showSearchResult(data, withBtc, resultsEl);
      } else {
        resultsEl.innerHTML = `
          <div class="search-result-item" onclick="navigateToName('${withBtc}')">
            <div class="search-result-avatar">${q[0].toUpperCase()}</div>
            <div>
              <div class="search-result-name">${withBtc}</div>
              <div class="search-result-sub">View profile</div>
            </div>
          </div>`;
      }
    }
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
document.addEventListener('DOMContentLoaded', () => {
  const path = location.pathname;
  // Support both /page.html and /page (SPA mode strips .html extension)
  const isIndex   = path.endsWith('index.html') || path.endsWith('index') || path.endsWith('/') || path === '';
  const isProfile = path.includes('name.html') || path.endsWith('/name');
  const isExplore = path.includes('explore.html') || path.endsWith('/explore');

  if (isIndex) {
    initIndex();
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
  if (isProfile) initProfilePage();
  if (isExplore) initExplorePage();
});
