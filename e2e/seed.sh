#!/bin/sh
# Seeds the demo brand the end-to-end test expects: members in every role, two accounts, a checklist and
# Tuesday/Thursday slots. Needs the API running with AUTH_DEV_LOGIN=true and a bootstrapped admin@example.com
# (npm run bootstrap -w @estudio/api -- --workspace Demo --brand "Lumen Coffee" --timezone Europe/Madrid --admin admin@example.com).
set -e
BASE="${BASE_URL:-http://localhost:3000}"
JAR="$(mktemp)"
H1='content-type: application/json'
H2='x-requested-by: studio'
post() { curl -sf -b "$JAR" -H "$H1" -H "$H2" -X "$1" "$BASE$2" -d "$3" -o /dev/null; }

curl -sf -c "$JAR" -H "$H1" -H "$H2" -X POST "$BASE/api/auth/dev-login" -d '{"email":"admin@example.com"}' -o /dev/null
BRAND=$(curl -sf -b "$JAR" "$BASE/api/me" | python3 -c "import sys,json;print(json.load(sys.stdin)['brands'][0]['id'])")

post POST "/api/brands/$BRAND/members" '{"email":"approver@example.com","name":"Ana Approver","role":"approver"}'
post POST "/api/brands/$BRAND/members" '{"email":"reviewer@example.com","name":"Rafa Reviewer","role":"reviewer"}'
post POST "/api/brands/$BRAND/members" '{"email":"producer@example.com","name":"Paula Producer","role":"producer"}'
post POST "/api/brands/$BRAND/members" '{"email":"reader@example.com","name":"Rita Reader","role":"reader"}'
post POST "/api/brands/$BRAND/accounts" '{"network":"instagram","externalId":"lumen.coffee","displayName":"Lumen Coffee"}'
post POST "/api/brands/$BRAND/accounts" '{"network":"youtube","externalId":"@lumencoffee","displayName":"Lumen Coffee TV"}'
post PATCH "/api/brands/$BRAND" '{"rules":{"checklist":["Facts verified","Subtitles reviewed"]}}'
IG=$(curl -sf -b "$JAR" "$BASE/api/brands/$BRAND/accounts" | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin) if a['network']=='instagram'][0])")
for DAY in 2 4; do
  post POST "/api/brands/$BRAND/slots" "{\"accountId\":\"$IG\",\"weekday\":$DAY,\"localTime\":\"19:00\",\"label\":\"Reels\"}"
done
rm -f "$JAR"
echo "Seeded brand $BRAND"
