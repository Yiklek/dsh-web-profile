#!/usr/bin/env bash
#
# Install dsh profile config from this repository or remotely via curl.
#
# Two installation styles are supported:
#   1. clone  - clone the repository directly into ~/.dsh/profiles/<name>
#   2. worktree - create a git worktree at ~/.dsh/profiles/<name>
#
# When run from a local git checkout, only worktree installation is allowed.
# When run via `curl ... | bash`, the script uses the default remote
# repository and defaults to clone installation unless --mode is given.
#
# For worktree installation, the source repository is cloned into the current
# directory by default, or into the path/name given by --dir.
#
# Usage:
#   ./install.sh [profile-name] [options]
#   curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- [profile-name] [options]
#
# Options:
#   --force               Skip overwrite confirmation (backup is still made)
#   --branch <branch>     Worktree branch name (default profile-<name>)
#   --mode <clone|worktree> Installation mode for remote installs
#   --dir <path>   Cloned repository directory path/name (full path or a directory name)
#
# Examples:
#   ./install.sh web
#   ./install.sh web2 --force
#   curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web
#   curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree
#   curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree --dir ~/repos/dsh-web-profile
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
else
  SCRIPT_DIR=""
fi
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_DIR="$DSH_HOME/profiles"
DEFAULT_REMOTE="https://github.com/Yiklek/dsh-web-profile.git"

usage() {
  cat <<'EOF'
Install dsh profile config from this repository or remotely via curl.

Two installation styles are supported:
  1. clone    - clone the repository directly into ~/.dsh/profiles/<name>
  2. worktree - create a git worktree at ~/.dsh/profiles/<name>

When run from a local git checkout, only worktree installation is allowed.
When run via `curl ... | bash`, the script uses the default remote
repository and defaults to clone installation unless --mode is given.

For worktree installation, the source repository is cloned into the current
directory by default, or into the path/name given by --dir.

Usage:
  ./install.sh [profile-name] [options]
  curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- [profile-name] [options]

Options:
  --force               Skip overwrite confirmation (backup is still made)
  --branch <branch>     Worktree branch name (default profile-<name>)
  --mode <clone|worktree> Installation mode for remote installs
  --dir <path>   Cloned repository directory path/name (full path or a directory name)

Examples:
  ./install.sh web
  ./install.sh web2 --force
  curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web
  curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree
  curl -fsSL https://raw.githubusercontent.com/Yiklek/dsh-web-profile/main/install.sh | bash -s -- web --mode worktree --dir ~/repos/dsh-web-profile
EOF
  exit 0
}

