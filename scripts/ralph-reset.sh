#!/usr/bin/env bash
# Reset a group to pending (allows re-running after manual fix)
# Usage: ./scripts/ralph-reset.sh <group-id>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/ralph.sh" --reset "${1:?'Usage: ralph-reset.sh <group-id>'}"
