// Sections fade in as they come into view; the terminal types its question, then shows the answer line by line.
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
