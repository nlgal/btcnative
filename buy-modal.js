/**
 * btcnative Buy Modal v2.0
 * Own-PSBT buyer flow — fully independent of UniSat settlement.
 *
 * Flow:
 *   1. GET  /api/psbt/listing   — fetch seller's signed SIGHASH_SINGLE|ANYONECANPAY PSBT
 *   2. wallet.getBitcoinUtxos() — get buyer's available UTXOs
 *   3. Build combined PSBT:
 *        input[0]  = inscription UTXO (already signed by seller in stored PSBT)
 *        input[1+] = buyer funding UTXOs (buyer signs SIGHASH_ALL)
 *        output[0] = seller address, priceSats (from seller PSBT)
 *        output[1] = buyer address, inscriptionDust (546 sats — inscription delivery)
 *        output[2] = fee address, feeSats (1% platform fee)
 *        output[3] = buyer change address, changeSats
 *   4. wallet.signPsbt — buyer signs their inputs (SIGHASH_ALL)
 *   5. POST /api/psbt/broadcast — finalize + broadcast to mempool.space
 *
 * SIGHASH_SINGLE|ANYONECANPAY means seller's signature commits to:
 *   - Their inscription input
 *   - output[0] (their payment)
 * ...and nothing else. So buyer can freely add inputs + outputs.
 *
 * Buyer's SIGHASH_ALL commits to the entire transaction including fee output,
 * so the fee cannot be stripped without invalidating the buyer's signature.
 */

const UNISAT_BASE_BM = 'https://open-api.unisat.io';
const UNISAT_KEY_BM  = 'd6082c62b212e154fb506f50957506bfefea2df898e02f7670a83791dd42a870';
const MARKET_API_BM  = 'https://btcnative-market.galanin.workers.dev';

const INSCRIPTION_DUST = 546; // sats for inscription delivery output
const FEE_RATE_FALLBACK = 6;  // sat/vbyte fallback

// ── Formatting ────────────────────────────────────────────────────────────────
let _bmBtcUsd = null;
async function _bmGetBtcUsd() {
  if (_bmBtcUsd) return _bmBtcUsd;
  try {
    const r = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(4000) });
    _bmBtcUsd = (await r.json()).USD || 95000;
  } catch { _bmBtcUsd = 95000; }
  return _bmBtcUsd;
}
function _bmFmtUsd(sats, rate) {
  if (!sats || !rate) return '';
  const usd = (sats / 1e8) * rate;
  return '$' + (usd >= 1000 ? Math.round(usd).toLocaleString() : usd.toFixed(2));
}
function _bmFmtBtc(sats) {
  if (!sats || isNaN(sats)) return '—';
  const btc = sats / 1e8;
  if (btc >= 1)    return btc.toFixed(4).replace(/\.?0+$/, '') + ' BTC';
  if (btc >= 0.01) return btc.toFixed(4).replace(/0+$/, '') + ' BTC';
  return btc.toFixed(8).replace(/0+$/, '') + ' BTC';
}

// ── Bitcoin helpers ───────────────────────────────────────────────────────────

