// Builds the landing: index.html (English) and es/index.html (Spanish) from src/content.mjs.
//   node site/build.mjs
// The output is committed, so the site deploys as plain static files (Vercel: root directory `site`, no build).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { content } from './src/content.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SITE = 'https://postbay.app';
const REPO = 'https://github.com/illodev/postbay';
const DOCS = `${REPO}/tree/main/docs`;
const DEPLOY = `${REPO}/blob/main/docs/deploying.md`;
const PLUGIN = `${REPO}/tree/main/integrations/claude-code`;
const DBC = 'https://github.com/illodev/drawn-by-code';
const net = JSON.parse(fs.readFileSync(path.join(here, 'src/networks.json'), 'utf8'));
const lockup = fs.readFileSync(path.join(here, '../docs/brand/postbay-logo-dark.svg'), 'utf8')
  .replace('<svg ', '<svg class="logo" role="img" aria-label="Postbay" ');

/** A short hash of an asset, added to its URL: assets are cached for a day, so a changed file needs a new URL. */
const ver = (f) => createHash('sha256').update(fs.readFileSync(path.join(here, f))).digest('hex').slice(0, 10);
const CSS_V = ver('assets/site.css');
const JS_V = ver('assets/site.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A network's logo on a dark tile, as in the app. */
function netLogo(n) {
  const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  switch (n) {
    case 'instagram': return svg(`<defs><radialGradient id="ig" cx=".3" cy="1.07" r="1.2"><stop offset="0" stop-color="#fdf497"/><stop offset=".1" stop-color="#fdf497"/><stop offset=".45" stop-color="#fd5949"/><stop offset=".65" stop-color="#d6249f"/><stop offset=".95" stop-color="#285aeb"/></radialGradient></defs><path fill="url(#ig)" d="${net.instagram}"/>`);
    case 'facebook': return svg(`<circle cx="12" cy="12" r="11" fill="#fff"/><path fill="#0866ff" d="${net.facebook}"/>`);
    case 'youtube': return svg(`<rect x="8.5" y="7.5" width="8" height="9" fill="#fff"/><path fill="#ff0000" d="${net.youtube}"/>`);
    case 'pinterest': return svg(`<circle cx="12" cy="12" r="10.5" fill="#fff"/><path fill="#e60023" d="${net.pinterest}"/>`);
    case 'tiktok': return svg(`<path fill="#25f4ee" transform="translate(-.7 -.7)" d="${net.tiktok}"/><path fill="#fe2c55" transform="translate(.7 .7)" d="${net.tiktok}"/><path fill="#fff" d="${net.tiktok}"/>`);
    case 'x': case 'threads': return svg(`<path fill="#fff" d="${net[n]}"/>`);
    case 'bluesky': return svg(`<path fill="#1185fe" d="${net.bluesky}"/>`);
    case 'linkedin': return svg(`<rect width="24" height="24" rx="4" fill="#0a66c2"/><path fill="#fff" d="${net.linkedin_in}"/>`);
    default: return '';
  }
}
/** The same logos in one colour, for the strip under the hero. */
function netMono(n) {
  const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  if (n === 'linkedin') return svg(`<rect width="24" height="24" rx="4" fill="currentColor"/><path fill="var(--bg)" d="${net.linkedin_in}"/>`);
  return svg(`<path fill="currentColor" fill-rule="evenodd" d="${net[n]}"/>`);
}
const NETWORKS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['tiktok', 'TikTok'], ['linkedin', 'LinkedIn'], ['x', 'X'], ['threads', 'Threads'], ['pinterest', 'Pinterest'], ['bluesky', 'Bluesky']];

