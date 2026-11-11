// "Crash test" demo video for Airbag: a HyperFrames composition built from a real take (demo/crash-scenario.mjs).
//   test card (the event + Polymarket's odds) → title → the rig (NEAR · Polygon · Base) → the code → live run
//   (full-screen footage, zooms, HUD callouts, a 3-lane transaction ticker with the real hashes) → status → outro
//
//   node demo/compose-crash.mjs [--take demo-video/crash-take] [--project demo-video/crash] [--settled]
// then render with one browser: (cd demo-video/crash && npx hyperframes@0.8.78 render -o ../airbag-crash.mp4 -w 1)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(import.meta.dirname, '..');
const TAKE = path.resolve(arg('take', `${ROOT}/demo-video/crash-take`));
const PROJECT = path.resolve(arg('project', `${ROOT}/demo-video/crash`));
const HF = 'hyperframes@0.8.78';
const C = { ink: '#0b0b0d', paper: '#f4f4f4', cyan: '#00E5FF', green: '#00F076', coral: '#FF3366', yellow: '#FFE600', purple: '#9333ea', lilac: '#e9d5ff', blue: '#2e6bff' };

// ── markers from the take ──
const video = `${TAKE}/edited.mp4`;
const vdur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString());
const M = {};
for (const c of JSON.parse(fs.readFileSync(`${TAKE}/chapters.json`, 'utf8'))) {
  const m = /^@(\w+)(?:\|(.*))?$/.exec(c.html ?? '');
  if (m) M[m[1]] = { t: c.t, ...(m[2] ? JSON.parse(m[2]) : {}) };
}
for (const k of ['market', 'quote', 'buy', 'bought', 'panel', 'split', 'policy', 'proof', 'end']) if (!M[k]) throw new Error(`marker @${k} missing in ${TAKE}`);
// the TEE oracle's latest reading of market 1 before the take (NEAR tx), from the keeper's log
const klog = fs.existsSync(`${ROOT}/testnet/keeper.log`) ? fs.readFileSync(`${ROOT}/testnet/keeper.log`, 'utf8') : '';
const refresh = [...klog.matchAll(/market 1: floor (\d+) bps \(tx (\w+)\)/g)].pop();

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : '—');
const odds = M.market.odds ?? '68.00%';
const shares = M.split.now ?? '';
const cover = M.bought.after ?? '';

