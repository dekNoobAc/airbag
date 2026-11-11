// Airbag demo video (hyperframes-app-demo skill). Records the real app on NEAR testnet; the "buyer" is the test
// account alice, buying through scripts/src/demo-buy.ts while the page updates live (no wallet popups on screen).
//
//   cd airbag-near && .claude/skills/hyperframes-app-demo/scripts/make-video.sh \
//     --scenario demo/scenario.mjs --out demo-video --base-url http://localhost:3108
import { exec } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALICE = 'alice.airbag-mw9otkyz.testnet';

// the Airbag pixel mark (same as web/src/components/Logo.tsx)
const PX = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', '.XXXXXX.', '..XXXX..'];
const markSvg = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" width="100%" height="100%"><rect x="0.5" y="0.5" width="11" height="11" fill="#fff" stroke="#000" stroke-width="1"/>${PX.flatMap((r, y) => [...r].map((c, x) => (c === 'X' ? `<rect x="${x + 2}" y="${y + 2}" width="1" height="1" fill="${(x + y) % 3 === 0 ? '#d61f4f' : '#ff3366'}"/>` : ''))).join('')}<rect x="4" y="4" width="1" height="1" fill="#fff"/></svg>`;

export const config = { hide: ['nextjs-portal'] };

export const video = {
  brand: { name: 'AIRBAG', mark: 'A', markSvg, accent: '#00E5FF', accent2: '#00F076', alert: '#FF3366' },
  intro: {
    title: 'Insure what Polymarket predicts.',
    highlight: 'Built on NEAR.',
    chips: ['Cover AMM on NEAR', 'Polymarket odds in a TEE', 'Polymarket CTF via Chain Signatures', { text: '● Live · NEAR testnet', live: true }],
  },
  problem: {
    eyebrow: 'THE PROBLEM',
    seconds: 11,
    stat: '68%',
    note: "Polymarket's odds that Bitcoin closes below $74k on Nov 12 · read by Airbag's oracle, Nov 10 2026",
    lines: [
      'Prediction markets tell you <b>how likely</b> a crash is. They don’t protect you from it.',
      'Airbag sells <b>cover</b> on the same events: priced by Polymarket, backed 1:1, paid out automatically.',
    ],
  },
  explainer: [
    { kind: 'flow', seconds: 10, eyebrow: 'HOW IT WORKS', title: 'Priced by Polymarket, read inside a TEE',
      nodes: [
        { tag: 'POLYMARKET', label: 'Live odds', sub: 'Gamma API: odds, result, close time', color: '#e9d5ff' },
        { tag: 'OUTLAYER TEE', label: 'Pinned oracle', sub: 'Intel TDX runs the wasm whose <b>sha256</b> is in the contract', color: '#fff' },
        { tag: 'NEAR', label: 'Airbag contract', sub: 'premium = <b>max(AMM, odds)</b> + fee', color: '#00E5FF' },
      ],
      arrows: ['read', 'on_oracle()'],
      note: 'No oracle key: the contract only accepts answers from <b>that exact code</b>.', noteAt: 5.2 },
    { kind: 'flow', seconds: 11, eyebrow: 'HOW IT WORKS', title: 'A NEAR contract that drives Polymarket’s own contracts',
      nodes: [
        { tag: 'NEAR', label: 'Airbag builds the tx', sub: 'split · reportPayouts · redeem', color: '#00E5FF' },
        { tag: 'CHAIN SIGNATURES', label: 'NEAR MPC signs', sub: 'Polygon wallet with <b>no private key</b>', color: '#fff' },
        { tag: 'POLYGON', label: 'Polymarket CTF', sub: 'real <b>YES + NO</b> shares for every policy', color: '#e9d5ff' },
      ],
      arrows: ['sign()', 'broadcast'],
      note: 'Like a hook on Polymarket: every policy is mirrored in <b>Polymarket’s CTF</b>.', noteAt: 5.5 },
    { kind: 'flow', seconds: 10, eyebrow: 'HOW IT WORKS', title: 'Polymarket decides. Everyone gets paid.',
      nodes: [
        { tag: 'POLYMARKET', label: 'Market resolves', sub: 'the TEE reads the result', color: '#e9d5ff' },
        { tag: 'NEAR', label: 'Dispute window', sub: 'a guardian can only delay', color: '#FFE600' },
        { tag: 'PAYOUT', label: 'NEAR or Base', sub: 'USDC pushed automatically, no claim form', color: '#00F076' },
      ],
      arrows: ['propose', 'finalize'],
      note: 'And on Polygon the result is <b>reported to the CTF</b> and the shares redeemed.', noteAt: 5 },
  ],
  footage: { startAt: /^<b>1 ·/, endAt: /^<b>END/, pill: '● LIVE · NEAR TESTNET + POLYGON AMOY · SPED-UP WAITS' },
  chapters: [
    { match: /^<b>1 ·/, label: 'Live markets' },
    { match: /^<b>2 ·/, label: 'Odds from the TEE' },
    { match: /^<b>3 ·/, label: 'The quote' },
    { match: /^<b>4 ·/, label: 'Buy cover' },
    { match: /^<b>5 ·/, label: 'Built on Polymarket' },
    { match: /^<b>6 ·/, label: 'Shares on Polygon' },
    { match: /^<b>7 ·/, label: 'The policy' },
    { match: /^<b>8 ·/, label: 'Proof' },
  ],
  outro: {
    items: [{ k: 'PRICED BY', v: 'Polymarket · TEE' }, { k: 'BACKED ON', v: 'NEAR' }, { k: 'MIRRORED ON', v: 'Polymarket CTF' }],
    tagline: 'Airbag · insurance on NEAR, built on Polymarket',
  },
};