const check = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const arrow = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const robot = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="8" width="14" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8V5M9.5 13h.01M14.5 13h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const back = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3m4-4L3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const play = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const gh = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** The hero: a review window that plays one round, from a comment to an approval (site.js drives the steps). */
function heroWindow(t, prefix) {
  const w = t.hero.win;
  const p = (f) => `${prefix}assets/img/p/${f}`;
  const strip = ['roast-1', 'roast-1', 'roast-1', 'roast-2', 'roast-2', 'roast-2', 'roast-2', 'roast-3', 'roast-3', 'roast-3']
    .map((f) => `<img src="${p(f + '-thumb.jpg')}" alt="" width="96" height="170">`).join('');
  return `<div class="stage" data-hw aria-hidden="true">
    <div class="hw">
      <div class="hw-bar">
        <span class="hw-crumbs">${back}<span class="muted hide-sm">${w.show}</span><span class="sep hide-sm">/</span><b>${w.piece}</b></span>
        <span class="hw-ver"><span class="v v1">v1</span><span class="v v2">v2</span>${chevron}</span>
        <span class="hw-sp"></span>
        <span class="hw-status hide-sm"><i></i><span class="st st-review">${w.inReview}</span><span class="st st-ok">${w.approved}</span></span>
        <span class="hw-avs hide-sm"><span class="av av-maya">MO</span><span class="av av-leo">LP</span><span class="av av-agent">${robot}</span></span>
        <span class="hw-btn hide-sm">${w.requestChanges}</span>
        <span class="hw-btn hw-approve">${check}${w.approve}</span>
      </div>
      <div class="hw-main">
        <div class="hw-stage">
          <div class="hw-frame">
            <img class="fr fr-1" src="${p('roast-1.jpg')}" alt="" width="540" height="960" fetchpriority="high">
            <img class="fr fr-2" src="${p('roast-2.jpg')}" alt="" width="540" height="960">
            <img class="fr fr-2b" src="${p('roast-2b.jpg')}" alt="" width="540" height="960">
            <svg class="hw-draw" viewBox="0 0 100 177.78"><path pathLength="1" d="M45 31.1C60 22.8 92 23.8 98 39.8C103 54.4 80 62.2 64 61.5C46 60.8 33 55.1 35 43.7C36.4 35.9 44 29.5 57 29"/></svg>
            <span class="hw-pin av av-maya">MO</span>
          </div>
          <div class="hw-tl">
            <div class="hw-ctl">${play}<span class="hw-time"><b data-now>0:00.0</b> / 0:09.2</span></div>
            <div class="hw-track">
              <div class="hw-strip">${strip}</div>
              <span class="mk mk-0 av av-maya" style="left:8.7%">MO</span>
              <span class="mk mk-1 av av-maya" style="left:37%">MO</span>
              <span class="hw-head" data-head></span>
            </div>
          </div>
        </div>
        <div class="hw-side">
          <div class="hw-tabs"><span class="on">${w.comments}</span><span>${w.details}</span></div>
          <div class="hw-threads">
            <div class="th th-0">
              <div class="th-head"><span class="av av-maya">MO</span><b>${w.maya}</b><span class="faint">${w.ago}</span><span class="th-done">${check}</span></div>
              <p><span class="tc">0:00.8</span> ${esc(w.first)}</p>
            </div>
            <div class="th th-1">
              <div class="th-head"><span class="av av-maya">MO</span><b>${w.maya}</b><span class="faint">${w.now}</span><span class="th-done">${check}</span></div>
              <p><span class="tc">0:03.4</span> ${esc(w.comment)}</p>
              <div class="grow g-work"><div><div class="th-work"><span class="av av-agent">${robot}</span><span>${w.working}</span><span class="dots"><i></i><i></i><i></i></span></div></div></div>
              <div class="grow g-reply"><div><div class="th-reply">
                <div class="th-head"><span class="av av-agent">${robot}</span><b class="agent">${w.agent}</b><span class="chip chip-good">${w.fixed}</span></div>
                <p>${esc(w.reply)}</p>
              </div></div></div>
              <div class="grow g-res"><div><div class="th-res">${check}${w.resolved}</div></div></div>
            </div>
          </div>
          <div class="hw-compose"><span class="tc" data-now>0:00.0</span><span>${w.compose}</span></div>
        </div>
      </div>
    </div>
    <div class="hw-toast">
      <span class="ok">${check}</span>
      <div><b>${w.approvedFor} <span class="net net-xs">${netLogo('instagram')}</span> @lumen.coffee</b><span class="muted">${w.by}<span class="hide-sm"> · <code>9b17539dcacb</code></span></span></div>
    </div>
  </div>`;
}

