// Footage for the "crash test" video (demo/compose-crash.mjs). Recorded with the hyperframes-app-demo recorder at
// 1600x900 (16:9) and 2x pixels for zooms. Captions are never drawn: they are markers ("@name" or "@name|json") that
// the composer turns into cuts, zooms and transaction-ticker events. The buyer is the test account alice, signing on
// NEAR through scripts/src/demo-buy.ts while the page updates live.
import { exec } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ALICE = 'alice.airbag-mw9otkyz.testnet';
const run = (cmd) => new Promise((ok, no) => exec(cmd, { cwd: path.join(ROOT, 'scripts') }, (e, out) => (e ? no(e) : ok(out.trim()))));

export const config = { hide: ['nextjs-portal'] };

export default async function scenario({ page, goto, caption, point, scrollTo, scrollY, hold, waitFor }) {
  const mark = (name, data) => caption(data ? `@${name}|${JSON.stringify(data)}` : `@${name}`);
  const kpi = (k) => page.locator('.kpi', { hasText: k }).locator('.v').first();

  await goto('/');
  await mark('home');
  await hold(2600);

  await goto('/market?id=1');
  await waitFor('market loads', page.locator('.price-card .pc-v', { hasText: /\d/ }));
  await mark('market', { odds: (await kpi('Polymarket odds').innerText()).trim(), ends: (await kpi('Ends').innerText()).trim() });
  await point(kpi('Polymarket odds'));
  await hold(2600);

  await scrollTo(page.locator('.price-card'), 150);
  await mark('quote', { premium: (await page.locator('.price-card .pc-v').innerText()).replace(/\s+/g, ' ').trim() });
  await point(page.locator('.quote-row', { hasText: 'Polymarket floor' }));
  await hold(2800);

  // the buy: alice signs on NEAR; the page's "cover in force" moves when it lands
  await scrollY(0);
  const before = (await kpi('Cover in force').innerText()).trim();
  await mark('buy', { before });
  await point(kpi('Cover in force'));
  const buy = run('./node_modules/.bin/tsx src/demo-buy.ts 1 100');
  await waitFor('cover bought on NEAR', async () => (await kpi('Cover in force').innerText()).trim() !== before, { timeout: 180_000, pill: '⏳ NEAR · sped up' });
  const out = await buy.catch((e) => `failed ${e.message}`);
  const tx = out.match(/\(([1-9A-HJ-NP-Za-km-z]{43,44})\)\s*$/)?.[1] ?? null;
  await mark('bought', { tx, after: (await kpi('Cover in force').innerText()).trim(), line: out.split('\n').pop() });
  await hold(2200);

  // Polygon: the keeper gets NEAR MPC to sign the split; the shares move on Polymarket's CTF
  const panel = page.locator('.pnl', { hasText: 'Built on Polymarket' });
  await scrollTo(panel, 70);
  const shares = panel.locator('.facts > div', { hasText: 'Shares held on Polygon' }).locator('b');
  const had = (await shares.innerText()).trim();
  await mark('panel', { had });
  await point(shares);
  await waitFor('split mined on Polygon', async () => { const t = (await shares.innerText()).trim(); return /YES/.test(t) && t !== had; },
    { timeout: 300_000, pill: '⏳ NEAR MPC → Polygon · sped up' });
  const split = JSON.parse(await run('./node_modules/.bin/tsx src/demo-last-split.ts').catch(() => 'null'));
  await mark('split', { ...split, now: (await shares.innerText()).trim() });
  await point(panel.locator('.dtable tbody tr').last());
  await hold(3200);

  await goto(`/me?account=${ALICE}`);
  await waitFor('policies load', page.locator('.dtable tbody tr').first());
  await mark('policy');
  await point(page.locator('.dtable tbody tr').last());
  await hold(3000);

  await goto('/proof');
  await mark('proof');
  await hold(1800);
  await scrollTo(page.locator('td', { hasText: 'Polygon Amoy' }).first(), 260);
  await hold(3000);
  await mark('end');
}
