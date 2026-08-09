/**
 * Render a composed review into a self-contained HTML page.
 *
 * The page is the review. It carries the totals, the deltas, and — the part
 * that makes it a working surface rather than a report — the assist's proposals
 * with an Accept/Reject control on each. Deciding posts back to this module's
 * own API; **deciding is not applying**. An accepted proposal sits as accepted
 * until a human runs the apply, which is a separate, deliberate act.
 *
 * Self-contained by the pages CSP: inline style and script only, no external
 * subresources, no fonts, no images.
 */

import type { ReviewSummary, SuggestionRecord } from '../types.js';

export interface RenderInput {
  reviewId: number;
  summary: ReviewSummary;
  suggestions: SuggestionRecord[];
  /** Shown in the footer so a stale page is obvious. */
  generatedAt?: Date;
}

export function reviewSlug(periodKey: string): string {
  return `finance-review-${periodKey}`;
}

export function reviewTitle(summary: ReviewSummary): string {
  return `Finance review — ${summary.periodLabel}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value)}`;
  }
}

function moneyExact(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function deltaLabel(current: number, prior: number | null): string {
  if (prior === null || prior === 0) return '';
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? '+' : '−';
  return `${sign}${Math.abs(Math.round(pct))}%`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --ink: #1b1b1a; --muted: #6b6b66;
  --line: #e3e3df; --accent: #2f5d50; --warn: #8a5a12; --pos: #2f6f4f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --panel: #1e2024; --ink: #e9e9e6; --muted: #9a9a93;
    --line: #2e3137; --accent: #7fbfa8; --warn: #d9a95c; --pos: #86c9a2;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--ink);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1.05rem; margin: 2.25rem 0 .75rem; letter-spacing: .02em;
     text-transform: uppercase; color: var(--muted); }
p.sub { margin: 0 0 1.75rem; color: var(--muted); }
.tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: .6rem; padding: .9rem 1rem; }
.tile .k { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.tile .v { font-size: 1.5rem; font-variant-numeric: tabular-nums; margin-top: .2rem; }
.tile .d { font-size: .8rem; color: var(--muted); }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; min-width: 34rem; background: var(--panel);
        border: 1px solid var(--line); border-radius: .6rem; }
th, td { text-align: left; padding: .55rem .75rem; border-bottom: 1px solid var(--line); font-size: .9rem; }
th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.reasons { color: var(--warn); font-size: .8rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: .6rem;
        padding: .85rem 1rem; margin-bottom: .6rem; }
.card .head { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; justify-content: space-between; }
.card .why { color: var(--muted); font-size: .85rem; margin: .35rem 0 .6rem; }
.prop { font-size: .9rem; }
.prop b { color: var(--accent); }
.controls { display: flex; gap: .5rem; margin-top: .6rem; align-items: center; }
button { font: inherit; font-size: .85rem; padding: .3rem .8rem; border-radius: .4rem;
         border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; }
button:hover { border-color: var(--accent); }
button[disabled] { opacity: .45; cursor: default; }
.state { font-size: .8rem; color: var(--muted); }
.state.accepted { color: var(--pos); }
.state.rejected { color: var(--muted); }
.state.applied { color: var(--pos); font-weight: 600; }
.note { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--warn);
        border-radius: .4rem; padding: .7rem .9rem; margin: .5rem 0; font-size: .88rem; }
footer { margin-top: 3rem; color: var(--muted); font-size: .8rem; border-top: 1px solid var(--line); padding-top: 1rem; }
`.trim();

/** Client script: decide a proposal. Deciding is not applying — see the module doc. */
const SCRIPT = `
(function () {
  var root = document.querySelector('main[data-review-id]');
  var reviewId = root ? root.getAttribute('data-review-id') : null;
  function decide(button) {
    var id = button.getAttribute('data-suggestion');
    var decision = button.getAttribute('data-decision');
    var row = document.getElementById('s' + id);
    var state = row.querySelector('.state');
    var buttons = row.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    state.textContent = 'saving…';
    fetch('/api/finance/reviews/' + reviewId + '/suggestions/' + id + '/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: decision })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (body) {
      state.textContent = body.suggestion.status;
      state.className = 'state ' + body.suggestion.status;
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
    }).catch(function (err) {
      state.textContent = 'could not save: ' + err.message;
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
    });
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button[data-suggestion]') : null;
    if (button) decide(button);
  });
})();
`.trim();

export function renderReviewPage(input: RenderInput): string {
  const s = input.summary;
  const cur = s.currency;
  const byTransaction = new Map<string, SuggestionRecord[]>();
  for (const suggestion of input.suggestions) {
    const list = byTransaction.get(suggestion.transactionId) ?? [];
    list.push(suggestion);
    byTransaction.set(suggestion.transactionId, list);
  }

  const needsAttention = [...s.uncategorized, ...s.flagged].filter(
    (item, index, all) =>
      all.findIndex((other) => other.transaction.externalId === item.transaction.externalId) === index,
  );

  return `<style>${STYLE}</style>
