#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Module: scripts/conductor-worktree-setup.sh
# Purpose: Prepare a Conductor-created node-template worktree for agent development.
# Side-effects: refreshes origin/main, links shared local auth/secrets when available,
#   installs deps, builds package declarations, and writes a setup proof marker.

set -euo pipefail

DEFAULT_BRANCH="${CONDUCTOR_DEFAULT_BRANCH:-main}"
WORKSPACE_ROOT="${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"

# AUTH_ROOT is THIS node's canonical (main) workspace checkout — the single place
# that holds .env.cogni and .local-auth. A Conductor worktree spawn is a git worktree
# of that main checkout, so we derive its path from git: no hardcoded or personal path,
# and never a reach into an unrelated repo. Override with COGNI_NODE_AUTH_ROOT if needed.
derive_main_workspace() {
  local common_dir
  common_dir="$(git -C "$WORKSPACE_ROOT" rev-parse --git-common-dir 2>/dev/null)" || return 1
  (cd "$WORKSPACE_ROOT" && cd "$(dirname "$common_dir")" && pwd)
}
AUTH_ROOT="${COGNI_NODE_AUTH_ROOT:-${CONDUCTOR_ROOT_PATH:-$(derive_main_workspace || true)}}"

warn() {
  printf 'warn: %s\n' "$1" >&2
}

read_env_file_value() {
  local var_name="$1"
  local env_file="$2"

  [[ -f "$env_file" ]] || return 0
  awk -F= -v key="$var_name" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\''"]|["'\''"]$/, "", value)
      print value
      exit
    }
  ' "$env_file" 2>/dev/null
}

refresh_workspace_base_ref() {
  git fetch origin "$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"
}

# Conductor frequently forms a worktree off a stale local base, so the checked-out
# branch lands behind origin. Bring it up to date with the freshly fetched base
# (the `git pull main` step). Conflict-safe: on a dirty tree, detached HEAD, or a
# merge conflict we warn and continue rather than leaving the worktree wedged.
sync_workspace_to_base() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "workspace has uncommitted changes; skipped $DEFAULT_BRANCH sync"
    return
  fi

  local branch
  branch="$(git branch --show-current 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    warn "detached HEAD; skipped $DEFAULT_BRANCH sync"
    return
  fi

  if ! git merge --no-edit "origin/$DEFAULT_BRANCH"; then
    git merge --abort 2>/dev/null || true
    warn "origin/$DEFAULT_BRANCH does not merge cleanly into $branch; left as-is to resolve manually"
  fi
}

refresh_auth_root_main() {
  if [[ -z "$AUTH_ROOT" || "$AUTH_ROOT" == "$WORKSPACE_ROOT" ]]; then
    return
  fi

  if ! git -C "$AUTH_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
    warn "auth root is not a git checkout: $AUTH_ROOT"
    return
  fi

  git -C "$AUTH_ROOT" fetch origin "$DEFAULT_BRANCH" || {
    warn "could not fetch origin/$DEFAULT_BRANCH in auth root: $AUTH_ROOT"
    return
  }

  local branch
  branch="$(git -C "$AUTH_ROOT" branch --show-current 2>/dev/null || true)"
  if [[ "$branch" != "$DEFAULT_BRANCH" ]]; then
    warn "auth root is on $branch, not $DEFAULT_BRANCH; fetched but skipped pull"
    return
  fi

  if ! git -C "$AUTH_ROOT" diff --quiet || ! git -C "$AUTH_ROOT" diff --cached --quiet; then
    warn "auth root has uncommitted changes; fetched but skipped pull"
    return
  fi

  git -C "$AUTH_ROOT" pull --ff-only origin "$DEFAULT_BRANCH" || {
    warn "could not fast-forward auth root: $AUTH_ROOT"
  }
}

# HTTP status the node hub returns for a bearer against its cognition endpoint —
# the same endpoint the session-start loader reads. "000" on network failure.
node_key_http_status() {
  local key="$1"
  local base_url
  base_url="$(node_hub_base_url)"
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -H "Authorization: Bearer ${key}" "$base_url/api/v1/cognition" 2>/dev/null || printf '000'
}