function reviewTiles(t, prefix) {
  const r = t.review;
  const p = (f) => `${prefix}assets/img/p/${f}`;
  const strip = Array.from({ length: 18 }, (_, i) => `<img src="${p(['roast-1', 'roast-2', 'roast-3'][Math.floor(i / 6)] + '-thumb.jpg')}" alt="" width="96" height="170" loading="lazy">`).join('');
  const caption = (c) => `<div class="tile-cap"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div>`;
  return `<div class="tiles">
    <article class="tile tile-wide">
      <div class="tile-art art-span" aria-hidden="true">
        <div class="sp-card"><span class="av av-leo">LP</span><div><b>${r.span.who}</b> <span class="tc">0:02.1 – 0:04.8</span><p>${esc(r.span.comment)}</p></div></div>
        <div class="sp-track">
          <div class="sp-strip">${strip}</div>
          <span class="sp-range"></span>
          <span class="sp-head"></span>
        </div>
        <div class="sp-scale">${[0, 2, 4, 6, 8].map((n) => `<span style="left:${(n / 9.2) * 100}%">0:0${n}</span>`).join('')}</div>
      </div>
      ${caption(r.span)}
    </article>
    <article class="tile">
      <div class="tile-art art-compare" aria-hidden="true">
        <div class="seg"><span>${r.compare.side}</span><span class="on">${r.compare.wipe}</span></div>
        <div class="wipe-wrap">
          <span class="wipe-tag">v1</span>
          <div class="wipe">
            <img src="${p('roast-2.jpg')}" alt="" width="540" height="960" loading="lazy">
            <img class="wipe-top" src="${p('roast-2b.jpg')}" alt="" width="540" height="960" loading="lazy">
            <span class="wipe-line"><i></i></span>
          </div>
          <span class="wipe-tag">v2</span>
        </div>
      </div>
      ${caption(r.compare)}
    </article>
    <article class="tile">
      <div class="tile-art art-cover" aria-hidden="true">
        <div class="seg seg-3"><span class="c1">Reels</span><span class="c2">TikTok</span><span class="c3">Shorts</span><i class="seg-on"></i></div>
        <div class="cover">
          <img src="${p('roast-1.jpg')}" alt="" width="540" height="960" loading="lazy">
          <div class="ghost g-reels"><b class="g-title">Reels</b><span class="g-col"><i></i><i></i><i></i><i></i></span><span class="g-cap"><i class="g-av"></i><i></i><i class="short"></i></span></div>
          <div class="ghost g-tiktok"><span class="g-tabs"><i></i><i></i></span><span class="g-col"><i class="g-av"></i><i></i><i></i><i></i><i></i></span><span class="g-cap"><i></i><i class="short"></i></span></div>
          <div class="ghost g-shorts"><span class="g-col"><i></i><i></i><i></i><i></i></span><span class="g-cap"><i class="g-av"></i><i class="g-sub"></i><i class="short"></i></span></div>
        </div>
      </div>
      ${caption(r.cover)}
    </article>
    <article class="tile tile-wide">
      <div class="tile-art art-pins" aria-hidden="true">
        <div class="slides">
          ${['latte-1', 'latte-2', 'latte-3', 'latte-4'].map((f) => `<div class="slide"><img src="${p(f + '.jpg')}" alt="" width="540" height="675" loading="lazy"></div>`).join('')}
          <span class="pin pin-a" style="--x:16.5%;--y:50%"><i class="av av-sam">SR</i><span class="bubble">${esc(r.pins.a)}</span></span>
          <span class="pin pin-b" style="--x:62%;--y:50%"><i class="av av-leo">LP</i><span class="bubble">${esc(r.pins.b)}</span></span>
        </div>
      </div>
      ${caption(r.pins)}
    </article>
  </div>`;
}

const caption = (c) => `<div class="tile-cap"><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div>`;
const head = (sec, href) => `<header class="sec-head" data-reveal>
    <h2>${sec.lines.map(esc).join('<br class="br"> ')}</h2>
    <div><p>${esc(sec.text)}</p><a class="quiet" href="${href}">${sec.link}${arrow}</a></div>
  </header>`;
/** Pieces that play in steps: site.js adds s1, s2… at these times (ms), then starts again after the last number. */
const loop = (times) => `data-loop="${times.join(',')}"`;

