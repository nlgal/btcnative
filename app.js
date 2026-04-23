/* app.js — btcnative.name
 * Bitcoin name discovery platform powered by BNRP + UniSat APIs
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BNRP_API        = 'https://api.bnrp.name/v1';
const UNISAT_API      = 'https://open-api.unisat.io';
const UNISAT_API_KEY  = 'd6082c62b212e154fb506f50957506bfefea2df898e02f7670a83791dd42a870';
const SUPPORTED_TLDS  = ['.btc', '.sats', '.x', '.ord', '.gm', '.xbt', '.sat', '.unisat', '.fb'];

// ── BTC/USD price ─────────────────────────────────────────────────────────────
let _btcUsd = null;
async function getBtcUsd() {
  if (_btcUsd) return _btcUsd;
  try {
    const r = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    _btcUsd = d.USD || 95000;
  } catch { _btcUsd = 95000; }
  return _btcUsd;
}

function formatUsd(sats, btcUsd) {
  if (!sats || !btcUsd) return '';
  const usd = (sats / 1e8) * btcUsd;
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString();
  if (usd >= 10)   return '$' + usd.toFixed(0);
  if (usd >= 1)    return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(2);
}

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
  // Saved preference wins; dark is the site default for new visitors
  const saved = localStorage.getItem('btcn-theme');
  const theme = saved || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    updateThemeIcon(btn, theme);
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('btcn-theme', next);
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
  // Query the listing with lowest unitPrice for this domainType
  const data = await unisatPost('/v3/market/domain/auction/list', {
    filter: { nftType: 'domain', domainType: tldKey },
    sort:   { unitPrice: 1 },
    start:  0,
    limit:  1,
  });
  if (!data || !data.list || data.list.length === 0) return null;
  return data.list[0].unitPrice || data.list[0].price || null;
}

// Fetch real floor prices for all known TLDs in parallel
async function fetchAllTldFloors() {
  const tldKeys = Object.keys(TLD_META); // btc, sats, x, ord, xbt, gm, unisat, sat
  const results = await Promise.allSettled(tldKeys.map(k => fetchTldFloor(k)));
  const floors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') floors[tldKeys[i]] = r.value;
  });
  return floors;
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
// Map our internal sort key to UniSat sort object
function _unisatSort(sort) {
  if (sort === 'price_desc') return { unitPrice: -1 };
  if (sort === 'recent')     return { onSaleTime: -1 };
  if (sort === 'insc_asc')   return { inscriptionNumber: 1 };
  if (sort === 'insc_desc')  return { inscriptionNumber: -1 };
  return { unitPrice: 1 }; // price_asc default
}

async function fetchListings({ domainType = null, minLength = null, maxLength = null, page = 0, pageSize = 20, sort = 'price_asc' } = {}) {
  // Fetch from both our KV worker (native PSBT listings) and UniSat marketplace.
  // UniSat does NOT support minLength/maxLength/trait filters natively — all
  // filtering is done client-side after fetching. We always fetch a large batch
  // (UNISAT_BATCH) so client-side filtering has enough data to work with.
  const UNISAT_BATCH = 200;
  try {
    // 1. Our KV worker
    const kvParams = new URLSearchParams({
      sort,
      limit: '200',
      ...(domainType ? { tld: domainType } : {}),
    });
    const kvPromise = fetch(`${MARKET_API}/api/market/listings?${kvParams}`, {
      signal: AbortSignal.timeout(8000),
    }).then(r => r.ok ? r.json() : null).catch(() => null);

    // 2. UniSat marketplace — fetch large batch, filter client-side
    const unisatPromise = UNISAT_API_KEY ? unisatPost('/v3/market/domain/auction/list', {
      filter: {
        nftType: 'domain',
        ...(domainType ? { domainType } : {}),
      },
      start: page * UNISAT_BATCH,
      limit: UNISAT_BATCH,
      sort: _unisatSort(sort),
    }).catch(() => null) : Promise.resolve(null);

    const [kvData, unisatData] = await Promise.all([kvPromise, unisatPromise]);

    // Client-side filter helper (applied to both sources)
    function passesLengthFilter(name) {
      if (!minLength && !maxLength) return true;
      const base = getBase(name);
      if (minLength && base.length < minLength) return false;
      if (maxLength && base.length > maxLength) return false;
      return true;
    }

    // Map KV listings (apply length filter only — traits filtered downstream)
    const kvListings = (kvData && kvData.ok && kvData.listings)
      ? kvData.listings
          .filter(l => l.name && passesLengthFilter(l.name))
          .map(l => ({
            name:              l.name,
            price:             l.priceSats,
            priceSats:         l.priceSats,
            feeSats:           l.feeSats,
            inscriptionId:     l.inscriptionId,
            inscriptionNumber: l.inscriptionNumber || null,
            address:           l.sellerAddress,
            auctionId:         null,
            bnrp:              null,
            source:            'kv',
          }))
      : [];

    // Map UniSat listings (apply length filter; skip names already in KV)
    const kvNames = new Set(kvListings.map(l => l.name.toLowerCase()));
    const unisatListings = (unisatData && unisatData.list)
      ? unisatData.list
          .filter(l => {
            const name = (l.domain || '').toLowerCase();
            return name && !kvNames.has(name) && passesLengthFilter(name);
          })
          .map(l => ({
            name:              l.domain,
            price:             l.price,
            priceSats:         l.price,
            feeSats:           0,
            inscriptionId:     l.inscriptionId,
            inscriptionNumber: l.inscriptionNumber || null,
            address:           l.address,
            auctionId:         l.auctionId,
            bnrp:              null,
            source:            'unisat',
          }))
      : [];

    const combined = [...kvListings, ...unisatListings];
    const total = (kvData && kvData.total ? kvData.total : 0) +
                  (unisatData ? (unisatData.total || 0) : 0);
    return { list: combined, total };
  } catch (e) {
    console.warn('fetchListings error:', e.message);
    return null;
  }
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
// Normalizes api.bnrp.name/v1 response to the internal shape used throughout app.js:
// { name, inscriptionId, address, records: { avatar, display, description, url, com.twitter, ... } }
async function resolveName(name) {
  try {
    // Use a longer timeout than fetchJson's 4s — BNRP worker makes multiple upstream
    // calls (UniSat, ordinals.com) and can take 8-12s on cold starts.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let data;
    try {
      const res = await fetch(`${BNRP_API}/resolve/${encodeURIComponent(name)}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!data || !data.name) return null;
    // Normalize to internal shape
    const profile = data.profile || {};
    const records = {};
    if (profile.avatar)        records.avatar       = profile.avatar;
    if (profile.display)       records.display      = profile.display;
    if (profile.description)   records.description  = profile.description;
    if (profile.url)           records.url          = profile.url;
    if (profile['com.twitter']) records['com.twitter'] = profile['com.twitter'];
    if (profile['com.github'])  records['com.github']  = profile['com.github'];
    return {
      name:          data.name,
      inscriptionId: data.inscription_id || null,
      address:       data.owner || null,
      owner:         data.owner || null,
      records,
    };
  } catch { return null; }
}
async function resolveSnsDomain(name) {
  // Alias — same endpoint handles all BNRP TLDs
  return resolveName(name);
}

// Avatar URL: bare inscription id or ord: prefix → static.unisat.space CDN
function resolveAvatarUrl(avatarField) {
  if (!avatarField) return null;
  if (avatarField.startsWith('ord:')) {
    return `https://static.unisat.space/content/${avatarField.slice(4)}`;
  }
  if (avatarField.startsWith('http')) return avatarField;
  // bare inscription id
  if (/^[a-f0-9]{64}i\d+$/.test(avatarField)) {
    return `https://static.unisat.space/content/${avatarField}`;
  }
  return null;
}

function initAvatar(el, avatarField, _fallbackText) {
  // No letter initials — gradient background is set by caller; just inject image if available
  const url = resolveAvatarUrl(avatarField);
  if (url) {
    const img = document.createElement('img');
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
    img.onerror = () => { /* image failed — gradient fallback already in place, no initials */ };
    img.onload  = () => { el.innerHTML = ''; el.appendChild(img); };
    img.src = url;
  }
  // no url — leave gradient background as-is
}

// ── Deterministic gradient avatar ────────────────────────────────────────────
// Generates a consistent HSL gradient for a name string — same as ENS approach.
function nameGradient(name) {
  if (!name) return { from: '#f7931a', to: '#c0620a', text: '#000' };
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  const hue1  = Math.abs(hash) % 360;
  const hue2  = (hue1 + 40) % 360;
  // Avoid near-white backgrounds by clamping saturation/lightness
  const sat   = 55 + (Math.abs(hash >> 8) % 30);  // 55-85%
  const light = 38 + (Math.abs(hash >> 4) % 18);  // 38-56%
  const text  = light > 50 ? '#000' : '#fff';
  return {
    from: `hsl(${hue1},${sat}%,${light}%)`,
    to:   `hsl(${hue2},${sat}%,${light - 8}%)`,
    text,
  };
}

