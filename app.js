/* app.js — btcnative.name
 * Bitcoin name discovery platform powered by BNRP + UniSat APIs
 */

'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const BNRP_API   = 'https://bnrp.name/api';
const UNISAT_API = 'https://open-api.unisat.io/v1';
const SUPPORTED_TLDS = ['.btc', '.sats', '.x', '.ord', '.gm', '.xbt', '.sat', '.unisat', '.fb'];

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

async function updateStats() {
  // Show placeholder stats — these would pull from live UniSat + BNRP indexer
  const stats = [
    ['statTotal',    '1.2M+'],
    ['statBtcFloor', '80K sats'],
    ['statSatsFloor','22K sats'],
    ['stat3LFloor',  '420K sats'],
    ['statBnrp',     '247'],
    ['statVol',      '$14.2K'],
  ];
  stats.forEach(([id, val]) => {
    const el = qs(`#${id}`);
    if (el) {
      el.style.opacity = '0';
      el.textContent = val;
      el.style.transition = 'opacity 0.4s';
      requestAnimationFrame(() => { el.style.opacity = '1'; });
    }
  });
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

  // Listing status
  qs('#listingPrice').textContent = 'Not listed';
  qs('#listingStatus').textContent = 'This name is not currently listed for sale. Make an offer via UniSat.';

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

  // Populate listings with seed
  renderListings(SEED_NAMES);

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
function loadMore() {
  // In production: fetch next page from UniSat API
}

function renderMarketIndexes() {
  const el = qs('#indexCards');
  if (!el) return;
  const indexes = [
    { name: 'BTC Names Floor', value: '80K sats', change: '+4.2%', up: true, desc: 'Composite floor across all TLDs' },
    { name: '3L Club',         value: '420K sats', change: '+8.1%', up: true, desc: '.btc three-character floor' },
    { name: '4L Club',         value: '55K sats',  change: '-1.2%', up: false, desc: '.btc four-character floor' },
    { name: '3-Digit Club',    value: '1.2M sats', change: '+12%',  up: true, desc: '000-999 numeric floor' },
    { name: 'BNRP Active',     value: '95K sats',  change: '+6.3%', up: true, desc: 'Names with BNRP records' },
    { name: '.sats Floor',     value: '22K sats',  change: '+2.1%', up: true, desc: 'Sats Names protocol floor' },
  ];
  indexes.forEach(idx => {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);padding:var(--space-5);';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
        <span style="font-size:var(--text-sm);font-weight:700;font-family:var(--font-display);color:var(--color-text);">${idx.name}</span>
        <span style="font-size:var(--text-xs);font-family:var(--font-mono);padding:2px var(--space-2);border-radius:var(--radius-sm);font-weight:600;
          color:${idx.up ? 'var(--color-success)' : 'var(--color-error)'};
          background:${idx.up ? 'var(--color-success-dim)' : 'var(--color-error-dim)'};">${idx.change}</span>
      </div>
      <div style="font-size:var(--text-xl);font-weight:800;font-family:var(--font-mono);color:var(--color-text);letter-spacing:-0.02em;margin-bottom:var(--space-2);">${idx.value}</div>
      <div style="font-size:var(--text-xs);color:var(--color-text-faint);">${idx.desc}</div>
    `;
    el.appendChild(card);
  });

  // Sales table
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
  const rows = [
    ['ord.ord',    '210K sats', 'UniSat',       '2h ago'],
    ['123.btc',    '980K sats', 'UniSat',       '5h ago'],
    ['gm.gm',      '88K sats',  'Ordinals Wallet','8h ago'],
    ['moon.sats',  '45K sats',  'UniSat',       '12h ago'],
    ['888.btc',    '2.1M sats', 'UniSat',       '1d ago'],
  ];
  const tbody = qs('#salesRows');
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
