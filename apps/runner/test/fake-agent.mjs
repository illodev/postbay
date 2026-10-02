// A stand-in for the agent, driven by FAKE_AGENT_MODE. It reads the instructions on stdin and works in the run directory,
// the way a real agent would: previous files in input/previous, comments in input/comments.json, new files in output/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_AGENT_MODE ?? 'ok';
const instructions = readFileSync(0, 'utf8');
const cwd = process.cwd();
const out = path.join(cwd, 'output');
mkdirSync(out, { recursive: true });
const comments = existsSync('input/comments.json') ? JSON.parse(readFileSync('input/comments.json', 'utf8')) : [];
const previous = existsSync('input/previous') ? readdirSync('input/previous').filter((f) => /video/.test(f)) : [];
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tone = 'sine=frequency=1000:sample_rate=48000,volume=6dB';
const smooth = (w, h, s) => ['-f', 'lavfi', '-i', `nullsrc=s=${w}x${h}:r=25,geq=lum='40+X*60/W':cb=128:cr=128`, '-f', 'lavfi', '-i', tone, '-t', String(s), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'];

const decide = (c) => {
  if (/legal|licen[cs]e/i.test(c.body)) return { id: c.id, status: 'needs_human', reply: 'This needs a person to decide.' };
  if (/impossible|cannot/i.test(c.body)) return { id: c.id, status: 'cannot_do', reply: 'The source footage does not have what this needs.' };
  if (/forgotten/i.test(c.body)) return null; // the agent says nothing about this one
  return { id: c.id, status: 'fixed', reply: `Changed it: ${c.body.slice(0, 40)}` };
};
const result = (extra = {}) => ({
  notes: `Brightened the picture (${comments.length} comments)`,
  comments: comments.map(decide).filter(Boolean),
  ...extra,
});
const write = (r) => writeFileSync(path.join(out, 'result.json'), JSON.stringify(r));
const revise = (name = 'revised.mp4', vf = 'eq=brightness=0.08') => {
  const src = path.join('input/previous', previous[0]);
  ff(['-i', src, '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(out, name)]);
};

switch (mode) {
  case 'ok':
  case 'cost': {
    revise();
    write(result());
    if (mode === 'cost') console.log(JSON.stringify({ type: 'result', total_cost_usd: 0.42 }));
    break;
  }
  case 'crash':
    console.error('boom: the agent fell over');
    process.exit(3);
  case 'slow':
    await sleep(60_000);
    break;
  case 'nofiles':
    write(result());
    break;
  case 'declines':
    // Makes nothing and says why, comment by comment (and, for the "forgotten" one, nothing at all).
    write({
      notes: 'No new version: what was asked cannot be done from the files I have.',
      comments: comments.filter((c) => !/forgotten/i.test(c.body)).map((c) => ({ id: c.id, status: /impossible/i.test(c.body) ? 'cannot_do' : 'needs_human', reply: `Declined: ${c.body.slice(0, 30)}` })),
    });
    break;
  case 'identical':
    copyFileSync(path.join('input/previous', previous[0]), path.join(out, 'same.mp4'));
    write(result());
    break;
  case 'retry': {
    // Fails the checks first (half a second long), then does it properly once told what was wrong.
    if (instructions.includes('did not pass the automatic checks')) revise();
    else ff([...smooth(540, 960, 0.5), path.join(out, 'short.mp4')]);
    write(result());
    break;
  }
  case 'always-short':
    ff([...smooth(540, 960, 0.5), path.join(out, 'short.mp4')]);
    write(result());
    break;
  case 'sources': {
    mkdirSync('../../sources', { recursive: true });
    const dir = path.resolve(cwd, '..', '..', 'sources');
    const seen = existsSync(dir) ? readdirSync(dir) : [];
    writeFileSync(path.join(dir, `round-${Date.now()}.txt`), 'kept between rounds');
    revise();
    write(result({ notes: `sources seen: ${seen.join(',') || 'none'}` }));
    break;
  }
  case 'env': {
    revise();
    write(result({ notes: `env: ${Object.keys(process.env).sort().join(',')}` }));
    break;
  }
  case 'traversal':
    revise();
    write(result({ files: [{ path: `${'../'.repeat(20)}etc/passwd`, kind: 'video' }] }));
    break;
  case 'symlink-manifest':
    symlinkSync('/etc/passwd', path.join(out, 'looks-innocent.mp4'));
    write(result({ files: [{ path: 'looks-innocent.mp4', kind: 'video' }] }));
    break;
  case 'symlink-inferred':
    symlinkSync('/etc/passwd', path.join(out, 'looks-innocent.mp4'));
    write(result());
    break;
  case 'slotnew': {
    ff([...smooth(1080, 1920, 5), path.join(out, 'new.mp4')]);
    write({
      notes: 'A first cut for the empty slot',
      comments: [],
      piece: { title: 'Slot filler: the spring menu', kind: 'video', format: '9:16', brief: 'Show the spring menu in five seconds.' },
    });
    break;
  }
  case 'leak': {
    // What a prompt injection would get an agent to do with a secret it can read: put it everywhere the runner posts from.
    const secret = process.env.FAKE_LEAK;
    revise();
    writeFileSync(path.join(out, 'revised.vtt'), `WEBVTT\n\n00:00.000 --> 00:01.000\n${secret}\n`);
    console.error(`debug: ${secret}`);
    write(result({ notes: `Done. By the way: ${secret}`, comments: comments.map((c) => ({ id: c.id, status: 'fixed', reply: `here it is: ${secret}` })) }));
    break;
  }
  case 'leak-in-file':
    // Only a file carries it: a subtitle line the reviewers would read.
    revise();
    writeFileSync(path.join(out, 'revised.vtt'), `WEBVTT\n\n00:00.000 --> 00:01.000\n${process.env.FAKE_LEAK}\n`);
    write(result());
    break;
  case 'leak-crash':
    console.error(`token=${process.env.FAKE_LEAK}`);
    process.exit(3);
  case 'snoop': {
    // Tries to read what an agent must not see, and says which it could (never what is in them).
    const readable = (process.env.FAKE_SNOOP ?? '').split(',').filter(Boolean).filter((f) => {
      try { readFileSync(f); return true; } catch { return false; }
    });
    revise();
    write(result({ notes: `readable: ${readable.join(',') || 'none'}; uid ${process.getuid()}; pid ${process.pid}` }));
    break;
  }
  case 'instructions':
    revise();
    writeFileSync(path.join(cwd, 'seen-instructions.md'), instructions);
    write(result());
    break;
  default:
    console.error(`unknown mode ${mode}`);
    process.exit(2);
}
