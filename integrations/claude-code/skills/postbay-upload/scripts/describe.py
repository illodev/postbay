#!/usr/bin/env python3
"""Describe files for Postbay's start_upload / start_uploads: name, type, exact size and sha256.

    python3 describe.py <file or folder>... > files.json

Folders are walked; only what Postbay accepts is listed (video, images, PDF, subtitles). Prints a JSON list of
{path, name, mime, bytes, sha256}; pass name/mime/bytes/sha256 to start_uploads, and keep the file for put.py.
"""
import hashlib, json, mimetypes, os, sys

ACCEPTED = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.pdf': 'application/pdf', '.vtt': 'text/vtt', '.srt': 'application/x-subrip',
}

def files(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                for n in sorted(names):
                    yield os.path.join(root, n)
        else:
            yield p

out = []
for f in files(sys.argv[1:]):
    ext = os.path.splitext(f)[1].lower()
    if ext not in ACCEPTED:
        continue
    h = hashlib.sha256()
    with open(f, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    out.append({'path': os.path.abspath(f), 'name': os.path.basename(f), 'mime': ACCEPTED[ext], 'bytes': os.path.getsize(f), 'sha256': h.hexdigest()})

names = [x['name'] for x in out]
dupes = sorted({n for n in names if names.count(n) > 1})
if dupes:
    print('Warning: these names appear more than once; put.py matches uploads by name, so rename them first: ' + ', '.join(dupes), file=sys.stderr)
json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
print()