function approveTiles(t, prefix) {
  const a = t.approve;
  const p = (f) => `${prefix}assets/img/p/${f}`;
  return `<div class="tiles">
    <article class="tile tile-wide">
      <div class="tile-art art-bound" aria-hidden="true" ${loop([2600, 3200, 7600])} data-still="0">
        <div class="bound">
          <img src="${p('pumpkin.jpg')}" alt="" width="540" height="675" loading="lazy">
          <div class="bound-body">
            <b class="bound-title">Pumpkin spice is back</b>
            <span class="muted">v2 · 4:5 · Bold type</span>
            <div class="fp"><span class="muted">${a.bound.fingerprint}</span><code><span class="fp-a">9b17539dcacb<span class="faint">8f2a41e0</span></span><span class="fp-b">9b17539dcacb<span class="faint">8f2a</span><em>9</em><span class="faint">1e0</span></span></code></div>
            <div class="bound-ok">${check}<span>${a.bound.approvedFor}</span><span class="net net-xs">${netLogo('instagram')}</span><b>@lumen.coffee</b></div>
            <div class="bound-void"><i></i>${esc(a.bound.changed)}</div>
          </div>
        </div>
      </div>
      ${caption(a.bound)}
    </article>
    <article class="tile">
      <div class="tile-art art-own" aria-hidden="true" ${loop([900, 1700, 4600])}>
        <div class="own">
          <div class="own-row"><span class="av av-sam">SR</span><span>${a.own.uploaded}</span></div>
          <div class="own-btn"><span class="tip">${a.own.tip}</span><span class="hw-btn hw-approve off">${check}${a.own.approve}</span>
            <svg class="cursor" viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L10 19z" fill="#fff" stroke="#0b0c11" stroke-width="1.4" stroke-linejoin="round"/></svg></div>
        </div>
      </div>
      ${caption(a.own)}
    </article>
    <article class="tile">
      <div class="tile-art art-open" aria-hidden="true" ${loop([1400, 2800, 3600, 7200])}>
        <div class="open">
          <div class="oc oc-a"><i class="ring"></i>${check}<span class="av av-leo">LP</span><span>${esc(a.open.a)}</span></div>
          <div class="oc oc-b"><i class="ring"></i>${check}<span class="av av-sam">SR</span><span>${esc(a.open.b)}</span></div>
          <div class="open-btn"><span class="hw-btn n2">${a.open.openN(2)}</span><span class="hw-btn n1">${a.open.openN(1)}</span><span class="hw-btn hw-approve n0">${check}${a.open.approve}</span></div>
        </div>
      </div>
      ${caption(a.open)}
    </article>
    <article class="tile tile-wide">
      <div class="tile-art art-rules" aria-hidden="true" ${loop([900, 1700, 2500, 3600, 4600, 5300, 8600])}>
        <div class="rules">
          <div class="panel">
            <span class="panel-label">${a.rules.checklist}</span>
            ${a.rules.items.map((it, i) => `<div class="ck ck-${i + 1}"><i class="box">${check}</i><span>${esc(it)}</span></div>`).join('')}
          </div>
          <div class="panel">
            <span class="panel-label">${a.rules.approvals} <span class="count"><span class="k0">${a.rules.of(0, 2)}</span><span class="k1">${a.rules.of(1, 2)}</span><span class="k2">${a.rules.of(2, 2)}</span></span></span>
            <div class="appr"><span class="av av-maya">MO</span><b>Maya Ortiz</b>${check}</div>
            <div class="appr appr-2"><span class="av av-leo">LP</span><b>Leo Park</b>${check}</div>
            <span class="chip chip-good rules-ok">${check}${a.rules.approved}</span>
          </div>
        </div>
      </div>
      ${caption(a.rules)}
    </article>
  </div>`;
}

