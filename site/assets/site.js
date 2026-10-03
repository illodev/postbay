// Sections fade in as they come into view; the hero plays one round of review; the terminal types its question, then shows the answer.
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    seen.unobserve(e.target);
    if (e.target.id === 'claude') type(e.target);
  }
}, { threshold: 0.2 });
document.querySelectorAll('[data-reveal]').forEach((el) => seen.observe(el));

// The hero: the playhead runs to 0:03.4, Maya circles the 212°, the agent answers with v2, Maya approves. Then again.
const hw = document.querySelector('[data-hw]');
if (hw) hero(hw);

function hero(root) {
  const head = root.querySelector('[data-head]');
  const clocks = root.querySelectorAll('[data-now]');
  const LENGTH = 9.2;
  const show = (t) => {
    head.style.setProperty('--p', `${(t / LENGTH) * 100}%`);
    const s = `0:${t.toFixed(1).padStart(4, '0')}`;
    clocks.forEach((c) => { c.textContent = s; });
    root.dataset.frame = t < 3 ? '1' : root.classList.contains('s3') ? '2b' : '2';
  };
  const steps = (n) => { for (let i = 1; i <= 4; i++) root.classList.toggle(`s${i}`, i <= n); };

  if (still) { steps(4); show(3.4); return; }

  let timers = [];
  let raf = 0;
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const run = (from, to, ms) => {
    const start = performance.now();
    cancelAnimationFrame(raf);
    const tick = (now) => {
      const k = Math.min(1, (now - start) / ms);
      show(from + (to - from) * (1 - (1 - k) ** 2));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  const round = () => {
    steps(0); show(0);
    at(400, () => run(0, 3.4, 2300));
    at(2900, () => steps(1));
    at(5200, () => steps(2));
    at(7000, () => { steps(3); show(3.4); });
    at(9400, () => root.classList.add('press'));
    at(9700, () => { root.classList.remove('press'); steps(4); });
    at(14500, () => root.classList.add('fade'));
    at(15100, () => { steps(0); show(0); });
    at(15800, () => { root.classList.remove('fade'); round(); });
  };
  let playing = false;
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !playing) { playing = true; round(); }
    if (!e.isIntersecting && playing) { playing = false; timers.forEach(clearTimeout); timers = []; cancelAnimationFrame(raf); }
  }, { threshold: 0.25 }).observe(root);
}

function type(section) {
  const ask = section.querySelector('[data-type]');
  const lines = [...section.querySelectorAll('.t-answer p')];
  const text = ask.dataset.type;
  if (still) { ask.textContent = text; lines.forEach((l) => l.classList.add('on')); return; }
  let i = 0;
  ask.classList.add('caret');
  const tick = () => {
    ask.textContent = text.slice(0, ++i);
    if (i < text.length) return setTimeout(tick, 32 + Math.random() * 40);
    ask.classList.remove('caret');
    lines.forEach((l, n) => setTimeout(() => l.classList.add('on'), 500 + n * 260));
  };
  setTimeout(tick, 300);
}