// ── Name card builder ─────────────────────────────────────────────────────────
function buildNameCard(data) {
  const { name, bnrp, address, inscriptionId, price, score, auctionId } = data;
  const base = getBase(name);
  const tld  = getTld(name);
  const rawInit = base[0] ? base[0].toUpperCase() : '?';
  const initial = /[A-Z]/i.test(rawInit) ? rawInit : '\u20BF';
  const s = score || calcScore(data);
  const avatarField = bnrp && bnrp.records && bnrp.records.avatar;
  const displayName = bnrp && bnrp.records && bnrp.records.display;

  // Deterministic gradient for avatar fallback
  const grad = nameGradient(name);
  const gradStyle = `background:linear-gradient(135deg,${grad.from},${grad.to});color:${grad.text};`;

  const card = document.createElement('a');
  card.className = 'name-card';
  // Pass listing context through URL so profile page can show correct buy state
  const _cardParams = new URLSearchParams({ name });
  if (data.auctionId) _cardParams.set('auction', data.auctionId);
  if (data.price)     _cardParams.set('price', String(data.price));
  if (data.source)    _cardParams.set('src', data.source);
  card.href = `./name.html?${_cardParams.toString()}`;
  card.dataset.name = name;
  card.innerHTML = `
    <div class="name-card__header">
      <div>
        <div class="name-card__name">${base}<span style="color:var(--color-primary);">${tld}</span></div>
        ${displayName ? `<div style="font-size:10px;color:var(--color-text-faint);">${displayName}</div>` : ''}
      </div>
      ${bnrp && bnrp.records ? `<svg class="name-card__bnrp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" title="BNRP verified"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
    </div>
    <div class="name-card__badges"></div>
    ${price ? `<div class="name-card__price">${formatSats(price)}<span class="name-card__usd"></span></div>` : ''}
    ${price ? `<button class="name-card__buy-btn" data-name="${name}" data-auction="${data.auctionId || ''}" data-price="${price}" onclick="event.preventDefault();event.stopPropagation();_openCardBuy(this);">Buy</button>` : ''}
  `;

  // async USD price
  if (price) {
    getBtcUsd().then(rate => {
      const usdEl = card.querySelector('.name-card__usd');
      if (usdEl) usdEl.textContent = ' · ' + formatUsd(price, rate);
    });
  }

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

// Buy button handler for name cards on explore/index grids
function _openCardBuy(btn) {
  const name = btn.dataset.name;
  const priceSats = parseInt(btn.dataset.price, 10);
  if (!name || !priceSats) return;

  // Open buy modal directly — modal fetches listing PSBT from our worker
  if (typeof window.openBuyModal === 'function') {
    window.openBuyModal({ name, priceSats });
    return;
  }

  // Fallback: go to name profile
  location.href = `./name.html?name=${encodeURIComponent(name)}`;
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

// ── Category floor updater ────────────────────────────────────────────────────────
// Fills [data-floor-slug] spans with 3 states:
//   loading  — "\u2014" dash (default from HTML)
//   listed   — "0.001 BTC  $95" (BTC + USD in small text below)
//   no-list  — "No listings" in muted style
async function updateCategoryFloors(domainTypes) {
  if (!domainTypes) return;
  const btcRate = await getBtcUsd().catch(() => 95000);
  const tldToKey = { 'tld-btc': 'btc', 'tld-sats': 'sats', 'tld-x': 'x', 'tld-ord': 'ord' };
  Object.entries(tldToKey).forEach(([slug, key]) => {
    const dt = domainTypes[key];
    const els = qsa(`[data-floor-slug="${slug}"]`);
    els.forEach(el => {
      if (dt && dt.curPrice && dt.curPrice > 0) {
        const usd = formatUsd(dt.curPrice, btcRate);
        el.innerHTML = `${formatSats(dt.curPrice)}<span style="display:block;font-size:10px;font-weight:400;color:var(--color-text-faint);margin-top:1px;">${usd}</span>`;
      } else {
        el.innerHTML = `<span style="font-size:var(--text-xs);font-weight:400;color:var(--color-text-faint);">No listings</span>`;
      }
    });
  });
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

  // Load live floor prices into category cards
  if (UNISAT_API_KEY) {
    fetchDomainTypes().then(domainTypes => updateCategoryFloors(domainTypes));
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

  // Show a subtle "still resolving" hint after 5s so users know it's working
  // (BNRP worker can take 8-12s on cold upstream calls)
  const slowTimer = setTimeout(() => {
    const sk = qs('#profileSkeleton');
    if (sk && sk.style.display !== 'none') {
      const hint = document.createElement('p');
      hint.id = 'profileSlowHint';
      hint.style.cssText = 'text-align:center;font-size:var(--text-xs);color:var(--color-text-faint);margin-top:var(--space-4);';
      hint.textContent = 'Resolving on-chain data…';
      sk.appendChild(hint);
    }
  }, 5000);

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
  clearTimeout(slowTimer);
  // resolveName returns BNRP identity records (name+records) or raw inscription data (no records)
  // We only use liveData if it has actual identity records or a name field
  const hasIdentity = liveData && (liveData.name || (liveData.records && Object.keys(liveData.records).length));
  const data = (hasIdentity ? liveData : null) || SEED_PROFILES[name] || null;

  qs('#profileSkeleton').style.display = 'none';

  if (!data) {
    // resolveName returned null (name not in BNRP) — show minimal profile without records
    if (liveData && liveData.address) {
      renderMinimalProfile(name, liveData);
      initProfileTabData(name, liveData);
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
  const records = (resolvedData && resolvedData.records) || {};
  const score   = calcScore({ name, bnrp: { records } });

  qs('#profileContent').removeAttribute('style');
  qs('#profileName').textContent = base + tld;
  qs('#breadcrumbName').textContent = name;
  // Expose for rarity chips module
  window._currentBnrpData = resolvedData;
  window._currentInscriptionNumber = resolvedData.inscriptionNumber || resolvedData.inscNumber || null;
  if (typeof window.renderRarityChips === 'function') {
    window.renderRarityChips(base + tld, window._currentInscriptionNumber, resolvedData);
  }

  // Fetch inscription number from UniSat auction/info for rarity chip accuracy
  // Fire-and-forget: re-renders chips once data arrives without blocking profile render
  (async () => {
    try {
      const tldRaw = getTld(name).replace('.', '');
      const baseRaw = getBase(name);
      const infoRes = await fetch(
        `${UNISAT_API}/v3/market/btcname/auction/info?domainType=${encodeURIComponent(tldRaw)}&domain=${encodeURIComponent(baseRaw)}`,
        {
          headers: { 'Authorization': `Bearer ${UNISAT_API_KEY}` },
          signal: AbortSignal.timeout(5000),
        }
      );
      const infoJson = await infoRes.json();
      const inscNum = infoJson?.data?.inscriptionNumber ?? infoJson?.data?.auctionInfo?.inscriptionNumber ?? null;
      if (inscNum !== null && inscNum !== window._currentInscriptionNumber) {
        window._currentInscriptionNumber = inscNum;
        if (typeof window.renderRarityChips === 'function') {
          window.renderRarityChips(base + tld, inscNum, resolvedData);
        }
      }
    } catch { /* silent fallback — chips already rendered without number */ }
  })();

  if (records.display) qs('#profileDisplayName').textContent = records.display;
  if (records.description) qs('#profileDesc').textContent = records.description;

  // Avatar — no letter initials; show gradient bg or ordinal image
  const avatarEl = qs('#profileAvatar');
  avatarEl.textContent = '';
  const _avGrad = nameGradient(name);
  avatarEl.style.background = `linear-gradient(135deg,${_avGrad.from},${_avGrad.to})`;
  if (records.avatar) {
    initAvatar(avatarEl, records.avatar, '');
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
  window._initBuyBtnPromise = initBuyBtn(name, inscId);

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

  // Check URL params — card may have passed listing context directly
  const _urlP = new URLSearchParams(location.search);
  const _urlAuction = _urlP.get('auction');
  const _urlPrice   = _urlP.get('price');
  const _urlSrc     = _urlP.get('src');

  // URL params may carry a stale UniSat listing context (e.g. from a market card
  // clicked before the listing expired). Always verify liveness against the
  // UniSat API before showing a "for sale" state.
  if (_urlAuction && _urlPrice && _urlSrc === 'unisat') {
    // Show checking state immediately while we verify
    if (listingPriceEl) listingPriceEl.textContent = 'Checking...';
    if (listingStatusEl) listingStatusEl.textContent = '';
    buyBtn.textContent = 'Checking...';
    buyBtn.disabled = true;

    const domainType = UNISAT_TLD_MAP[getTld(name)] || null;
    let liveListing = null;
    try {
      const verifyData = await unisatPost('/v3/market/domain/auction/list', {
        filter: {
          nftType: 'domain',
          ...(domainType ? { domainType } : {}),
        },
        start: 0,
        limit: 200,
        sort: { unitPrice: 1 },
      });
      if (verifyData && verifyData.list) {
        const nameLower = name.toLowerCase();
        liveListing = verifyData.list.find(l => (l.domain || '').toLowerCase() === nameLower) || null;
      }
    } catch(e) {
      console.warn('[btcn] UniSat verify failed, falling back to URL price', e);
      // On network error, trust URL params rather than showing "not listed"
      liveListing = { price: parseInt(_urlPrice, 10), auctionId: _urlAuction };
    }

    buyBtn.disabled = false;

    if (liveListing) {
      const livePriceSats = liveListing.price || parseInt(_urlPrice, 10);
      const unisatBuyUrl = `https://unisat.io/market/domain/${encodeURIComponent(name)}`;
      if (listingPriceEl) {
        listingPriceEl.innerHTML = formatSats(livePriceSats) + '<span class="listing-usd"></span>';
        getBtcUsd().then(r => { const el = qs('.listing-usd'); if (el) el.textContent = ' · ' + formatUsd(livePriceSats, r); });
      }
      if (listingStatusEl) {
        listingStatusEl.innerHTML = `Listed on UniSat &middot; <span style="color:var(--color-text-muted);font-size:var(--text-xs);">buy completes on UniSat</span>`;
      }
      buyBtn.textContent = `Buy for ${formatSats(livePriceSats)} on UniSat`;
      buyBtn.onclick = () => window.open(unisatBuyUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    // Listing not found in live UniSat data — show not-listed state and fall through
    console.log(`[btcn] ${name} not found in live UniSat listings (URL params were stale)`);
    if (listingPriceEl) listingPriceEl.textContent = 'Not listed';
    if (listingStatusEl) {
      listingStatusEl.innerHTML = `
        <span style="color:var(--color-text-muted);font-size:var(--text-xs);">Not currently for sale</span>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button id="watchNameBtn" style="
            flex:1; padding:9px 12px; border:1px solid var(--color-border);
            border-radius:8px; background:var(--color-surface-offset);
            color:var(--color-text); font-size:var(--text-xs); font-weight:600;
            cursor:pointer; transition:all .15s;
          ">Watch</button>
          <button id="makeOfferBtn" style="
            flex:1; padding:9px 12px; border:none; border-radius:8px;
            background:var(--color-primary); color:#000;
            font-size:var(--text-xs); font-weight:700;
            cursor:pointer; transition:opacity .15s;
          ">Make Offer</button>
        </div>
      `;
      const watchNameBtn = qs('#watchNameBtn');
      const makeOfferBtn = qs('#makeOfferBtn');
      if (watchNameBtn) {
        watchNameBtn.onmouseover = () => { watchNameBtn.style.background = 'var(--color-surface-dynamic)'; };
        watchNameBtn.onmouseout  = () => { watchNameBtn.style.background = 'var(--color-surface-offset)'; };
        watchNameBtn.onclick = () => openWatchModal(name);
      }
      if (makeOfferBtn) {
        makeOfferBtn.onmouseover = () => { makeOfferBtn.style.opacity = '.85'; };
        makeOfferBtn.onmouseout  = () => { makeOfferBtn.style.opacity = '1'; };
        makeOfferBtn.onclick = () => openOfferModal();
      }
    }
    buyBtn.textContent = 'View on UniSat';
    buyBtn.style.background = 'var(--color-surface-offset)';
    buyBtn.style.color = 'var(--color-text-muted)';
    buyBtn.onclick = () => window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  // Start with fallback behaviour while we fetch listing
  buyBtn.textContent = 'Buy';
  buyBtn.onclick = () => window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
  if (listingPriceEl) listingPriceEl.textContent = 'Checking...';

  try {
    const res = await fetch(`${MARKET_API}/api/psbt/listing?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();

    if (data.ok && data.listed) {
      // Name is listed -- wire native buy modal
      const { priceSats, feeSats, totalSats } = data;
      if (listingPriceEl) {
        listingPriceEl.innerHTML = formatSats(priceSats) + '<span class="listing-usd"></span>';
        getBtcUsd().then(r => { const el = qs('.listing-usd'); if (el) el.textContent = ' · ' + formatUsd(priceSats, r); });
      }
      if (listingStatusEl) {
        listingStatusEl.innerHTML = `Listed &middot; <span style="color:var(--color-text-muted);font-size:var(--text-xs);">+${formatSats(feeSats)} platform fee</span>`;
      }
      window._profileListed = true;
      window._profileListedPrice = formatSats(priceSats);

      buyBtn.textContent = `Buy for ${formatSats(totalSats)}`;
      buyBtn.onclick = (e) => {
        e.preventDefault();
        // openBuyModal is loaded via buy-modal.js module
        if (typeof window.openBuyModal === 'function') {
          window.openBuyModal({ name, priceSats });
        } else {
          window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
        }
      };
    } else {
      // Not listed
      if (listingPriceEl) listingPriceEl.textContent = 'Not listed';
      if (listingStatusEl) {
        listingStatusEl.innerHTML = `
          <span style="color:var(--color-text-muted);font-size:var(--text-xs);">Not currently for sale</span>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="watchNameBtn" style="
              flex:1; padding:9px 12px; border:1px solid var(--color-border);
              border-radius:8px; background:var(--color-surface-offset);
              color:var(--color-text); font-size:var(--text-xs); font-weight:600;
              cursor:pointer; transition:all .15s;
            ">Watch</button>
            <button id="makeOfferBtn" style="
              flex:1; padding:9px 12px; border:none; border-radius:8px;
              background:var(--color-primary); color:#000;
              font-size:var(--text-xs); font-weight:700;
              cursor:pointer; transition:opacity .15s;
            ">Make Offer</button>
          </div>
        `;
        // Wire buttons after DOM insertion
        const watchNameBtn = qs('#watchNameBtn');
        const makeOfferBtn = qs('#makeOfferBtn');
        if (watchNameBtn) {
          watchNameBtn.onmouseover = () => { watchNameBtn.style.background = 'var(--color-surface-dynamic)'; };
          watchNameBtn.onmouseout  = () => { watchNameBtn.style.background = 'var(--color-surface-offset)'; };
          watchNameBtn.onclick = () => openWatchModal(name);
        }
        if (makeOfferBtn) {
          makeOfferBtn.onmouseover = () => { makeOfferBtn.style.opacity = '.85'; };
          makeOfferBtn.onmouseout  = () => { makeOfferBtn.style.opacity = '1'; };
          makeOfferBtn.onclick = () => openOfferModal();
        }
      }
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

// ── Make an Offer Modal ──────────────────────────────────────────────────────
// ── Shared modal styles ──────────────────────────────────────────────────────
function _injectOfferStyles() {
  if (document.getElementById('bn-offer-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'bn-offer-modal-styles';
  style.textContent = `
    .bn-offer-backdrop {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
    }
    .bn-offer-modal {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 16px;
      padding: 28px 28px 24px;
      width: 100%; max-width: 420px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.18);
      position: relative;
    }
    [data-theme="dark"] .bn-offer-modal { background: #141414; border-color: #2a2a2a; }
    .bn-offer__close {
      position: absolute; top: 16px; right: 16px;
      background: none; border: none; cursor: pointer;
      color: var(--color-text-muted); font-size: 20px; line-height: 1;
      padding: 4px 6px; border-radius: 6px;
    }
    .bn-offer__close:hover { background: var(--color-surface-offset); }
    .bn-offer__title {
      font-family: var(--font-mono);
      font-size: 1.1rem; font-weight: 700;
      margin: 0 0 6px;
      color: var(--color-text);
    }
    .bn-offer__sub {
      font-size: var(--text-sm); color: var(--color-text-muted);
      margin: 0 0 20px;
    }
    .bn-offer__field { margin-bottom: 16px; }
    .bn-offer__label {
      display: block;
      font-size: var(--text-xs); font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--color-text-muted);
      margin-bottom: 6px;
    }
    .bn-offer__input {
      width: 100%; padding: 10px 12px;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      background: var(--color-surface-offset);
      color: var(--color-text);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      box-sizing: border-box;
    }
    [data-theme="dark"] .bn-offer__input { background: #1a1a1a; border-color: #333; }
    .bn-offer__input:focus { outline: none; border-color: var(--color-primary); }
    .bn-offer__actions { display: flex; gap: 10px; margin-top: 20px; }
    .bn-offer__cta {
      flex: 1; padding: 12px; border: none; border-radius: 10px;
      background: var(--color-primary); color: #000;
      font-weight: 700; font-size: var(--text-sm); cursor: pointer;
      transition: opacity .15s;
    }
    .bn-offer__cta:hover { opacity: .88; }
    .bn-offer__cta--secondary {
      background: var(--color-surface-offset); color: var(--color-text);
      border: 1px solid var(--color-border);
    }
    .bn-offer__msg {
      margin-top: 12px; padding: 10px 14px;
      border-radius: 8px; font-size: var(--text-xs);
      display: none;
    }
    .bn-offer__msg.info { display: block; background: #e8f4fd; color: #1a6fa8; }
    .bn-offer__msg.success { display: block; background: #e6f9f0; color: #1a7a46; }
    [data-theme="dark"] .bn-offer__msg.info { background: #0a2030; color: #4aaddf; }
    [data-theme="dark"] .bn-offer__msg.success { background: #0a2016; color: #4ac97a; }
  `;
  document.head.appendChild(style);
}

// ── Watch Modal ───────────────────────────────────────────────────────────────────
function openWatchModal(watchName) {
  _injectOfferStyles();
  const backdrop = document.createElement('div');
  backdrop.className = 'bn-offer-backdrop';
  backdrop.innerHTML = `
    <div class="bn-offer-modal" role="dialog" aria-modal="true" aria-label="Watch ${watchName}">
      <button class="bn-offer__close" aria-label="Close">&times;</button>
      <div class="bn-offer__title">Watch ${watchName}</div>
      <div class="bn-offer__sub">Get an email when this name is listed for sale.</div>
      <div class="bn-offer__field">
        <label class="bn-offer__label" for="watchEmail">Your email</label>
        <input class="bn-offer__input" id="watchEmail" type="email" placeholder="you@example.com" autocomplete="email" />
      </div>
      <div class="bn-offer__msg" id="watchMsg"></div>
      <div class="bn-offer__actions">
        <button class="bn-offer__cta" id="watchSubmitBtn">Notify me</button>
      </div>
      <div style="margin-top:12px; font-size:10px; color:var(--color-text-faint); text-align:center;">
        We only use this to notify you about this name. No marketing.
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('.bn-offer__close').onclick = () => backdrop.remove();
  setTimeout(() => backdrop.querySelector('#watchEmail').focus(), 50);

  backdrop.querySelector('#watchSubmitBtn').onclick = async () => {
    const email = backdrop.querySelector('#watchEmail').value.trim();
    const msgEl = backdrop.querySelector('#watchMsg');
    const btn   = backdrop.querySelector('#watchSubmitBtn');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      msgEl.className = 'bn-offer__msg info';
      msgEl.textContent = 'Please enter a valid email address.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const res = await fetch(`${MARKET_API}/api/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: watchName, email }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json();
      if (data.ok) {
        msgEl.className = 'bn-offer__msg success';
        msgEl.textContent = data.alreadyWatching
          ? 'You are already watching this name.'
          : 'Done. You will be notified when this name is listed.';
        btn.textContent = 'Saved';
        setTimeout(() => backdrop.remove(), 2200);
      } else {
        throw new Error(data.error || 'Failed to save watch');
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Notify me';
      msgEl.className = 'bn-offer__msg info';
      msgEl.textContent = e.message || 'Could not save. Try again.';
    }
  };
}

// ── Make an Offer Modal ─────────────────────────────────────────────────────────────
function openOfferModal() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || '';
  const ownerAddress = window._profileOwnerAddress || '';
  _injectOfferStyles();

  const backdrop = document.createElement('div');
  backdrop.className = 'bn-offer-backdrop';

  const tldRaw = getTld(name).replace('.', '');
  const base   = getBase(name);
  const unisatOfferUrl = `https://unisat.io/bns/market?type=${encodeURIComponent(tldRaw)}&search=${encodeURIComponent(base)}`;

  backdrop.innerHTML = `
    <div class="bn-offer-modal" role="dialog" aria-modal="true" aria-label="Make an offer for ${name}">
      <button class="bn-offer__close" aria-label="Close">&times;</button>
      <div class="bn-offer__title">Make an offer</div>
      <div class="bn-offer__sub">${name} is not listed. Your offer is recorded and visible to the owner.</div>

      <div class="bn-offer__field">
        <label class="bn-offer__label" for="offerAmount">Your offer (BTC)</label>
        <input class="bn-offer__input" id="offerAmount" type="number" min="0.00001" step="0.0001" placeholder="0.001" />
      </div>
      <div class="bn-offer__field">
        <label class="bn-offer__label" for="offerAddress">Your Bitcoin address (so owner can respond)</label>
        <input class="bn-offer__input" id="offerAddress" type="text" placeholder="bc1p..." autocomplete="off" spellcheck="false" />
      </div>

      <div class="bn-offer__msg" id="offerMsg"></div>

      <div class="bn-offer__actions">
        <button class="bn-offer__cta" id="offerSendBtn">Submit Offer</button>
        <a class="bn-offer__cta bn-offer__cta--secondary" href="${unisatOfferUrl}" target="_blank" rel="noopener noreferrer" style="text-align:center; text-decoration:none; display:flex; align-items:center; justify-content:center;">UniSat</a>
      </div>

      <div style="margin-top:12px; font-size:10px; color:var(--color-text-faint); text-align:center;">
        ${ownerAddress ? 'Owner: ' + ownerAddress.slice(0,16) + '...' + ownerAddress.slice(-6) : 'Owner address not resolved'}
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector('.bn-offer__close').onclick = () => backdrop.remove();
  setTimeout(() => backdrop.querySelector('#offerAmount').focus(), 50);

  backdrop.querySelector('#offerSendBtn').onclick = async () => {
    const amount = parseFloat(backdrop.querySelector('#offerAmount').value);
    const addr   = backdrop.querySelector('#offerAddress').value.trim();
    const msgEl  = backdrop.querySelector('#offerMsg');
    const btn    = backdrop.querySelector('#offerSendBtn');

    if (!amount || amount <= 0) {
      msgEl.className = 'bn-offer__msg info';
      msgEl.textContent = 'Please enter an offer amount.';
      return;
    }
    if (!addr) {
      msgEl.className = 'bn-offer__msg info';
      msgEl.textContent = 'Please enter your Bitcoin address so the owner can respond.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      const res = await fetch(`${MARKET_API}/api/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, offerBtc: amount, contactAddress: addr }),
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json();
      if (data.ok) {
        msgEl.className = 'bn-offer__msg success';
        msgEl.textContent = `Offer of ${amount} BTC recorded. The owner will see it on btcnative.name.`;
        btn.textContent = 'Submitted';
      } else {
        throw new Error(data.error || 'Failed to submit offer');
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Submit Offer';
      msgEl.className = 'bn-offer__msg info';
      msgEl.textContent = e.message || 'Could not submit. Please try again.';
    }
  };
}

function showProfileError() {
  const sk = qs('#profileSkeleton');
  if (sk) sk.style.display = 'none';
  const err = qs('#profileError');
  if (!err) return;
  err.style.display = 'block';

  // Personalize with the actual name
  const params = new URLSearchParams(location.search);
  const name = params.get('name');
  if (name) {
    const base = getBase(name);
    const tld  = getTld(name);

    const titleEl = qs('#notFoundName');
    if (titleEl) {
      titleEl.innerHTML = `<span style="font-family:var(--font-mono);">${base}<span style="color:var(--color-primary);">${tld}</span></span> not found`;
    }

    const descEl = qs('#notFoundDesc');
    if (descEl) {
      descEl.textContent = `${name} doesn't appear to exist on Bitcoin yet. Be the first to register it.`;
    }

    const ctaEl = qs('#registerCta');
    if (ctaEl) {
      // Deep link to UniSat BNS search for this name
      const tldRaw = tld.replace('.', '');
      ctaEl.href = `https://unisat.io/bns?type=${encodeURIComponent(tldRaw)}&search=${encodeURIComponent(base)}`;
      ctaEl.textContent = `Register ${name} on UniSat →`;
    }
  }
}

// ── Watchlist (localStorage-backed) ─────────────────────────────────────────────────────────────────────────────────
function loadWatchList() {
  try { return JSON.parse(localStorage.getItem('btcnative_watchlist') || '[]'); } catch { return []; }
}
function saveWatchList(list) {
  try { localStorage.setItem('btcnative_watchlist', JSON.stringify(list)); } catch {}
}
let watchList = loadWatchList();

function toggleWatch() {
  const params = new URLSearchParams(location.search);
  const name = params.get('name');
  const btn = qs('#watchBtn');
  if (!name || !btn) return;
  const isWatching = watchList.includes(name);
  if (isWatching) {
    watchList = watchList.filter(n => n !== name);
    if (btn) btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  } else {
    watchList.push(name);
    if (btn) btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#f7931a" stroke="#f7931a" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  }
  saveWatchList(watchList);
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
      if (result && result.list) {
        LIVE_LISTINGS = result.list;
        if (result.total) LIVE_TOTAL = result.total;
      }
      renderListings(getFilteredNames());
    });
  } else {
    renderListings(getFilteredNames());
    if (UNISAT_API_KEY) {
      fetchListings(apiParams).then(result => {
        if (result && result.list) {
          LIVE_LISTINGS = result.list;
          if (result.total) LIVE_TOTAL = result.total;
          renderListings(getFilteredNames());
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

// Re-fetch listings from API whenever TLD or length filter changes,
// since UniSat returns paginated results per-TLD (client-side filter alone won't work)
function _refetchListings() {
  const el = qs('#listingsGrid');
  if (!el) { renderListings(getFilteredNames()); return; }
  // Show skeletons immediately
  el.innerHTML = Array(8).fill(0).map(() =>
    `<div class="name-card skeleton" style="height:96px;border-radius:var(--radius-lg);"></div>`
  ).join('');
  LIVE_LISTINGS = null; // mark as loading
  LIVE_TOTAL    = null;
  const apiParams = { sort: typeof currentSort !== 'undefined' ? currentSort : 'price_asc' };
  if (currentTld && currentTld !== 'all') apiParams.domainType = currentTld.replace('.', '');
  if (currentLen === '1-2') { apiParams.minLength = 1; apiParams.maxLength = 2; }
  if (currentLen === '3')   { apiParams.minLength = 3; apiParams.maxLength = 3; }
  if (currentLen === '4')   { apiParams.minLength = 4; apiParams.maxLength = 4; }
  if (currentLen === '5')   { apiParams.minLength = 5; apiParams.maxLength = 5; }
  if (currentLen === '6+')  { apiParams.minLength = 6; }
  fetchListings(apiParams).then(result => {
    LIVE_LISTINGS = (result && result.list) ? result.list : [];
    if (result && result.total) LIVE_TOTAL = result.total;
    renderListings(getFilteredNames());
  });
}

function filterTld(tld, btn) {
  currentTld = tld;
  qsa('[data-tld]').forEach(b => b.classList.toggle('active', b.dataset.tld === tld));
  _refetchListings();
}
function filterLen(len, btn) {
  if (currentLen === len) { currentLen = 'all'; btn.classList.remove('active'); }
  else { currentLen = len; qsa('[data-len]').forEach(b => b.classList.toggle('active', b.dataset.len === len)); }
  _refetchListings();
}
function filterSpecial(special, btn) {
  if (currentSpecial === special) { currentSpecial = null; btn.classList.remove('active'); }
  else { currentSpecial = special; qsa('[data-special]').forEach(b => b.classList.toggle('active', b.dataset.special === special)); }
  _refetchListings(); // re-fetch with larger batch so trait filtering has enough raw data
}
function sortNames(key, btn) {
  qsa('.filter-chip:not([data-tld]):not([data-len]):not([data-special]):not([data-tab])').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderListings(getFilteredNames());
}
// Live listings state
let LIVE_LISTINGS = null;  // populated from UniSat if API key present
let LIVE_TOTAL    = null;  // total count from API (may be much larger than LIVE_LISTINGS.length)

function renderListings(names) {
  const el = qs('#listingsGrid');
  if (!el) return;
  el.innerHTML = '';
  const countEl = qs('#listingCount');
  // Show API total when available; fall back to local filtered count
  if (countEl) {
    if (LIVE_TOTAL !== null) {
      countEl.textContent = `${LIVE_TOTAL.toLocaleString()} names`;
    } else {
      countEl.textContent = `${names.length} names`;
    }
  }
  if (names.length === 0) {
    const marketEmpty = LIVE_LISTINGS !== null && LIVE_LISTINGS.length === 0;
    if (marketEmpty) {
      // Market is genuinely empty — show warm CTA regardless of active filters
      el.innerHTML = `<div style="grid-column:1/-1; display:flex; flex-direction:column; align-items:center; text-align:center; padding:var(--space-16) var(--space-8); color:var(--color-text-muted);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-text-faint); margin-bottom:var(--space-4);" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <h3 style="color:var(--color-text); font-size:var(--text-base); font-weight:600; margin:0 0 var(--space-2);">No listings yet</h3>
        <p style="max-width:30ch; margin:0 0 var(--space-6); font-size:var(--text-sm);">Be the first to list a Bitcoin name for sale.</p>
        <a href="sell.html" class="btn btn-primary" style="font-size:var(--text-sm);">List a name &rarr;</a>
      </div>`;
    } else {
      // Listings exist but none match the current filters
      el.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:var(--space-16) 0; color:var(--color-text-faint); font-size:var(--text-sm);">No names match these filters.</div>`;
    }
    return;
  }
  names.forEach(n => el.appendChild(buildNameCard({ ...n, score: calcScore(n) })));
  // Async: silently remove any re-inscriptions from the grid
  const _rlNames = names.map(n => n.name);
  filterMarketReInscriptions(_rlNames, name => el.querySelector(`[data-name="${name}"]`));
}

// ── Re-inscription filter for market listings ────────────────────────────────
// Calls /api/validate-batch on a list of names, then removes cards for any
// that are re-inscriptions. Called after rendering so the page loads instantly.
async function filterMarketReInscriptions(names, getCardEl) {
  if (!names || names.length === 0) return;
  try {
    const query = names.map(n => encodeURIComponent(n)).join(',');
    const res = await fetch(
      `${MARKET_API}/api/validate-batch?names=${query}`,
      { signal: AbortSignal.timeout(12000) }
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.reInscriptions)) return;
    data.reInscriptions.forEach(name => {
      const el = getCardEl(name);
      if (el) el.remove();
    });
  } catch { /* silent — never block market load */ }
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
    auctionId:     item.auctionId || null,
    bnrp:          null,
  };
}

function getFilteredNames() {
  // Use live listings if loaded (even if empty); fall back to seed only if not yet loaded
  const pool = LIVE_LISTINGS !== null ? LIVE_LISTINGS : SEED_NAMES;
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
    LIVE_LISTINGS = result.list;
    renderListings(getFilteredNames());
  }
}

// ── Market tab helpers ────────────────────────────────────────────────────────────────────────

// TLD metadata for the leaderboard
const TLD_META = {
  btc:    { label: '.btc',    color: '#f7931a', browse: './explore.html?tab=listings&tld=btc' },
  sats:   { label: '.sats',   color: '#9b72f5', browse: './explore.html?tab=listings&tld=sats' },
  x:      { label: '.x',      color: '#1d9bf0', browse: './explore.html?tab=listings&tld=x' },
  ord:    { label: '.ord',    color: '#e8622a', browse: './explore.html?tab=listings&tld=ord' },
  xbt:    { label: '.xbt',    color: '#2dd4bf', browse: './explore.html?tab=listings&tld=xbt' },
  gm:     { label: '.gm',     color: '#4ade80', browse: './explore.html?tab=listings&tld=gm' },
  unisat: { label: '.unisat', color: '#f59e0b', browse: './explore.html?tab=listings&tld=unisat' },
  sat:    { label: '.sat',    color: '#a78bfa', browse: './explore.html?tab=listings&tld=sat' },
};

function renderTldLeaderboard(domainTypes, btcRate, floors = {}) {
  const el = qs('#tldLeaderboard');
  if (!el) return;

  // Sort by btcVolume desc, then by curPrice desc as tiebreak
  const tlds = Object.entries(domainTypes || {})
    .filter(([k]) => TLD_META[k])
    .sort((a, b) => (b[1].btcVolume || 0) - (a[1].btcVolume || 0) || (b[1].curPrice || 0) - (a[1].curPrice || 0));

  if (!tlds.length) {
    el.innerHTML = '<div style="color:var(--color-text-faint);font-size:var(--text-sm);padding:var(--space-8) 0;text-align:center;">No market data available</div>';
    return;
  }

  // Header row
  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:grid;grid-template-columns:28px 90px 1fr 1fr 60px;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--color-divider);';
  header.innerHTML = `
    <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-faint);">#</span>
    <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-faint);">TLD</span>
    <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-faint);text-align:right;">Floor</span>
    <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-faint);text-align:right;">24h Vol</span>
    <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-faint);text-align:right;">Change</span>
  `;
  wrap.appendChild(header);

  tlds.forEach(([key, dt], i) => {
    const meta = TLD_META[key] || { label: '.'+key, color: '#888', browse: '#' };
    // Use real floor from auction/list (floors map), not curPrice from domain_types (always 0)
    const floor   = floors[key] > 0 ? floors[key] : null;
    const vol     = dt.btcVolume  > 0 ? dt.btcVolume  : null;
    const pct     = dt.btcVolumePercent;
    const sales   = dt.amountVolume || 0;

    const floorHtml = floor
      ? `<div style="text-align:right;">
           <div style="font-family:var(--font-mono);font-size:var(--text-xs);font-weight:700;color:var(--color-text);">${formatSats(floor)}</div>
           ${btcRate ? `<div style="font-size:9px;color:var(--color-text-faint);">${formatUsd(floor, btcRate)}</div>` : ''}
         </div>`
      : `<span style="font-size:var(--text-xs);color:var(--color-text-faint);display:block;text-align:right;">No listings</span>`;

    const volHtml = vol
      ? `<div style="text-align:right;">
           <div style="font-family:var(--font-mono);font-size:var(--text-xs);font-weight:700;color:var(--color-text);">${formatSats(vol)}</div>
           <div style="font-size:9px;color:var(--color-text-faint);">${sales} sale${sales!==1?'s':''}</div>
         </div>`
      : `<span style="font-size:var(--text-xs);color:var(--color-text-faint);display:block;text-align:right;">—</span>`;

    let changeHtml = '<span style="font-size:var(--text-xs);color:var(--color-text-faint);display:block;text-align:right;">—</span>';
    if (pct !== null && pct !== undefined && pct !== 0) {
      const up = pct > 0;
      const pctStr = (up ? '+' : '') + pct.toFixed(1) + '%';
      changeHtml = `<span style="font-size:var(--text-xs);font-family:var(--font-mono);font-weight:700;display:block;text-align:right;color:${up ? 'var(--color-success)' : 'var(--color-error)'};">${pctStr}</span>`;
    }

    const row = document.createElement('div');
    row.className = 'tld-row';
    row.innerHTML = `
      <span style="font-size:var(--text-xs);font-family:var(--font-mono);color:var(--color-text-faint);font-weight:600;">${i + 1}</span>
      <a href="${meta.browse}" class="tld-pill" style="border-color:${meta.color}22;color:${meta.color};">${meta.label}</a>
      ${floorHtml}
      ${volHtml}
      ${changeHtml}
    `;
    wrap.appendChild(row);
  });

  el.innerHTML = '';
  el.appendChild(wrap);
}

function renderSalesFeed(sales, btcRate) {
  const el = qs('#salesFeed');
  if (!el) return;

  if (!sales || !sales.length) {
    el.innerHTML = '<div style="color:var(--color-text-faint);font-size:var(--text-sm);padding:var(--space-6) 0;text-align:center;">No recent sales found</div>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:0 var(--space-4);overflow:hidden;';

  sales.slice(0, 12).forEach(s => {
    const name   = s.domain || s.name || '?';
    const price  = s.price || 0;
    const ts     = s.timestamp;
    const tldKey = s.domainType || '';
    const meta   = TLD_META[tldKey] || {};

    const item = document.createElement('div');
    item.className = 'sale-item';
    item.innerHTML = `
      <div style="min-width:0;flex:1;">
        <a href="./name.html?name=${encodeURIComponent(name)}" class="sale-name">${escHtml(name)}</a>
        <div style="font-size:9px;color:var(--color-text-faint);margin-top:1px;">${ts ? timeAgo(ts) : ''}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div class="sale-price">${price ? formatSats(price) : '—'}</div>
        ${btcRate && price ? `<div class="sale-usd">${formatUsd(price, btcRate)}</div>` : ''}
      </div>
    `;
    wrap.appendChild(item);
  });

  el.innerHTML = '';
  el.appendChild(wrap);
}

// Skeleton loaders for market tab
function renderMarketSkeletons() {
  const lb = qs('#tldLeaderboard');
  const sf = qs('#salesFeed');
  const skelRow = (wide) => `<div style="height:44px;background:var(--color-surface-offset);border-radius:var(--radius-md);margin-bottom:4px;${wide?'width:100%':'width:70%'};animation:shimmer 1.5s ease-in-out infinite;background:linear-gradient(90deg,var(--color-surface-offset)25%,var(--color-surface-dynamic)50%,var(--color-surface-offset)75%);background-size:200% 100%;"></div>`;
  if (lb) lb.innerHTML = skelRow(true)+skelRow(true)+skelRow(true)+skelRow(true)+skelRow(true)+skelRow(true);
  if (sf) sf.innerHTML = skelRow(false)+skelRow(false)+skelRow(false)+skelRow(false)+skelRow(false)+skelRow(false);
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Legacy stubs (kept so old call sites don't break)
function buildIndexCard() { return document.createElement('div'); }
function buildSalesTable() {}
function populateSalesRows() {}


async function renderMarketIndexes() {
  // Show skeletons immediately
  renderMarketSkeletons();

  if (!UNISAT_API_KEY) return;

  const [domainTypes, liveSales, btcRate, tldFloors] = await Promise.all([
    fetchDomainTypes(),
    fetchRecentSales(16),
    getBtcUsd(),
    fetchAllTldFloors(),
  ]);

  // Stats strip
  if (domainTypes) {
    const vals = Object.values(domainTypes);
    const totalVol = vals.reduce((s, d) => s + (d.btcVolume || 0), 0);
    const topTld = vals.sort((a, b) => (b.btcVolume||0) - (a.btcVolume||0))[0];

    const el24h = qs('#mktVol24h');
    const elList = qs('#mktListings');
    const elTop  = qs('#mktTopTld');
    if (el24h) el24h.textContent = totalVol > 0 ? formatSats(totalVol) : '—';
    if (elTop && topTld && topTld.btcVolume > 0) elTop.textContent = '.' + topTld.domainType;
  }

  // Active listings count from our worker
  try {
    const res = await fetch(`${MARKET_API}/api/market/listings?limit=200`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const elList = qs('#mktListings');
    if (elList && data.ok) elList.textContent = (data.total || 0).toLocaleString();
  } catch {}

  // Last sale
  if (liveSales && liveSales.length > 0) {
    const last = liveSales[0];
    const elLast = qs('#mktLastSale');
    if (elLast && last.domain) {
      elLast.textContent = last.domain + (last.price ? '  ' + formatSats(last.price) : '');
    }
  }

  // Render leaderboard and sales feed
  if (domainTypes) renderTldLeaderboard(domainTypes, btcRate, tldFloors || {});
  if (liveSales)   renderSalesFeed(liveSales, btcRate);
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

  // Find adjacent clear button
  const clearBtn = input.parentElement.querySelector('.search-clear');
  if (clearBtn) {
    input.addEventListener('input', () => {
      clearBtn.classList.toggle('visible', input.value.length > 0);
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      resultsEl.style.display = 'none';
      clearBtn.classList.remove('visible');
      input.focus();
    });
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(resultsEl.querySelectorAll('.search-result-item'));
      if (items.length === 0) return;
      const focused = resultsEl.querySelector('.search-result-item.focused');
      let idx = focused ? items.indexOf(focused) : -1;
      if (e.key === 'ArrowDown') idx = Math.min(idx + 1, items.length - 1);
      if (e.key === 'ArrowUp')   idx = Math.max(idx - 1, 0);
      items.forEach(i => i.classList.remove('focused'));
      items[idx].classList.add('focused');
      items[idx].scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    }
    if (e.key === 'Enter') {
      const focused = resultsEl.querySelector('.search-result-item.focused');
      if (focused) {
        focused.click();
      } else {
        const q2 = input.value.trim();
        if (q2) navigateToName(q2);
      }
    }
    if (e.key === 'Escape') { resultsEl.style.display = 'none'; clearTimeout(timer); }
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
  resultsEl.innerHTML = `<div style="padding:var(--space-3) var(--space-4); color:var(--color-text-faint); font-size:var(--text-sm);">Searching...</div>`;

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
        const _sg = (typeof nameGradient === 'function') ? nameGradient(base + getTld(name)) : { from: '#f7931a', to: '#c0620a', text: '#fff' };
        av.style.cssText = `background:linear-gradient(135deg,${_sg.from},${_sg.to});`;
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

  // Hint footer
  const hint = document.createElement('div');
  hint.style.cssText = 'padding:var(--space-2) var(--space-4); font-size:10px; color:var(--color-text-faint); border-top:1px solid var(--color-border); text-align:center; letter-spacing:0.04em;';
  hint.textContent = 'Enter to search \u00b7 \u2191\u2193 to navigate \u00b7 Esc to close';
  resultsEl.appendChild(hint);
}

function showSearchResult(data, name, resultsEl) {
  const records = data.records || {};
  const base = getBase(name); const tld = getTld(name);
  resultsEl.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'search-result-item';
  item.onclick = () => navigateToName(name);
  item.innerHTML = `
    <div class="search-result-avatar" data-initial="${base[0].toUpperCase()}" style="background:${(()=>{const g=nameGradient(name);return `linear-gradient(135deg,${g.from},${g.to})`;})()};"></div>
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
  // If name already has a supported TLD, go straight to profile page
  const hasTld = SUPPORTED_TLDS.some(tld => name.endsWith(tld));
  if (hasTld) {
    location.href = `./name.html?name=${encodeURIComponent(name)}`;
    return;
  }
  // Bare query (no TLD) with 2+ chars -> search results page
  const trimmed = name.trim();
  if (trimmed.length >= 2) {
    location.href = `./explore.html?search=${encodeURIComponent(trimmed)}`;
    return;
  }
  // Single char fallback -> append .btc
  location.href = `./name.html?name=${encodeURIComponent(trimmed + '.btc')}`;
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
  const sel = document.getElementById('marketSortSelect');
  if (sel) sel.value = 'price_asc';
  const minEl = document.getElementById('priceMin');
  const maxEl = document.getElementById('priceMax');
  if (minEl) minEl.value = '';
  if (maxEl) maxEl.value = '';
  _refetchListingsMVP();
}

// Override sortNames to use new key scheme
function sortNames(key, btn) {
  currentSort = key;
  // Support both chip buttons (data-sort) and the select dropdown
  document.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b.dataset.sort === key));
  const sel = document.getElementById('marketSortSelect');
  if (sel && sel.value !== key) sel.value = key;
  _refetchListingsMVP(); // re-fetch so UniSat sort order changes too
}

// Re-fetch for MVP variant when TLD, length, or special filter changes
// When a special trait filter is active, fetch a larger batch so client-side
// filtering has enough variety to find matches
function _refetchListingsMVP() {
  const gridEl = qs('#listingsGrid');
  if (!gridEl) { renderListings(getFilteredNamesMVP()); return; }
  gridEl.innerHTML = Array(8).fill(0).map(() =>
    `<div class="name-card skeleton" style="height:96px;border-radius:var(--radius-lg);"></div>`
  ).join('');
  LIVE_LISTINGS = null;
  LIVE_TOTAL    = null;
  const apiParams = { sort: typeof currentSort !== 'undefined' ? currentSort : 'price_asc' };
  if (currentTld && currentTld !== 'all') apiParams.domainType = currentTld.replace('.', '');
  if (currentLen === '1-2') { apiParams.minLength = 1; apiParams.maxLength = 2; }
  if (currentLen === '3')   { apiParams.minLength = 3; apiParams.maxLength = 3; }
  if (currentLen === '4')   { apiParams.minLength = 4; apiParams.maxLength = 4; }
  if (currentLen === '5')   { apiParams.minLength = 5; apiParams.maxLength = 5; }
  if (currentLen === '6+')  { apiParams.minLength = 6; }
  fetchListings(apiParams).then(result => {
    LIVE_LISTINGS = (result && result.list) ? result.list : [];
    if (result && result.total) LIVE_TOTAL = result.total;
    renderListings(getFilteredNamesMVP());
  });
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
  _refetchListingsMVP();
}

// Override filterTld
function filterTld(tld, btn) {
  currentTld = tld;
  document.querySelectorAll('[data-tld]').forEach(b => b.classList.toggle('active', b.dataset.tld === tld));
  _refetchListingsMVP();
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
  // Re-fetch with larger batch so trait filtering has enough raw data
  _refetchListingsMVP();
}

function getFilteredNamesMVP() {
  const pool = LIVE_LISTINGS !== null ? LIVE_LISTINGS : SEED_NAMES;
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
  if (currentSort === 'recent')     filtered.reverse();
  if (currentSort === 'insc_asc')   filtered.sort((a, b) => (a.inscriptionNumber || a.inscriptionId || 99999999) - (b.inscriptionNumber || b.inscriptionId || 99999999));
  if (currentSort === 'insc_desc')  filtered.sort((a, b) => (b.inscriptionNumber || b.inscriptionId || 0) - (a.inscriptionNumber || a.inscriptionId || 0));

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

function buildSparkline(prices) {
  if (!prices || prices.length < 2) return '';
  const W = 280, H = 48, pad = 4;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (W - pad * 2);
    const y = H - pad - ((p - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  const trend = prices[prices.length - 1] >= prices[0] ? '#22c55e' : '#ef4444';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${trend}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${trend}"/>
  </svg>`;
}

// ── Sale history fetch + render ───────────────────────────────────────────────
async function fetchAndRenderSaleHistory(name) {
  const el = document.getElementById('saleHistoryTimeline');
  if (!el) return;

  const base = getBase(name);
  const tldRaw = getTld(name).replace('.', '');
  const fullNameLower = name.toLowerCase();

  // UniSat /v3/market/domain/auction/actions is a global feed — "keyword" is NOT
  // a supported filter field. Fetch a large batch and client-side filter by domain.
  let events = [];
  if (UNISAT_API_KEY) {
    try {
      // Fetch sold events
      const data = await unisatPost('/v3/market/domain/auction/actions', {
        filter: { nftType: 'domain', domainType: tldRaw, event: 'Sold' },
        start: 0,
        limit: 200,
      });
      if (data && data.list) {
        // domain field sometimes has "@" prefix (e.g. "@Store.btc") — strip it
        events = data.list.filter(ev => {
          const d = (ev.domain || '').toLowerCase().replace(/^@/, '');
          return d === fullNameLower || d === base + '.' + tldRaw;
        });
      }
    } catch (e) { /* silent */ }

    try {
      // Fetch listing events too for a fuller picture
      const listData = await unisatPost('/v3/market/domain/auction/actions', {
        filter: { nftType: 'domain', domainType: tldRaw, event: 'Listed' },
        start: 0,
        limit: 200,
      });
      if (listData && listData.list) {
        const listEvents = listData.list.filter(ev => {
          const d = (ev.domain || '').toLowerCase().replace(/^@/, '');
          return d === fullNameLower || d === base + '.' + tldRaw;
        }).map(ev => ({ ...ev, _eventType: 'Listed' }));
        events = [...events, ...listEvents].sort((a, b) => b.timestamp - a.timestamp);
      }
    } catch (e) { /* silent */ }
  }

  // Render sparkline from sold events only (price history)
  const soldEvents = events.filter(ev => !ev._eventType || ev._eventType === 'Sold');
  if (soldEvents.length >= 2) {
    const wrap = document.getElementById('saleHistoryWrap');
    if (wrap) {
      const prices = soldEvents.map(e => e.price || 0).filter(p => p > 0).reverse(); // oldest first
      const sparkHtml = buildSparkline(prices);
      const sparkDiv = document.createElement('div');
      sparkDiv.style.cssText = 'margin-bottom:var(--space-4); padding:var(--space-3); background:var(--color-surface-offset); border-radius:var(--radius-md); border:1px solid var(--color-border);';
      sparkDiv.innerHTML = `
        <div style="font-size:var(--text-xs); color:var(--color-text-faint); text-transform:uppercase; letter-spacing:0.06em; margin-bottom:var(--space-2);">Sale price history</div>
        ${sparkHtml}
        <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--color-text-faint); font-family:var(--font-mono); margin-top:var(--space-1);">
          <span>${formatSats(prices[0])}</span>
          <span>${formatSats(prices[prices.length-1])}</span>
        </div>
      `;
      wrap.insertBefore(sparkDiv, wrap.firstChild);
    }
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
    const eventType = ev._eventType || 'Sold';
    let typeColor;
    if (eventType === 'Sold') {
      typeColor = 'color:var(--color-accent, #f7931a);';
    } else if (eventType === 'Cancel') {
      typeColor = 'color:var(--color-text-faint); opacity:0.6;';
    } else {
      // Listed — normal color
      typeColor = 'color:var(--color-text);';
    }
    const div = document.createElement('div');
    div.className = 'history-event' + (eventType === 'Listed' ? ' history-event--muted' : '');
    div.innerHTML = `
      <div class="history-event__row">
        <span class="history-event__type" style="${typeColor}">${eventType}</span>
        ${ev.price ? `<span class="history-event__price">${formatSats(ev.price)}</span>` : ''}
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

  // Show skeleton
  el.innerHTML = Array(4).fill(0).map(() =>
    `<div class="name-card skeleton" style="height:88px; border-radius:var(--radius-lg);"></div>`
  ).join('');

  const base   = getBase(name);
  const tldRaw = getTld(name).replace('.', '');
  const len    = base.length;

  // Fetch a larger set for stats (up to 20)
  const data = UNISAT_API_KEY ? await fetchListings({
    domainType: tldRaw,
    minLength: len,
    maxLength: len,
    page: 0,
    pageSize: 20,
  }) : null;

  el.innerHTML = '';

  if (!data || !data.list || data.list.length === 0) {
    el.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No comparable listings found right now.</p>`;
    return;
  }

  // Filter out the current name
  const allComps = data.list.filter(item => {
    const itemName = item.domain ? (item.domain.includes('.') ? item.domain : item.domain + '.' + tldRaw) : '';
    return itemName.toLowerCase() !== name.toLowerCase();
  });

  if (allComps.length === 0) {
    el.innerHTML = `<p style="color:var(--color-text-faint); font-size:var(--text-sm); grid-column:1/-1;">No comparable listings found right now.</p>`;
    return;
  }

  // Calculate stats from all fetched comps
  const prices = allComps.map(i => i.unitPrice || i.price || 0).filter(p => p > 0).sort((a, b) => a - b);
  const floor  = prices[0];
  const maxP   = prices[prices.length - 1];
  const median = prices[Math.floor(prices.length / 2)];
  const count  = prices.length;

  // Insert stats bar BEFORE the grid
  const statsDiv = document.createElement('div');
  statsDiv.style.cssText = 'grid-column:1/-1; display:grid; grid-template-columns:repeat(4,1fr); gap:var(--space-3); margin-bottom:var(--space-4); padding:var(--space-3) var(--space-4); background:var(--color-surface-offset); border-radius:var(--radius-md); border:1px solid var(--color-border);';
  statsDiv.innerHTML = `
    <div>
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--color-text-faint); margin-bottom:2px;">Floor</div>
      <div style="font-family:var(--font-mono); font-weight:700; font-size:var(--text-sm); color:var(--color-primary);">${formatSats(floor)}</div>
    </div>
    <div>
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--color-text-faint); margin-bottom:2px;">Median</div>
      <div style="font-family:var(--font-mono); font-weight:700; font-size:var(--text-sm);">${formatSats(median)}</div>
    </div>
    <div>
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--color-text-faint); margin-bottom:2px;">Max</div>
      <div style="font-family:var(--font-mono); font-weight:600; font-size:var(--text-sm); color:var(--color-text-muted);">${formatSats(maxP)}</div>
    </div>
    <div>
      <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.06em; color:var(--color-text-faint); margin-bottom:2px;">Listed</div>
      <div style="font-family:var(--font-mono); font-weight:600; font-size:var(--text-sm); color:var(--color-text-muted);">${count}</div>
    </div>
  `;

  // If this name is listed, show a summary note
  if (window._profileListed && prices.length > 0) {
    const note = document.createElement('div');
    note.style.cssText = 'grid-column:1/-1; font-size:var(--text-xs); color:var(--color-text-faint); padding-top:var(--space-2); border-top:1px solid var(--color-border); margin-top:var(--space-1);';
    note.textContent = `${len}-char .${tldRaw} names · ${count} listed · floor ${formatSats(floor)}`;
    statsDiv.appendChild(note);
  }

  el.appendChild(statsDiv);

  // Render up to 6 comp cards
  const _compItems = allComps.slice(0, 6).map(item => unisatListingToCard(item));
  _compItems.forEach(cardData => {
    const card = buildNameCard(cardData);
    el.appendChild(card);
  });
  // Async: silently remove any re-inscriptions
  filterMarketReInscriptions(_compItems.map(c => c.name), name => el.querySelector(`[data-name="${name}"]`));
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

  const _rlItems = data.list.slice(0, 10).map(item => unisatListingToCard(item));
  _rlItems.forEach(cardData => {
    const card = buildNameCard({ ...cardData, score: calcScore(cardData) });
    card.style.flex = '0 0 180px';
    el.appendChild(card);
  });
  // Async: silently remove any re-inscriptions
  filterMarketReInscriptions(_rlItems.map(c => c.name), name => el.querySelector(`[data-name="${name}"]`));
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
  const _pdItems = [];
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
    _pdItems.push(cardData);
  });

  if (el.children.length === 0) {
    SEED_NAMES.slice(0, 5).forEach(n => {
      const card = buildNameCard({ ...n, score: calcScore(n) });
      card.style.flex = '0 0 180px';
      el.appendChild(card);
    });
  } else {
    // Async: silently remove any re-inscriptions
    filterMarketReInscriptions(_pdItems.map(c => c.name), name => el.querySelector(`[data-name="${name}"]`));
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
    fetchDomainTypes().then(domainTypes => updateCategoryFloors(domainTypes));
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
  window._currentBnrpData = data;
  window._currentInscriptionNumber = data.inscriptionNumber || null;
  if (typeof window.renderRarityChips === 'function') {
    window.renderRarityChips(base + tld, window._currentInscriptionNumber, data);
  }
  const _minAvEl = qs('#profileAvatar');
  _minAvEl.textContent = '';
  const _minGrad = nameGradient(name);
  _minAvEl.style.background = `linear-gradient(135deg,${_minGrad.from},${_minGrad.to})`;

  const addr = data.address;
  window._profileOwnerAddress = addr || ''; // store for offer modal
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
  const sellBtnMin = qs('#sellBtn');
  if (sellBtnMin) sellBtnMin.href = `./sell.html?name=${encodeURIComponent(name)}`;
  window._initBuyBtnPromise = initBuyBtn(name, inscId);

  // Check if connected wallet owns this name
  checkWalletOwnership(name, inscId, addr).then(async isOwner => {
    if (!isOwner) return;
    // Wait for listing fetch to complete before deciding which owner actions to show
    await (window._initBuyBtnPromise || Promise.resolve());
    const buyBtn = qs('#buyBtn');
    const watchBtn = qs('#watchBtn');
    if (buyBtn) {
      buyBtn.textContent = 'You own this';
      buyBtn.disabled = true;
      buyBtn.style.background = 'var(--color-surface-offset)';
      buyBtn.style.color = 'var(--color-text-faint)';
      buyBtn.style.cursor = 'default';
      buyBtn.onclick = null;
    }
    if (watchBtn) watchBtn.style.display = 'none';
    setOwnerActions(name);
  });

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

// ── Owner action row ────────────────────────────────────────────────────────
// Renders the correct owner buttons into #ownerActionRow based on listing state.
// Called after wallet ownership is confirmed.
function setOwnerActions(name) {
  const row = document.getElementById('ownerActionRow');
  if (!row) return;

  const isListed = !!window._profileListed;
  const auctionId = window._profileListedAuctionId || null;

  if (isListed) {
    // Already listed: Change price + Delist
    row.innerHTML = `
      <a class="btn btn--outline" href="./sell.html?name=${encodeURIComponent(name)}" title="Change listing price">Change price</a>
      <button class="btn btn--outline" id="delistBtn" title="Remove listing">Delist</button>
    `;
    const delistBtn = row.querySelector('#delistBtn');
    if (delistBtn) delistBtn.onclick = () => delistName(name, auctionId);
  } else {
    // Not listed: List for sale (full width)
    row.innerHTML = `<a class="btn btn--primary" href="./sell.html?name=${encodeURIComponent(name)}">List for sale</a>`;
  }

  row.classList.add('visible');
}

// Delist flow: create_put_off -> wallet signs -> confirm_put_off
async function delistName(name, auctionId) {
  if (!auctionId) {
    alert('Listing data not available. Try refreshing.');
    return;
  }
  const delistBtn = document.getElementById('delistBtn');
  if (delistBtn) { delistBtn.textContent = 'Delisting...'; delistBtn.disabled = true; }

  try {
    const wallet = window.unisat;
    if (!wallet) throw new Error('UniSat wallet not connected.');

    const accounts = await wallet.getAccounts();
    const address = accounts && accounts[0];
    if (!address) throw new Error('No wallet address found.');

    const pubkeyHex = await wallet.getPublicKey();
    // For taproot (bc1p) use x-only pubkey (strip 02/03 prefix)
    const pubkey = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;

    // Step 1: create_put_off
    const res = await fetch('https://open-api.unisat.io/v3/market/domain/auction/create_put_off', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${UNISAT_API_KEY}`,
      },
      body: JSON.stringify({ auctionId, nftAddress: address, btcPubkey: pubkey }),
    });
    const data = await res.json();
    if (!data || data.code !== 0) throw new Error(data?.msg || 'Delist prepare failed.');

    const psbt = data.data?.psbt;
    const signIndexes = data.data?.signIndexes || [0];
    if (!psbt) throw new Error('No PSBT returned from delist prepare.');

    // Step 2: wallet signs
    const signed = await wallet.signPsbt(psbt, {
      autoFinalized: false,
      toSignInputs: signIndexes.map(i => ({ index: i, address })),
    });

    // Step 3: confirm_put_off
    const confirmRes = await fetch('https://open-api.unisat.io/v3/market/domain/auction/confirm_put_off', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${UNISAT_API_KEY}`,
      },
      body: JSON.stringify({ auctionId, psbt: signed, fromBase64: false }),
    });
    const confirmData = await confirmRes.json();
    if (!confirmData || confirmData.code !== 0) throw new Error(confirmData?.msg || 'Delist confirm failed.');

    // Success
    window._profileListed = false;
    window._profileListedAuctionId = null;
    const listingStatusEl = document.getElementById('listingStatus');
    const listingPriceEl = document.getElementById('listingPrice');
    if (listingPriceEl) listingPriceEl.textContent = 'Not listed';
    if (listingStatusEl) listingStatusEl.textContent = 'Delisted successfully.';
    // Refresh owner row to show "List for sale"
    setOwnerActions(name);
  } catch (e) {
    console.error('Delist error:', e);
    if (delistBtn) { delistBtn.textContent = 'Delist'; delistBtn.disabled = false; }
    alert('Delist failed: ' + (e.message || 'Unknown error'));
  }
}

// ── Wallet ownership check ────────────────────────────────────────────────────
async function checkWalletOwnership(name, inscId, ownerAddress) {
  // Only check if wallet is available
  const wallet = window.unisat || window.XverseProviders?.BitcoinProvider || window.btc;
  if (!wallet) return false;

  try {
    let connectedAddr;
    if (window.unisat) {
      const accounts = await window.unisat.getAccounts();
      connectedAddr = accounts && accounts[0];
    } else {
      return false; // Xverse requires a request, skip passive check
    }
    if (!connectedAddr || !ownerAddress) return false;
    return connectedAddr.toLowerCase() === ownerAddress.toLowerCase();
  } catch { return false; }
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

  // Slow-resolve hint after 5s (BNRP worker cold starts can take 8-12s)
  const slowTimer = setTimeout(() => {
    const sk = qs('#profileSkeleton');
    if (sk && sk.style.display !== 'none') {
      const hint = document.createElement('p');
      hint.id = 'profileSlowHint';
      hint.style.cssText = 'text-align:center;font-size:var(--text-xs);color:var(--color-text-faint);margin-top:var(--space-4);';
      hint.textContent = 'Resolving on-chain data…';
      sk.appendChild(hint);
    }
  }, 5000);

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
    // resolveName returned null (name not in BNRP) — show minimal profile without records
    if (liveData && liveData.address) {
      renderMinimalProfile(name, liveData);
      initProfileTabData(name, liveData);
      return;
    }
    showProfileError(); return;
  }

  const resolvedData = data || { name, records: {}, address: null };
  if (!resolvedData.records) resolvedData.records = {};
  const hasBnrp = !!(resolvedData.records && Object.keys(resolvedData.records).length);

  const base    = getBase(name);
  const tld     = getTld(name);
  const records = (resolvedData && resolvedData.records) || {};
  const score   = calcScore({ name, bnrp: { records } });

  qs('#profileContent').removeAttribute('style');
  qs('#profileName').textContent = base + tld;
  qs('#breadcrumbName').textContent = name;

  if (records.display)     qs('#profileDisplayName').textContent = records.display;
  if (records.description) qs('#profileDesc').textContent = records.description;

  const avatarEl = qs('#profileAvatar');
  avatarEl.textContent = '';
  const _avGrad2 = nameGradient(name);
  avatarEl.style.background = `linear-gradient(135deg,${_avGrad2.from},${_avGrad2.to})`;
  if (records.avatar) {
    initAvatar(avatarEl, records.avatar, '');
    qs('#profileBanner').style.background = 'linear-gradient(135deg, #1a1200, #2d1f00, #0a0a0a)';
  }

  if (hasBnrp || (resolvedData && resolvedData.name) || records.display) {
    const badge = qs('#profileBnrpBadge');
    if (badge) badge.style.display = 'block';
  }

  const addr = resolvedData.address || resolvedData.owner;
  window._profileOwnerAddress = addr || ''; // store for offer modal
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
  const sellBtn = qs('#sellBtn');
  if (sellBtn) sellBtn.href = `./sell.html?name=${encodeURIComponent(name)}`;
  window._initBuyBtnPromise = initBuyBtn(name, inscId);

  // Restore watchlist state
  const watchBtn = qs('#watchBtn');
  if (watchBtn && watchList.includes(name)) {
    watchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#f7931a" stroke="#f7931a" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  }

  // Check if connected wallet owns this name
  checkWalletOwnership(name, inscId, addr).then(async isOwner => {
    if (!isOwner) return;
    // Wait for listing fetch to complete before deciding which owner actions to show
    await (window._initBuyBtnPromise || Promise.resolve());
    const buyBtn = qs('#buyBtn');
    const watchBtn = qs('#watchBtn');
    if (buyBtn) {
      buyBtn.textContent = 'You own this';
      buyBtn.disabled = true;
      buyBtn.style.background = 'var(--color-surface-offset)';
      buyBtn.style.color = 'var(--color-text-faint)';
      buyBtn.style.cursor = 'default';
      buyBtn.onclick = null;
    }
    if (watchBtn) watchBtn.style.display = 'none';
    setOwnerActions(name);
    // Show BNRP editor tab
    showBnrpEditorForOwner(records);
  });

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

  // Update og:image + twitter meta dynamically
  updateProfileMeta({ name, records, inscId, addr });
}

// ── Social meta updater ────────────────────────────────────────────────────────
function generateOgFallbackDataUrl(name, display, score) {
  const base = getBase(name);
  const tld  = getTld(name);
  const initial = (display || base)[0].toUpperCase();
  const scoreStr = score ? String(score) : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#0a0a0a"/>
    <rect x="0" y="0" width="1200" height="4" fill="#f7931a"/>
    <!-- Avatar circle -->
    <circle cx="140" cy="280" r="72" fill="#1a1a1a" stroke="#2a2a2a" stroke-width="2"/>
    <text x="140" y="298" text-anchor="middle" font-family="monospace" font-size="52" font-weight="700" fill="#f7931a">${initial}</text>
    <!-- Name -->
    <text x="248" y="256" font-family="monospace" font-size="64" font-weight="800" fill="#f5f5f5">${base}</text>
    <text x="${248 + base.length * 38}" y="256" font-family="monospace" font-size="64" font-weight="800" fill="#f7931a">${tld}</text>
    ${display && display !== name ? `<text x="248" y="312" font-family="sans-serif" font-size="28" fill="#888">${display}</text>` : ''}
    <!-- Score pill -->
    ${scoreStr ? `<rect x="248" y="336" width="90" height="32" rx="16" fill="#1e1e1e" stroke="#2a2a2a"/>
    <text x="293" y="358" text-anchor="middle" font-family="monospace" font-size="15" font-weight="700" fill="#f7931a">${scoreStr}</text>` : ''}
    <!-- Bottom bar -->
    <rect x="0" y="580" width="1200" height="50" fill="#111"/>
    <rect x="48" y="592" width="24" height="24" rx="5" fill="#f7931a"/>
    <text x="48" y="604" font-family="monospace" font-size="13" font-weight="900" fill="#000">B</text>
    <text x="82" y="606" font-family="sans-serif" font-size="15" font-weight="600" fill="#888">btcnative.name</text>
    <text x="1152" y="606" text-anchor="end" font-family="monospace" font-size="13" fill="#555">Bitcoin names</text>
  </svg>`;

  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

function updateProfileMeta({ name, records, inscId, addr }) {
  const display  = records.display || name;
  const desc     = records.description
    ? records.description.slice(0, 120)
    : `Bitcoin name ${name} — identity, market data, and attributes on BTC Native.`;

  // og:image: use the ordinals.com content URL for the inscription avatar if available,
  // otherwise use the name inscription itself as the image
  let imageUrl = generateOgFallbackDataUrl(name, records.display, null);
  if (records.avatar && records.avatar.startsWith('ord:')) {
    const avatarId = records.avatar.replace('ord:', '');
    imageUrl = `https://ordinals.com/content/${avatarId}`;
  } else if (inscId) {
    imageUrl = `https://ordinals.com/content/${inscId}`;
  }

  const pageUrl = `https://btcnative.name/name.html?name=${encodeURIComponent(name)}`;
  const title   = `${display} — BTC Native`;

  // Update <meta> tags
  function setMeta(id, attr, val) {
    const el = document.getElementById(id);
    if (el) el.setAttribute(attr, val);
  }
  setMeta('ogTitle',  'content', title);
  setMeta('ogDesc',   'content', desc);
  setMeta('ogImage',  'content', imageUrl);
  setMeta('ogUrl',    'content', pageUrl);
  setMeta('twTitle',  'content', title);
  setMeta('twDesc',   'content', desc);
  setMeta('twImage',  'content', imageUrl);

  // Store for share button
  window._profileShareData = { name, display, imageUrl, pageUrl, records };
}

// ── Share on X ────────────────────────────────────────────────────────────────
function shareProfile() {
  const data = window._profileShareData;
  if (!data) return;
  const { name, display, pageUrl, records } = data;

  const listed = window._profileListed; // set by initBuyBtn
  const priceStr = listed && window._profileListedPrice
    ? ` Listed for ${window._profileListedPrice}.`
    : '';
  const twitter = records && records['com.twitter'] ? ` @${records['com.twitter']}` : '';

  const text = `${display !== name ? display + ' (' + name + ')' : name}${twitter} on @ordinalpunk72's BTC Native marketplace.${priceStr}`;
  const url  = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
  window.open(url, '_blank', 'noopener,width=580,height=420');
}

// ── New explore init ──────────────────────────────────────────────────────────

// ── Explore search results (called when ?search= param is present) ────────────
async function _runExploreSearch(query) {
  // Switch to listings tab so the grid container is visible
  if (typeof switchTab === 'function') switchTab('listings');

  const gridEl  = qs('#listingsGrid');
  const countEl = qs('#listingCount');

  if (gridEl) {
    gridEl.innerHTML = Array(12).fill(0).map(() =>
      `<div class="name-card skeleton" style="height:96px;border-radius:var(--radius-lg);"></div>`
    ).join('');
  }
  if (countEl) countEl.textContent = `Searching "${query}"...`;

  // Show a "Search results for X" heading if there's a page title area
  const heroEl = qs('#exploreHero') || qs('.explore-hero') || qs('.page-hero');
  if (heroEl) {
    heroEl.innerHTML = `<h1 style="font-size:var(--text-2xl);font-weight:700;">Results for <em style="color:var(--color-primary);">${query}</em></h1>`;
  }

  // Fan out across all SEARCH_TLDS in parallel
  const deduped = new Map();
  const fetches = SEARCH_TLDS.map(tld => {
    const domainType = tld.replace('.', '');
    return fetchListings({ domainFuzzy: query, domainType, limit: 20 })
      .then(res => {
        if (res && res.list) {
          res.list.forEach(item => {
            const key = item.domain || item.name || JSON.stringify(item);
            if (!deduped.has(key)) deduped.set(key, item);
          });
        }
      })
      .catch(() => {});
  });

  await Promise.all(fetches);

  const cards = [...deduped.values()].map(unisatListingToCard);

  if (gridEl) {
    gridEl.innerHTML = '';
    if (cards.length === 0) {
      gridEl.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:var(--space-12) 0;color:var(--color-text-faint);">
          <div style="font-size:var(--text-xl);margin-bottom:var(--space-2);">No listings found</div>
          <div style="font-size:var(--text-sm);">No marketplace listings match <strong>${query}</strong>. Try a different query.</div>
        </div>`;
    } else {
      cards.forEach(c => gridEl.appendChild(buildNameCard(c)));
    }
  }

  if (countEl) countEl.textContent = cards.length > 0 ? `${cards.length} results for "${query}"` : '';

  LIVE_LISTINGS = cards;

  // Hide load-more; results are complete
  const loadBtn = qs('#loadMoreBtn');
  if (loadBtn) loadBtn.style.display = 'none';

  renderMarketIndexes();
}

async function initExplorePageMVP() {
  const params = new URLSearchParams(location.search);

  // If ?search= param present, render a search-results grid and return early
  const urlSearch = params.get('search') || '';
  if (urlSearch) {
    await _runExploreSearch(urlSearch);
    // Still wire up nav search so user can search again
    const navSearch  = qs('#navSearch');
    const navResults = qs('#navResults');
    if (navSearch) {
      navSearch.value = urlSearch;
      initSearchInput(navSearch, navResults);
    }
    return;
  }

  // If a TLD filter is present but no explicit tab param, land on listings not categories
  const _urlTldPre = params.get('tld');
  const tab = params.get('tab') || (_urlTldPre ? 'listings' : 'categories');
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
    if (result && result.list) {
      LIVE_LISTINGS = result.list;
      if (result.total) LIVE_TOTAL = result.total;
    }
    renderListings(getFilteredNamesMVP());
    const loadBtn = qs('#loadMoreBtn');
    if (loadBtn) loadBtn.style.display = '';
  } else {
    renderListings(getFilteredNamesMVP());
    if (UNISAT_API_KEY) {
      fetchListings(apiParams).then(result => {
        if (result && result.list) {
          LIVE_LISTINGS = result.list;
          if (result.total) LIVE_TOTAL = result.total;
          renderListings(getFilteredNamesMVP());
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
    const newItems = result.list;
    LIVE_LISTINGS = [...(LIVE_LISTINGS || []), ...newItems];
    renderListings(getFilteredNamesMVP());
  }
}

// ── Nav wallet button ────────────────────────────────────────────────────
async function initNavWallet() {
  const btn = document.getElementById('navWalletBtn');
  if (!btn) return;

  // Already connected — navigate to portfolio
  if (btn.dataset.addr) {
    location.href = `./portfolio.html?address=${encodeURIComponent(btn.dataset.addr)}`;
    return;
  }

  // Try to connect UniSat
  try {
    btn.textContent = 'Connecting...';
    if (window.unisat) {
      const accounts = await window.unisat.requestAccounts();
      if (accounts && accounts[0]) {
        setNavWalletConnected(accounts[0]);
        return;
      }
    }
    // No wallet
    btn.textContent = 'No wallet';
    setTimeout(() => { btn.textContent = 'Connect'; }, 2000);
  } catch {
    btn.textContent = 'Connect';
  }
}

async function setNavWalletConnected(address) {
  const btn = document.getElementById('navWalletBtn');
  if (!btn) return;
  btn.dataset.addr = address;
  const shortAddr = address.slice(0, 6) + '...' + address.slice(-4);
  btn.title = address;

  // Immediately show truncated address while resolving
  btn.innerHTML = `<span class="nav__wallet-name">${shortAddr}</span>`;
  btn.classList.add('nav__wallet-btn--connected');

  // Async identity resolution — both calls get 15s timeouts
  // (BNRP worker makes multiple upstream calls; cold starts take 8-12s)
  try {
    const BNRP = 'https://api.bnrp.name/v1';

    // Step 1: reverse resolve address → name
    const revCtrl = new AbortController();
    const revTimer = setTimeout(() => revCtrl.abort(), 15000);
    let revData;
    try {
      const revRes = await fetch(`${BNRP}/reverse/${encodeURIComponent(address)}`, { signal: revCtrl.signal });
      clearTimeout(revTimer);
      if (!revRes.ok) throw new Error('no reverse');
      revData = await revRes.json();
    } finally { clearTimeout(revTimer); }
    const name = revData?.name;
    if (!name) throw new Error('no name');

    // Step 2: forward resolve name → profile.avatar
    let avatarHtml = '';
    try {
      const fwdCtrl = new AbortController();
      const fwdTimer = setTimeout(() => fwdCtrl.abort(), 15000);
      let fwdData;
      try {
        const fwdRes = await fetch(`${BNRP}/resolve/${encodeURIComponent(name)}`, { signal: fwdCtrl.signal });
        clearTimeout(fwdTimer);
        if (fwdRes.ok) fwdData = await fwdRes.json();
      } finally { clearTimeout(fwdTimer); }
      const rawAvatar = fwdData?.profile?.avatar || '';
      const inscriptionId = rawAvatar.startsWith('ord:') ? rawAvatar.slice(4) : rawAvatar;
      if (inscriptionId) {
        avatarHtml = `<span class="nav__wallet-avatar"><img src="https://static.unisat.space/content/${inscriptionId}" alt="" onerror="this.style.display='none'"></span>`;
      }
    } catch { /* no avatar — gradient fallback */ }

    if (!avatarHtml) avatarHtml = `<span class="nav__wallet-avatar"></span>`;

    // Guard: only update if this address is still the active wallet
    // (user may have switched again while we were resolving)
    if (btn.dataset.addr !== address) return;

    btn.innerHTML = `${avatarHtml}<span class="nav__wallet-name">${name}</span>`;
    btn.classList.add('nav__wallet-btn--has-identity');
    btn.title = `${name} (${address})`;
  } catch {
    if (btn.dataset.addr !== address) return;
    // No name resolved — show gradient avatar + truncated address
    btn.innerHTML = `<span class="nav__wallet-avatar"></span><span class="nav__wallet-name">${shortAddr}</span>`;
    btn.classList.add('nav__wallet-btn--has-identity');
  }
}

// ── Mobile nav toggle ───────────────────────────────────────────────────────────────────────────────────
function toggleMobileNav() {
  const nav = document.querySelector('.nav');
  if (nav) nav.classList.toggle('nav--open');
}
// Close mobile nav on link or dropdown item click
document.addEventListener('click', e => {
  const link = e.target.closest('.nav__link, .nav__dropdown-item');
  if (link) {
    const nav = document.querySelector('.nav');
    if (nav) nav.classList.remove('nav--open');
  }
});
// Wallet connect via dropdown item
document.addEventListener('click', e => {
  const walletItem = e.target.closest('.nav__dropdown-item--wallet');
  if (!walletItem) return;
  e.preventDefault();
  initNavWallet();
});
// Mobile: tap nav trigger to toggle dropdown
document.addEventListener('click', e => {
  if (window.innerWidth > 768) return; // desktop uses hover
  const link = e.target.closest('.nav__link--has-dropdown');
  if (!link) return;
  const item = link.closest('.nav__item');
  if (!item) return;
  const isOpen = item.classList.contains('mobile-open');
  // close all others
  document.querySelectorAll('.nav__item.mobile-open').forEach(el => el.classList.remove('mobile-open'));
  if (!isOpen) {
    e.preventDefault();
    item.classList.add('mobile-open');
  }
});

// Show wallet button if wallet extension is installed
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const btn = document.getElementById('navWalletBtn');
    if (!btn) return;
    if (window.unisat || window.XverseProviders?.BitcoinProvider || window.btc) {
      btn.style.display = '';
      // Auto-read if already connected (getAccounts is passive — no popup)
      if (window.unisat) {
        window.unisat.getAccounts().then(accounts => {
          if (accounts && accounts[0]) setNavWalletConnected(accounts[0]);
        }).catch(() => {});
      }
    }
  }, 300);
});

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

// ── BNRP Record Editor ────────────────────────────────────────────────────────

function showBnrpEditorForOwner(records) {
  // Reveal the Edit tab
  const editTab = document.getElementById('editTab');
  if (editTab) editTab.style.display = '';

  // Pre-fill form with existing records
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  set('bnrpDisplay', records.display);
  set('bnrpDesc',    records.description);
  set('bnrpUrl',     records.url);
  set('bnrpTwitter', records['com.twitter']);
  set('bnrpBtc',     records['btc'] || records['bitcoin']);
  // Avatar: strip 'ord:' prefix for display
  if (records.avatar) {
    const avatarEl = document.getElementById('bnrpAvatar');
    if (avatarEl) avatarEl.value = records.avatar.replace('ord:', '');
  }
}

function saveBnrpRecords() {
  const get = id => (document.getElementById(id)?.value || '').trim();

  const display  = get('bnrpDisplay');
  const desc     = get('bnrpDesc');
  const avatarRaw = get('bnrpAvatar');
  const url      = get('bnrpUrl');
  const twitter  = get('bnrpTwitter').replace('@', '');
  const btc      = get('bnrpBtc');

  // Build BNRP records object (only include non-empty fields)
  const records = {};
  if (display)    records.display     = display;
  if (desc)       records.description = desc;
  if (avatarRaw)  records.avatar      = avatarRaw.includes(':') ? avatarRaw : `ord:${avatarRaw}`;
  if (url)        records.url         = url.startsWith('http') ? url : `https://${url}`;
  if (twitter)    records['com.twitter'] = twitter;
  if (btc)        records.btc         = btc;

  if (Object.keys(records).length === 0) {
    const s = document.getElementById('bnrpStatus');
    if (s) { s.style.color = '#ef4444'; s.textContent = 'Fill in at least one field.'; }
    return;
  }

  // Get the current name from URL
  const name = new URLSearchParams(location.search).get('name') || '';

  // Build the BNRP JSON payload
  const payload = { name, records };
  const jsonStr = JSON.stringify(payload, null, 2);

  // Show preview
  const previewWrap = document.getElementById('bnrpPreviewWrap');
  const previewJson = document.getElementById('bnrpPreviewJson');
  if (previewWrap) previewWrap.style.display = 'block';
  if (previewJson) previewJson.textContent = jsonStr;

  const s = document.getElementById('bnrpStatus');
  if (s) {
    s.style.color = 'var(--color-text-faint)';
    s.textContent = 'Preview ready. Inscribe this JSON on Bitcoin to publish your identity.';
  }

  // Copy to clipboard for convenience
  if (navigator.clipboard) {
    navigator.clipboard.writeText(jsonStr).catch(() => {});
  }

  const btn = document.getElementById('bnrpSaveBtn');
  if (btn) btn.textContent = 'Copied to clipboard';
}
