/*
 * tests/at-prefix-names.test.js
 *
 * Exercises the @-prefix handling for Bitcoin names like @grok.btc and @nasa.sats.
 * UniSat lists names that begin with "@" (e.g. @grok.btc, @nasa.sats); the search
 * input, bulk lookup, and listing matchers all need to accept and round-trip the
 * leading @ without stripping it.
 *
 * Run:  node tests/at-prefix-names.test.js
 * Exits non-zero on failure. No test framework dependency.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.src.js'), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; }
}

console.log('@-prefix Bitcoin name handling');

// ── Pure helpers that mirror app.src.js — keep in sync ────────────────────────
function getBase(name) {
  if (!name) return '';
  const m = name.match(/^([^.]+)/);
  return m ? m[1] : name;
}
function getTld(name) {
  if (!name) return '';
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1] : '';
}
const SUPPORTED_TLDS = ['.btc', '.sats', '.x', '.ord', '.gm', '.xbt', '.sat', '.unisat', '.fb'];

// Mirrors app.src.js runSearch normalization (line ~2580)
function normalizeSearchQuery(q) {
  const hasTld = SUPPORTED_TLDS.some(t => q.endsWith(t));
  return hasTld ? getBase(q) : q.toLowerCase().replace(/[^a-z0-9@]/g, '');
}

// Mirrors app.src.js parseBulkInput allowed-char filter (line ~3304)
function isValidBulkBase(s) {
  return /^@?[a-z0-9][a-z0-9-]*$/.test(s);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('getBase preserves leading @ for @grok.btc', () => {
  assert.strictEqual(getBase('@grok.btc'), '@grok');
});

test('getBase preserves leading @ for @nasa.sats', () => {
  assert.strictEqual(getBase('@nasa.sats'), '@nasa');
});

test('getTld returns .btc for @grok.btc', () => {
  assert.strictEqual(getTld('@grok.btc'), '.btc');
});

test('getTld returns .sats for @nasa.sats', () => {
  assert.strictEqual(getTld('@nasa.sats'), '.sats');
});

test('search query normalization preserves leading @ when no TLD', () => {
  assert.strictEqual(normalizeSearchQuery('@grok'), '@grok');
  assert.strictEqual(normalizeSearchQuery('@NASA'), '@nasa');
});

test('search query normalization with TLD returns the @-prefixed base', () => {
  assert.strictEqual(normalizeSearchQuery('@grok.btc'), '@grok');
  assert.strictEqual(normalizeSearchQuery('@nasa.sats'), '@nasa');
});

test('search query normalization still strips other punctuation', () => {
  // dollar/percent/dot stay disallowed in the freeform-base path
  assert.strictEqual(normalizeSearchQuery('foo$bar'), 'foobar');
  assert.strictEqual(normalizeSearchQuery('hello!'), 'hello');
});

test('bulk parser accepts @grok and @nasa', () => {
  assert.ok(isValidBulkBase('@grok'));
  assert.ok(isValidBulkBase('@nasa'));
});

test('bulk parser accepts plain alphanumeric and hyphenated names', () => {
  assert.ok(isValidBulkBase('satoshi'));
  assert.ok(isValidBulkBase('hello-world'));
  assert.ok(isValidBulkBase('123'));
});

test('bulk parser rejects names with disallowed characters', () => {
  assert.ok(!isValidBulkBase('foo$bar'));
  assert.ok(!isValidBulkBase('x@y'));            // @ only allowed at start
  assert.ok(!isValidBulkBase('-leading-hyphen')); // [a-z0-9] required at position 1
  assert.ok(!isValidBulkBase(''));                // empty
  assert.ok(!isValidBulkBase('@'));               // @ alone is not a name
});

test('subname label validator (unchanged) still rejects @ — DNS-style labels only', () => {
  // app.src.js validateSubnameLabel — ^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$
  const re = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
  assert.ok(!re.test('@grok'), 'subname labels must not allow @');
  assert.ok(re.test('grok'),   'plain subname labels still work');
});

test('UniSat domain match is @-tolerant on both sides (sale history fix)', () => {
  // Mirrors the de-@-prefixed comparison added in fetchAndRenderSaleHistory.
  function matches(eventDomain, fullName, base, tldRaw) {
    const fullNameLower = fullName.toLowerCase();
    const fullNameNoAt  = fullNameLower.replace(/^@/, '');
    const baseNoAt      = base.toLowerCase().replace(/^@/, '');
    const d             = (eventDomain || '').toLowerCase().replace(/^@/, '');
    return d === fullNameNoAt || d === baseNoAt + '.' + tldRaw;
  }
  // User looks up @grok.btc; UniSat returns event.domain "@grok.btc"
  assert.ok(matches('@grok.btc', '@grok.btc', '@grok', 'btc'));
  // User looks up @grok.btc; UniSat returned event.domain "grok.btc" (no @)
  assert.ok(matches('grok.btc',  '@grok.btc', '@grok', 'btc'));
  // User looks up grok.btc; UniSat returned event.domain "@grok.btc"
  assert.ok(matches('@grok.btc', 'grok.btc',  'grok',  'btc'));
  // Should not match a different name
  assert.ok(!matches('@nasa.sats', '@grok.btc', '@grok', 'btc'));
});

test('UniSat live-listing find is @-tolerant (profile listing-status fix)', () => {
  function find(list, name) {
    const nameLower    = name.toLowerCase();
    const nameLowerNoAt = nameLower.replace(/^@/, '');
    return list.find(l => {
      const d = (l.domain || '').toLowerCase();
      return d === nameLower || d.replace(/^@/, '') === nameLowerNoAt;
    }) || null;
  }
  const listing = { domain: '@grok.btc', price: 100 };
  // exact
  assert.strictEqual(find([listing], '@grok.btc'), listing);
  // user typed without @, UniSat has @
  assert.strictEqual(find([listing], 'grok.btc'),  listing);
  // user typed with @, UniSat dropped it
  const listing2 = { domain: 'grok.btc', price: 100 };
  assert.strictEqual(find([listing2], '@grok.btc'), listing2);
  // mismatch
  assert.strictEqual(find([listing], '@nasa.sats'), null);
});

// ── Source-parity guards (catch silent regressions in app.src.js) ────────────

test('source-parity: search regex in app.src.js allows @', () => {
  assert.ok(/q\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9@\]\/g, ''\)/.test(SRC),
    'expected runSearch to use [^a-z0-9@] (allow leading @)');
});

test('source-parity: bulk parser regex in app.src.js allows leading @', () => {
  assert.ok(/\^@\?\[a-z0-9\]\[a-z0-9-\]\*\$/.test(SRC),
    'expected parseBulkInput to use ^@?[a-z0-9][a-z0-9-]*$ (allow leading @)');
});

test('source-parity: fetchAndRenderSaleHistory uses @-stripped comparison vars', () => {
  assert.ok(/fullNameNoAt/.test(SRC), 'expected fullNameNoAt in fetchAndRenderSaleHistory');
  assert.ok(/baseNoAt/.test(SRC),     'expected baseNoAt in fetchAndRenderSaleHistory');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + (fail === 0 ? 'PASS ' : 'FAIL ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
