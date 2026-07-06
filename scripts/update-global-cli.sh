#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  printf 'update-global-cli: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/update-global-cli.sh [--push-fork]

Updates this checkout, rebuilds the packaged CLI, and relinks `rig` globally.

Default behavior never pushes. In a fork checkout with both `origin` and
`upstream`, the script updates from `upstream/<current-branch>` and reports
whether the fork remote still needs syncing.

Options:
  --push-fork   Push HEAD to origin/<current-branch> after a successful update.
  -h, --help    Show this help.
USAGE
}

step() {
  printf '\n==> %s\n' "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found on PATH"
}

require_cmd git
require_cmd node
require_cmd npm

export npm_config_allow_scripts=

push_fork=false
for arg in "$@"; do
  case "$arg" in
    --push-fork)
      push_fork=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $arg"
      ;;
  esac
done

[ -d .git ] || fail "expected a git checkout at $REPO_ROOT"

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "worktree is dirty; commit or stash changes before updating"
fi

current_branch="$(git branch --show-current)"
[ -n "$current_branch" ] || fail "detached HEAD is not supported"

step "Fetching all remotes"
git fetch --all --prune

tracking_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
source_ref=""
fork_ref=""

if git show-ref --verify --quiet "refs/remotes/upstream/$current_branch"; then
  source_ref="upstream/$current_branch"
elif [ -n "$tracking_ref" ]; then
  source_ref="$tracking_ref"
else
  fail "current branch has no upstream and upstream/$current_branch was not found"
fi

if git show-ref --verify --quiet "refs/remotes/origin/$current_branch" &&
  git remote get-url upstream >/dev/null 2>&1; then
  fork_ref="origin/$current_branch"
elif [ -n "$tracking_ref" ] && [ "$tracking_ref" != "$source_ref" ]; then
  fork_ref="$tracking_ref"
fi

if [ "$source_ref" = "upstream/$current_branch" ] && [ -n "$fork_ref" ]; then
  printf 'Using %s as update source; %s must be synced separately.\n' "$source_ref" "$fork_ref"
fi

local_sha="$(git rev-parse @)"
remote_sha="$(git rev-parse "$source_ref")"
base_sha="$(git merge-base @ "$source_ref")"

if [ "$local_sha" = "$remote_sha" ]; then
  printf 'Already up to date with %s.\n' "$source_ref"
elif [ "$local_sha" = "$base_sha" ]; then
  step "Fast-forwarding from $source_ref"
  git merge --ff-only "$source_ref"
elif [ "$remote_sha" = "$base_sha" ]; then
  printf 'Local branch is ahead of %s; continuing without pull.\n' "$source_ref"
else
  fail "local branch diverged from $source_ref; rebase or merge manually"
fi

if [ -n "$fork_ref" ]; then
  fork_remote="${fork_ref%%/*}"
  fork_branch="${fork_ref#*/}"
  fork_sha="$(git rev-parse "$fork_ref")"
  head_sha="$(git rev-parse @)"

  if [ "$fork_sha" = "$head_sha" ]; then
    printf '%s is synced.\n' "$fork_ref"
  elif [ "$push_fork" = true ]; then
    step "Syncing fork remote $fork_ref"
    git push "$fork_remote" "HEAD:$fork_branch"
  else
    printf 'Fork remote %s is not synced. To publish this state, run:\n' "$fork_ref"
    printf '  git push %s HEAD:%s\n' "$fork_remote" "$fork_branch"
    printf 'Or rerun this updater with --push-fork.\n'
  fi
fi

step "Installing dependencies from lockfile"
npm ci

step "Building packaged CLI"
npm run build:package

step "Linking @openrig/cli globally"
npm link --workspace packages/cli

npm_prefix="$(npm config get prefix)"
case "$npm_prefix" in
  "$HOME/.asdf/installs/nodejs/"*)
    if command -v asdf >/dev/null 2>&1; then
      step "Refreshing asdf nodejs shims"
      asdf reshim nodejs
    else
      printf 'update-global-cli: npm prefix uses asdf, but asdf is not on PATH\n' >&2
    fi
    ;;
esac

expected_version="$(node -p "require('./packages/cli/package.json').version")"
rig_bin="$npm_prefix/bin/rig"
[ -x "$rig_bin" ] || fail "global rig not found at $rig_bin"

actual_version="$("$rig_bin" --version)"
actual_semver="${actual_version%% *}"
[ "$actual_semver" = "$expected_version" ] || fail "rig --version returned $actual_version, expected $expected_version"

printf '\nOpenRig CLI installed globally: rig %s (%s)\n' "$actual_version" "$rig_bin"