function _bmHexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function _bmBytesToHex(b) {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function _bmBytesToB64(b) {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function _bmB64ToBytes(b64) {
  const bin = atob(b64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

function _bmConcat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function _bmWriteVarint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; }
  if (n <= 0xffffffff) { const b = new Uint8Array(5); b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true); return b; }
  throw new Error('varint overflow');
}

function _bmReadVarint(view, offset) {
  const first = view.getUint8(offset);
  if (first < 0xfd) return { value: first, length: 1 };
  if (first === 0xfd) return { value: view.getUint16(offset + 1, true), length: 3 };
  if (first === 0xfe) return { value: view.getUint32(offset + 2, true), length: 5 };
  const lo = view.getUint32(offset + 1, true);
  const hi = view.getUint32(offset + 5, true);
  return { value: lo + hi * 0x100000000, length: 9 };
}

function _bmUint64LE(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  new DataView(b.buffer).setUint32(4, Math.floor(n / 0x100000000) >>> 0, true);
  return b;
}

function _bmUint32LE(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function _bmBech32mDecode(addr) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const lower = addr.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) throw new Error('Invalid bech32m address: ' + addr);
  const data = [];
  for (let i = sep + 1; i < lower.length; i++) {
    const idx = CHARSET.indexOf(lower[i]);
    if (idx < 0) throw new Error('Invalid bech32m char in: ' + addr);
    data.push(idx);
  }
  const witnessProgram5bit = data.slice(1, data.length - 6);
  const bytes = [];
  let acc = 0, bits = 0;
  for (const val of witnessProgram5bit) {
    acc = (acc << 5) | val;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(bytes);
}

function _bmP2trScript(addr) {
  const prog = _bmBech32mDecode(addr);
  if (prog.length !== 32) throw new Error('Not a P2TR address: ' + addr);
  const s = new Uint8Array(34);
  s[0] = 0x51; s[1] = 0x20;
  s.set(prog, 2);
  return s;
}

// ── Fee rate ──────────────────────────────────────────────────────────────────

async function _bmGetFeeRate() {
  try {
    const r = await fetch('https://mempool.space/api/v1/fees/recommended', { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    return d.fastestFee || d.halfHourFee || FEE_RATE_FALLBACK;
  } catch {
    return FEE_RATE_FALLBACK;
  }
}

// ── Wallet ────────────────────────────────────────────────────────────────────
function _bmDetectWallet() {
  if (window.unisat) return { type: 'unisat', api: window.unisat };
  if (window.XverseProviders?.BitcoinProvider) return { type: 'xverse', api: window.XverseProviders.BitcoinProvider };
  if (window.btc) return { type: 'xverse', api: window.btc };
  return null;
}

async function _bmGetAddress(wallet) {
  if (wallet.type === 'unisat') {
    const accs = await wallet.api.requestAccounts();
    return accs[0];
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('getAccounts', { purposes: ['ordinals', 'payment'] });
    wallet._paymentAddress = res.result.find(a => a.purpose === 'payment')?.address || res.result[0].address;
    return res.result.find(a => a.purpose === 'payment')?.address || res.result[0].address;
  }
  throw new Error('Unsupported wallet');
}

async function _bmGetPubkey(wallet, address) {
  if (wallet.type === 'unisat') {
    const compressed = await wallet.api.getPublicKey();
    if (compressed && compressed.length === 66) return compressed.slice(2);
    return compressed;
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('getAccounts', { purposes: ['payment'] });
    const pk = res.result[0].publicKey;
    if (pk && pk.length === 66) return pk.slice(2);
    return pk;
  }
  throw new Error('Unsupported wallet');
}

/**
 * Get buyer's UTXOs.
 * UniSat provides getBitcoinUtxos() which returns confirmed + unconfirmed UTXOs.
 * Xverse requires fetching from mempool.space.
 */
async function _bmGetUtxos(wallet, address) {
  if (wallet.type === 'unisat') {
    try {
      const utxos = await wallet.api.getBitcoinUtxos();
      // UniSat returns [{ txid, vout, satoshis }]
      if (utxos && utxos.length > 0) {
        return utxos.map(u => ({
          txid:  u.txid,
          vout:  u.vout,
          value: u.satoshis || u.value || u.amount,
        }));
      }
    } catch (_) { /* fall through to mempool */ }
  }
  // Fallback: mempool.space
  const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}/utxo`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Could not fetch UTXOs — try again');
  const utxos = await res.json();
  // Filter to confirmed UTXOs only for safety
  return utxos.filter(u => u.status?.confirmed).map(u => ({
    txid:  u.txid,
    vout:  u.vout,
    value: u.value,
  }));
}

// ── PSBT construction ─────────────────────────────────────────────────────────

/**
 * Parse the seller's SIGHASH_SINGLE|ANYONECANPAY PSBT and extract:
 * - The inscription input (txid, vout, value, scriptPubKey)
 * - The seller payment output (address/script, value)
 * - The raw bytes of the partial signature for input 0
 *
 * Then build a new combined PSBT with buyer inputs/outputs appended.
 *
 * Returns { psbtB64, buyerInputIndexes } for wallet signing.
 */
function _bmBuildCombinedPsbt({
  sellerPsbtHex,
  inscriptionUtxo,   // { txid, vout, value }
  sellerAddress,
  priceSats,
  buyerUtxos,        // array of { txid, vout, value } — funding inputs
  buyerAddress,      // inscription delivery
  feeAddress,
  feeSats,
  feeRate,
}) {
  // ── Parse seller PSBT ───────────────────────────────────────────────────────
  // We need to extract the partial sig from the seller's signed PSBT.
  const sellerPsbt = _bmHexToBytes(sellerPsbtHex);
  const sellerView = new DataView(sellerPsbt.buffer, sellerPsbt.byteOffset);

  // Validate magic
  if (sellerView.getUint32(0) !== 0x70736274 || sellerPsbt[4] !== 0xff) {
    throw new Error('Invalid seller PSBT format');
  }

  // Find global map end (skip unsigned tx)
  let off = 5;
  let sellerUnsignedTx = null;
  while (off < sellerPsbt.length) {
    const keyLen = sellerPsbt[off];
    if (keyLen === 0x00) { off++; break; }
    const keyType = sellerPsbt[off + 1];
    off += 1 + keyLen;
    const { value: valLen, length: valLenSize } = _bmReadVarint(sellerView, off);
    off += valLenSize;
    if (keyType === 0x00 && keyLen === 1) {
      sellerUnsignedTx = sellerPsbt.slice(off, off + valLen);
    }
    off += valLen;
  }
  if (!sellerUnsignedTx) throw new Error('Could not parse seller PSBT unsigned tx');

  // Parse input 0 map from seller PSBT — find partial_sig (key type 0x02)
  // and witness_utxo (key type 0x01)
  let partialSig = null;
  let sigPubkey  = null;
  while (off < sellerPsbt.length) {
    const keyLen = sellerPsbt[off];
    if (keyLen === 0x00) { off++; break; }
    const keyType = sellerPsbt[off + 1];
    const fullKey = sellerPsbt.slice(off + 1, off + 1 + keyLen);
    off += 1 + keyLen;
    const { value: valLen, length: valLenSize } = _bmReadVarint(sellerView, off);
    const valData = sellerPsbt.slice(off + valLenSize, off + valLenSize + valLen);
    off += valLenSize + valLen;

    if (keyType === 0x13 && keyLen === 1) {
      // PSBT_IN_TAP_KEY_SIG (0x13): Taproot key-path Schnorr signature (64 or 65 bytes)
      partialSig = valData;
      sigPubkey  = null; // not used for tap_key_sig — key is just [0x13]
    } else if (keyType === 0x02 && keyLen >= 1) {
      // Legacy partial_sig fallback (non-taproot)
      sigPubkey  = fullKey.slice(1);
      partialSig = valData;
    }
  }

  if (!partialSig) throw new Error('Seller PSBT does not contain a partial signature. Was it signed?');

  // ── Build combined PSBT ─────────────────────────────────────────────────────
  // Calculate transaction weight for fee estimation
  // P2TR input: 41 bytes (outpoint+seq) + 65 bytes witness = ~106 vbytes
  // P2TR output: 43 bytes each
  // We estimate: 10 overhead + 68 * numInputs + 43 * numOutputs (vbytes)
  const numInputs  = 1 + buyerUtxos.length;  // seller + buyer funding
  const numOutputs = 4;                       // seller + buyer + fee + change
  const estVbytes  = 10 + 68 * numInputs + 43 * numOutputs;
  const networkFee = Math.ceil(estVbytes * feeRate);

  // Select UTXOs: need priceSats + feeSats + INSCRIPTION_DUST + networkFee
  const totalNeeded = priceSats + feeSats + INSCRIPTION_DUST + networkFee;
  let selectedUtxos = [];
  let selectedTotal = 0;
  // Sort by value descending for efficient selection
  const sortedUtxos = [...buyerUtxos].sort((a, b) => b.value - a.value);
  for (const u of sortedUtxos) {
    // Skip the inscription UTXO if it appears in buyer's list
    if (u.txid === inscriptionUtxo.txid && u.vout === inscriptionUtxo.vout) continue;
    selectedUtxos.push(u);
    selectedTotal += u.value;
    if (selectedTotal >= totalNeeded) break;
  }

  if (selectedTotal < totalNeeded) {
    const shortfall = totalNeeded - selectedTotal;
    throw new Error(
      `Insufficient balance. Need ${_bmFmtBtc(totalNeeded)} total ` +
      `(${_bmFmtBtc(priceSats)} price + ${_bmFmtBtc(feeSats)} fee + network fees), ` +
      `but wallet only has ${_bmFmtBtc(selectedTotal)} in confirmed UTXOs. ` +
      `Short by ${_bmFmtBtc(shortfall)}.`
    );
  }

  const changeSats = selectedTotal - priceSats - feeSats - INSCRIPTION_DUST - networkFee;

  // ── Build unsigned tx ───────────────────────────────────────────────────────
  const inscTxid = _bmHexToBytes(inscriptionUtxo.txid).reverse();
  const seqRBF = new Uint8Array([0xff, 0xff, 0xff, 0xfd]);

  // inputs
  const sellerInput = _bmConcat(inscTxid, _bmUint32LE(inscriptionUtxo.vout), new Uint8Array([0x00]), seqRBF);
  const buyerInputs = selectedUtxos.map(u =>
    _bmConcat(_bmHexToBytes(u.txid).reverse(), _bmUint32LE(u.vout), new Uint8Array([0x00]), seqRBF)
  );
  const allInputBytes = _bmConcat(sellerInput, ...(buyerInputs.length ? buyerInputs : []));

  // outputs
  const sellerScript = _bmP2trScript(sellerAddress);
  const buyerScript  = _bmP2trScript(buyerAddress);
  const feeScript    = _bmP2trScript(feeAddress);

  const sellerOut = _bmConcat(_bmUint64LE(priceSats), _bmWriteVarint(sellerScript.length), sellerScript);
  const buyerOut  = _bmConcat(_bmUint64LE(INSCRIPTION_DUST), _bmWriteVarint(buyerScript.length), buyerScript);
  const feeOut    = _bmConcat(_bmUint64LE(feeSats), _bmWriteVarint(feeScript.length), feeScript);

  let changeOut = new Uint8Array(0);
  let outputCount = 3;
  if (changeSats > 546) {
    outputCount = 4;
    const changeScript = _bmP2trScript(buyerAddress);
    changeOut = _bmConcat(_bmUint64LE(changeSats), _bmWriteVarint(changeScript.length), changeScript);
  }

  const unsignedTx = _bmConcat(
    new Uint8Array([0x02, 0x00, 0x00, 0x00]),                 // version 2
    _bmWriteVarint(numInputs),
    allInputBytes,
    _bmWriteVarint(outputCount),
    sellerOut, buyerOut, feeOut,
    ...(changeSats > 546 ? [changeOut] : []),
    new Uint8Array([0x00, 0x00, 0x00, 0x00])                  // locktime 0
  );

  // ── Build PSBT ───────────────────────────────────────────────────────────────
  // Global map: magic + unsigned tx
  const txLenVarint = _bmWriteVarint(unsignedTx.length);
  const globalMap = _bmConcat(
    new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),
    new Uint8Array([0x01, 0x00]),                              // key type 0x00 = unsigned tx
    txLenVarint, unsignedTx,
    new Uint8Array([0x00])                                     // end global map
  );

  // Input 0 map: seller's inscription UTXO
  // witness_utxo (0x01) + tap_key_sig (0x13) or legacy partial_sig (0x02 + pubkey)
  const inscValue     = _bmUint64LE(inscriptionUtxo.value);
  const inscScript    = _bmP2trScript(sellerAddress);
  const witnessUtxo0  = _bmConcat(inscValue, _bmWriteVarint(inscScript.length), inscScript);

  // Build the signature entry for input 0.
  // If sigPubkey is null it was a Taproot key-path sig (PSBT_IN_TAP_KEY_SIG, key 0x13).
  // Otherwise it's a legacy partial_sig (key 0x02 + pubkey).
  let sigKeyBytes, sigValBytes;
  if (sigPubkey === null) {
    // Taproot: key = [0x13] (1 byte, no pubkey appended)
    sigKeyBytes = new Uint8Array([0x13]);
    sigValBytes = partialSig;
  } else {
    // Legacy: key = [0x02, ...pubkey]
    sigKeyBytes = _bmConcat(new Uint8Array([0x02]), sigPubkey);
    sigValBytes = partialSig;
  }

  const input0Map = _bmConcat(
    new Uint8Array([0x01, 0x01]), _bmWriteVarint(witnessUtxo0.length), witnessUtxo0,
    _bmWriteVarint(sigKeyBytes.length), sigKeyBytes,
    _bmWriteVarint(sigValBytes.length), sigValBytes,
    new Uint8Array([0x00])                                     // end input 0 map
  );

  // Input 1..N maps: buyer funding UTXOs (witness_utxo for each)
  const buyerInputMaps = selectedUtxos.map(u => {
    const utxoVal    = _bmUint64LE(u.value);
    const utxoScript = _bmP2trScript(buyerAddress);
    const witnessUtxo = _bmConcat(utxoVal, _bmWriteVarint(utxoScript.length), utxoScript);
    return _bmConcat(
      new Uint8Array([0x01, 0x01]), _bmWriteVarint(witnessUtxo.length), witnessUtxo,
      new Uint8Array([0x00])
    );
  });

  // Output maps: all empty
  const outputMaps = new Uint8Array(outputCount).fill(0x00); // N empty maps

  const combinedPsbt = _bmConcat(
    globalMap,
    input0Map,
    ...(buyerInputMaps.length ? buyerInputMaps : []),
    outputMaps
  );

  const psbtB64 = _bmBytesToB64(combinedPsbt);

  // Buyer must sign inputs 1..N (the funding inputs they added)
  const buyerInputIndexes = selectedUtxos.map((_, i) => i + 1);

  return {
    psbtB64,
    psbtHex: _bmBytesToHex(combinedPsbt),
    buyerInputIndexes,
    networkFee,
    changeSats: changeSats > 546 ? changeSats : 0,
  };
}

// ── Sign ──────────────────────────────────────────────────────────────────────

async function _bmSignPsbt(wallet, psbtB64, signIndexes, buyerAddress, buyerPubkey) {
  if (wallet.type === 'unisat') {
    const toSignInputs = signIndexes.map(i => ({
      index: i,
      address: buyerAddress,
      ...(buyerPubkey ? { publicKey: buyerPubkey } : {}),
      disableToSignCheck: true,
    }));
    return wallet.api.signPsbt(psbtB64, { autoFinalized: true, toSignInputs });
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('signPsbt', {
      psbt: psbtB64,
      broadcast: false,
      signInputs: Object.fromEntries(signIndexes.map(i => [String(i), ['SIGHASH_DEFAULT']])),
    });
    return res.result.psbt;
  }
  throw new Error('Unsupported wallet');
}

// ── Modal styles ──────────────────────────────────────────────────────────────
function _bmInjectStyles() {
  if (document.getElementById('bn-buy-modal-styles')) return;
  const s = document.createElement('style');
  s.id = 'bn-buy-modal-styles';
  s.textContent = `
    .bn-modal-backdrop {
      position:fixed;inset:0;z-index:9000;
      background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);
      display:flex;align-items:center;justify-content:center;padding:16px;
    }
    .bn-modal {
      background:var(--color-surface,#fff);
      border:1px solid var(--color-border,#e5e7eb);
      border-radius:16px;padding:28px 28px 24px;
      width:100%;max-width:400px;
      box-shadow:0 24px 48px rgba(0,0,0,0.18);position:relative;
    }
    [data-theme="dark"] .bn-modal{background:#141414;border-color:#2a2a2a;}
    .bn-modal__close{
      position:absolute;top:16px;right:16px;
      background:none;border:none;cursor:pointer;
      color:var(--color-text-muted,#888);font-size:20px;line-height:1;
      padding:4px 6px;border-radius:6px;
    }
    .bn-modal__close:hover{background:var(--color-surface-offset,#f3f4f6);}
    .bn-modal__title{
      font-family:var(--font-mono,monospace);font-size:1.1rem;font-weight:700;
      margin:0 0 20px;color:var(--color-text,#111);
    }
    .bn-modal__row{
      display:flex;justify-content:space-between;align-items:center;
      padding:10px 0;border-bottom:1px solid var(--color-border,#e5e7eb);
      font-size:0.875rem;
    }
    .bn-modal__label{color:var(--color-text-muted,#888);}
    .bn-modal__value{font-weight:600;font-family:var(--font-mono,monospace);}
    .bn-modal__value--accent{color:#f7931a;}
    .bn-modal__value--faint{color:var(--color-text-faint,#aaa);font-weight:400;}
    .bn-modal__total{
      margin-top:16px;padding:14px;
      background:var(--color-surface-offset,#f9fafb);border-radius:10px;
      display:flex;justify-content:space-between;align-items:center;
    }
    [data-theme="dark"] .bn-modal__total{background:#1e1e1e;}
    .bn-modal__total-label{font-size:0.8rem;color:var(--color-text-muted,#888);text-transform:uppercase;letter-spacing:0.05em;}
    .bn-modal__total-value{font-size:1.1rem;font-weight:700;font-family:var(--font-mono,monospace);}
    .bn-modal__usd{text-align:right;font-size:0.78rem;color:var(--color-text-muted,#888);margin-top:4px;}
    .bn-modal__cta{
      width:100%;margin-top:16px;padding:14px;border:none;border-radius:10px;
      background:#f7931a;color:#000;font-weight:700;font-size:0.95rem;cursor:pointer;
      transition:opacity .15s;
    }
    .bn-modal__cta:hover{opacity:.88;}
    .bn-modal__cta:disabled{opacity:.5;cursor:not-allowed;}
    .bn-modal__status{
      margin-top:12px;padding:10px 14px;border-radius:8px;font-size:0.82rem;display:none;line-height:1.5;
    }
    .bn-modal__status.info{display:block;background:color-mix(in srgb,#3b82f6 12%,transparent);color:#1d4ed8;}
    .bn-modal__status.success{display:block;background:color-mix(in srgb,#22c55e 12%,transparent);color:#15803d;}
    .bn-modal__status.error{display:block;background:color-mix(in srgb,#ef4444 12%,transparent);color:#b91c1c;}
    [data-theme="dark"] .bn-modal__status.info{background:#0a2030;color:#60a5fa;}
    [data-theme="dark"] .bn-modal__status.success{background:#0a2016;color:#4ade80;}
    [data-theme="dark"] .bn-modal__status.error{background:#2a0a08;color:#f87171;}
    .bn-modal__wallet-note{margin-top:10px;font-size:0.78rem;color:var(--color-text-faint,#aaa);text-align:center;}
    .bn-modal__txid{font-family:var(--font-mono,monospace);font-size:0.75rem;word-break:break-all;margin-top:6px;}
    .bn-modal__txid a{color:#f7931a;}
    .bn-modal__step{font-size:0.72rem;color:var(--color-text-faint,#aaa);text-align:center;margin-top:8px;}
  `;
  document.head.appendChild(s);
}

function _bmSetStatus(el, type, html) {
  el.className = `bn-modal__status ${type}`;
  el.innerHTML = html;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function openBuyModal({ name, priceSats: _priceSats }) {
  _bmInjectStyles();

  // Fetch listing from our worker (includes PSBT + inscription UTXO)
  let listing = null;
  try {
    const res = await fetch(`${MARKET_API_BM}/api/psbt/listing?name=${encodeURIComponent(name)}`);
    listing = await res.json();
  } catch (_) {}

  if (!listing || !listing.listed) {
    const msg = listing?.invalidReInscription
      ? `Cannot buy ${name}: re-inscription detected. Only the first inscription is valid.`
      : `${name} is not currently listed for sale.`;
    alert(msg);
    return;
  }

  if (listing.invalidReInscription) {
    alert(`Cannot buy ${name}: this is a re-inscription. Only the first inscription is valid.`);
    return;
  }

  const { priceSats, feeSats, feeAddress, sellerAddress, inscriptionId, inscriptionUtxo, psbtHex } = listing;
  const sellerPsbtHex = psbtHex;

  if (!sellerPsbtHex) {
    alert('Listing data is incomplete. Try again or contact support.');
    return;
  }

  // Build modal
  const backdrop = document.createElement('div');
  backdrop.className = 'bn-modal-backdrop';
  backdrop.innerHTML = `
    <div class="bn-modal" role="dialog" aria-modal="true" aria-label="Buy ${name}">
      <button class="bn-modal__close" aria-label="Close">&times;</button>
      <div class="bn-modal__title">Buy ${name}</div>
      <div class="bn-modal__row">
        <span class="bn-modal__label">Listing price</span>
        <span class="bn-modal__value">${_bmFmtBtc(priceSats)}</span>
      </div>
      <div class="bn-modal__row">
        <span class="bn-modal__label">Platform fee (1%)</span>
        <span class="bn-modal__value">${_bmFmtBtc(feeSats)}</span>
      </div>
      <div class="bn-modal__row">
        <span class="bn-modal__label">Network fee</span>
        <span class="bn-modal__value bn-modal__value--faint" id="bnNetworkFee">calculated at signing</span>
      </div>
      <div class="bn-modal__total">
        <span class="bn-modal__total-label">You pay (est.)</span>
        <span class="bn-modal__total-value bn-modal__value--accent" id="bnTotalVal">${_bmFmtBtc(priceSats + feeSats)}</span>
      </div>
      <div class="bn-modal__usd" id="bnModalUsd"></div>
      <button class="bn-modal__cta" id="bnBuyBtn">Connect wallet &amp; buy</button>
      <div class="bn-modal__status" id="bnBuyStatus"></div>
      <p class="bn-modal__wallet-note">UniSat or Xverse required. Your wallet signs directly — no keys leave your device.</p>
      <p class="bn-modal__step" id="bnStep"></p>
    </div>
  `;
  document.body.appendChild(backdrop);

  _bmGetBtcUsd().then(rate => {
    const el = document.getElementById('bnModalUsd');
    if (el) el.textContent = 'approx. ' + _bmFmtUsd(priceSats + feeSats, rate);
  });

  const btn    = backdrop.querySelector('#bnBuyBtn');
  const status = backdrop.querySelector('#bnBuyStatus');
  const stepEl = backdrop.querySelector('#bnStep');

  backdrop.querySelector('.bn-modal__close').onclick = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });

  btn.addEventListener('click', async () => {
    btn.disabled = true;

    try {
      // ── Step 1: Detect + connect wallet ──────────────────────────────────
      _bmSetStatus(status, 'info', 'Detecting wallet...');
      stepEl.textContent = 'Step 1 of 4';
      const wallet = _bmDetectWallet();
      if (!wallet) {
        _bmSetStatus(status, 'error', 'No wallet detected. Install <a href="https://unisat.io/download" target="_blank" rel="noopener">UniSat</a> and refresh.');
        btn.disabled = false;
        return;
      }

      btn.textContent = 'Connecting...';
      _bmSetStatus(status, 'info', `Connecting ${wallet.type === 'unisat' ? 'UniSat' : 'Xverse'}...`);
      const buyerAddress = await _bmGetAddress(wallet);
      wallet._address = buyerAddress;

      // Self-purchase guard
      if (sellerAddress && buyerAddress.toLowerCase() === sellerAddress.toLowerCase()) {
        _bmSetStatus(status, 'error', 'You own this listing. Connect a different wallet to buy it.');
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }

      // Taproot address required for Ordinals
      if (!buyerAddress.startsWith('bc1p')) {
        _bmSetStatus(status, 'error',
          'Your wallet is set to a non-Taproot address type (<code>' + buyerAddress.slice(0, 10) + '...</code>).<br><br>' +
          'To buy Ordinals, switch to <strong>Taproot</strong>: open UniSat, tap your address, select <strong>Taproot</strong>.');
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }

      const buyerPubkey = await _bmGetPubkey(wallet, buyerAddress);

      // ── Step 2: Fetch UTXOs ───────────────────────────────────────────────
      btn.textContent = 'Loading UTXOs...';
      _bmSetStatus(status, 'info', 'Fetching your UTXOs...');
      stepEl.textContent = 'Step 2 of 4';
      const buyerUtxos = await _bmGetUtxos(wallet, buyerAddress);
      if (!buyerUtxos.length) {
        _bmSetStatus(status, 'error', 'No confirmed UTXOs found in your wallet. Make sure you have BTC and try again.');
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }

      // ── Step 3: Build combined PSBT ───────────────────────────────────────
      btn.textContent = 'Building transaction...';
      _bmSetStatus(status, 'info', 'Building transaction...');
      stepEl.textContent = 'Step 3 of 4';

      const feeRate = await _bmGetFeeRate();

      let psbtData;
      try {
        psbtData = _bmBuildCombinedPsbt({
          sellerPsbtHex,
          inscriptionUtxo,
          sellerAddress,
          priceSats,
          buyerUtxos,
          buyerAddress,
          feeAddress,
          feeSats,
          feeRate,
        });
      } catch (buildErr) {
        _bmSetStatus(status, 'error', buildErr.message);
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }

      const { psbtB64, buyerInputIndexes, networkFee } = psbtData;

      // Update fee display
      if (networkFee) {
        const netFeeEl = document.getElementById('bnNetworkFee');
        const totalEl  = document.getElementById('bnTotalVal');
        const usdEl    = document.getElementById('bnModalUsd');
        if (netFeeEl) netFeeEl.textContent = _bmFmtBtc(networkFee);
        const total = priceSats + feeSats + networkFee;
        if (totalEl) totalEl.textContent = _bmFmtBtc(total);
        _bmGetBtcUsd().then(rate => {
          if (usdEl) usdEl.textContent = 'approx. ' + _bmFmtUsd(total, rate);
        });
      }

      // ── Step 4: Buyer signs their inputs ─────────────────────────────────
      btn.textContent = 'Sign in wallet...';
      _bmSetStatus(status, 'info', 'Check your wallet — a signature request is waiting.');
      stepEl.textContent = 'Step 4 of 4';

      const signedPsbtB64 = await _bmSignPsbt(wallet, psbtB64, buyerInputIndexes, buyerAddress, buyerPubkey);

      // ── Broadcast ─────────────────────────────────────────────────────────
      btn.textContent = 'Broadcasting...';
      _bmSetStatus(status, 'info', 'Broadcasting to Bitcoin network...');
      stepEl.textContent = '';

      // Convert signed PSBT to raw tx hex for mempool.space broadcast
      // When autoFinalized: true, UniSat returns a complete signed PSBT that
      // we can extract the raw tx from. We send psbt hex to our worker
      // which finalizes and broadcasts.
      const broadcastRes = await fetch(`${MARKET_API_BM}/api/psbt/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Pass the raw signed PSBT — worker will finalize and extract tx hex
          txHex: signedPsbtB64,
          name,
          isPsbt: true,
        }),
      });
      const broadcastData = await broadcastRes.json();

      if (!broadcastData.ok) {
        throw new Error(broadcastData.error || 'Broadcast failed');
      }

      const txid = broadcastData.txid || '';
      _bmSetStatus(status, 'success',
        `Purchase complete. ${name} is now yours.` +
        (txid ? `<div class="bn-modal__txid"><a href="https://mempool.space/tx/${txid}" target="_blank" rel="noopener">${txid}</a></div>` : '')
      );
      btn.textContent = 'Done';
      btn.style.background = '#22c55e';
      btn.style.color = '#fff';

    } catch (e) {
      const msg = e.message || String(e);
      stepEl.textContent = '';
      if (/user reject|user cancel|user denied|user dismissed/i.test(msg)) {
        _bmSetStatus(status, 'info', 'Signature cancelled.');
      } else {
        _bmSetStatus(status, 'error', msg);
      }
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  });
}

if (typeof window !== 'undefined') window.openBuyModal = openBuyModal;
export { openBuyModal };
