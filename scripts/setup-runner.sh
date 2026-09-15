#!/usr/bin/env bash
#
# One-time registration of the self-hosted GitHub Actions runner that executes
# .github/workflows/deploy-vps.yml on the debug.leavchandara.com VPS.
#
# A runner registration token is short-lived (~1 hour) and cannot be minted from
# here, so you fetch it yourself and pass it in:
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
# repo's jobs off the other runner already on this box (test-connect/dgmini).
RUNNER_LABELS=self-hosted,vconsole

TOKEN="${1:-}"
[ -n "$TOKEN" ] || { echo "usage: $0 <REGISTRATION_TOKEN>"; exit 1; }
[ -d "$RUNNER_DIR" ] || { echo "runner package missing at $RUNNER_DIR"; exit 1; }

cd "$RUNNER_DIR"

# The deploy drives docker and writes to a root-owned checkout, so the runner
# runs as root — config.sh refuses that unless this is set.
export RUNNER_ALLOW_RUNASROOT=1

./config.sh \
  --url "$REPO_URL" \
  --token "$TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" \
  --work _work \
  --unattended \
  --replace

./svc.sh install
./svc.sh start
./svc.sh status
