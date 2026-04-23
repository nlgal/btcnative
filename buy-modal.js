/**
 * btcnative Buy Modal — Sprint 5
 * Full PSBT buy flow via UniSat Domain Marketplace API.
 *
 * Flow:
 *   1. create_bid_prepare  — get buyer UTXOs needed
 *   2. create_bid          — UniSat builds the combined PSBT
 *   3. wallet.signPsbt     — buyer signs their inputs
 *   4. confirm_bid         — UniSat broadcasts, sale settles
 *
 * Usage:
 *   openBuyModal({ name: 'trump.btc', auctionId: '...', priceSats: 500000 });
 */

const UNISAT_BASE_BM  = 'https://open-api.unisat.io';
const UNISAT_KEY_BM   = 'd6082c62b212e154fb506f50957506bfefea2df898e02f7670a83791dd42a870';
const MARKET_API_BM   = 'https://btcnative-market.galanin.workers.dev';

// ── BTC/USD ───────────────────────────────────────────────────────────────────
let _bmBtcUsd = null;
async function _bmGetBtcUsd() {
  if (_bmBtcUsd) return _bmBtcUsd;
  try {
    const r = await fetch('https://mempool.space/api/v1/prices', { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    _bmBtcUsd = d.USD || 95000;
  } catch { _bmBtcUsd = 95000; }
  return _bmBtcUsd;
}
function _bmFmtUsd(sats, rate) {
  if (!sats || !rate) return '';
  const usd = (sats / 1e8) * rate;
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString();
  if (usd >= 1)    return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(2);
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
    // ordinals address for receiving inscription, payment address for BTC inputs
    wallet._paymentAddress = res.result.find(a => a.purpose === 'payment')?.address || res.result[0].address;
    return res.result.find(a => a.purpose === 'ordinals')?.address || res.result[0].address;
  }
  throw new Error('Unsupported wallet');
}
async function _bmGetPubkey(wallet) {
  if (wallet.type === 'unisat') return wallet.api.getPublicKey();
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('getAccounts', { purposes: ['ordinals'] });
    return res.result[0].publicKey;
  }
  throw new Error('Unsupported wallet');
}
async function _bmGetUtxos(wallet, address) {
  // UniSat API: get spendable UTXOs for the buyer's payment address
  const payAddr = wallet._paymentAddress || address;
  const res = await fetch(
    `${UNISAT_BASE_BM}/v1/indexer/address/${payAddr}/utxo-data?cursor=0&size=16`,
    { headers: { 'Authorization': `Bearer ${UNISAT_KEY_BM}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error('Could not fetch UTXOs: ' + data.msg);
  return (data.data?.utxo || []).filter(u => !u.inscriptions?.length).map(u => ({
    txid: u.txid,
    index: u.vout,
  }));
}
async function _bmSignPsbt(wallet, psbtHex, signIndexes) {
  const toSignInputs = signIndexes.map(i => ({ index: i, address: wallet._address }));
  if (wallet.type === 'unisat') {
    return wallet.api.signPsbt(psbtHex, { autoFinalized: false, toSignInputs });
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('signPsbt', {
      psbt: psbtHex,
      broadcast: false,
      signInputs: Object.fromEntries(signIndexes.map(i => [i, ['SIGHASH_DEFAULT']])),
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
    .bn-modal__row:last-of-type{border-bottom:none;}
    .bn-modal__label{color:var(--color-text-muted,#888);}
    .bn-modal__value{font-weight:600;font-family:var(--font-mono,monospace);}
    .bn-modal__value--accent{color:#f7931a;}
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
      margin-top:12px;padding:10px 14px;border-radius:8px;font-size:0.82rem;display:none;
    }
    .bn-modal__status.info{display:block;background:#e8f4fd;color:#1a6fa8;}
    .bn-modal__status.success{display:block;background:#e6f9f0;color:#1a7a46;}
    .bn-modal__status.error{display:block;background:#fdecea;color:#a0190d;}
    [data-theme="dark"] .bn-modal__status.info{background:#0a2030;color:#4aaddf;}
    [data-theme="dark"] .bn-modal__status.success{background:#0a2016;color:#4ac97a;}
    [data-theme="dark"] .bn-modal__status.error{background:#2a0a08;color:#f07060;}
    .bn-modal__wallet-note{margin-top:10px;font-size:0.78rem;color:var(--color-text-faint,#aaa);text-align:center;}
    .bn-modal__txid{font-family:var(--font-mono,monospace);font-size:0.75rem;word-break:break-all;margin-top:6px;}
    .bn-modal__txid a{color:#f7931a;}
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

  // Resolve auctionId / priceSats if not provided
  if (!auctionId || !priceSats) {
    try {
      const res = await fetch(`${MARKET_API_BM}/api/listing?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      if (data.ok && data.listed) {
        auctionId = data.auctionId;
        priceSats = data.priceSats;
      }
    } catch (_) {}
  }
  if (!auctionId || !priceSats) {
    alert(`${name} is not currently listed for sale.`);
    return;
  }

  // Validate that the listing is for the canonical (first) inscription.
  // Re-inscriptions must be rejected — they are not valid BNS names.
  try {
    const valRes = await fetch(`${MARKET_API_BM}/api/listing?name=${encodeURIComponent(name)}`);
    const valData = await valRes.json();
    if (valData.invalidReInscription) {
      const canonical = valData.canonicalInscriptionId || '';
      alert(
        `Cannot buy ${name}: the listing is a re-inscription and is not the canonical BNS name.\n\n` +
        `Canonical inscription: ${canonical.slice(0, 20)}...\n` +
        `Only the first inscription of a name is valid.`
      );
      return;
    }
  } catch (_) {
    // BNRP resolve failed — allow through (don't block buyers on BNRP downtime)
  }

  // Platform fee shown to buyer (collected by UniSat on their end for domain listings)
  // We display a 0% buyer fee (UniSat charges 0.5% from seller side for domains)
  const feeSats = 0;
  const totalSats = priceSats + feeSats;

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
        <span class="bn-modal__label">Network fee</span>
        <span class="bn-modal__value" style="font-size:0.8rem;color:var(--color-text-muted)">calculated at signing</span>
      </div>
      <div class="bn-modal__total">
        <span class="bn-modal__total-label">You pay</span>
        <span class="bn-modal__total-value bn-modal__value--accent">${_bmFmtBtc(totalSats)}</span>
      </div>
      <div class="bn-modal__usd" id="bnModalUsd"></div>
      <button class="bn-modal__cta" id="bnBuyBtn">Connect wallet &amp; buy</button>
      <div class="bn-modal__status" id="bnBuyStatus"></div>
      <p class="bn-modal__wallet-note">Requires UniSat extension. Your wallet signs the transaction directly.</p>
    </div>
  `;
  document.body.appendChild(backdrop);

  // USD hint
  _bmGetBtcUsd().then(rate => {
    const el = document.getElementById('bnModalUsd');
    if (el) el.textContent = '≈ ' + _bmFmtUsd(totalSats, rate);
  });

  const btn    = backdrop.querySelector('#bnBuyBtn');
  const status = backdrop.querySelector('#bnBuyStatus');

  backdrop.querySelector('.bn-modal__close').onclick = () => backdrop.remove();
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });

  btn.addEventListener('click', async () => {
    btn.disabled = true;

    try {
      // Step 1 — wallet
      _bmSetStatus(status, 'info', 'Detecting wallet...');
      const wallet = _bmDetectWallet();
      if (!wallet) {
        _bmSetStatus(status, 'error', 'No wallet detected. Install <a href="https://unisat.io/download" target="_blank">UniSat</a>.');
        btn.disabled = false;
        return;
      }

      btn.textContent = 'Connecting...';
      _bmSetStatus(status, 'info', `Connecting ${wallet.type}...`);
      const buyerAddress = await _bmGetAddress(wallet);
      wallet._address = buyerAddress;
      const buyerPubkey = await _bmGetPubkey(wallet);

      // Step 2 — create_bid_prepare (get fee rate, confirm auction still live)
      btn.textContent = 'Preparing...';
      _bmSetStatus(status, 'info', 'Preparing purchase...');
      const prepRes = await fetch(`${UNISAT_BASE_BM}/v3/market/domain/auction/create_bid_prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${UNISAT_KEY_BM}` },
        body: JSON.stringify({ auctionId, bidPrice: priceSats, address: buyerAddress, pubkey: buyerPubkey }),
      });
      const prepData = await prepRes.json();
      if (prepData.code !== 0) throw new Error(prepData.msg || 'prepare failed');

      // Step 3 — get buyer UTXOs
      _bmSetStatus(status, 'info', 'Fetching UTXOs...');
      const utxos = await _bmGetUtxos(wallet, buyerAddress);
      if (!utxos.length) throw new Error('No spendable UTXOs in your wallet. Make sure you have BTC to cover the purchase.');

      // Step 4 — create_bid (UniSat builds combined PSBT)
      btn.textContent = 'Building transaction...';
      _bmSetStatus(status, 'info', 'Building transaction...');
      const bidRes = await fetch(`${UNISAT_BASE_BM}/v3/market/domain/auction/create_bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${UNISAT_KEY_BM}` },
        body: JSON.stringify({
          auctionId,
          bidPrice: priceSats,
          address: buyerAddress,
          pubkey: buyerPubkey,
          feeRate: prepData.data?.feeRate || 10,
          nftAddress: buyerAddress,
          utxos,
        }),
      });
      const bidData = await bidRes.json();
      if (bidData.code !== 0) throw new Error(bidData.msg || 'create bid failed');

      const { bidId, psbtBid, psbtBid2, psbtSettle, bidSignIndexes } = bidData.data;

      // Step 5 — buyer signs psbtBid
      btn.textContent = 'Waiting for signature...';
      _bmSetStatus(status, 'info', 'Sign the purchase in your wallet...');
      const signedPsbtBid = await _bmSignPsbt(wallet, psbtBid, bidSignIndexes || []);

      // Step 6 — confirm_bid (UniSat broadcasts)
      btn.textContent = 'Broadcasting...';
      _bmSetStatus(status, 'info', 'Broadcasting transaction...');
      const confirmRes = await fetch(`${UNISAT_BASE_BM}/v3/market/domain/auction/confirm_bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${UNISAT_KEY_BM}` },
        body: JSON.stringify({
          auctionId,
          bidId,
          psbtBid: signedPsbtBid,
          psbtBid2: psbtBid2 || '',
          psbtSettle: psbtSettle || '',
        }),
      });
      const confirmData = await confirmRes.json();
      if (confirmData.code !== 0) throw new Error(confirmData.msg || 'broadcast failed');

      const txid = confirmData.data?.txid || confirmData.data?.bidTxid || '';
      _bmSetStatus(status, 'success', `
        Purchase complete!
        ${txid ? `<div class="bn-modal__txid"><a href="https://mempool.space/tx/${txid}" target="_blank" rel="noopener">${txid}</a></div>` : ''}
      `);
      btn.textContent = 'Done';
      btn.style.background = '#22c55e';

    } catch (e) {
      const msg = e.message || String(e);
      if (/reject|cancel|denied|dismiss/i.test(msg)) {
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
