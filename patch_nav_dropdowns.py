#!/usr/bin/env python3
"""
Patch all 7 HTML files to add hover dropdown menus to the nav.
Replaces the flat <li><a class="nav__link"> structure with dropdown-aware HTML.
"""

import re
import os

# ── Icons (inline SVGs used in dropdown items) ──────────────────────────
def grid_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="5" height="5" rx="0.5"/><rect x="8" y="1" width="5" height="5" rx="0.5"/><rect x="1" y="8" width="5" height="5" rx="0.5"/><rect x="8" y="8" width="5" height="5" rx="0.5"/></svg>'

def list_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="3.5" x2="13" y2="3.5"/><line x1="5" y1="7" x2="13" y2="7"/><line x1="5" y1="10.5" x2="13" y2="10.5"/><circle cx="2" cy="3.5" r="0.75" fill="currentColor"/><circle cx="2" cy="7" r="0.75" fill="currentColor"/><circle cx="2" cy="10.5" r="0.75" fill="currentColor"/></svg>'

def search_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="4"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>'

def chart_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="13" x2="13" y2="13"/><polyline points="3,9 6,5 9,7 12,3"/></svg>'

def tag_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1h5l7 7-5 5L1 6V1z"/><circle cx="3.5" cy="3.5" r="0.75" fill="currentColor"/></svg>'

def clock_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><polyline points="7,4 7,7 9.5,7"/></svg>'

def upload_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1v7M4 4l3-3 3 3"/><path d="M2 10v1.5A1.5 1.5 0 003.5 13h7a1.5 1.5 0 001.5-1.5V10"/></svg>'

def folder_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3.5A1 1 0 012 2.5h3.5l1 1.5H12a1 1 0 011 1v5.5a1 1 0 01-1 1H2a1 1 0 01-1-1V3.5z"/></svg>'

def info_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="5.5"/><line x1="7" y1="6" x2="7" y2="10"/><circle cx="7" cy="4" r="0.5" fill="currentColor"/></svg>'

def wallet_icon():
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="12" height="9" rx="1"/><path d="M1 6h12"/><circle cx="10" cy="8.5" r="0.75" fill="currentColor"/></svg>'

def caret_svg():
    return '<svg class="nav__caret" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3.5l3 3 3-3"/></svg>'

# ── Dropdown HTML builders ────────────────────────────────────────────────
def build_dropdown_item(href, icon_fn, label, extra_class=""):
    cls = f'nav__dropdown-item{" " + extra_class if extra_class else ""}'
    return f'      <a href="{href}" class="{cls}">{icon_fn()} {label}</a>'

def names_li(active_page):
    active = ' active' if active_page == 'explore' else ''
    return f'''\
        <li class="nav__item">
          <a href="./explore.html" class="nav__link nav__link--has-dropdown{active}">
            Names{caret_svg()}
          </a>
          <div class="nav__dropdown">
            <div class="nav__dropdown-label">Browse</div>
{build_dropdown_item("./explore.html", grid_icon, "Categories")}
{build_dropdown_item("./explore.html?tab=listings", list_icon, "Listings")}
{build_dropdown_item("./bulk.html", search_icon, "Bulk Search")}
          </div>
        </li>'''

def market_li(active_page):
    active = ' active' if active_page == 'market' else ''
    return f'''\
        <li class="nav__item">
          <a href="./explore.html?tab=market" class="nav__link nav__link--has-dropdown{active}">
            Market{caret_svg()}
          </a>
          <div class="nav__dropdown">
            <div class="nav__dropdown-label">Data</div>
{build_dropdown_item("./explore.html?tab=market", chart_icon, "Overview")}
{build_dropdown_item("./explore.html?tab=listings&sort=price_asc", tag_icon, "Floor Prices")}
{build_dropdown_item("./explore.html?tab=market", clock_icon, "Recent Sales")}
          </div>
        </li>'''

def sell_li(active_page):
    active = ' active' if active_page == 'sell' else ''
    return f'''\
        <li class="nav__item">
          <a href="./sell.html" class="nav__link nav__link--has-dropdown{active}">
            Sell{caret_svg()}
          </a>
          <div class="nav__dropdown">
            <div class="nav__dropdown-label">Manage</div>
{build_dropdown_item("./sell.html", upload_icon, "List a Name")}
{build_dropdown_item("./portfolio.html", folder_icon, "My Listings")}
            <div class="nav__dropdown-divider"></div>
{build_dropdown_item("./about.html#how-it-works", info_icon, "How It Works")}
          </div>
        </li>'''

def mynames_li(active_page):
    active = ' active' if active_page == 'portfolio' else ''
    return f'''\
        <li class="nav__item">
          <a href="./portfolio.html" class="nav__link nav__link--has-dropdown{active}">
            My Names{caret_svg()}
          </a>
          <div class="nav__dropdown">
            <div class="nav__dropdown-label">Account</div>
{build_dropdown_item("./portfolio.html", folder_icon, "My Portfolio")}
{build_dropdown_item("#", wallet_icon, "Connect Wallet", "nav__dropdown-item--wallet")}
          </div>
        </li>'''

def build_nav_ul(active_page):
    return f'''\
      <ul class="nav__links" role="list">
{names_li(active_page)}
{market_li(active_page)}
{sell_li(active_page)}
{mynames_li(active_page)}
      </ul>'''

# ── Old nav ul pattern to replace ────────────────────────────────────────
OLD_NAV_PATTERN = re.compile(
    r'<ul class="nav__links" role="list">.*?</ul>',
    re.DOTALL
)

# ── File map: filename → active_page key ─────────────────────────────────
FILES = {
    'index.html':     None,
    'explore.html':   'explore',
    'name.html':      'explore',
    'portfolio.html': 'portfolio',
    'sell.html':      'sell',
    'about.html':     None,
    'bulk.html':      'explore',
}

base = '/home/user/workspace/btcnative'
patched = 0
skipped = 0

for filename, active_page in FILES.items():
    path = os.path.join(base, filename)
    with open(path, 'r') as f:
        content = f.read()

    new_ul = build_nav_ul(active_page)

    if not OLD_NAV_PATTERN.search(content):
        print(f'  SKIP (no match): {filename}')
        skipped += 1
        continue

    new_content = OLD_NAV_PATTERN.sub(new_ul, content)

    if new_content == content:
        print(f'  UNCHANGED: {filename}')
        skipped += 1
        continue

    with open(path, 'w') as f:
        f.write(new_content)
    print(f'  PATCHED: {filename}')
    patched += 1

print(f'\nDone — {patched} patched, {skipped} skipped.')