# Classify the auth-root NODE key against the hub that actually serves cognition:
#   valid    -> 2xx, the hub accepts it (nothing to do)
#   invalid  -> 401/403, present but rejected (the apex-key symptom); re-register
#   missing  -> no key on file
#   unknown  -> timeout / 5xx / offline; can't prove it bad, so keep it (no churn)
auth_root_node_key_state() {
  local key status
  key="$(read_env_file_value COGNI_NODE_API_KEY "$AUTH_ROOT/.env.cogni")"
  [[ -n "$key" ]] || { printf 'missing'; return; }
  status="$(node_key_http_status "$key")"
  case "$status" in
    2*) printf 'valid' ;;
    401 | 403) printf 'invalid' ;;
    *) printf 'unknown' ;;
  esac
}

# Comment out any existing COGNI_NODE_API_KEY lines so a freshly registered key
# (appended after) is the one read: read_env_file_value and the session-start
# loader both take the FIRST match, so a stale line left in place shadows the fix.
neutralize_stale_node_key() {
  local env_file="$1"
  local tmp
  [[ -f "$env_file" ]] || return 0
  tmp="${env_file}.tmp.$$"
  awk '
    /^[[:space:]]*COGNI_NODE_API_KEY=/ { print "# stale (rejected by node hub): " $0; next }
    { print }
  ' "$env_file" >"$tmp" && mv "$tmp" "$env_file"
  chmod 600 "$env_file" 2>/dev/null || true
}

# THIS node's own hub base URL, derived from .cogni/repo-spec.yaml intent.name —
# the same derivation scripts/agent/session-cognition.sh uses to fetch the bundle.
# The registered agent MUST live on the same hub that serves the session-cognition
# bundle: an agent registered at the apex (cognidao.org) is not a valid principal
# at a node subdomain and its key gets a 401 "Session required" there. The apex
# node (operator / cogni-template) is its own hub, so it stays on cognidao.org.
node_hub_base_url() {
  local spec="$WORKSPACE_ROOT/.cogni/repo-spec.yaml"
  local slug=""

  if [[ -f "$spec" ]]; then
    slug="$(awk '
      /^intent:/ { in_intent = 1; next }
      in_intent && /^[^[:space:]]/ { in_intent = 0 }
      in_intent && /^[[:space:]]+name:/ {
        sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'\''"]/, ""); print; exit
      }
    ' "$spec" 2>/dev/null)"
  fi

  case "$slug" in
    operator | cogni-template | "") printf 'https://cognidao.org' ;;
    *) printf 'https://%s.cognidao.org' "$slug" ;;
  esac
}

register_auth_root_cogni_agent() {
  local env_file="$AUTH_ROOT/.env.cogni"
  local agent_name response key base_url

  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    warn "curl and jq are required to auto-register Cogni credentials"
    return 1
  fi

  base_url="$(node_hub_base_url)"
  agent_name="${USER:-agent}-conductor-$(hostname -s 2>/dev/null || printf 'local')-$(date -u +%Y%m%dT%H%M%SZ)"
  response="$(
    curl -fsS --max-time 10 -X POST "$base_url/api/v1/agent/register" \
      -H 'content-type: application/json' \
      -d "$(jq -cn --arg name "$agent_name" '{name:$name}')"
  )" || return 1
  key="$(printf '%s\n' "$response" | jq -r '.apiKey // empty')"
  [[ -n "$key" ]] || return 1

  {
    if [[ -f "$env_file" ]]; then
      printf '\n'
    else
      printf '# Cogni node API keys (gitignored via .env*)\n'
    fi
    printf '# Agent name: %s\n' "$agent_name"
    printf 'COGNI_NODE_API_KEY=%s\n' "$key"
  } >>"$env_file"
  chmod 600 "$env_file"
}

