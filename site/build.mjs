// Builds the landing: index.html (English) and es/index.html (Spanish) from src/content.mjs.
//   node site/build.mjs
// The output is committed, so the site deploys as plain static files (Vercel: root directory `site`, no build).
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
const points = (list) => `<ul class="points">${list.map((p) => `<li>${check}<span>${esc(p)}</span></li>`).join('')}</ul>`;
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
<link rel="stylesheet" href="${prefix}assets/site.css">
</head>
<body>
<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="${prefix}" aria-label="Postbay">${lockup}</a>
    <nav class="nav-links" aria-label="${t.lang === 'en' ? 'Main' : 'Principal'}">
      <a href="#features">${t.nav.features}</a><a href="#agents">${t.nav.agents}</a><a href="#claude">${t.nav.claude}</a><a href="#self-host">${t.nav.selfhost}</a><a href="${DOCS}">${t.nav.docs}</a>
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

<section class="wrap features">
  <article class="feature reverse" data-reveal>
    <div class="feature-text">
      <p class="kicker">${t.features.approve.kicker}</p>
      <h2>${esc(t.features.approve.title)}</h2>
      <p>${esc(t.features.approve.text)}</p>
    </div>
    <div class="feature-media">
      <div class="approval" aria-hidden="true">
        <div class="ap-row"><img src="${prefix}assets/img/approval-thumb.jpg" alt="" width="96" height="120"><div><b>Pumpkin spice is back</b><span class="muted">v2 · 4:5 · Bold type</span></div></div>
        <div class="ap-fp"><span class="muted">${t.features.approve.fingerprint}</span><code>9b17539dcacb<span class="fp-rest">8f2a…</span></code></div>
        <div class="ap-ok">${check}<span>${t.features.approve.approvedFor}</span><span class="net net-sm">${netLogo('instagram')}</span><b>@lumen.coffee</b></div>
        <div class="ap-void"><span class="dot"></span>${esc(t.features.approve.changed)}</div>
      </div>
    </div>
  </article>

  <article class="feature" data-reveal>
    <div class="feature-text">
      <p class="kicker">${t.features.publish.kicker}</p>
      <h2>${esc(t.features.publish.title)}</h2>
      <p>${esc(t.features.publish.text)}</p>
      ${points(t.features.publish.points)}
    </div>
    <div class="feature-media"><div class="window"><img src="${img('calendar')}" alt="" loading="lazy" width="2400" height="1500"></div></div>
  </article>
</section>

<section id="agents" class="band">
  <div class="wrap agents" data-reveal>
    <div>
      <p class="kicker k-agent">${t.agents.kicker}</p>
      <h2>${esc(t.agents.title)}</h2>
      <p>${esc(t.agents.text)}</p>
      ${points(t.agents.points)}
    </div>
    <div class="dbc">
      <video src="${prefix}assets/video/drawn-by-code.mp4" poster="${prefix}assets/video/drawn-by-code.jpg" autoplay muted loop playsinline aria-hidden="true"></video>
      <div class="dbc-text">
        <h3>${esc(t.agents.dbc.title)}</h3>
        <p>${esc(t.agents.dbc.text)}</p>
        <a class="link" href="${DBC}">${t.agents.dbc.link}${arrow}</a>
      </div>
    </div>
  </div>
</section>

<section id="claude" class="wrap claude" data-reveal>
  <div class="claude-text">
    <p class="kicker">${t.claude.kicker}</p>
    <h2>${esc(t.claude.title)}</h2>
    <p>${esc(t.claude.text)}</p>
    <p class="small"><a class="link" href="${PLUGIN}">${t.claude.install}${arrow}</a></p>
    <pre class="code"><code><span class="c">$</span> claude plugin marketplace add illodev/postbay
<span class="c">$</span> claude plugin install postbay@postbay</code></pre>
  </div>
  <div class="terminal" aria-hidden="true">
    <div class="term-bar"><i></i><i></i><i></i><span>claude</span></div>
    <div class="term-body">
      <p class="t-ask"><span class="prompt">&gt;</span> <span data-type="${esc(t.claude.terminal.ask)}"></span></p>
      <div class="t-answer">${t.claude.terminal.answer.map((l) => `<p>${l.startsWith('  ') ? '&nbsp;&nbsp;' + esc(l.trim()) : esc(l)}</p>`).join('')}</div>
    </div>
  </div>
</section>

<section id="self-host" class="band">
  <div class="wrap selfhost" data-reveal>
    <div>
      <p class="kicker">${t.selfhost.kicker}</p>
      <h2>${esc(t.selfhost.title)}</h2>
      <p>${esc(t.selfhost.text)}</p>
      <div class="cta"><a class="btn btn-primary" href="${DEPLOY}">${t.selfhost.docs}${arrow}</a><a class="btn" href="${REPO}">${gh}GitHub</a></div>
    </div>
    <pre class="code"><code><span class="c">$</span> git clone ${REPO}.git &amp;&amp; cd postbay
<span class="c">$</span> cp deploy/.env.example deploy/.env   <span class="cm"># ${t.lang === 'en' ? 'your domains and secrets' : 'tus dominios y secretos'}</span>
<span class="c">$</span> docker compose -f deploy/docker-compose.yml \\
    --env-file deploy/.env up -d --build</code></pre>
  </div>
</section>
</main>

<footer class="wrap footer">
  <a class="brand" href="${prefix}" aria-label="Postbay">${lockup}</a>
  <p>${t.footer.oss} ${t.footer.by} ${t.footer.sister} <a href="${DBC}">drawn-by-code</a>.</p>
  <nav><a href="${REPO}">GitHub</a><a href="${DOCS}">${t.nav.docs}</a><a href="${t.switchTo.href}" lang="${other}">${t.switchTo.label}</a></nav>
</footer>
<script src="${prefix}assets/site.js" defer></script>
</body>
</html>
`;
}

fs.writeFileSync(path.join(here, 'index.html'), page(content.en, '/'));
fs.mkdirSync(path.join(here, 'es'), { recursive: true });
fs.writeFileSync(path.join(here, 'es/index.html'), page(content.es, '/'));
console.log('site/index.html, site/es/index.html');
