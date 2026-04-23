/**
 * nav-search.js — Global persistent nav search with autocomplete
 * Included on every page. Binds to #navSearchInput / #navSearchDropdown.
 * Keyboard: / or Cmd+K focuses, Esc closes, arrow keys navigate results.
 */
(function() {
  'use strict';

  const BTCNAME_TLDS = ['.btc','.sats','.x','.ord','.gm','.xbt','.sat','.unisat','.fb'];
  const SEARCH_TLDS  = ['.btc','.sats','.x','.ord','.xbt'];

  function normalizeName(raw) {
    const lower = raw.trim().toLowerCase();
    if (BTCNAME_TLDS.some(t => lower.endsWith(t))) return lower;
    return lower; // no TLD added for autocomplete display
  }

  function fmtBtc(sats) {
    if (!sats) return null;
    const btc = sats / 1e8;
    if (btc >= 0.01) return btc.toFixed(4).replace(/0+$/,'') + ' BTC';
    return btc.toFixed(8).replace(/0+$/,'') + ' BTC';
  }

  // Build candidate names from a query (add each TLD variant)
  function buildCandidates(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    // If already has a TLD, just return as-is
    if (BTCNAME_TLDS.some(t => q.endsWith(t))) return [q];
    return SEARCH_TLDS.map(t => q + t);
  }

  async function resolveCandidate(name) {
    try {
      const base = (typeof UNISAT_API_KEY !== 'undefined')
        ? 'https://open-api.unisat.io'
        : null;
      if (!base) return null;
      const apiKey = (typeof UNISAT_API_KEY !== 'undefined') ? UNISAT_API_KEY : null;
      if (!apiKey) return null;

      const tld = BTCNAME_TLDS.find(t => name.endsWith(t));
      const domainType = tld ? tld.slice(1) : 'btc';
      const label = tld ? name.slice(0, -tld.length) : name;

      const r = await fetch(
        `https://open-api.unisat.io/v3/market/btcname/auction/info?domainType=${domainType}&domain=${encodeURIComponent(label)}`,
        { headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(4000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      if (d.code !== 0) return null;
      return d.data || null;
    } catch { return null; }
  }

  let _debounce = null;
  let _focusIdx = -1;

  function init() {
    const input = document.getElementById('navSearchInput');
    const dropdown = document.getElementById('navSearchDropdown');
    if (!input || !dropdown) return;

    // Bind / and Cmd+K globally
    document.addEventListener('keydown', function(e) {
      // Ignore if in a text field (other than our own)
      const tag = document.activeElement?.tagName;
      const isOtherInput = (tag === 'INPUT' || tag === 'TEXTAREA') && document.activeElement !== input;
      if (isOtherInput) return;

      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        input.focus();
        input.select();
      }
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        input.focus();
        input.select();
      }
      if (e.key === 'Escape') {
        close();
        input.blur();
      }
    });

    input.addEventListener('input', function() {
      const q = input.value.trim();
      clearTimeout(_debounce);
      if (!q) { close(); return; }
      _debounce = setTimeout(() => search(q), 200);
    });

    input.addEventListener('keydown', function(e) {
      const items = dropdown.querySelectorAll('.nav__search-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _focusIdx = Math.min(_focusIdx + 1, items.length - 1);
        updateFocus(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _focusIdx = Math.max(_focusIdx - 1, 0);
        updateFocus(items);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const focused = dropdown.querySelector('.nav__search-result.focused');
        if (focused) {
          const href = focused.dataset.href;
          if (href) window.location.href = href;
        } else {
          // Navigate to name page for first candidate
          const q = input.value.trim();
          if (q) {
            const first = buildCandidates(q)[0] || q;
            window.location.href = './name.html?name=' + encodeURIComponent(first);
          }
        }
      } else if (e.key === 'Escape') {
        close();
        input.blur();
      }
    });

    input.addEventListener('focus', function() {
      if (input.value.trim()) {
        dropdown.classList.add('open');
      }
    });

    document.addEventListener('click', function(e) {
      if (!dropdown.contains(e.target) && e.target !== input) close();
    });
  }

  function updateFocus(items) {
    items.forEach((item, i) => item.classList.toggle('focused', i === _focusIdx));
  }

  function close() {
    const dropdown = document.getElementById('navSearchDropdown');
    if (dropdown) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; }
    _focusIdx = -1;
  }

  async function search(q) {
    const dropdown = document.getElementById('navSearchDropdown');
    if (!dropdown) return;
    _focusIdx = -1;

    // Show loading hint
    dropdown.innerHTML = '<div class="nav__search-hint">Searching...</div>';
    dropdown.classList.add('open');

    const candidates = buildCandidates(q);
    if (!candidates.length) { close(); return; }

    // Try to resolve the first few candidates concurrently
    const results = await Promise.allSettled(
      candidates.slice(0, 3).map(name => resolveCandidate(name).then(data => ({ name, data })))
    );

    const found = results
      .filter(r => r.status === 'fulfilled' && r.value.data)
      .map(r => r.value);

    // Also add unresolved candidates as "look up" entries
    const resolvedNames = new Set(found.map(f => f.name));
    const extras = candidates.filter(c => !resolvedNames.has(c));

    let html = '';

    for (const { name, data } of found) {
      const listed = data.status === 'listed' || data.listed;
      const price = listed ? fmtBtc(data.price || data.initPrice) : null;
      const href = `./name.html?name=${encodeURIComponent(name)}`;
      html += `
        <button class="nav__search-result" data-href="${href}" onclick="window.location.href='${href}'">
          <span class="nav__search-result-name">${escHtml(name)}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            ${price ? `<span class="nav__search-result-price">${escHtml(price)}</span>` : ''}
            ${listed ? `<span class="nav__search-result-badge">For Sale</span>` : ''}
          </span>
        </button>`;
    }

    for (const name of extras.slice(0, 2)) {
      const href = `./name.html?name=${encodeURIComponent(name)}`;
      html += `
        <button class="nav__search-result" data-href="${href}" onclick="window.location.href='${href}'">
          <span class="nav__search-result-name">${escHtml(name)}</span>
          <span class="nav__search-result-price" style="color:var(--color-text-faint);">Look up</span>
        </button>`;
    }

    if (!html) {
      html = `<div class="nav__search-hint">No names found for "${escHtml(q)}"</div>`;
    } else {
      // Add "See all results" at bottom
      html += `<button class="nav__search-result" style="border-top:1px solid var(--color-divider);"
        data-href="./explore.html?tab=listings&q=${encodeURIComponent(q)}"
        onclick="window.location.href='./explore.html?tab=listings&q=${encodeURIComponent(q)}'">
        <span style="font-size:var(--text-xs);color:var(--color-text-muted);">Browse all names matching "${escHtml(q)}" \u2192</span>
      </button>`;
    }

    dropdown.innerHTML = html;
    dropdown.classList.add('open');
  }

  function escHtml(str) {
    return String(str).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
