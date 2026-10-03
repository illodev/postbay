#!/bin/sh
# Generates the media the end-to-end test uploads: two short videos, two images, a three-page PDF, subtitles for the first video, and a
# big video (about 18 MB of noise, so it takes three pieces to send) for the resumable upload run (e2e/accounts-and-notifications.sh).
# WebM because the headless Chromium used for the test has no H.264 decoder; the app accepts MP4 as well.
set -e
OUT="${1:-e2e/assets}"
mkdir -p "$OUT"
ffmpeg -v error -y -f lavfi -i testsrc2=size=540x960:rate=30 -f lavfi -i sine=frequency=440 -t 6 \
  -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -c:a libvorbis -shortest "$OUT/reel-v1.webm"
ffmpeg -v error -y -f lavfi -i smptebars=size=540x960:rate=30 -f lavfi -i sine=frequency=660 -t 6 \
  -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -c:a libvorbis -shortest "$OUT/reel-v2.webm"
# Noise does not compress, so a short clip is big. It is only ever uploaded, never played.
ffmpeg -v error -y -f lavfi -i "nullsrc=size=640x360:rate=25,geq=random(1)*255:128:128" -f lavfi -i sine=frequency=330 -t 8 \
  -c:v libvpx-vp9 -b:v 20M -minrate 20M -maxrate 20M -deadline realtime -cpu-used 8 -c:a libvorbis -shortest "$OUT/big.webm"
cat > "$OUT/captions.vtt" <<'VTT'
WEBVTT

00:00:00.500 --> 00:00:02.000
Welcome to the <i>spring</i> menu

00:00:02.500 --> 00:00:04.000
Our flat white is back

00:00:04.500 --> 00:00:05.800
Come and try it today
VTT
ffmpeg -v error -y -f lavfi -i testsrc2=size=1080x1350 -frames:v 1 "$OUT/slide-1.png"
ffmpeg -v error -y -f lavfi -i smptebars=size=1080x1350 -frames:v 1 "$OUT/slide-2.png"
python3 - "$OUT/deck.pdf" <<'PY'
import sys
objs = []
def obj(s):
    objs.append(s)
    return len(objs)
cat = obj("<< /Type /Catalog /Pages 2 0 R >>")
pages = obj("PLACEHOLDER")
font = obj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
kids = []
for i in range(3):
    content = f"BT /F1 36 Tf 72 700 Td (Deck page {i + 1}) Tj ET BT /F1 18 Tf 72 640 Td (Quarterly content plan for the brand) Tj ET"
    c = obj(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")
    kids.append(obj(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {c} 0 R /Resources << /Font << /F1 {font} 0 R >> >> >>"))
objs[pages - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count 3 >>"
out, offs = "%PDF-1.4\n", []
for i, o in enumerate(objs, 1):
    offs.append(len(out))
    out += f"{i} 0 obj\n{o}\nendobj\n"
xref = len(out)
out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
out += f"trailer\n<< /Size {len(objs) + 1} /Root {cat} 0 R >>\nstartxref\n{xref}\n%%EOF\n"
open(sys.argv[1], "w").write(out)
PY
echo "Assets written to $OUT"
