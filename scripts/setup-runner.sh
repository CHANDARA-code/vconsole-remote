#!/usr/bin/env bash
#
# One-time registration of the self-hosted GitHub Actions runner that executes
# .github/workflows/deploy-vps.yml on the debug.leavchandara.com VPS.
#
# A runner registration token is short-lived (~1 hour) and can only be minted by
# someone with admin on the repo, so you fetch it and pass it in:
#
#   https://github.com/CHANDARA-code/vconsole-remote/settings/actions/runners/new
#   (the token is the value after --token in the ./config.sh line GitHub shows)
#
#   sudo scripts/setup-runner.sh <REGISTRATION_TOKEN>
#
# Re-running with a fresh token re-registers the same runner (--replace), which
# is the recovery path if the runner is ever deleted in the GitHub UI.
set -euo pipefail

RUNNER_DIR=/opt/actions-runner-vconsole
REPO_URL=https://github.com/CHANDARA-code/vconsole-remote
RUNNER_NAME=vconsole-vps
# deploy-vps.yml targets [self-hosted, vconsole]; "vconsole" is what keeps this
# repo's jobs off the other runner already on this box (test-connect/dgmini),
# which belongs to a different GitHub account and cannot serve this repo.
RUNNER_LABELS=self-hosted,vconsole

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

TOKEN="${1:-}"
[ -n "$TOKEN" ] || { echo "usage: $0 <REGISTRATION_TOKEN>"; exit 1; }
[ -x "$RUNNER_DIR/config.sh" ] || {
  echo "runner package missing at $RUNNER_DIR"
  echo "re-download with:"
  echo "  mkdir -p $RUNNER_DIR && cd $RUNNER_DIR"
  echo "  curl -fsSL -o r.tar.gz https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz"
  echo "  tar xzf r.tar.gz && rm r.tar.gz"
  exit 1
}

# deploy.sh calls these by absolute path; fail here rather than inside a job.
for bin in /usr/bin/docker /usr/bin/git /usr/bin/curl; do
  [ -x "$bin" ] || { echo "required binary missing: $bin"; exit 1; }
done

cd "$RUNNER_DIR"

# The deploy drives docker and writes to a root-owned checkout, so the runner
# runs as root — config.sh refuses that unless this is set.
export RUNNER_ALLOW_RUNASROOT=1

log "Registering $RUNNER_NAME with $REPO_URL"
./config.sh \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work _work \
  --unattended \
  --replace

# svc.sh is written by config.sh, so it only exists once registration succeeded.
[ -x ./svc.sh ] || { echo "config.sh did not produce svc.sh — registration failed"; exit 1; }

log "Installing and starting the service"
./svc.sh install
./svc.sh start
./svc.sh status

log "Runner ready — the next push to main will deploy."
echo "Queued runs pick up automatically; to deploy now without a push:"
echo "  https://github.com/CHANDARA-code/vconsole-remote/actions/workflows/deploy-vps.yml"
echo "  (Run workflow -> main), or run scripts/deploy.sh directly on the box."
