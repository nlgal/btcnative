/**
 * btcnative Buy Modal
 * Drop this into btcnative/app.js or load as a module.
 *
 * Replaces the "Buy on UniSat" external link with a native buy flow:
 *   1. Show price breakdown (including 1% fee)
 *   2. Detect buyer's wallet (UniSat extension, Xverse)
 *   3. POST to market worker to get fee-injected PSBT
 *   4. Ask wallet to sign PSBT
 *   5. POST signed PSBT to market worker to broadcast
 *   6. Show success with txid
 *
 * Usage:
 *   openBuyModal({ name: 'trump.btc', auctionId: '...', priceSats: 500000 });
 */

const MARKET_API = 'https://btcnative-market.galanin.workers.dev';

// ── Wallet detection ──────────────────────────────────────────────────────────

function detectWallet() {
  if (typeof window === 'undefined') return null;
  if (window.unisat)  return { type: 'unisat',  api: window.unisat };
  if (window.XverseProviders?.BitcoinProvider) return { type: 'xverse', api: window.XverseProviders.BitcoinProvider };
  if (window.btc)     return { type: 'xverse',  api: window.btc };
  return null;
}

async function getWalletAddress(wallet) {
  if (wallet.type === 'unisat') {
    const accounts = await wallet.api.requestAccounts();
    return accounts[0];
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('getAccounts', { purposes: ['ordinals'] });
    return res.result[0].address;
  }
  throw new Error('unsupported wallet');
}

async function signPsbt(wallet, psbtBase64, inputsToSign) {
  if (wallet.type === 'unisat') {
    // UniSat extension: signPsbt returns signed PSBT base64
    const opts = {
      autoFinalized: false,
      toSignInputs: inputsToSign.length ? inputsToSign : undefined,
    };
    return wallet.api.signPsbt(psbtBase64, opts);
  }
  if (wallet.type === 'xverse') {
    const res = await wallet.api.request('signPsbt', {
      psbt: psbtBase64,
      broadcast: false,
      signInputs: inputsToSign.length
        ? Object.fromEntries(inputsToSign.map(i => [i.index, ['SIGHASH_DEFAULT']]))
        : undefined,
    });
    return res.result.psbt;
  }
  throw new Error('unsupported wallet');
}

// ── Modal UI ──────────────────────────────────────────────────────────────────

