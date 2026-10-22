#!/usr/bin/env bash
# Clones (or updates) the API gateway config repos the load-test tool reads, laid out as <dir>/<prefix>/services/...
# Only the repos whose folder name is a gateway prefix are cloned: the -opm / -demo copies describe other
# environments and would add duplicate routes.
#
# Usage:  AZDO_PAT=<pat with Code (Read)> scripts/clone-gateway-config.sh [target dir, default ~/api_gateway]
#         (without AZDO_PAT it asks for the PAT without echoing it)
# Then:   export LT_GATEWAY_CONFIG_DIR=<target dir>   (or set gatewayConfigDir in config/settings.json)
#
# The PAT is passed to git through the environment for each command only: it is not written to .git/config, the
# remote URL or the shell history, and it doesn't show in `ps`.
set -euo pipefail

ORG_URL="https://dev.azure.com/FintechDevOps"
PROJECT="API%20Gateway%20Management"
BRANCH="${GATEWAY_BRANCH:-main}"
REPOS=(${GATEWAY_REPOS:-fms data-platform fintech-platforms platform-engineering-internal})
TARGET="${1:-$HOME/api_gateway}"

if [ -z "${AZDO_PAT:-}" ]; then
  read -r -s -p "Azure DevOps PAT (Code: Read): " AZDO_PAT
  echo
fi
[ -n "$AZDO_PAT" ] || { echo "No PAT given." >&2; exit 1; }

AUTH_HEADER="Authorization: Basic $(printf ":%s" "$AZDO_PAT" | base64 | tr -d "\n")"
git_auth() {
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$AUTH_HEADER" GIT_TERMINAL_PROMPT=0 git "$@"
}

mkdir -p "$TARGET"
failed=()
for repo in "${REPOS[@]}"; do
  dir="$TARGET/$repo"
  url="$ORG_URL/$PROJECT/_git/$repo"
  if [ -d "$dir/.git" ]; then
    if [ -n "$(git -C "$dir" status --porcelain)" ]; then
      echo "$repo: local changes, left as is"
      continue
    fi
    if git_auth -C "$dir" fetch --quiet --depth 1 origin "$BRANCH" && git -C "$dir" reset --quiet --hard FETCH_HEAD; then
      echo "$repo: updated to $(git -C "$dir" log -1 --format="%h %cs %s")"
    else
      failed+=("$repo")
    fi
  elif git_auth clone --quiet --depth 1 --branch "$BRANCH" "$url" "$dir"; then
    echo "$repo: cloned at $(git -C "$dir" log -1 --format="%h %cs %s")"
  else
    failed+=("$repo")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "Failed: ${failed[*]} (check the PAT's Code (Read) scope and that it can see the API Gateway Management project)" >&2
  exit 1
fi
count=$(find "$TARGET" -path "*/services/*/service.json" | wc -l | tr -d " ")
echo "Done: $count service.json files under $TARGET"
echo "Point the tool at it:  export LT_GATEWAY_CONFIG_DIR=$TARGET"
