import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Makes a small test video or image with ffmpeg: `src` is a lavfi source, `audio` an optional lavfi audio source. */
export function make(dir: string, name: string, o: { src: string; seconds?: number; audio?: string; size?: string; fps?: number; vf?: string }) {
  const out = path.join(dir, name);
  const isImage = /\.(png|jpg)$/.test(name);
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', o.src];
  if (!isImage && o.audio) args.push('-f', 'lavfi', '-i', o.audio);
  if (o.vf) args.push('-vf', o.vf);
  if (isImage) args.push('-frames:v', '1');
  else {
    args.push('-t', String(o.seconds ?? 5), '-r', String(o.fps ?? 25), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (o.audio) args.push('-c:a', 'aac', '-shortest');
  }
  args.push(out);
  execFileSync('ffmpeg', args, { stdio: 'pipe' });
  return out;
}

/** A smooth gradient everywhere, with a band of fine detail (stripes standing in for text) where `band` says. */
export const detailBand = (size: string, band: 'bottom' | 'middle' | 'everywhere' | 'none') => {
  const [w, h] = size.split('x').map(Number);
  // Detail sized for how the checks look at a frame (a 180 pixel wide copy), whatever the size of the file.
  const k = ((1.2 * 180) / w!).toFixed(4);
  const stripes = `128+100*sin(X*${k})*sin(Y*${k})`;
  const smooth = `40+X*60/W`;
  const where = { bottom: `gt(Y,H*0.88)`, middle: `between(Y,H*0.45,H*0.55)`, everywhere: '1', none: '0' }[band];
  return `nullsrc=s=${w}x${h}:r=25,geq=lum='if(${where},${stripes},${smooth})':cb=128:cr=128`;
};