function injectModalStyles() {
  if (document.getElementById('bn-buy-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'bn-buy-modal-styles';
  style.textContent = `
    .bn-modal-backdrop {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
    }
    .bn-modal {
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border, #e5e7eb);
      border-radius: 16px;
      padding: 28px 28px 24px;
      width: 100%; max-width: 400px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.18);
      position: relative;
    }
    [data-theme="dark"] .bn-modal {
      background: #141414; border-color: #2a2a2a;
    }
    .bn-modal__close {
      position: absolute; top: 16px; right: 16px;
      background: none; border: none; cursor: pointer;
      color: var(--color-text-muted, #888); font-size: 20px; line-height: 1;
      padding: 4px 6px; border-radius: 6px;
    }
    .bn-modal__close:hover { background: var(--color-surface-offset, #f3f4f6); }
    .bn-modal__title {
      font-family: var(--font-mono, monospace);
      font-size: 1.1rem; font-weight: 700;
      margin: 0 0 20px;
      color: var(--color-text, #111);
    }
    .bn-modal__row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--color-border, #e5e7eb);
      font-size: 0.875rem;
    }
    .bn-modal__row:last-of-type { border-bottom: none; }
    .bn-modal__label { color: var(--color-text-muted, #888); }
    .bn-modal__value { font-weight: 600; font-family: var(--font-mono, monospace); }
    .bn-modal__value--accent { color: #f7931a; }
    .bn-modal__total {
      margin-top: 16px; padding: 14px;
      background: var(--color-surface-offset, #f9fafb);
      border-radius: 10px;
      display: flex; justify-content: space-between; align-items: center;
    }
    [data-theme="dark"] .bn-modal__total { background: #1e1e1e; }
    .bn-modal__total-label { font-size: 0.8rem; color: var(--color-text-muted, #888); text-transform: uppercase; letter-spacing: 0.05em; }
    .bn-modal__total-value { font-size: 1.1rem; font-weight: 700; font-family: var(--font-mono, monospace); }
    .bn-modal__cta {
      width: 100%; margin-top: 16px;
      padding: 14px; border: none; border-radius: 10px;
      background: #f7931a; color: #000;
      font-weight: 700; font-size: 0.95rem; cursor: pointer;
      transition: opacity .15s;
    }
    .bn-modal__cta:hover { opacity: .88; }
    .bn-modal__cta:disabled { opacity: .5; cursor: not-allowed; }
    .bn-modal__status {
      margin-top: 12px; padding: 10px 14px;
      border-radius: 8px; font-size: 0.82rem;
      display: none;
    }
    .bn-modal__status.info { display: block; background: #e8f4fd; color: #1a6fa8; }
    .bn-modal__status.success { display: block; background: #e6f9f0; color: #1a7a46; }
    .bn-modal__status.error { display: block; background: #fdecea; color: #a0190d; }
    [data-theme="dark"] .bn-modal__status.info { background: #0a2030; color: #4aaddf; }
    [data-theme="dark"] .bn-modal__status.success { background: #0a2016; color: #4ac97a; }
    [data-theme="dark"] .bn-modal__status.error { background: #2a0a08; color: #f07060; }
    .bn-modal__wallet-note {
      margin-top: 10px; font-size: 0.78rem;
      color: var(--color-text-faint, #aaa); text-align: center;
    }
    .bn-modal__txid {
      font-family: var(--font-mono, monospace); font-size: 0.75rem;
      word-break: break-all; margin-top: 6px;
    }
    .bn-modal__txid a { color: #f7931a; }
  `;
  document.head.appendChild(style);
}

function formatSatsModal(n) {
  if (!n || isNaN(n)) return '—';
  const btc = n / 1e8;
  if (btc >= 1)    return btc.toFixed(4).replace(/\.?0+$/, '') + ' BTC';
  if (btc >= 0.01) return btc.toFixed(4).replace(/0+$/, '') + ' BTC';
  return btc.toFixed(8).replace(/0+$/, '') + ' BTC';
}

function createModal(name, priceSats, feeSats) {
  const totalSats = priceSats + feeSats;
  const backdrop = document.createElement('div');
  backdrop.className = 'bn-modal-backdrop';
  backdrop.innerHTML = `
    <div class="bn-modal" role="dialog" aria-modal="true" aria-label="Buy ${name}">
      <button class="bn-modal__close" aria-label="Close">&times;</button>
      <div class="bn-modal__title">Buy ${name}</div>

      <div class="bn-modal__row">
        <span class="bn-modal__label">Listing price</span>
        <span class="bn-modal__value">${formatSatsModal(priceSats)}</span>
      </div>
      <div class="bn-modal__row">
        <span class="bn-modal__label">Platform fee (1%)</span>
        <span class="bn-modal__value">${formatSatsModal(feeSats)}</span>
      </div>
      <div class="bn-modal__row">
        <span class="bn-modal__label">Network fee</span>
        <span class="bn-modal__value" style="font-size:0.8rem; color: var(--color-text-muted)">estimated at signing</span>
      </div>

      <div class="bn-modal__total">
        <span class="bn-modal__total-label">You pay</span>
        <span class="bn-modal__total-value bn-modal__value--accent">${formatSatsModal(totalSats)}</span>
      </div>

      <button class="bn-modal__cta" id="bnBuyBtn">Connect wallet &amp; buy</button>
      <div class="bn-modal__status" id="bnBuyStatus"></div>
      <p class="bn-modal__wallet-note">Requires UniSat or Xverse extension. Signing happens in your wallet.</p>
    </div>
  `;
  return backdrop;
}

function setStatus(statusEl, type, html) {
  statusEl.className = `bn-modal__status ${type}`;
  statusEl.innerHTML = html;
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function openBuyModal({ name, auctionId, priceSats }) {
  injectModalStyles();

  // If auctionId not provided, fetch listing first
  if (!auctionId || !priceSats) {
    const res = await fetch(`${MARKET_API}/api/listing?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!data.ok || !data.listed) {
      alert(`${name} is not currently listed for sale.`);
      return;
    }
    auctionId = data.auctionId;
    priceSats = data.priceSats;
  }

  const feeSats = Math.max(Math.round(priceSats * 0.01), 1000);
  const modal = createModal(name, priceSats, feeSats);
  document.body.appendChild(modal);

  const btn = modal.querySelector('#bnBuyBtn');
  const statusEl = modal.querySelector('#bnBuyStatus');

  // Close handlers
  modal.querySelector('.bn-modal__close').onclick = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Buy flow
  btn.addEventListener('click', async () => {
    btn.disabled = true;

    try {
      // 1. Detect wallet
      setStatus(statusEl, 'info', 'Detecting wallet...');
      const wallet = detectWallet();
      if (!wallet) {
        setStatus(statusEl, 'error', 'No wallet detected. Install <a href="https://unisat.io/download" target="_blank">UniSat</a> or <a href="https://www.xverse.app" target="_blank">Xverse</a>.');
        btn.disabled = false;
        return;
      }

      // 2. Get buyer address
      setStatus(statusEl, 'info', `Connecting ${wallet.type}...`);
      btn.textContent = 'Connecting wallet...';
      const buyerAddress = await getWalletAddress(wallet);

      // 3. Prepare PSBT (worker injects fee)
      setStatus(statusEl, 'info', 'Preparing transaction...');
      btn.textContent = 'Preparing...';
      const prepRes = await fetch(`${MARKET_API}/api/psbt/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, auctionId, buyerAddress, priceSats }),
      });
      const prepData = await prepRes.json();
      if (!prepData.ok) throw new Error(prepData.error || 'prepare failed');

      // 4. Sign PSBT with wallet
      setStatus(statusEl, 'info', 'Check your wallet to sign...');
      btn.textContent = 'Waiting for signature...';
      const signedPsbt = await signPsbt(wallet, prepData.psbtBase64, prepData.inputsToSign || []);

      // 5. Broadcast
      setStatus(statusEl, 'info', 'Broadcasting...');
      btn.textContent = 'Broadcasting...';
      const broadcastRes = await fetch(`${MARKET_API}/api/psbt/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedPsbtBase64: signedPsbt, auctionId, name }),
      });
      const broadcastData = await broadcastRes.json();
      if (!broadcastData.ok) throw new Error(broadcastData.error || 'broadcast failed');

      // 6. Success
      const txid = broadcastData.txid;
      setStatus(statusEl, 'success', `
        Purchase complete.
        <div class="bn-modal__txid">
          <a href="https://mempool.space/tx/${txid}" target="_blank" rel="noopener noreferrer">${txid}</a>
        </div>
      `);
      btn.textContent = 'Done';
      btn.style.background = '#22c55e';

    } catch (e) {
      const msg = e.message || String(e);
      // User rejected signing -- not an error
      if (msg.includes('User rejected') || msg.includes('cancelled') || msg.includes('denied')) {
        setStatus(statusEl, 'info', 'Signature cancelled.');
      } else {
        setStatus(statusEl, 'error', msg);
      }
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  });
}

// Export for use in app.js
if (typeof window !== 'undefined') window.openBuyModal = openBuyModal;
export { openBuyModal };