function publishTiles(t, prefix) {
  const u = t.publish;
  const th = (f) => `<img src="${prefix}assets/img/p/${f}-thumb.jpg" alt="" width="120" height="150" loading="lazy">`;
  const post = (time, n, f, extra = '') => `<div class="post ${extra}">${th(f)}<span class="post-time">${time}</span><span class="mono">${netMono(n)}</span>${extra === 'goes-out' ? `<span class="pub">${check}</span>` : ''}</div>`;
  const days = [
    [post('09:00', 'instagram', 'pumpkin'), post('18:30', 'facebook', 'ethiopia')],
    [post('08:00', 'linkedin', 'store-1'), `<div class="swap"><div class="post slot"><span class="slot-free">${u.week.free}</span><span class="slot-meta"><span class="post-time">19:00</span><span class="mono">${netMono('instagram')}</span></span></div>${post('19:00', 'instagram', 'latte-1', 'filled')}</div>`],
    [post('10:00', 'tiktok', 'roast-1', 'goes-out'), post('13:00', 'youtube', 'teaser-1')],
    [post('12:00', 'x', 'hours')],
    [post('09:00', 'instagram', 'ethiopia'), post('20:00', 'threads', 'latte-2')],
    [post('11:00', 'pinterest', 'latte-1')],
    null,
  ];
  return `<div class="tiles">
    <article class="tile tile-full">
      <div class="tile-art art-week" aria-hidden="true" ${loop([1400, 2800, 4600, 8400])}>
        <div class="week">
          ${u.week.days.map((d, i) => `<div class="day${i === 2 ? ' today' : ''}${days[i] ? '' : ' blocked'}">
            <span class="day-head">${d} <b>${12 + i}</b></span>
            <div class="day-body">${days[i] ? days[i].join('') : `<span class="blocked-label">${u.week.blocked}</span>`}</div>
          </div>`).join('')}
        </div>
      </div>
      ${caption(u.week)}
    </article>
    <article class="tile">
      <div class="tile-art art-hand" aria-hidden="true" ${loop([1500, 3300, 6400])}>
        <div class="hand">
          <div class="hand-head"><img src="${prefix}assets/img/p/hours-thumb.jpg" alt="" width="120" height="213" loading="lazy"><div><span class="chip chip-due">${u.hand.due}</span><span class="hand-meta">20:00 <span class="net net-xs">${netLogo('instagram')}</span> ${u.hand.files}</span></div></div>
          <div class="hand-row r1"><div><span class="muted">${u.hand.caption}</span><p>${esc(u.hand.captionText)}</p></div><span class="copy"><span class="c-a">${u.hand.copy}</span><span class="c-b">${check}${u.hand.copied}</span></span></div>
          <div class="hand-row r2"><div><span class="muted">${u.hand.first}</span><p>${esc(u.hand.firstText)}</p></div><span class="copy"><span class="c-a">${u.hand.copy}</span><span class="c-b">${check}${u.hand.copied}</span></span></div>
        </div>
      </div>
      ${caption(u.hand)}
    </article>
    <article class="tile">
      <div class="tile-art art-results" aria-hidden="true" ${loop([500, 6500])}>
        <div class="results">
          ${u.results.rows.map(([n, metric, value, pct]) => `<div class="res res-${n}"><span class="mono">${netMono(n)}</span><span class="muted">${metric}</span><b>${value}</b><span class="bar"><i style="--w:${pct}%"></i></span></div>`).join('')}
        </div>
      </div>
      ${caption(u.results)}
    </article>
    <article class="tile">
      <div class="tile-art art-pause" aria-hidden="true" ${loop([2400, 6000])}>
        <div class="pause">
          <div class="pause-head"><span class="p-on">${u.pause.on}</span><span class="p-off">${u.pause.off}</span><span class="switch"><i></i></span></div>
          ${[['19:00', 'instagram', 'latte-1'], ['20:00', 'threads', 'latte-2'], ['09:00', 'instagram', 'ethiopia']].map(([time, n, f]) => `<div class="held">${th(f)}<span class="post-time">${time}</span><span class="mono">${netMono(n)}</span><span class="chip chip-held">${u.pause.held}</span></div>`).join('')}
        </div>
      </div>
      ${caption(u.pause)}
    </article>
  </div>`;
}

