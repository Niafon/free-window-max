#!/bin/sh
# Pull-based continuous deployment (TZ §23) for the VPS, run by cron every 2 minutes.
# Deploys the newest main commit whose "Verify MVP" workflow succeeded; no GitHub secrets are needed.
# On a failed health check the previous commit is restored and rebuilt.
set -eu
REPO=${OKNO_REPO:-Niafon/free-window-max}
DIR=${OKNO_DIR:-/opt/okno}
COMPOSE="docker compose -f compose.yaml -f deploy/compose.vps.yaml"
exec 9>/var/lock/okno-deploy.lock
flock -n 9 || exit 0
cd "$DIR"

sha=$(curl -fsS -m 20 "https://api.github.com/repos/$REPO/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin).get("workflow_runs",[]); print(r[0]["head_sha"] if r else "")') || exit 0
current=$(git rev-parse HEAD)
[ -n "$sha" ] && [ "$sha" != "$current" ] || exit 0
git fetch -q origin main
# Only move forward: an older green commit (while a newer one is still in CI) is ignored.
git merge-base --is-ancestor "$current" "$sha" || exit 0

. ./.env
notify() {
  [ -n "${BOT_TOKEN:-}" ] && [ -n "${OKNO_NOTIFY_MAX_USER:-}" ] || return 0
  curl -fsS -m 10 -X POST "${MAX_API_URL:-https://platform-api.max.ru}/messages?user_id=$OKNO_NOTIFY_MAX_USER" \
    -H "Authorization: $BOT_TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1")" >/dev/null || true
}
healthy() {
  for _ in $(seq 1 30); do curl -fsS -m 5 "$PUBLIC_URL/health" | grep -q '"ok"' && return 0; sleep 3; done
  return 1
}

title=$(git log -1 --format=%s "$sha")
echo "$(date -Is) deploy $current -> $sha"
git merge -q --ff-only "$sha"
if $COMPOSE up -d --build >/tmp/okno-deploy.log 2>&1 && healthy; then
  echo "$(date -Is) deployed $sha"
  notify "🚀 ОКНО обновлено: ${sha%"${sha#???????}"} — $title"
else
  echo "$(date -Is) health check failed for $sha, rolling back to $current"
  git reset -q --hard "$current"
  $COMPOSE up -d --build >>/tmp/okno-deploy.log 2>&1 || true
  notify "⚠️ Выкатка ${sha%"${sha#???????}"} не прошла проверку /health — вернул предыдущую версию"
  exit 1
fi