export default async function scenario({ page, goto, caption, click, point, scrollTo, scrollY, hold, waitFor }) {
  const kpi = (k) => page.locator('.kpi', { hasText: k }).locator('.v').first();

  // 1 · home: the live markets
  await goto('/');
  await hold(1500);
  await caption('<b>1 ·</b> Live markets, each linked to a Polymarket market');
  await scrollTo(page.locator('#markets'), 90);
  await waitFor('markets load', page.locator('.product').first());
  await hold(3000);
  await point(page.locator('.product').nth(1));
  await hold(1500);
  await click(page.locator('.product').nth(1));
  await page.waitForURL('**/market?id=1');
  await waitFor('market loads', page.locator('.price-card .pc-v', { hasText: /\d/ }));

  // 2 · odds read in the TEE
  await caption('<b>2 ·</b> Polymarket’s odds, read on NEAR by the TEE oracle');
  await point(kpi('Polymarket odds'));
  await hold(3200);

  // 3 · the quote
  await caption('<b>3 ·</b> The price: max(AMM, Polymarket odds) + fee');
  await scrollTo(page.locator('.price-card'), 140);
  await hold(2500);
  await point(page.locator('.quote-row', { hasText: 'Polymarket floor' }));
  await hold(3000);

  // 4 · a buyer takes cover (alice signs on NEAR via the demo script)
  await scrollY(0);
  const before = (await kpi('Cover in force').innerText()).trim();
  await caption('<b>4 ·</b> A buyer takes 100 USDC of cover, signed on NEAR');
  await point(kpi('Cover in force'));
  const buy = new Promise((ok, no) => exec('./node_modules/.bin/tsx src/demo-buy.ts 1 100', { cwd: path.join(ROOT, 'scripts') }, (e, out) => (e ? no(e) : ok(out))));
  buy.then((o) => console.log(`[demo] ${o.trim()}`)).catch((e) => console.log(`[demo] buy failed: ${e.message}`));
  await waitFor('cover bought on NEAR', async () => (await kpi('Cover in force').innerText()).trim() !== before, { timeout: 180_000, pill: '⏳ NEAR transaction · sped up' });
  await hold(3000);

  // 5 · built on Polymarket
  const panel = page.locator('.pnl', { hasText: 'Built on Polymarket' });
  await caption('<b>5 ·</b> Built on Polymarket: TEE odds, then Polymarket’s own CTF on Polygon');
  await scrollTo(panel, 90);
  await hold(4000);

  // 6 · the keeper gets NEAR MPC to sign the split; the shares appear on Polygon
  const shares = panel.locator('.facts > div', { hasText: 'Shares held on Polygon' }).locator('b');
  const had = (await shares.innerText()).trim();
  await caption('<b>6 ·</b> NEAR MPC signs the split: the cover becomes real Polymarket shares');
  await point(shares);
  await waitFor('split mined on Polygon', async () => { const t = (await shares.innerText()).trim(); return /YES/.test(t) && t !== had; },
    { timeout: 300_000, pill: '⏳ NEAR MPC → Polygon · sped up' });
  await hold(1500);
  await point(panel.locator('.dtable tbody tr').last());
  await hold(3500);

  // 7 · the policy
  await goto(`/me?account=${ALICE}`);
  await caption('<b>7 ·</b> The buyer’s policy: pays automatically if Polymarket resolves NO');
  await waitFor('policies load', page.locator('.dtable tbody tr').first());
  await point(page.locator('.dtable tbody tr').last());
  await hold(3800);

  // 8 · proof
  await goto('/proof');
  await caption('<b>8 ·</b> Proof: the oracle’s code hash, the MPC wallets, every transaction');
  await hold(3000);
  await scrollTo(page.locator('.pnl', { hasText: 'Every step' }), 90);
  await hold(2000);
  await scrollTo(page.locator('td', { hasText: 'Polygon Amoy' }).first(), 200);
  await hold(3500);
  await caption('<b>END</b>');
  await hold(500);
}
