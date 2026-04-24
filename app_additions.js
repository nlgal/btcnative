
// ── Extended record field registry ──────────────────────────────────────────
/**
 * BNRP_RECORD_FIELDS — All supported record field keys with metadata.
 * 'core' fields are in the base spec. 'extended' fields are optional but recognized.
 * 'custom' fields are user-defined key/value pairs.
 */
const BNRP_RECORD_FIELDS = Object.freeze({
  // Core address fields
  btc:          { label: 'BTC address',       type: 'address', tier: 'core',     placeholder: 'bc1p...' },
  lightning:    { label: 'Lightning address', type: 'address', tier: 'core',     placeholder: 'lnbc...' },
  ordinals:     { label: 'Ordinals address',  type: 'address', tier: 'core',     placeholder: 'bc1p...' },
  // Extended address fields
  eth:          { label: 'ETH address',       type: 'address', tier: 'extended', placeholder: '0x...' },
  sol:          { label: 'SOL address',       type: 'address', tier: 'extended', placeholder: 'addr...' },
  // Content
  website:      { label: 'Website URL',       type: 'url',     tier: 'core',     placeholder: 'https://...' },
  avatar:       { label: 'Avatar inscription',type: 'inscription', tier: 'core', placeholder: 'inscription_id...' },
  description:  { label: 'Description',       type: 'text',    tier: 'core',     placeholder: 'Short description' },
  content_hash: { label: 'Content hash',      type: 'hash',    tier: 'extended', placeholder: 'ipfs://... or sha256:...' },
  // Social
  'com.twitter':   { label: 'Twitter / X',     type: 'handle',  tier: 'core',     placeholder: '@handle' },
  'com.farcaster':  { label: 'Farcaster',       type: 'handle',  tier: 'extended', placeholder: '@handle' },
  'com.discord':    { label: 'Discord',         type: 'handle',  tier: 'extended', placeholder: 'user#1234' },
  email_hash:      { label: 'Email hash',       type: 'hash',    tier: 'extended', placeholder: 'sha256 of email' },
});

/**
 * makeExtendedRecords(fields) → records object
 * Creates a full records object with all supported fields defaulting to empty string.
 * Use this for the extended record form.
 */
function makeExtendedRecords(fields = {}) {
  const out = {};
  for (const key of Object.keys(BNRP_RECORD_FIELDS)) {
    out[key] = fields[key] || '';
  }
  // Preserve custom fields
  if (fields.custom && typeof fields.custom === 'object') {
    out.custom = { ...fields.custom };
  }
  return out;
}

// ── Op status reference ──────────────────────────────────────────────────────
// BNRP_RECORD_OPS status as of Phase 2:
// LIVE:      record_register, record_update (via profile op)
// PROTOTYPE: subname_register, subname_update, subname_revoke, delegate_add, delegate_remove
// ROADMAP:   record_revoke, policy_update, subname_transfer, subname_freeze
// All ops use { p: 'bnrp', op: <op>, name: <name>, nonce: <n>, v: 1 }

// ── ResolverAdapter — abstraction over BNRP resolver sources ─────────────────
/**
 * BNRP_RESOLVER_SOURCES — Known resolver sources.
 */
const BNRP_RESOLVER_SOURCES = Object.freeze({
  BNRP_API: 'bnrp-api',   // api.bnrp.name — primary
  UNISAT:   'unisat',     // unisat.io — fallback for address data
  BTCNAME:  'btcname',    // .btc resolver
  SNS:      'sns',        // .sats resolver
  NONE:     'none',
});

/**
 * ResolverAdapter
 *
 * Wraps a resolved name object into a normalized shape regardless of source.
 * Supports BNRP API, UniSat domain info, and manual overrides.
 *
 * Usage:
 *   const adapter = new ResolverAdapter(resolveResult, 'bnrp-api');
 *   adapter.getBTC()     → 'bc1p...' or null
 *   adapter.getWebsite() → 'https://...' or null
 *   adapter.getAvatar()  → inscription_id or null
 *   adapter.getTrustLevel() → 'verified' | 'unverified' | 'conflict' | 'unavailable'
 */
class ResolverAdapter {
  constructor(data, source = BNRP_RESOLVER_SOURCES.NONE) {
    this._data = data || {};
    this._source = source;
  }

  get source() { return this._source; }
  get raw() { return this._data; }

  getBTC() {
    return this._data?.records?.btc
      || this._data?.addresses?.btc
      || this._data?.btcAddress
      || null;
  }

