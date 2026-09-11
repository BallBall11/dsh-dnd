#!/usr/bin/env bash
# dsh-dnd install helper (POSIX sh). See install.ps1 for the same flow.
set -euo pipefail
VERSION="${1:-}"
PROFILE="${PROFILE:-web}"
DSH_CMD="${DSH_CMD:-dsh}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -n "$VERSION" ]; then
  echo ":: installing dsh-dnd@$VERSION"
  "$DSH_CMD" plugin --profile "$PROFILE" add "dsh-dnd@$VERSION"
else
  echo ":: installing local bundle (link): $REPO_ROOT"
  "$DSH_CMD" plugin --profile "$PROFILE" add "link:$REPO_ROOT"
fi
echo ":: done. Remove any stale dnd-host manual mount row in the profile's cordis.patch.yml to avoid double-mounting."