ensure_auth_root_cogni_env() {
  local lock_dir state

  if [[ -z "$AUTH_ROOT" ]]; then
    warn "no auth root resolved; cannot auto-register COGNI_NODE_API_KEY safely"
    exit 1
  fi

  # A valid key needs nothing. An UNKNOWN state (network/5xx) is left alone so a
  # flaky hub never churns a working key. Only missing/invalid keys fall through
  # to (re)registration.
  state="$(auth_root_node_key_state)"
  if [[ "$state" == "valid" ]]; then
    return
  fi
  if [[ "$state" == "unknown" ]]; then
    warn "could not validate COGNI_NODE_API_KEY against $(node_hub_base_url) (network?); keeping existing key"
    return
  fi

  mkdir -p "$AUTH_ROOT/.context"
  lock_dir="$AUTH_ROOT/.context/cogni-node-key.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    for _ in {1..20}; do
      sleep 1
      [[ "$(auth_root_node_key_state)" == "valid" ]] && return
    done
    warn "$AUTH_ROOT/.env.cogni still lacks a hub-valid COGNI_NODE_API_KEY after waiting for another setup"
    exit 1
  fi
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

  # Re-check under the lock — another setup may have healed it meanwhile.
  state="$(auth_root_node_key_state)"
  if [[ "$state" == "valid" ]]; then
    return
  fi

  if [[ "$state" == "invalid" ]]; then
    warn "$AUTH_ROOT/.env.cogni COGNI_NODE_API_KEY rejected by $(node_hub_base_url) (401/403 — apex-key symptom); neutralizing and re-registering"
    neutralize_stale_node_key "$AUTH_ROOT/.env.cogni"
  else
    warn "$AUTH_ROOT/.env.cogni missing COGNI_NODE_API_KEY; attempting NODE agent registration"
  fi

  if register_auth_root_cogni_agent; then
    printf 'registered Cogni NODE agent and saved COGNI_NODE_API_KEY in %s\n' "$AUTH_ROOT/.env.cogni"
  else
    warn "could not auto-register Cogni NODE agent; POST $(node_hub_base_url)/api/v1/agent/register and save COGNI_NODE_API_KEY in $AUTH_ROOT/.env.cogni"
    exit 1
  fi
}

link_from_auth_root() {
  local name="$1"
  local src_path="$AUTH_ROOT/$name"

  if [[ -z "$AUTH_ROOT" || "$AUTH_ROOT" == "$WORKSPACE_ROOT" ]]; then
    warn "no separate main-workspace root resolved; using local $name as-is, skipped link"
    return
  fi

  if [[ ! -e "$src_path" ]]; then
    warn "$src_path missing; skipped $name symlink"
    return
  fi

  if [[ -e "$name" && ! -L "$name" ]]; then
    # A real (non-symlink) file here is one of two things: (a) a node's own bespoke
    # source of truth, or (b) a Conductor copy-on-create snapshot that has since
    # gone stale and now SHADOWS the canonical auth-root file — the bug that leaves
    # worktrees on a dead key. Only .env.cogni carries a checkable credential, so
    # keep it when its own key still validates; otherwise back it up and relink.
    if [[ "$name" == ".env.cogni" ]]; then
      local local_key
      local_key="$(read_env_file_value COGNI_NODE_API_KEY "$name")"
      if [[ -n "$local_key" && "$(node_key_http_status "$local_key")" == 2* ]]; then
        warn "$name is a real file with a hub-valid node key; keeping it, skipped auth-root link"
        return
      fi
      mv "$name" "$name.pre-link.bak" 2>/dev/null || true
      warn "$name was a stale/invalid real copy; backed up to $name.pre-link.bak and relinked to $src_path"
    else
      warn "$name is a real file, not a symlink; keeping it and skipping the auth-root link"
      return
    fi
  fi

  ln -sfn "$src_path" "$name"
}

write_setup_proof() {
  mkdir -p .context
  WORKSPACE_ROOT="$WORKSPACE_ROOT" AUTH_ROOT="$AUTH_ROOT" DEFAULT_BRANCH="$DEFAULT_BRANCH" SETUP_COMPLETED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" node <<'EOF'
const fs = require("node:fs");

fs.writeFileSync(
  ".context/conductor-setup.json",
  `${JSON.stringify(
    {
      workspaceRoot: process.env.WORKSPACE_ROOT,
      authRoot: process.env.AUTH_ROOT,
      defaultBranch: process.env.DEFAULT_BRANCH,
      completedAt: process.env.SETUP_COMPLETED_AT,
    },
    null,
    2
  )}\n`
);
EOF
}

refresh_workspace_base_ref
sync_workspace_to_base
refresh_auth_root_main
ensure_auth_root_cogni_env

# Symlink, never copy, so secret rotation and captured auth in the human's
# canonical checkout are immediately reflected in active Conductor worktrees.
link_from_auth_root ".env.cogni"
link_from_auth_root ".local-auth"

pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile
pnpm build:packages
write_setup_proof
