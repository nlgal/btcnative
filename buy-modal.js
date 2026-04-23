/**
 * btcnative Buy Modal
 * Self-custodied PSBT buy flow with 1% platform fee.
 *
 * Flow:
 *   1. GET  /api/listing        — validate listing + canonical inscription check
 *   2. POST create_bid_prepare  — confirm auction still live, get fee rate
 *   3. POST create_bid          — UniSat builds the combined PSBT (unsigned by buyer)
 *   4. POST /api/psbt/prepare   — worker injects 1% fee output into the PSBT
 *   5. wallet.signPsbt          — buyer signs their inputs on the fee-injected PSBT
 *   6. POST confirm_bid         — UniSat broadcasts; sale settles on-chain
 *
 * The fee output is injected BEFORE the buyer signs, so their SIGHASH_ALL
 * covers all outputs including the platform fee. The seller's SIGHASH_SINGLE
 * is unaffected (it commits input 0 → output 0 only).
 *
 * Usage:
 *   openBuyModal({ name: 'trump.btc', auctionId: '...', priceSats: 500000 });
 */

const UNISAT_BASE_BM = 'https://open-api.unisat.io';
const UNISAT_KEY_BM  = 'd6082c62b212e154fb506f50957506bfefea2df898e02f7670a83791dd42a870';
const MARKET_API_BM  = 'https://btcnative-market.galanin.workers.dev';

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
    return res.result.find(a => a.purpose === 'ordinals')?.address || res.result[0].address;
  }
  throw new Error('Unsupported wallet');
}

async function _bmGetPubkey(wallet) {
  if (wallet.type === 'unisat') {
    // UniSat returns compressed pubkey (02/03 + 32 bytes = 66 hex chars).
    // For taproot (bc1p) addresses, x-only pubkey (32 bytes = 64 hex chars) is needed.
    const compressed = await wallet.api.getPublicKey();
    if (compressed && compressed.length === 66) return compressed.slice(2);
    return compressed;
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('getAccounts', { purposes: ['ordinals'] });
    const pk = res.result[0].publicKey;
    if (pk && pk.length === 66) return pk.slice(2);
    return pk;
  }
  throw new Error('Unsupported wallet');
}

async function _bmSignPsbt(wallet, psbtHex, signIndexes, pubkey) {
  if (wallet.type === 'unisat') {
    const toSignInputs = (signIndexes && signIndexes.length > 0)
      ? signIndexes.map(i => ({ index: i, publicKey: pubkey }))
      : [{ index: 0, publicKey: pubkey }];
    const signed = await wallet.api.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs,
    });
    return signed; // hex
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('signPsbt', {
      psbt: psbtHex,
      broadcast: false,
      signInputs: Object.fromEntries(
        (signIndexes || [0]).map(i => [String(i), ['SIGHASH_DEFAULT']])
      ),
    });
    return res.result.psbt; // hex
  }
  throw new Error('Unsupported wallet');
}