// ── project (init first: the voice clips are copied into its assets) ──
if (!fs.existsSync(`${PROJECT}/hyperframes.json`)) {
  fs.mkdirSync(path.dirname(PROJECT), { recursive: true });
  execFileSync('npx', ['-y', HF, 'init', path.basename(PROJECT), '--non-interactive', '--example', 'blank', '--skip-transcribe'],
    { cwd: path.dirname(PROJECT), env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' }, stdio: 'ignore' });
}
fs.mkdirSync(`${PROJECT}/assets`, { recursive: true });
for (const f of fs.readdirSync(`${PROJECT}/assets`)) if (f.startsWith('vo-')) fs.rmSync(`${PROJECT}/assets/${f}`);

// ── voice: a male British "crash-test announcer" (Kokoro bm_george via `hyperframes tts`: local, free) ──
// Wayfare and Trellis use af_heart in first person; Airbag uses another voice and speaks like a test lab: short, factual lines.
const VOICE = arg('voice', 'af_bella'), VO_CACHE = `${ROOT}/demo-video/vo-crash`;
fs.mkdirSync(VO_CACHE, { recursive: true });
const ttsEnv = { ...process.env, HYPERFRAMES_PYTHON: process.env.HYPERFRAMES_PYTHON ?? `${os.homedir()}/.cache/hf-tts-venv/bin/python` };
const durOf = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
function tts(text, speed = 1.0) {
  const h = crypto.createHash('sha1').update(`${VOICE}|${speed}|${text}`).digest('hex').slice(0, 14);
  const f = `${VO_CACHE}/${h}.wav`;
  if (!fs.existsSync(f)) execFileSync('npx', ['--yes', HF, 'tts', text, '-v', VOICE, '-s', String(speed), '-o', f], { env: ttsEnv, stdio: 'ignore' });
  if (!fs.existsSync(f)) throw new Error(`tts failed: ${text}`);
  fs.copyFileSync(f, `${PROJECT}/assets/vo-${h}.wav`);
  return { file: `assets/vo-${h}.wav`, d: +durOf(f).toFixed(2), text };
}
// a line that must fit a fixed stretch of footage is re-voiced a little faster (up to 1.25x) if it's too long
function fit(text, slot) {
  let v = tts(text);
  for (const s of [1.1, 1.18, 1.25]) { if (v.d <= slot) break; v = tts(text, s); }
  if (v.d > slot + 0.6) console.warn(`  ! line runs ${(v.d - slot).toFixed(1)}s past its shot: "${text}"`);
  return v;
}
const AUDIO = [];
const say = (v, t) => { AUDIO.push({ ...v, t: +t.toFixed(2) }); return t + v.d; };

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const w2 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const words = (n) => (n >= 1000 ? String(n) : n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${w2(n % 100)}` : ''}` : w2(n));
const oddsW = words(Math.round(parseFloat(odds) || 68));
const premW = words(Math.round(parseFloat(M.quote.premium ?? '69') || 69));
const coverW = words(parseInt(cover, 10) || 0);

const L = {
  card: ['Crash test number one. Subject: Bitcoin. Impact: November twelfth, five p.m., U T C.',
    `Polymarket gives it a ${oddsW} percent chance of closing below seventy-four thousand dollars.`,
    'So if it crashes, who pays you?'],
  title: ['Airbag. Insurance on NEAR, built on Polymarket.'],
  rig: ['The rig. Polymarket sets the odds. A pinned oracle reads them inside a TEE, and the Airbag contract on NEAR prices the cover. Never below those odds.',
    'Then, the hook. The contract writes a Polygon transaction, NEAR’s MPC network signs it, and every policy becomes real YES and NO shares, on Polymarket’s own contract.',
    'When Polymarket decides, payouts go out automatically. On NEAR, or on Base.'],
  code: ['No private key, anywhere. The NEAR contract builds Polymarket’s split position call itself. The MPC network only signs it.'],
  status: [`Status: armed. ${coverW} dollars of cover, backed one to one on NEAR, and mirrored on Polymarket.`, 'Impact: November twelfth. Polymarket decides.'],
  outro: ['Airbag. Insure what Polymarket predicts.'],
};
const RUN_LINES = [
  ['market', `Live on testnet. The TEE oracle reads Polymarket: ${oddsW} percent.`],
  ['quote', `So a hundred dollars of cover costs about ${premW} dollars. Never below the odds.`],
  ['buy', 'A buyer takes cover, signed on NEAR.'],
  ['panel', 'Now the hook. The keeper asks NEAR’s MPC network to sign Polymarket’s split.'],
  ['split', 'Mined on Polygon. The cover is now real Polymarket shares.'],
  ['policy', 'The policy pays out automatically, if Polymarket resolves no.'],
  ['proof', 'And every step is public. On NEAR, and on Polygon.'],
];

// a scene lasts as long as its lines (and at least `min` seconds)
function scene(start, lines, min, lead = 0.5) {
  let t = start + lead;
  const at = [], d = [];
  for (const l of lines) { const v = tts(l); at.push(+t.toFixed(2)); d.push(v.d); t = say(v, t) + 0.35; }
  return { start, at, d, end: +Math.max(start + min, t + 0.6).toFixed(2) };
}

// ── timeline ──
const sCard = scene(0, L.card, 9.5, 0.4);
const sTitle = scene(sCard.end, L.title, 5, 0.5);
const sRig = scene(sTitle.end, L.rig, 20, 0.4);
const sCode = scene(sRig.end, L.code, 8, 0.6);
const T = { card: 0, title: sCard.end, rig: sTitle.end, code: sRig.end, run: sCode.end };
const SKIP = Math.max(0, M.market.t - 0.6), FD = +(M.end.t + 0.6 - SKIP).toFixed(2);
const at = (t) => +(T.run + (t - SKIP)).toFixed(2);
const RUN_END = +(T.run + FD).toFixed(2);
RUN_LINES.forEach(([k, text], i) => {
  const t0 = M[k].t + 0.3, t1 = i + 1 < RUN_LINES.length ? M[RUN_LINES[i + 1][0]].t : M.end.t + 0.6;
  say(fit(text, t1 - t0 - 0.25), at(t0));
});
const sStatus = scene(RUN_END, L.status, 9, 0.5);
const STATUS = RUN_END, STATUS_D = +(sStatus.end - RUN_END).toFixed(2);
const sOutro = scene(sStatus.end, L.outro, 6, 0.7);
const OUTRO = sStatus.end, OUTRO_D = +(sOutro.end - sStatus.end).toFixed(2), TOTAL = sOutro.end;

const A = [];
const fromTo = (sel, from, to, t) => A.push(`tl.fromTo(${JSON.stringify(sel)}, ${JSON.stringify(from)}, ${JSON.stringify(to)}, ${(+t).toFixed(2)})`);
const to = (sel, v, t) => A.push(`tl.to(${JSON.stringify(sel)}, ${JSON.stringify(v)}, ${(+t).toFixed(2)})`);
const set = (sel, v, t) => A.push(`tl.set(${JSON.stringify(sel)}, ${JSON.stringify(v)}, ${(+t).toFixed(2)})`);
const along = (s, i, frac) => s.at[i] + s.d[i] * frac; // a moment inside line i of scene s

// 1 · test card: rows appear as they're read
const CARD_ROWS = [['SUBJECT', 'BITCOIN'], ['IMPACT', 'NOV 12 · 17:00 UTC'], ['CONDITION', 'CLOSES BELOW $74,000'], ['POLYMARKET ODDS', odds]];
[0.3, 0.55, null, 0.15].forEach((f, i) => fromTo(`#cr${i}`, { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: .35 }, f === null ? along(sCard, 1, 0.55) : along(sCard, i === 3 ? 1 : 0, f)));
fromTo('#cr3 b', { scale: .6 }, { scale: 1, duration: .5, ease: 'back.out(2)' }, along(sCard, 1, 0.2));
fromTo('#card-q', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: .5 }, sCard.at[2]);
fromTo('#card-rec', { opacity: 0 }, { opacity: 1, duration: .3 }, .1);
to('#card', { opacity: 0, duration: .4 }, T.title - .4);

// 2 · title
fromTo('#title .logo', { opacity: 0, scale: .7 }, { opacity: 1, scale: 1, duration: .55, ease: 'back.out(1.8)' }, T.title + .15);
fromTo('#title h1', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: .5 }, along(sTitle, 0, 0.25));
fromTo('#title .tchips span', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .35, stagger: .2 }, along(sTitle, 0, 0.8));
to('#title', { opacity: 0, duration: .4 }, T.rig - .4);

