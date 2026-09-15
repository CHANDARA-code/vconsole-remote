#!/usr/bin/env bash
#
# Production deploy for the vConsole Remote broker on the debug.leavchandara.com
# VPS.
#
# Invoked by .github/workflows/deploy-vps.yml on every push (including the merge
# commit GitHub writes when a PR is merged) to main, and safe to run by hand.
# It acts on the LIVE checkout at $APP_DIR, not on the runner's workspace copy,
# so the workspace can keep churning while the served tree stays coherent.
set -euo pipefail

APP_DIR=/root/Document/dgc/vconsole-remote
SERVICE=vconsole-remote
BRANCH=main
HEALTH_URL=http://127.0.0.1:8099/healthz
PUBLIC_URL=https://debug.leavchandara.com

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# One deploy at a time, even if someone also runs this by hand.
exec 9>/var/lock/vconsole-remote-deploy.lock
flock -n 9 || { echo "another deploy is in progress; aborting"; exit 1; }

for bin in /usr/bin/docker /usr/bin/git /usr/bin/curl; do
  [ -x "$bin" ] || { echo "required binary missing: $bin"; exit 1; }
done

cd "$APP_DIR"
PREV_SHA=$(git rev-parse HEAD)

# Until the new image is actually serving, a failure must leave the source where
# the running container came from — the tree never sits ahead of the process.
rollback() {
  echo
  echo "!!! deploy failed — rolling source back to $PREV_SHA"
  git reset --hard "$PREV_SHA" >/dev/null 2>&1 || true
}
trap rollback ERR

log "Syncing $BRANCH"
git fetch --prune origin
# Drop local edits to tracked files, then move onto main explicitly.
# `git reset --hard origin/main` alone would be wrong: if the checkout is
# sitting on some other branch it would repoint THAT branch at main's commit
# instead of switching, silently destroying it. checkout -B is idempotent.
#
# Both are safe ONLY because .env is gitignored, so it survives. NEVER add
# `git clean -fdx` here: -x deletes ignored files, which is exactly the .env
# holding this host's port binding and origin pin.
git reset --hard
git checkout -B "$BRANCH" "origin/$BRANCH"
echo "now at $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

[ -f "$APP_DIR/.env" ] || { echo ".env is missing — refusing to deploy with default settings"; exit 1; }

log "Building image"
# Build before touching the running container: a broken build must not take the
# live broker down with it.
docker compose build

log "Starting new container"
# Rooms are in-memory only, so a restart drops live debug sessions by design;
# there is no state to migrate and no drain step that would preserve them.
docker compose up -d --remove-orphans

log "Waiting for health"
fail=0
for i in $(seq 1 30); do
  if curl -sf -m 5 "$HEALTH_URL" > /dev/null; then
    echo "broker healthy: $(curl -s -m 5 "$HEALTH_URL")"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "broker did not become healthy in 60s"
    fail=1
  fi
  sleep 2
done

# Past this point the new container is the one serving, so rolling the source
# back would only misrepresent what is deployed.
trap - ERR

log "Edge checks"
check() {
  local code
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$1" || true)
  printf '  %-56s %s\n' "$1" "$code"
  [ "$code" = "$2" ] || fail=1
}
check "$PUBLIC_URL/healthz" 200
check "$PUBLIC_URL/" 200

if [ "$fail" != "0" ]; then
  echo
  echo "!!! health checks FAILED — container left running, investigate with:"
  echo "    docker compose -f $APP_DIR/docker-compose.yml logs --tail 80"
  exit 1
fi

log "Pruning dangling images"
docker image prune -f > /dev/null || true

log "Deploy complete: $(git rev-parse --short HEAD)"