// ── UniSat API ────────────────────────────────────────────────────────────────
async function _bmUnisat(path, body) {
  const res = await fetch(`${UNISAT_BASE_BM}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${UNISAT_KEY_BM}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (data.code !== 0) {
    const msg = data.msg || 'Unknown error';
    if (msg.toLowerCase().includes('order not exist') || msg.toLowerCase().includes('not exist')) {
      throw new Error('This listing is no longer active. It may have been sold or delisted.');
    }
    if (msg.toLowerCase().includes('receive address') || msg.toLowerCase().includes('bind first') || msg.toLowerCase().includes('need to bind')) {
      throw new Error('Your wallet is using a non-Taproot address. In UniSat, tap your address at the top of the extension and switch to Taproot (bc1p).');
    }
    if (msg.toLowerCase().includes('public key') || msg.toLowerCase().includes('pubkey')) {
      throw new Error('Wallet address mismatch. Make sure your wallet is unlocked and on the correct account.');
    }
    if (msg.toLowerCase().includes('balance') || msg.toLowerCase().includes('insufficient')) {
      throw new Error('Insufficient balance. You need more BTC to complete this purchase.');
    }
    throw new Error(msg);
  }
  return data.data;
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
async function openBuyModal({ name, auctionId, priceSats }) {
  _bmInjectStyles();

  // Single call: resolve listing + validate canonical inscription
  try {
    const res = await fetch(`${MARKET_API_BM}/api/listing?name=${encodeURIComponent(name)}`);
    const data = await res.json();

    if (data.invalidReInscription) {
      const c = data.canonicalInscriptionId || '';
      alert(`Cannot buy ${name}: this listing is a re-inscription.\n\nOnly the first inscription (${c.slice(0,14)}...) is the valid BNS name.`);
      return;
    }
    if (data.ok && data.listed) {
      auctionId = data.auctionId;
      priceSats = data.priceSats;
    } else if (!auctionId || !priceSats) {
      alert(`${name} is not currently listed for sale.`);
      return;
    }
  } catch (_) {
    if (!auctionId || !priceSats) {
      alert('Could not verify listing. Please try again.');
      return;
    }
  }

  // Fee preview (1% of price, min 1000 sats)
  const feeSats = Math.max(Math.round(priceSats * 0.01), 1000);

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
        <span class="bn-modal__value bn-modal__value--faint" id="bnNetworkFee">estimated at signing</span>
      </div>
      <div class="bn-modal__total">
        <span class="bn-modal__total-label">You pay</span>
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
    if (el) el.textContent = '≈ ' + _bmFmtUsd(priceSats + feeSats, rate);
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
      stepEl.textContent = 'Step 1 of 5';
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

      // UniSat requires a Taproot (bc1p) address to buy Ordinals.
      // If the wallet is set to Native Segwit (bc1q) or Legacy, buying will fail.
      if (wallet.type === 'unisat' && !buyerAddress.startsWith('bc1p')) {
        _bmSetStatus(status, 'error',
          'Your UniSat wallet is set to a non-Taproot address type (<code>' + buyerAddress.slice(0,10) + '...</code>).<br><br>' +
          'To buy Ordinals, switch to <strong>Taproot</strong> in UniSat: open the extension, tap your address at the top, select <strong>Taproot</strong>.');
        btn.disabled = false;
        btn.textContent = 'Try again';
        return;
      }

      const buyerPubkey = await _bmGetPubkey(wallet);

      // ── Step 2: Prepare bid (confirm auction still live, get fee rate) ────
      btn.textContent = 'Checking listing...';
      _bmSetStatus(status, 'info', 'Verifying listing is still active...');
      stepEl.textContent = 'Step 2 of 5';

      const prepData = await _bmUnisat(
        '/v3/market/domain/auction/create_bid_prepare',
        { auctionId, bidPrice: priceSats, address: buyerAddress, pubkey: buyerPubkey }
      );
      const feeRate = prepData.feeRate || prepData.fastestFeeRate || 5;

      // ── Step 3: Build PSBT via UniSat ─────────────────────────────────────
      btn.textContent = 'Building transaction...';
      _bmSetStatus(status, 'info', 'Building transaction...');
      stepEl.textContent = 'Step 3 of 5';

      const bidData = await _bmUnisat(
        '/v3/market/domain/auction/create_bid',
        {
          auctionId,
          bidPrice: priceSats,
          address: buyerAddress,
          pubkey: buyerPubkey,
          feeRate,
          nftAddress: buyerAddress,
        }
      );

      const { bidId, psbtBid, psbtBid2, psbtSettle, bidSignIndexes, networkFee } = bidData;

      // Update network fee display
      if (networkFee) {
        const netFeeEl = document.getElementById('bnNetworkFee');
        const totalEl  = document.getElementById('bnTotalVal');
        const usdEl    = document.getElementById('bnModalUsd');
        if (netFeeEl) netFeeEl.textContent = _bmFmtBtc(networkFee);
        const total = priceSats + feeSats + networkFee;
        if (totalEl) totalEl.textContent = _bmFmtBtc(total);
        _bmGetBtcUsd().then(rate => {
          if (usdEl) usdEl.textContent = '≈ ' + _bmFmtUsd(total, rate);
        });
      }

      // ── Step 4: Worker injects 1% fee output into PSBT ───────────────────
      btn.textContent = 'Injecting fee output...';
      _bmSetStatus(status, 'info', 'Adding platform fee output...');
      stepEl.textContent = 'Step 4 of 5';

      // psbtBid from UniSat is hex — convert to base64 for the worker
      function hexToBase64(hex) {
        const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      }
      function base64ToHex(b64) {
        const bin = atob(b64);
        let hex = '';
        for (let i = 0; i < bin.length; i++) {
          hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
        }
        return hex;
      }

      const psbtBase64 = hexToBase64(psbtBid);

      const injectRes = await fetch(`${MARKET_API_BM}/api/psbt/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          auctionId,
          buyerAddress,
          priceSats,
          feeRate,
          psbtBase64, // pass the raw PSBT so worker doesn't need to re-fetch
        }),
        signal: AbortSignal.timeout(15000),
      });
      const injectData = await injectRes.json();

      let psbtToSign;
      if (injectData.ok && injectData.psbtBase64) {
        // Fee injected — convert back to hex for wallet signing
        psbtToSign = base64ToHex(injectData.psbtBase64);
      } else {
        // Worker unavailable or injection failed — fall back to original PSBT
        // Fee collection skipped, but buy still works
        console.warn('Fee injection failed, using original PSBT:', injectData.error);
        psbtToSign = psbtBid;
      }

      // ── Step 5: Buyer signs ───────────────────────────────────────────────
      btn.textContent = 'Sign in wallet...';
      _bmSetStatus(status, 'info', 'Check your wallet — a signature request is waiting.');
      stepEl.textContent = 'Step 5 of 5';

      const signedPsbt = await _bmSignPsbt(wallet, psbtToSign, bidSignIndexes || [], buyerPubkey);

      // ── Broadcast via UniSat ──────────────────────────────────────────────
      btn.textContent = 'Broadcasting...';
      _bmSetStatus(status, 'info', 'Broadcasting to Bitcoin network...');
      stepEl.textContent = '';

      const confirmData = await _bmUnisat(
        '/v3/market/domain/auction/confirm_bid',
        {
          auctionId,
          bidId,
          psbtBid: signedPsbt,
          psbtBid2: psbtBid2 || '',
          psbtSettle: psbtSettle || '',
          fromBase64: false,
        }
      );

      const txid = confirmData.txid || confirmData.bidTxid || '';
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
      if (/reject|cancel|denied|dismiss|user rejected/i.test(msg)) {
        _bmSetStatus(status, 'info', 'Signature cancelled. Click below to try again.');
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