PROFILE_NAME="web"
POSITIONAL=0
FORCE=0
BRANCH=""
BRANCH_SET=0
REMOTE=""
MODE=""
SOURCE_DIR=""

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
      BRANCH_SET=1
      shift 2
      ;;
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "error: --mode requires a value" >&2
        exit 1
      fi
      case "$2" in
        clone|worktree) MODE="$2" ;;
        *)
          echo "error: --mode must be 'clone' or 'worktree'" >&2
          exit 1
          ;;
      esac
      shift 2
      ;;
    --dir)
      if [[ $# -lt 2 ]]; then
        echo "error: --dir requires a value" >&2
        exit 1
      fi
      SOURCE_DIR="$2"
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
      if [[ $POSITIONAL -eq 1 ]]; then
        echo "error: only one profile name is allowed" >&2
        exit 1
      fi
      POSITIONAL=1
      PROFILE_NAME="$1"
      shift
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  BRANCH="profile-$PROFILE_NAME"
fi

# When running from a local git checkout, only worktree installation is allowed.
if [[ -d "$SCRIPT_DIR/.git" ]]; then
  if [[ -n "$MODE" && "$MODE" != "worktree" ]]; then
    echo "error: when running from a local repository, only worktree installation is supported" >&2
    exit 1
  fi
  MODE="worktree"
fi

# Running via `curl ... | bash` means SCRIPT_DIR is not a git checkout.
# Fall back to the default remote repository so the one-liner works.
if [[ -z "$REMOTE" && ! -d "$SCRIPT_DIR/.git" ]]; then
  REMOTE="$DEFAULT_REMOTE"
  echo "Not running from a git checkout; using remote $REMOTE"
fi

if [[ -n "$REMOTE" && -z "$MODE" ]]; then
  MODE="clone"
  echo "No --mode specified; using clone mode."
fi

if [[ "$MODE" == "clone" && ( -n "$SOURCE_DIR" || $BRANCH_SET -eq 1 ) ]]; then
  echo "error: --dir and --branch are only valid in worktree mode" >&2
  exit 1
fi

PROFILE_DIR="$PROFILES_DIR/$PROFILE_NAME"

backup_profile() {
  local source_repo="${1:-}"
  local timestamp backup_dir
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$PROFILES_DIR/$PROFILE_NAME.bak.$timestamp"
  mv "$PROFILE_DIR" "$backup_dir"
  echo "Backed up existing profile to: $backup_dir"
  if [[ -n "$source_repo" && -d "$source_repo/.git" ]]; then
    git -C "$source_repo" worktree prune
  fi
}

NEED_BACKUP=0
if [[ -e "$PROFILE_DIR" || -L "$PROFILE_DIR" ]]; then
  echo "Profile '$PROFILE_NAME' already exists: $PROFILE_DIR"
  if [[ $FORCE -ne 1 ]]; then
    if [[ ! -t 0 ]]; then
      echo "error: profile exists and non-interactive mode requires --force" >&2
      exit 1
    fi
    read -r -p "Overwrite it? A backup will be created first. [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy] ]]; then
      echo "Aborted."
      exit 1
    fi
  fi
  NEED_BACKUP=1
fi

install_deps() {
  if command -v dsh >/dev/null 2>&1; then
    dsh plugin --profile "$PROFILE_NAME" install
  elif command -v pnpm >/dev/null 2>&1; then
    # Use pnpm's store (cached in CI) so the dsh CLI itself is not re-downloaded
    # through npx on every fresh runner.
    pnpm dlx @deepseek-ai/dsh@next plugin --profile "$PROFILE_NAME" install
  else
    npx --yes @deepseek-ai/dsh@next plugin --profile "$PROFILE_NAME" install
  fi
}

if [[ -n "$REMOTE" && "$MODE" == "clone" ]]; then
  if [[ $NEED_BACKUP -eq 1 ]]; then
    backup_profile ""
  fi
  mkdir -p "$PROFILES_DIR"
  git clone "$REMOTE" "$PROFILE_DIR"
  echo "Cloned remote repository into $PROFILE_DIR"
  install_deps
  echo
  echo "Profile '$PROFILE_NAME' is ready."
  echo "Start it with:"
  echo "  dsh --profile $PROFILE_NAME"
  exit 0
fi

# worktree mode (local repo or remote clone)
if [[ -n "$REMOTE" ]]; then
  if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_REPO="$SOURCE_DIR"
  else
    repo_name="$(basename "$REMOTE" .git)"
    SOURCE_REPO="$PWD/$repo_name"
  fi

  if [[ -e "$SOURCE_REPO" ]]; then
    if [[ ! -d "$SOURCE_REPO" ]]; then
      echo "error: $SOURCE_REPO exists and is not a directory" >&2
      exit 1
    fi
    if [[ ! -d "$SOURCE_REPO/.git" && -n "$(ls -A "$SOURCE_REPO" 2>/dev/null || true)" ]]; then
      echo "error: $SOURCE_REPO exists and is not an empty git repository" >&2
      exit 1
    fi
  fi

  if [[ ! -d "$SOURCE_REPO/.git" ]]; then
    mkdir -p "$(dirname "$SOURCE_REPO")"
    git clone "$REMOTE" "$SOURCE_REPO"
    echo "Cloned remote source repository to $SOURCE_REPO"
  else
    git -C "$SOURCE_REPO" fetch --all --prune
    echo "Updated existing source repository at $SOURCE_REPO"
  fi

  if git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/remotes/origin/main"; then
    DEFAULT_BRANCH="origin/main"
  elif git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/remotes/origin/master"; then
    DEFAULT_BRANCH="origin/master"
  else
    echo "error: cannot determine default branch in $SOURCE_REPO" >&2
    exit 1
  fi
else
  SOURCE_REPO="$SCRIPT_DIR"
  if [[ ! -d "$SOURCE_REPO/.git" ]]; then
    echo "error: $SOURCE_REPO is not a git repository" >&2
    exit 1
  fi
  if git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/heads/main"; then
    DEFAULT_BRANCH="main"
  elif git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/heads/master"; then
    DEFAULT_BRANCH="master"
  else
    # Detached HEAD (e.g. CI checkouts): base the branch on the current commit
    DEFAULT_BRANCH="HEAD"
  fi
fi

if ! git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$SOURCE_REPO" branch "$BRANCH" "$DEFAULT_BRANCH"
  echo "Created branch $BRANCH from $DEFAULT_BRANCH"
fi

if git -C "$SOURCE_REPO" worktree list --porcelain | grep -q "^branch refs/heads/$BRANCH$"; then
  echo "error: branch $BRANCH is already checked out in another worktree" >&2
  exit 1
fi

if [[ $NEED_BACKUP -eq 1 ]]; then
  backup_profile "$SOURCE_REPO"
fi

git -C "$SOURCE_REPO" worktree add "$PROFILE_DIR" "$BRANCH"
echo "Added worktree at $PROFILE_DIR on branch $BRANCH"

install_deps

echo
echo "Profile '$PROFILE_NAME' is ready."
echo "Start it with:"
echo "  dsh --profile $PROFILE_NAME"
echo "Worktree branch: $BRANCH"