// 3 · the rig: each part lights up as it's mentioned
const RIG = [
  ['#lane-near', T.rig + .2], ['#lane-poly', T.rig + .35], ['#lane-base', T.rig + .5],
  ['#p-pm', along(sRig, 0, .1)], ['#w-pm', along(sRig, 0, .22)], ['#p-tee', along(sRig, 0, .28)], ['#w-tee', along(sRig, 0, .5)],
  ['#p-airbag', along(sRig, 0, .58)], ['#n-tee', along(sRig, 0, .85)],
  ['#w-mpc', along(sRig, 1, .2)], ['#p-mpc', along(sRig, 1, .38)], ['#w-ctf', along(sRig, 1, .6)], ['#p-ctf', along(sRig, 1, .68)], ['#n-mpc', along(sRig, 1, .9)],
  ['#w-base', along(sRig, 2, .3)], ['#p-base', along(sRig, 2, .45)], ['#n-base', along(sRig, 2, .75)],
];
RIG.forEach(([sel, t]) => fromTo(sel, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, duration: .45, ease: 'back.out(1.6)' }, t));
fromTo('#rig h2', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .4 }, T.rig + .1);
to('#rig', { opacity: 0, duration: .4 }, T.code - .4);

// 4 · the code
fromTo('#code h2', { opacity: 0 }, { opacity: 1, duration: .4 }, T.code + .1);
[0.05, 0.4, 0.75].forEach((f, i) => {
  fromTo(`#code .file:nth-of-type(${i + 1})`, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: .45 }, along(sCode, 0, f));
  fromTo(`#code .file:nth-of-type(${i + 1}) .hl`, { backgroundColor: 'rgba(255,230,0,0)' }, { backgroundColor: 'rgba(255,230,0,.35)', duration: .4 }, along(sCode, 0, f) + .5);
});
to('#code', { opacity: 0, duration: .4 }, T.run - .4);