function agentTiles(t, prefix) {
  const g = t.agents;
  return `<div class="tiles">
    <article class="tile tile-wide">
      <div class="tile-art art-run" aria-hidden="true" ${loop([600, 1400, 2200, 3000, 3800, 4600, 9000])}>
        <div class="run">
          <ol>${g.run.steps.map(([time, text], i) => `<li class="st-${i + 1}"><span class="run-time">${time}</span><i class="run-dot"></i><span>${esc(text)}</span></li>`).join('')}</ol>
          <div class="meters">
            <div class="meter"><span class="muted">${g.run.piece}</span><b>$0.42 <span class="faint">/ $2.00</span></b><span class="bar"><i style="--w:21%"></i></span></div>
            <div class="meter"><span class="muted">${g.run.month}</span><b>$7.10 <span class="faint">/ $40.00</span></b><span class="bar"><i style="--w:18%"></i></span></div>
          </div>
        </div>
      </div>
      ${caption(g.run)}
    </article>
    <article class="tile tile-dbc">
      <div class="tile-art art-dbc"><video src="${prefix}assets/video/drawn-by-code.mp4" poster="${prefix}assets/video/drawn-by-code.jpg" autoplay muted loop playsinline aria-hidden="true"></video></div>
      <div class="tile-cap"><h3>${esc(g.dbc.title)}</h3><p>${esc(g.dbc.text)}</p><a class="quiet" href="${DBC}">${g.dbc.link}${arrow}</a></div>
    </article>
  </div>
  <div class="principles" data-reveal>${g.rules.map(([h, x]) => `<div><h3>${esc(h)}</h3><p>${esc(x)}</p></div>`).join('')}</div>`;
}

function page(t, prefix) {
  const img = (name) => `${prefix}assets/img/${name}-${t.img}.jpg`;
  const other = t.lang === 'en' ? 'es' : 'en';
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)}</title>
<meta name="description" content="${esc(t.description)}">
<meta name="theme-color" content="#0a0b10">
<link rel="canonical" href="${SITE}${t.lang === 'en' ? '/' : '/es/'}">
<link rel="alternate" hreflang="en" href="${SITE}/">
<link rel="alternate" hreflang="es" href="${SITE}/es/">
<link rel="alternate" hreflang="x-default" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(t.title)}">
<meta property="og:description" content="${esc(t.description)}">
<meta property="og:image" content="${SITE}/assets/img/og.jpg">
<meta property="og:url" content="${SITE}${t.lang === 'en' ? '/' : '/es/'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${prefix}assets/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${prefix}assets/img/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${prefix}assets/img/apple-touch-icon.png">
<link rel="preload" href="${prefix}assets/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${prefix}assets/site.css?v=${CSS_V}">
</head>
<body>
<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="${prefix}" aria-label="Postbay">${lockup}</a>
    <nav class="nav-links" aria-label="${t.lang === 'en' ? 'Main' : 'Principal'}">
      <a href="#features">${t.nav.review}</a><a href="#approve">${t.nav.approve}</a><a href="#publish">${t.nav.publish}</a><a href="#agents">${t.nav.agents}</a><a href="#claude">${t.nav.claude}</a><a href="#self-host">${t.nav.selfhost}</a>
    </nav>
    <div class="nav-end">
      <a class="lang" href="${t.switchTo.href}" hreflang="${other}" lang="${other}">${t.switchTo.label}</a>
      <a class="btn btn-light btn-sm" href="${REPO}">${gh}<span>${t.nav.github}</span></a>
    </div>
  </div>
</header>

<main>
<section class="hero">
  <div class="wrap">
    <h1>${t.hero.lines.map(esc).join('<br class="br"> ')}</h1>
    <div class="hero-row">
      <p class="lead">${esc(t.hero.lead)}</p>
      <div class="hero-actions">
        <a class="btn btn-light" href="#self-host">${t.hero.primary}</a>
        <a class="quiet" href="${REPO}">${t.hero.quiet}${arrow}</a>
      </div>
    </div>
  </div>
  <div class="wrap hero-stage">${heroWindow(t, prefix)}</div>
  <div class="wrap strip">
    <ul>${NETWORKS.map(([id, name]) => `<li><span class="mono">${netMono(id)}</span><span class="sr">${name}</span></li>`).join('')}</ul>
    <p>${t.networks}</p>
  </div>
</section>

