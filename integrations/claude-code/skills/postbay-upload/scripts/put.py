#!/usr/bin/env python3
"""Send files to the signed URLs Postbay gave in start_upload / start_uploads.

    python3 put.py <uploads.json> <files.json>

uploads.json is the tool's answer, saved as it came ({"uploads": [...]} or {"items": [...]}); files.json is
describe.py's output. Each upload is matched to its file by name and sent with a PUT and exactly the headers
given. Exits non-zero if any file fails; storage refuses any byte that differs from what was declared.
"""
import json, sys, urllib.request

answer = json.load(open(sys.argv[1]))
paths = {f['name']: f['path'] for f in json.load(open(sys.argv[2]))}
uploads = answer.get('uploads') or [u for item in answer.get('items', []) if item.get('ok', True) for u in item.get('uploads', [])]
failed = 0
for u in uploads:
    path = paths.get(u['name'])
    if not path:
        print(f"missing  {u['name']}: not in files.json")
        failed += 1
        continue
    with open(path, 'rb') as fh:
        req = urllib.request.Request(u['url'], data=fh.read(), method=u.get('method', 'PUT'), headers=u.get('headers', {}))
    try:
        with urllib.request.urlopen(req) as r:
            print(f"{r.status}      {u['name']}")
    except Exception as e:  # noqa: BLE001 - report every failure and go on
        print(f"failed   {u['name']}: {e}")
        failed += 1
print(f"{len(uploads) - failed} sent, {failed} failed")
sys.exit(1 if failed else 0)