// 5 · live run: zooms (origin in % of the 1600x900 page), HUD callouts, ticker
fromTo('#vid', { opacity: 0 }, { opacity: 1, duration: .5 }, T.run);
fromTo('#hud', { opacity: 0 }, { opacity: 1, duration: .5 }, T.run + .3);
const ZOOMS = [
  [M.market.t, M.quote.t, 1.22, '50% 25%'],
  [M.quote.t, M.buy.t, 1.25, '22% 55%'],
  [M.buy.t, M.panel.t, 1.28, '62% 25%'],
  [M.panel.t, M.policy.t, 1.18, '50% 40%'],
  [M.policy.t, M.proof.t, 1.2, '30% 30%'],
];
for (const [a, b, s, o] of ZOOMS) {
  set('#vid', { transformOrigin: o }, at(a));
  to('#vid', { scale: s, duration: .9, ease: 'power2.inOut' }, at(a) + .25);
  to('#vid', { scale: 1, duration: .6, ease: 'power2.inOut' }, Math.max(at(a) + 1.3, at(b) - .7));
}
const CALLOUTS = [
  [M.market.t, '01 · SENSOR', `Polymarket odds, read on NEAR by a TEE oracle: <b>${esc(odds)}</b>`],
  [M.quote.t, '02 · PRICE', `premium = max(AMM, Polymarket odds) + fee → <b>${esc(M.quote.premium ?? '')}</b> for 100 cover`],
  [M.buy.t, '03 · BUY', 'a buyer takes <b>100 USDC</b> of cover, signed on NEAR'],
  [M.panel.t, '04 · THE HOOK', 'NEAR MPC signs Polymarket’s <b>splitPosition</b> on Polygon'],
  [M.split.t, '04 · THE HOOK', `the cover is now real Polymarket shares: <b>${esc(shares)}</b>`],
  [M.policy.t, '05 · POLICY', 'pays automatically if Polymarket resolves <b>NO</b>'],
  [M.proof.t, '06 · PROOF', 'every NEAR and Polygon transaction, public'],
];
CALLOUTS.forEach(([t, , ], i) => {
  fromTo(`#co${i}`, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: .35 }, at(t) + .2);
  const next = CALLOUTS[i + 1]?.[0] ?? M.end.t;
  to(`#co${i}`, { opacity: 0, duration: .25 }, at(next) - .05);
});
const EVENTS = [
  ['near', M.market.t, `TEE oracle → odds ${refresh ? (refresh[1] / 100).toFixed(2) + '%' : odds}`, refresh?.[2]],
  ['near', M.bought.t, 'buy · 100 USDC cover', M.bought.tx],
  ['near', M.split.t - 2.2, 'MPC signs splitPosition', M.split.near_sign],
  ['poly', M.split.t - .6, 'Polymarket CTF · splitPosition', M.split.polygon],
  ['base', M.policy.t, 'payout armed · NEAR or Base', null],
];
const laneN = { near: 0, poly: 0, base: 0 };
const evHtml = EVENTS.map(([lane, t, label, hash], i) => {
  const x = laneN[lane]++ * 520;
  fromTo(`#ev${i}`, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .4, ease: 'back.out(2)' }, Math.max(T.run + .6, at(t)));
  return `<div class="ev ev-${lane}" id="ev${i}" style="left:${x}px">${esc(label)}${hash ? ` <i>${esc(short(hash))}</i>` : ''}</div>`;
});
to(['#vid', '#hud'], { opacity: 0, duration: .5 }, RUN_END - .5);

// 6 · status
fromTo('#status .st-k', { opacity: 0 }, { opacity: 1, duration: .3 }, STATUS + .2);
fromTo('#status .st-big', { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .5, ease: 'back.out(2)' }, sStatus.at[0]);
fromTo('#status .st-row', { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: .35, stagger: sStatus.d[0] * .25 }, along(sStatus, 0, .25));
fromTo('#status .st-foot', { opacity: 0 }, { opacity: 1, duration: .4 }, sStatus.at[1]);
to('#status', { opacity: 0, duration: .4 }, OUTRO - .4);

// 7 · outro
fromTo('#outro .logo', { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .5, ease: 'back.out(1.8)' }, OUTRO + .2);
fromTo('#outro .o-line', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: .4, stagger: .35 }, OUTRO + .8);

