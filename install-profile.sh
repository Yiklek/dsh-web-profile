#!/usr/bin/env bash
#
# Install the dsh-web-profile repo as a dsh profile using a git worktree.
#
# The profile directory becomes a real git worktree checked out from this
# repository. Tracked config files are real files inside the profile, so pnpm
# can write pnpm-lock.yaml normally and node_modules stays ignored.
#
# Usage:
#   ./install-profile.sh [profile-name] [--force] [--branch <branch>]
#
# Examples:
#   ./install-profile.sh web
#   ./install-profile.sh web2
#   ./install-profile.sh --force web2
#   ./install-profile.sh web --branch my-profile
#
# If the target profile already exists, you will be asked to confirm.
# The existing profile is moved to a timestamped backup before overwriting.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_DIR="$HOME/.dsh/profiles"

usage() {
  cat <<'EOF'
Install the dsh-web-profile repo as a dsh profile using a git worktree.

The profile directory becomes a real git worktree checked out from this
repository. Tracked config files are real files inside the profile, so pnpm
can write pnpm-lock.yaml normally and node_modules stays ignored.

Usage:
  ./install-profile.sh [profile-name] [--force] [--branch <branch>]

Examples:
  ./install-profile.sh web
  ./install-profile.sh web2
  ./install-profile.sh --force web2
  ./install-profile.sh web --branch my-profile

If the target profile already exists, you will be asked to confirm.
The existing profile is moved to a timestamped backup before overwriting.
EOF
  exit 0
}

PROFILE_NAME="web"
FORCE=0
BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f)
      FORCE=1
      shift
      ;;
    --branch|-b)
      if [[ $# -lt 2 ]]; then
        echo "error: --branch requires a value" >&2
        exit 1
      fi
      BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    -*)
      echo "error: unknown option: $1" >&2
      usage
      ;;
    *)
      PROFILE_NAME="$1"
      shift
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  BRANCH="profile-$PROFILE_NAME"
fi

if [[ ! -d "$SCRIPT_DIR/.git" ]]; then
  echo "error: $SCRIPT_DIR is not a git repository" >&2
  echo "Run this script from inside the dsh-web-profile repository." >&2
  exit 1
fi

PROFILE_DIR="$PROFILES_DIR/$PROFILE_NAME"

if [[ -e "$PROFILE_DIR" || -L "$PROFILE_DIR" ]]; then
  echo "Profile '$PROFILE_NAME' already exists: $PROFILE_DIR"
  if [[ $FORCE -ne 1 ]]; then
    read -r -p "Overwrite it? A backup will be created first. [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy] ]]; then
      echo "Aborted."
      exit 1
    fi
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$PROFILES_DIR/$PROFILE_NAME.bak.$timestamp"
  mv "$PROFILE_DIR" "$backup_dir"
  echo "Backed up existing profile to: $backup_dir"

  # If the old profile was a worktree of this repository, drop its stale entry.
  git -C "$SCRIPT_DIR" worktree prune
fi

if ! git -C "$SCRIPT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$SCRIPT_DIR" branch "$BRANCH" main
  echo "Created branch $BRANCH from main"
fi

if git -C "$SCRIPT_DIR" worktree list --porcelain | grep -q "^branch refs/heads/$BRANCH$"; then
  echo "error: branch $BRANCH is already checked out in another worktree" >&2
  exit 1
fi

git -C "$SCRIPT_DIR" worktree add "$PROFILE_DIR" "$BRANCH"
echo "Added worktree at $PROFILE_DIR on branch $BRANCH"

if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile "$PROFILE_NAME" install
else
  npx --yes @deepseek-ai/dsh plugin --profile "$PROFILE_NAME" install
fi

echo
echo "Profile '$PROFILE_NAME' is ready."
echo "Start it with:"
echo "  dsh --profile $PROFILE_NAME"
echo "Worktree branch: $BRANCH"