<section id="features" class="wrap section review">
  <header class="sec-head" data-reveal>
    <h2>${t.review.lines.map(esc).join('<br class="br"> ')}</h2>
    <div><p>${esc(t.review.text)}</p><a class="quiet" href="${REPO}/blob/main/docs/review.md">${t.review.link}${arrow}</a></div>
  </header>
  <div data-reveal>${reviewTiles(t, prefix)}</div>
</section>

<section id="approve" class="wrap section">
  ${head(t.approve, `${REPO}/blob/main/docs/review.md`)}
  <div data-reveal>${approveTiles(t, prefix)}</div>
</section>

<section id="publish" class="wrap section">
  ${head(t.publish, `${REPO}/blob/main/docs/publishing.md`)}
  <div data-reveal>${publishTiles(t, prefix)}</div>
</section>

<section id="agents" class="wrap section">
  ${head(t.agents, `${REPO}/blob/main/docs/agents.md`)}
  <div data-reveal>${agentTiles(t, prefix)}</div>
</section>

<section id="claude" class="wrap section">
  ${head(t.claude, PLUGIN)}
  <div class="tiles" data-reveal data-claude>
    <article class="tile tile-wide tile-term">
      <div class="tile-art art-term" aria-hidden="true">
        <div class="term">
          <p class="t-ask"><span class="prompt">&gt;</span> <span data-type="${esc(t.claude.terminal.ask)}"></span></p>
          <div class="t-answer">${t.claude.terminal.answer.map((l) => `<p>${l.startsWith('  ') ? '&nbsp;&nbsp;' + esc(l.trim()) : esc(l)}</p>`).join('')}</div>
        </div>
      </div>
    </article>
    <article class="tile">
      <div class="tile-art art-install">
        <pre class="code"><code><span class="c">$</span> claude plugin marketplace add \\
    illodev/postbay
<span class="c">$</span> claude plugin install \\
    postbay@postbay</code></pre>
      </div>
      ${caption(t.claude.install)}
    </article>
  </div>
</section>

<section id="self-host" class="wrap closing" data-reveal>
  <h2>${esc(t.selfhost.title)}</h2>
  <p>${esc(t.selfhost.text)}</p>
  <div class="cta"><a class="btn btn-light" href="${DEPLOY}">${t.selfhost.docs}</a><a class="btn" href="${REPO}">${gh}GitHub</a></div>
  <pre class="code"><code><span class="c">$</span> git clone ${REPO}.git &amp;&amp; cd postbay
<span class="c">$</span> cp deploy/.env.example deploy/.env   <span class="cm"># ${t.selfhost.comment}</span>
<span class="c">$</span> docker compose -f deploy/docker-compose.yml \\
    --env-file deploy/.env up -d --build</code></pre>
</section>
</main>

<footer class="wrap footer">
  <div class="foot-brand">
    <a class="brand" href="${prefix}" aria-label="Postbay">${lockup}</a>
    <p>${t.footer.oss}<br>${t.footer.by}</p>
  </div>
  <nav class="foot-cols" aria-label="Footer">
    <div><h4>${t.footer.product}</h4><a href="#features">${t.nav.review}</a><a href="#approve">${t.nav.approve}</a><a href="#publish">${t.nav.publish}</a><a href="#agents">${t.nav.agents}</a><a href="#claude">${t.nav.claude}</a></div>
    <div><h4>${t.footer.resources}</h4><a href="${DOCS}">${t.nav.docs}</a><a href="${DEPLOY}">${t.footer.deploy}</a><a href="${PLUGIN}">${t.footer.plugin}</a><a href="${REPO}">GitHub</a></div>
    <div><h4>${t.footer.more}</h4><a href="${DBC}">drawn-by-code</a><a href="${t.switchTo.href}" lang="${other}">${t.switchTo.label}</a></div>
  </nav>
</footer>
<script src="${prefix}assets/site.js?v=${JS_V}" defer></script>
</body>
</html>
`;
}

fs.writeFileSync(path.join(here, 'index.html'), page(content.en, '/'));
fs.mkdirSync(path.join(here, 'es'), { recursive: true });
fs.writeFileSync(path.join(here, 'es/index.html'), page(content.es, '/'));
console.log('site/index.html, site/es/index.html');