  getLightning() {
    return this._data?.records?.lightning
      || this._data?.addresses?.lightning
      || null;
  }

  getWebsite() {
    return this._data?.records?.website
      || this._data?.profile?.url
      || this._data?.url
      || null;
  }

  getAvatar() {
    return this._data?.records?.avatar
      || this._data?.profile?.avatar
      || null;
  }

  getDisplay() {
    return this._data?.records?.display
      || this._data?.profile?.display
      || this._data?.display
      || null;
  }

  getDescription() {
    return this._data?.records?.description
      || this._data?.profile?.description
      || null;
  }

  getTwitter() {
    return this._data?.records?.['com.twitter']
      || this._data?.profile?.['com.twitter']
      || null;
  }

  getTrustLevel() {
    if (!this._data || this._source === BNRP_RESOLVER_SOURCES.NONE) return 'unavailable';
    if (this._data.resolverStatus === 'verified' || this._data.via === 'btcname') return 'verified';
    if (this._data.resolverStatus === 'conflict') return 'conflict';
    if (this._source === BNRP_RESOLVER_SOURCES.UNISAT) return 'unverified';
    return 'unverified';
  }

  toRecordsObject() {
    const out = {};
    const fields = ['btc', 'lightning', 'ordinals', 'website', 'avatar', 'description', 'com.twitter', 'com.farcaster'];
    for (const f of fields) {
      const val = this._data?.records?.[f] || this._data?.profile?.[f] || '';
      if (val) out[f] = val;
    }
    return out;
  }
}

// ── TrustWarning — centralized trust check and warning generation ─────────────
/**
 * TRUST_WARNING_TYPES — Known warning types.
 */
const TRUST_WARNING_TYPES = Object.freeze({
  REINSCRIPTION:       'reinscription',    // name has been re-inscribed
  NOT_OWNER:           'not-owner',        // signer is not owner or delegate
  RESOLVER_STALE:      'resolver-stale',   // resolver data is stale
  EXPERIMENTAL:        'experimental',     // feature is experimental
  CONFUSABLE:          'confusable',       // name contains confusable characters
  POLICY_LOCKED:       'policy-locked',    // namespace policy is locked
  UNVERIFIED_PARENT:   'unverified-parent',// parent name not verified on-chain
  CUSTOM_RECORD:       'custom-record',    // record type is not standard
  ADDRESS_MISMATCH:    'address-mismatch', // address format mismatch
});

/**
 * getTrustWarnings(context) → Array<{type, level, title, detail, actionLabel, actionHref}>
 *
 * Runs a set of trust checks against the provided context object and returns
 * an array of warnings to surface to the user.
 *
 * context shape:
 * {
 *   name, parentName, label, records, policy,
 *   ownerAddress, connectedWallet,
 *   resolverStatus, isExperimental,
 *   inscriptionCount,     // > 1 = re-inscription risk
 *   confusableResult,     // from detectConfusable()
 * }
 */
function getTrustWarnings(context = {}) {
  const warnings = [];

  if (context.isExperimental) {
    warnings.push({
      type:  TRUST_WARNING_TYPES.EXPERIMENTAL,
      level: 'info',
      title: 'Experimental feature',
      detail: 'Subname issuance is in prototype phase. Do not use for high-value transfers without independent verification.',
    });
  }

  if (context.inscriptionCount > 1) {
    warnings.push({
      type:  TRUST_WARNING_TYPES.REINSCRIPTION,
      level: 'warning',
      title: 'Re-inscription detected',
      detail: 'This name has been inscribed more than once. Only the first inscription is canonical. Verify on ordinals.com before trusting any records.',
      actionLabel: 'View on ordinals.com',
      actionHref:  context.name ? `https://ordinals.com/search?query=${encodeURIComponent(context.name)}` : 'https://ordinals.com',
    });
  }

  if (context.ownerAddress && context.connectedWallet && context.ownerAddress !== context.connectedWallet) {
    warnings.push({
      type:  TRUST_WARNING_TYPES.NOT_OWNER,
      level: 'error',
      title: 'Not the owner',
      detail: 'The connected wallet does not match the name owner. You cannot update records for this name.',
    });
  }

  if (context.resolverStatus === 'stale') {
    warnings.push({
      type:  TRUST_WARNING_TYPES.RESOLVER_STALE,
      level: 'caution',
      title: 'Resolver data may be stale',
      detail: 'The BNRP resolver last updated over 24 hours ago. Records shown may not reflect the latest on-chain state.',
    });
  }

  if (context.confusableResult) {
    warnings.push({
      type:  TRUST_WARNING_TYPES.CONFUSABLE,
      level: 'warning',
      title: 'Confusable characters detected',
      detail: context.confusableResult,
    });
  }

  if (context.policy === 'locked') {
    warnings.push({
      type:  TRUST_WARNING_TYPES.POLICY_LOCKED,
      level: 'info',
      title: 'Namespace locked',
      detail: 'This namespace has a locked policy. Only the original owner can update records.',
    });
  }

  return warnings;
}

