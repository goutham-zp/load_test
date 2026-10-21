#!/usr/bin/env bash
# One-time setup on macOS or Linux (bare metal / VM). For containers, use the Dockerfile instead.
set -euo pipefail
cd "$(dirname "$0")/.."

K6_VERSION="${K6_VERSION:-2.3.0}"

if ! command -v node >/dev/null; then
  echo "Node.js 22+ is required (https://nodejs.org)." >&2
  exit 1
fi

if ! command -v k6 >/dev/null; then
  case "$(uname -s)" in
    Darwin)
      brew install k6 ;;
    Linux)
      arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
      curl -fsSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${arch}.tar.gz" | tar -xz -C /tmp
      sudo mv "/tmp/k6-v${K6_VERSION}-linux-${arch}/k6" /usr/local/bin/k6 ;;
    *)
      echo "Install k6 manually: https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2; exit 1 ;;
  esac
fi
k6 version

npm ci --no-audit --no-fund
npm run lt -- setup