// ── HTML ──
const PX = ['..XXXX..', '.XXXXXX.', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', 'XXXXXXXX', '.XXXXXX.', '..XXXX..'];
const mark = `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" width="100%" height="100%"><rect x="0.5" y="0.5" width="11" height="11" fill="#fff" stroke="#000" stroke-width="1"/>${PX.flatMap((r, y) => [...r].map((c, x) => (c === 'X' ? `<rect x="${x + 2}" y="${y + 2}" width="1" height="1" fill="${(x + y) % 3 === 0 ? '#d61f4f' : '#ff3366'}"/>` : ''))).join('')}<rect x="4" y="4" width="1" height="1" fill="#fff"/></svg>`;
const logo = (big) => `<div class="logo${big ? ' big' : ''}"><span class="m">${mark}</span><span class="w">AIR<em>BAG</em></span></div>`;
const hazard = `<div class="hz top"></div><div class="hz bot"></div>`;

const code1 = [
  ['// contracts/airbag/src/lib.rs · every policy bought on NEAR…', 'c'],
  ['s.queue(Some(mid), "split", &cfg.ctf,', 'hl'],
  ['    polymarket::split_position(&collateral, &condition, x), 300_000);', 'hl'],
];
const code2 = [
  ['// polymarket.rs · …becomes Polymarket’s own call, encoded on NEAR', 'c'],
  ['call("splitPosition(address,bytes32,bytes32,uint256[],uint256)",', 'hl'],
  ['     &[w_addr(collateral), [0; 32], *condition_id, …, w_u(amount), …])', ''],
];
const code3 = [
  ['// lib.rs · pm_sign: NEAR MPC signs exactly that transaction', 'c'],
  ['let digest = polymarket::signing_hash(&tx);   // EIP-1559, Polygon', 'hl'],
  ['Promise::new(mpc).function_call("sign", { payload: digest, path: "airbag-float" })', ''],
];
const codeBlock = (lines) => lines.map(([l, k]) => `<div class="ln ${k}">${esc(l)}</div>`).join('');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;700;800&display=swap" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${C.ink}; }
      #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: ${C.ink}; color: #fff; font-family: 'Space Grotesk', sans-serif; }
      .clip { position: absolute; inset: 0; }
      .mono { font-family: 'JetBrains Mono', monospace; }
      .hz { position: absolute; left: 0; right: 0; height: 26px; background: repeating-linear-gradient(-45deg, ${C.yellow} 0 26px, #000 26px 52px); }
      .hz.top { top: 0; } .hz.bot { bottom: 0; }
      .logo { display: inline-flex; align-items: center; gap: 20px; }
      .logo .m { width: 72px; height: 72px; display: block; box-shadow: 6px 6px 0 #000; }
      .logo .w { font: 700 54px 'Space Grotesk'; letter-spacing: .02em; }
      .logo .w em { font-style: normal; color: ${C.coral}; }
      .logo.big .m { width: 130px; height: 130px; box-shadow: 10px 10px 0 #000; }
      .logo.big .w { font-size: 120px; color: #000; }
      /* test card */
      #card { background: ${C.ink}; }
      #card-rec { position: absolute; left: 110px; top: 90px; font: 800 26px 'JetBrains Mono'; letter-spacing: .12em; color: #fff; }
      #card-rec i { display: inline-block; width: 20px; height: 20px; border-radius: 50%; background: ${C.coral}; margin-right: 14px; vertical-align: -2px; }
      #card-rec span { color: #888; margin-left: 30px; }
      #card-rows { position: absolute; left: 110px; top: 250px; }
      .cr { display: flex; align-items: baseline; gap: 40px; margin-bottom: 34px; font: 700 50px 'JetBrains Mono'; }
      .cr span { width: 560px; color: #8a8a8a; font-size: 34px; letter-spacing: .1em; }
      .cr b { display: inline-block; transform-origin: left center; }
      #cr3 b { color: ${C.coral}; font-size: 110px; }
      #card-q { position: absolute; left: 110px; bottom: 120px; font: 700 64px 'Space Grotesk'; }
      #card-q em { font-style: normal; background: ${C.yellow}; color: #000; padding: 0 14px; }
      /* title */
      #title { background: ${C.yellow}; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 40px; color: #000; }
      #title h1 { font: 700 58px 'Space Grotesk'; text-align: center; line-height: 1.15; }
      #title h1 b { background: #000; color: ${C.yellow}; padding: 0 14px; }
      .tchips { display: flex; gap: 18px; }
      .tchips span { font: 700 24px 'JetBrains Mono'; background: #fff; border: 4px solid #000; box-shadow: 6px 6px 0 #000; padding: 10px 18px; }
      /* rig */
      #rig { background: ${C.ink}; }
      #rig h2 { position: absolute; left: 110px; top: 70px; font: 700 58px 'Space Grotesk'; }
      #rig h2 span { font: 700 24px 'JetBrains Mono'; color: ${C.yellow}; display: block; letter-spacing: .14em; margin-bottom: 8px; }
      .lane { position: absolute; left: 60px; right: 60px; height: 210px; border: 3px dashed #444; }
      .lane > label { position: absolute; left: 20px; top: 16px; font: 800 22px 'JetBrains Mono'; letter-spacing: .14em; }
      #lane-near { top: 230px; } #lane-near > label { color: ${C.cyan}; }
      #lane-poly { top: 490px; } #lane-poly > label { color: #c084fc; }
      #lane-base { top: 750px; height: 170px; } #lane-base > label { color: #7aa2ff; }
      .part { position: absolute; border: 4px solid #000; box-shadow: 8px 8px 0 #000; color: #000; padding: 16px 22px; transform-origin: center; }
      .part b { display: block; font: 700 34px 'Space Grotesk'; line-height: 1.1; }
      .part small { display: block; margin-top: 8px; font: 600 20px 'JetBrains Mono'; }
      .part .tag { display: inline-block; font: 800 16px 'JetBrains Mono'; background: #000; color: #fff; padding: 2px 8px; margin-bottom: 10px; letter-spacing: .08em; }
      #p-pm { left: 110px; top: 285px; width: 380px; background: ${C.lilac}; }
      #p-tee { left: 610px; top: 285px; width: 440px; background: #fff; }
      #p-airbag { left: 1170px; top: 270px; width: 560px; background: ${C.cyan}; }
      #p-mpc { left: 1240px; top: 532px; width: 420px; background: #fff; }
      #p-ctf { left: 610px; top: 545px; width: 460px; background: ${C.lilac}; }
      #p-base { left: 1240px; top: 790px; width: 420px; background: ${C.green}; }
      .wire { position: absolute; background: ${C.yellow}; transform-origin: left center; }
      .wire::after { content: ''; position: absolute; border: 13px solid transparent; }
      #w-pm { left: 486px; top: 352px; width: 108px; height: 8px; } #w-pm::after { right: -18px; top: -9px; border-left: 18px solid ${C.yellow}; border-right: 0; }
      #w-tee { left: 1046px; top: 352px; width: 108px; height: 8px; } #w-tee::after { right: -18px; top: -9px; border-left: 18px solid ${C.yellow}; border-right: 0; }
      #w-mpc { left: 1446px; top: 418px; width: 8px; height: 100px; transform-origin: center top; } #w-mpc::after { bottom: -18px; left: -9px; border-top: 18px solid ${C.yellow}; border-bottom: 0; }
      #w-ctf { left: 1090px; top: 610px; width: 132px; height: 8px; transform-origin: right center; } #w-ctf::after { left: -18px; top: -9px; border-right: 18px solid ${C.yellow}; border-left: 0; }
      #w-base { left: 1446px; top: 676px; width: 8px; height: 98px; transform-origin: center top; } #w-base::after { bottom: -18px; left: -9px; border-top: 18px solid ${C.yellow}; border-bottom: 0; }
      .note { position: absolute; font: 700 22px 'JetBrains Mono'; color: ${C.yellow}; }
      #n-tee { left: 610px; top: 452px; } #n-mpc { left: 610px; top: 712px; } #n-base { left: 110px; top: 840px; color: ${C.green}; }
      /* code */
      #code { background: ${C.ink}; padding: 80px 110px; }
      #code h2 { font: 700 54px 'Space Grotesk'; margin-bottom: 40px; }
      #code h2 em { font-style: normal; color: ${C.yellow}; }
      .file { background: #16161a; border: 3px solid #333; padding: 20px 26px; margin-bottom: 24px; }
      .ln { font: 600 25px/1.55 'JetBrains Mono'; white-space: pre; color: #e5e5e5; }
      .ln.c { color: #7c7c86; }
      .ln.hl { color: #fff; }
      /* live run */
      #vid { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; z-index: 2; }
      #hud { z-index: 6; pointer-events: none; }
      #hud .rec { position: absolute; left: 34px; top: 30px; font: 800 20px 'JetBrains Mono'; letter-spacing: .1em; background: rgba(11,11,13,.92); padding: 10px 16px; border: 3px solid #000; }
      #hud .rec i { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: ${C.coral}; margin-right: 10px; }
      .co { position: absolute; left: 34px; bottom: 196px; max-width: 980px; background: ${C.yellow}; color: #000; border: 4px solid #000; box-shadow: 8px 8px 0 #000; padding: 14px 20px; opacity: 0; }
      .co span { display: block; font: 800 18px 'JetBrains Mono'; letter-spacing: .12em; }
      .co div { font: 700 32px 'Space Grotesk'; margin-top: 4px; line-height: 1.2; }
      .co b { background: #000; color: ${C.yellow}; padding: 0 8px; }
      #ticker { position: absolute; left: 0; right: 0; bottom: 0; height: 168px; background: rgba(11,11,13,.94); border-top: 4px solid ${C.yellow}; }
      .tl { position: absolute; left: 0; right: 0; height: 50px; display: flex; align-items: center; }
      .tl > label { width: 190px; padding-left: 34px; font: 800 20px 'JetBrains Mono'; letter-spacing: .1em; }
      .tl .track { position: relative; flex: 1; height: 40px; }
      #tl-near { top: 8px; } #tl-near > label { color: ${C.cyan}; }
      #tl-poly { top: 59px; } #tl-poly > label { color: #c084fc; }
      #tl-base { top: 110px; } #tl-base > label { color: #7aa2ff; }
      .ev { position: absolute; top: 2px; height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 14px; font: 700 18px 'JetBrains Mono'; color: #000; border: 3px solid #000; white-space: nowrap; opacity: 0; transform-origin: left center; }
      .ev i { font-style: normal; font-weight: 500; opacity: .75; }
      .ev-near { background: ${C.cyan}; } .ev-poly { background: ${C.lilac}; } .ev-base { background: ${C.green}; }
      /* status */
      #status { background: ${C.ink}; padding: 120px 110px; }
      .st-k { font: 800 26px 'JetBrains Mono'; letter-spacing: .14em; color: #888; }
      .st-big { display: inline-block; margin: 18px 0 44px; font: 700 120px 'Space Grotesk'; color: #000; background: ${C.green}; padding: 0 30px; border: 5px solid #000; box-shadow: 12px 12px 0 #333; transform-origin: left center; }
      .st-row { font: 700 40px 'JetBrains Mono'; margin-bottom: 18px; }
      .st-row span { color: #888; display: inline-block; width: 560px; font-size: 28px; letter-spacing: .08em; }
      .st-foot { position: absolute; left: 110px; bottom: 110px; font: 700 36px 'Space Grotesk'; color: ${C.yellow}; }
      /* outro */
      #outro { background: ${C.yellow}; color: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; }
      .o-line { font: 700 44px 'Space Grotesk'; }
      .o-line.mono { font: 700 26px 'JetBrains Mono'; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">

      <section id="card" class="clip" data-start="0" data-duration="${T.title}" data-track-index="0">
        <div id="card-rec"><i></i>REC · CRASH TEST #001<span>NEAR TESTNET · POLYGON AMOY</span></div>
        <div id="card-rows">
          ${CARD_ROWS.map(([k, v], i) => `<div class="cr" id="cr${i}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('\n          ')}
        </div>
        <div id="card-q">If it crashes, <em>who pays you?</em></div>
        ${hazard}
      </section>

      <section id="title" class="clip" data-start="${T.title}" data-duration="${T.rig - T.title}" data-track-index="0">
        ${logo(true)}
        <h1>Insurance on <b>NEAR</b>,<br/>built on <b>Polymarket</b>.</h1>
        <div class="tchips"><span>cover AMM on NEAR</span><span>odds read in a TEE</span><span>Polymarket CTF via Chain Signatures</span></div>
      </section>

      <section id="rig" class="clip" data-start="${T.rig}" data-duration="${T.code - T.rig}" data-track-index="0">
        <h2><span>THE RIG</span>One NEAR contract. Three chains.</h2>
        <div class="lane" id="lane-near"><label>NEAR</label></div>
        <div class="lane" id="lane-poly"><label>POLYGON</label></div>
        <div class="lane" id="lane-base"><label>BASE</label></div>
        <div class="part" id="p-pm"><span class="tag">POLYMARKET</span><b>Live odds</b><small>odds · results</small></div>
        <div class="wire" id="w-pm"></div>
        <div class="part" id="p-tee"><span class="tag">OUTLAYER TEE</span><b>Pinned oracle</b><small>Intel TDX · pinned sha256</small></div>
        <div class="wire" id="w-tee"></div>
        <div class="part" id="p-airbag"><span class="tag">NEAR CONTRACT</span><b>Airbag</b><small>cover AMM · policies · underwriters<br/>premium = max(AMM, odds) + fee</small></div>
        <div class="note" id="n-tee">no oracle key: only that code’s answers count</div>
        <div class="wire" id="w-mpc"></div>
        <div class="part" id="p-mpc"><span class="tag">CHAIN SIGNATURES</span><b>NEAR MPC signs</b><small>Polygon + Base wallet, no private key</small></div>
        <div class="wire" id="w-ctf"></div>
        <div class="part" id="p-ctf"><span class="tag">POLYMARKET CTF</span><b>Real YES + NO shares</b><small>split · reportPayouts · redeem</small></div>
        <div class="note" id="n-mpc">a hook on Polymarket’s own contracts</div>
        <div class="wire" id="w-base"></div>
        <div class="part" id="p-base"><span class="tag">USDC</span><b>Automatic payouts</b><small>on NEAR, or on Base</small></div>
        <div class="note" id="n-base">paid when Polymarket resolves · no claim form</div>
      </section>

      <section id="code" class="clip" data-start="${T.code}" data-duration="${T.run - T.code}" data-track-index="0">
        <h2>The NEAR contract <em>writes the Polygon transaction</em>. MPC only signs it.</h2>
        <div class="file">${codeBlock(code1)}</div>
        <div class="file">${codeBlock(code2)}</div>
        <div class="file">${codeBlock(code3)}</div>
      </section>

      <!-- the footage is a direct child of the stage, timed on its own -->
      <video id="vid" class="clip" src="assets/crash.mp4" muted playsinline data-start="${T.run}" data-duration="${FD}" data-media-start="${SKIP.toFixed(2)}" data-track-index="1"></video>
      <section id="hud" class="clip" data-start="${T.run}" data-duration="${FD}" data-track-index="2">
        <div class="rec"><i></i>LIVE · CRASH TEST #001 · REAL TRANSACTIONS · WAITS SPED UP</div>
        ${CALLOUTS.map(([, k, v], i) => `<div class="co" id="co${i}"><span>${esc(k)}</span><div>${v}</div></div>`).join('\n        ')}
        <div id="ticker">
          <div class="tl" id="tl-near"><label>NEAR</label><div class="track">${evHtml.filter((h) => h.includes('ev-near')).join('')}</div></div>
          <div class="tl" id="tl-poly"><label>POLYGON</label><div class="track">${evHtml.filter((h) => h.includes('ev-poly')).join('')}</div></div>
          <div class="tl" id="tl-base"><label>BASE</label><div class="track">${evHtml.filter((h) => h.includes('ev-base')).join('')}</div></div>
        </div>
      </section>

      <section id="status" class="clip" data-start="${STATUS}" data-duration="${STATUS_D}" data-track-index="0">
        <div class="st-k">CRASH TEST #001 · STATUS</div>
        <div class="st-big">AIRBAG ARMED</div>
        <div class="st-row"><span>COVER IN FORCE</span>${esc(cover)} USDC · backed 1:1 on NEAR</div>
        <div class="st-row"><span>ON POLYMARKET'S CTF</span>${esc(shares)}</div>
        <div class="st-row"><span>IF BTC CLOSES &lt; $74K</span>pays 100% · NEAR or Base · automatic</div>
        <div class="st-foot">Impact: Nov 12, 17:00 UTC. Polymarket decides.</div>
        ${hazard}
      </section>

      <section id="outro" class="clip" data-start="${OUTRO}" data-duration="${OUTRO_D}" data-track-index="0">
        ${logo(true)}
        <div class="o-line">Insure what Polymarket predicts.</div>
        <div class="o-line mono">NEAR contract · OutLayer TEE · Chain Signatures · Polymarket CTF</div>
      </section>
${AUDIO.map((a, i) => `      <audio id="vo${i}" src="${a.file}" data-start="${a.t}" data-duration="${a.d}" data-volume="1" data-track-index="${3 + (i % 2)}"></audio>`).join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${A.join(';\n      ')};
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;

fs.copyFileSync(video, `${PROJECT}/assets/crash.mp4`);
fs.writeFileSync(`${PROJECT}/index.html`, html);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
fs.writeFileSync(`${PROJECT}/narration.txt`, AUDIO.map((a) => `${a.t.toFixed(1).padStart(6)}s  ${a.text}`).join('\n') + '\n');
console.log(`crash composition: card ${T.title}s + title + rig + code (run starts ${T.run}s) + footage ${FD}s + status ${STATUS_D}s + outro ${OUTRO_D}s = ${TOTAL}s (${mmss(TOTAL)}) · ${EVENTS.length} ticker events · ${AUDIO.length} voice lines (${VOICE})`);