/**
 * buildTrustCheckPanel(warnings, checks) → HTMLElement
 *
 * Renders a trust check panel — list of checks (pass/fail/warn) and warnings.
 * Used on Step 4 of the Subname Manager wizard.
 *
 * checks: Array<{ label, pass: boolean|null, note }>
 * warnings: Array (from getTrustWarnings)
 */
function buildTrustCheckPanel(checks = [], warnings = []) {
  const panel = document.createElement('div');
  panel.className = 'trust-check-panel';

  const checksHTML = checks.map(c => {
    const icon = c.pass === true
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success,#22c55e)" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg>'
      : c.pass === false
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error,#ef4444)" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-warn,#f59e0b)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg>';
    return `<div class="trust-check-panel__item trust-check-panel__item--${c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'warn'}">
      ${icon}
      <span class="trust-check-panel__label">${c.label}</span>
      ${c.note ? `<span class="trust-check-panel__note">${c.note}</span>` : ''}
    </div>`;
  }).join('');

  const warningsHTML = warnings.map(w => {
    const LEVEL_COLORS = { warning: 'warn', error: 'error', info: 'info', caution: 'caution' };
    const color = LEVEL_COLORS[w.level] || 'info';
    return `<div class="trust-warning trust-warning--${color}">
      <div class="trust-warning__title">${w.title}</div>
      <div class="trust-warning__detail">${w.detail}</div>
      ${w.actionLabel ? `<a href="${w.actionHref || '#'}" target="_blank" rel="noopener" class="trust-warning__action">${w.actionLabel} →</a>` : ''}
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="trust-check-panel__header">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Trust Check
    </div>
    <div class="trust-check-panel__checks">${checksHTML}</div>
    ${warningsHTML ? `<div class="trust-check-panel__warnings">${warningsHTML}</div>` : ''}
  `;

  return panel;
}

// ── SubnameTemplatePicker — template definitions and picker component ─────────
/**
 * SUBNAME_TEMPLATES — Standard use-case templates for subname creation.
 */
const SUBNAME_TEMPLATES = [
  {
    id: 'payment',
    label:    'Payment',
    example:  'pay.name.btc',
    purpose:  'Receive payments at a dedicated address',
    icon:     'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z',
    defaultLabel: 'pay',
    defaultRecords: { btc: '' },
    risk: 'Verify the address before sharing for payments',
    tier: 'core',
  },
  {
    id: 'vault',
    label:    'Cold Vault',
    example:  'vault.name.btc',
    purpose:  'Long-term storage address, separate from hot wallet',
    icon:     'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    defaultLabel: 'vault',
    defaultRecords: { btc: '' },
    risk: 'Never share the private key for a cold vault address',
    tier: 'core',
  },
  {
    id: 'shop',
    label:    'Shop',
    example:  'shop.name.btc',
    purpose:  'Link to your store, marketplace listing, or product page',
    icon:     'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
    defaultLabel: 'shop',
    defaultRecords: { website: '', btc: '' },
    tier: 'core',
  },
  {
    id: 'archive',
    label:    'Archive',
    example:  'archive.name.btc',
    purpose:  'Historical work, past releases, or read-only records',
    icon:     'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
    defaultLabel: 'archive',
    defaultRecords: { website: '' },
    tier: 'core',
  },
  {
    id: 'collection',
    label:    'Collection item',
    example:  '001.collection.btc',
    purpose:  'Index items in a series or numbered collection',
    icon:     'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    defaultLabel: '001',
    defaultRecords: { ordinals: '', website: '' },
    risk: 'Use consistent numbering (001, 002, ...) for a series',
    tier: 'core',
  },
  {
    id: 'support',
    label:    'Support',
    example:  'support.brand.btc',
    purpose:  'Support channel or contact for a brand or product',
    icon:     'M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z',
    defaultLabel: 'support',
    defaultRecords: { website: '' },
    tier: 'core',
  },
  {
    id: 'docs',
    label:    'Docs',
    example:  'docs.protocol.btc',
    purpose:  'Documentation for a protocol, project, or product',
    icon:     'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    defaultLabel: 'docs',
    defaultRecords: { website: '' },
    tier: 'core',
  },
  {
    id: 'agent',
    label:    'AI agent',
    example:  'agent.wallet.btc',
    purpose:  'Autonomous agent wallet address or service endpoint',
    icon:     'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2',
    defaultLabel: 'agent',
    defaultRecords: { btc: '', website: '' },
    risk: 'Experimental — do not use for real funds without independent verification',
    tier: 'extended',
  },
  {
    id: 'custom',
    label:    'Custom',
    example:  'custom.name.btc',
    purpose:  'Start from scratch with any label and records',
    icon:     'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
    defaultLabel: '',
    defaultRecords: {},
    tier: 'core',
  },
];

/**
 * buildSubnameTemplatePicker(onSelect) → HTMLElement
 *
 * Renders a card grid of subname templates.
 * onSelect(template) is called when the user clicks a card.
 */
function buildSubnameTemplatePicker(onSelect) {
  const wrap = document.createElement('div');
  wrap.className = 'sn-template-picker';

  SUBNAME_TEMPLATES.forEach(tpl => {
    const card = document.createElement('button');
    card.className = 'sn-template-card';
    card.setAttribute('data-template-id', tpl.id);
    card.type = 'button';
    card.innerHTML = `
      <div class="sn-template-card__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="${tpl.icon}"/>
        </svg>
      </div>
      <div class="sn-template-card__body">
        <div class="sn-template-card__label">${tpl.label}</div>
        <code class="sn-template-card__example">${tpl.example}</code>
        <div class="sn-template-card__purpose">${tpl.purpose}</div>
        ${tpl.risk ? `<div class="sn-template-card__risk"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${tpl.risk}</div>` : ''}
      </div>
    `;
    card.addEventListener('click', () => {
      wrap.querySelectorAll('.sn-template-card').forEach(c => c.classList.remove('sn-template-card--selected'));
      card.classList.add('sn-template-card--selected');
      if (typeof onSelect === 'function') onSelect(tpl);
    });
    wrap.appendChild(card);
  });

  return wrap;
}

// ── ParentNameSelector component ──────────────────────────────────────────────
/**
 * buildParentNameSelector(onSelect) → HTMLElement
 *
 * Renders a name search/select component for picking the parent name.
 * Calls the BNRP API to resolve the name and show owner/status info.
 * onSelect(name, resolveResult) is called when user confirms selection.
 */
function buildParentNameSelector(onSelect) {
  const wrap = document.createElement('div');
  wrap.className = 'sn-parent-selector';

  wrap.innerHTML = `
    <div class="sn-parent-selector__search">
      <div class="sn-parent-selector__input-wrap">
        <svg class="sn-parent-selector__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input
          class="sn-parent-selector__input"
          type="text"
          placeholder="Search or paste a name (e.g. artist.btc)"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search for a parent name"
        />
        <button class="sn-parent-selector__btn btn btn--primary btn--sm" type="button">Search</button>
      </div>
    </div>
    <div class="sn-parent-selector__result" style="display:none;"></div>
  `;

  const input = wrap.querySelector('.sn-parent-selector__input');
  const btn   = wrap.querySelector('.sn-parent-selector__btn');
  const result = wrap.querySelector('.sn-parent-selector__result');

  async function lookup() {
    const raw = input.value.trim().toLowerCase();
    if (!raw) return;
    // Basic TLD check
    const validTlds = ['.btc','.sats','.x','.ord','.gm','.xbt','.sat','.unisat','.fb'];
    const hasTld = validTlds.some(t => raw.endsWith(t));
    if (!hasTld) {
      result.style.display = 'block';
      result.innerHTML = `<div class="sn-parent-selector__error">Enter a valid Bitcoin name (e.g. artist.btc, vault.sats)</div>`;
      return;
    }

    result.style.display = 'block';
    result.innerHTML = `<div class="sn-parent-selector__loading"><span class="spinner"></span> Looking up ${_esc(raw)}...</div>`;

    let resolveData = null;
    try {
      const r = await fetch(`${BNRP_API}/resolve?name=${encodeURIComponent(raw)}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) resolveData = await r.json();
    } catch {}

    const owner = resolveData?.owner || null;
    const ownerShort = owner ? owner.slice(0, 8) + '...' + owner.slice(-6) : 'Unknown';
    const resolverOk = resolveData?.resolved_at ? true : false;

    result.innerHTML = `
      <div class="sn-parent-selector__card">
        <div class="sn-parent-selector__card-name">
          <code>${_esc(raw)}</code>
          <span class="resolver-status resolver-status--${resolverOk ? 'verified' : 'unresolved'}">${resolverOk ? 'Resolved' : 'Unresolved'}</span>
        </div>
        <div class="sn-parent-selector__card-row">
          <span class="sn-parent-selector__card-label">Owner</span>
          <span class="sn-parent-selector__card-val mono">${ownerShort}</span>
        </div>
        ${!resolverOk ? `<div class="sn-parent-selector__card-warn"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> Could not verify owner. Proceed with caution.</div>` : ''}
        <button class="sn-parent-selector__use btn btn--outline btn--sm" type="button">Use ${_esc(raw)} →</button>
      </div>
    `;

    wrap.querySelector('.sn-parent-selector__use')?.addEventListener('click', () => {
      if (typeof onSelect === 'function') onSelect(raw, resolveData);
    });
  }

  btn.addEventListener('click', lookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') lookup(); });

  return wrap;
}

// ── SubnameCreateWizard helpers ───────────────────────────────────────────────

/**
 * validateSubnameLabel(label) → { valid: boolean, error: string|null }
 * Labels must be 1-63 chars, alphanumeric + hyphens, not start/end with hyphen.
 */
function validateSubnameLabel(label) {
  if (!label || label.length === 0) return { valid: false, error: 'Label is required' };
  if (label.length > 63) return { valid: false, error: 'Label must be 63 characters or fewer' };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(label)) {
    return { valid: false, error: 'Label must be lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen.' };
  }
  return { valid: true, error: null };
}

/**
 * buildBNRPSubnameEvent(parentName, label, destination, records, nonce) → BNRPEvent object
 * Builds the BNRP inscription event for subname_register.
 */
function buildBNRPSubnameEvent(parentName, label, destination, records, nonce = 1) {
  const sub = label + '.' + parentName;
  const r = { ...records };
  // Auto-classify destination
  if (destination) {
    if (destination.startsWith('bc1') || destination.startsWith('1') || destination.startsWith('3')) {
      r.btc = r.btc || destination;
    } else if (destination.startsWith('lnbc') || destination.startsWith('lntb') || destination.startsWith('lnurl')) {
      r.lightning = r.lightning || destination;
    } else if (destination.startsWith('https://') || destination.startsWith('http://')) {
      r.website = r.website || destination;
    }
  }
  // Strip empty fields
  const cleanRecords = Object.fromEntries(Object.entries(r).filter(([,v]) => v && v.trim()));

  return {
    p: 'bnrp',
    op: 'subname_register',
    name: parentName,
    sub,
    to: destination || '',
    records: cleanRecords,
    nonce,
    v: 1,
  };
}

/**
 * getSubnameWizardChecks(state) → Array<{label, pass, note}>
 * Derives trust check items from wizard state for Step 4.
 */
function getSubnameWizardChecks(state = {}) {
  const checks = [];

  const labelResult = validateSubnameLabel(state.label || '');
  checks.push({
    label: 'Subname label format',
    pass: labelResult.valid,
    note: labelResult.error || null,
  });

  const hasDest = !!(state.destination || (state.records && Object.values(state.records).some(v => v)));
  checks.push({
    label: 'Destination or records',
    pass: hasDest,
    note: hasDest ? null : 'Add a BTC address, website, or at least one record',
  });

  if (state.destination?.startsWith('bc1') || state.records?.btc) {
    const addr = state.destination || state.records?.btc || '';
    const addrValid = /^(bc1|1|3)[a-zA-Z0-9]{25,62}$/.test(addr);
    checks.push({
      label: 'BTC address format',
      pass: addrValid,
      note: addrValid ? null : 'Address does not appear to be a valid Bitcoin address',
    });
  }

  checks.push({
    label: 'Parent name owner verified',
    pass: state.ownerVerified ?? null,
    note: state.ownerVerified ? null : 'Connect wallet to verify ownership',
  });

  checks.push({
    label: 'Subname issuance phase',
    pass: null, // neither pass nor fail — informational
    note: 'Experimental — indexer is in prototype phase',
  });

  return checks;
}