<main data-review-id="${input.reviewId}">
<h1>${escapeHtml(reviewTitle(s))}</h1>
<p class="sub">${escapeHtml(s.periodStart)} to ${escapeHtml(s.periodEnd)} · ${s.transactionCount} transactions</p>

${s.warnings.length > 0 ? s.warnings.map((w) => `<div class="note">${escapeHtml(w)}</div>`).join('\n') : ''}

<div class="tiles">
  <div class="tile"><div class="k">Out</div><div class="v">${money(s.totalOutflow, cur)}</div>
    <div class="d">${escapeHtml(deltaLabel(s.totalOutflow, s.priorTotalOutflow) || '—')} vs ${escapeHtml(s.priorPeriodKey ?? 'no prior month')}</div></div>
  <div class="tile"><div class="k">In</div><div class="v">${money(s.totalInflow, cur)}</div><div class="d">&nbsp;</div></div>
  <div class="tile"><div class="k">Net</div><div class="v">${money(s.net, cur)}</div><div class="d">&nbsp;</div></div>
  <div class="tile"><div class="k">Needs a look</div><div class="v">${needsAttention.length}</div>
    <div class="d">${s.uncategorized.length} uncategorized</div></div>
</div>

<h2>Where it went</h2>
<div class="scroll"><table>
<thead><tr><th>Category</th><th class="num">Out</th><th class="num">vs prior</th><th class="num">Count</th></tr></thead>
<tbody>
${s.categories
  .map(
    (c) => `<tr><td>${escapeHtml(c.category)}</td><td class="num">${money(c.outflow, cur)}</td>` +
      `<td class="num">${escapeHtml(deltaLabel(c.outflow, c.priorOutflow) || '—')}</td>` +
      `<td class="num">${c.count}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>

<h2>Top merchants</h2>
<div class="scroll"><table>
<thead><tr><th>Merchant</th><th class="num">Out</th><th class="num">Count</th></tr></thead>
<tbody>
${s.topMerchants
  .map(
    (m) => `<tr><td>${escapeHtml(m.merchant)}</td><td class="num">${money(m.outflow, cur)}</td><td class="num">${m.count}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>

<h2>Needs a look${needsAttention.length > 0 ? ` (${needsAttention.length})` : ''}</h2>
${
  needsAttention.length === 0
    ? '<div class="note">Nothing flagged. Every transaction was categorized and none stood out.</div>'
    : needsAttention
        .map((item) => renderFlagged(item.transaction.externalId, item, byTransaction, cur))
        .join('\n')
}

${
  s.accounts.length > 0
    ? `<h2>Balances at pull</h2>
<div class="scroll"><table>
<thead><tr><th>Account</th><th>Institution</th><th class="num">Balance</th></tr></thead>
<tbody>
${s.accounts
  .map(
    (a) => `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.institution ?? '—')}</td>` +
      `<td class="num">${a.balance === null ? '—' : moneyExact(a.balance, cur)}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
    : ''
}

<footer>
Accepting a proposal records your decision here. It does <b>not</b> change the
ledger — applying accepted proposals is a separate, deliberate step.
${input.generatedAt ? `<br>Generated ${escapeHtml(input.generatedAt.toISOString())}.` : ''}
</footer>
</main>
<script>${SCRIPT}</script>`;
}

function renderFlagged(
  id: string,
  item: { transaction: ReviewSummary['flagged'][number]['transaction']; reasons: string[] },
  byTransaction: Map<string, SuggestionRecord[]>,
  currency: string,
): string {
  const t = item.transaction;
  const proposals = byTransaction.get(id) ?? [];
  return `<div class="card">
  <div class="head">
    <div><b>${escapeHtml(t.merchant ?? t.description ?? 'Unknown')}</b>
      <span class="state">${escapeHtml(t.postedOn)} · ${escapeHtml(t.categoryName ?? 'uncategorized')}</span></div>
    <div class="num">${moneyExact(t.amount, currency)}</div>
  </div>
  <div class="why">${escapeHtml(item.reasons.join(' · '))}</div>
${proposals.map(renderProposal).join('\n')}
</div>`;
}

function renderProposal(suggestion: SuggestionRecord): string {
  const decided = suggestion.status !== 'proposed';
  const label = suggestion.kind === 'category' ? 'Category' : 'Note';
  return `  <div class="prop" id="s${suggestion.id}">
    ${escapeHtml(label)}: <b>${escapeHtml(suggestion.suggestedValue)}</b>
    ${suggestion.rationale ? `<span class="state">— ${escapeHtml(suggestion.rationale)}</span>` : ''}
    ${suggestion.confidence ? `<span class="state">(${escapeHtml(suggestion.confidence)})</span>` : ''}
    <div class="controls">
      <button data-suggestion="${suggestion.id}" data-decision="accepted"${
        suggestion.status === 'applied' ? ' disabled' : ''
      }>Accept</button>
      <button data-suggestion="${suggestion.id}" data-decision="rejected"${
        suggestion.status === 'applied' ? ' disabled' : ''
      }>Reject</button>
      <span class="state ${escapeHtml(suggestion.status)}">${escapeHtml(decided ? suggestion.status : '')}</span>
    </div>
  </div>`;
}
