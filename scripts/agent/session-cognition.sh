#!/usr/bin/env bash
# Session-start cognition loader — shared by the Claude Code (.claude/settings.json)
# and Codex (.codex/config.toml) SessionStart hooks. Pulls THIS node's own
# cognition bundle and prints it to stdout; both runtimes inject it into context.
# Non-fatal by design: any failure degrades to a loud self-serve prompt.
#
# .env.cogni holds two accounts (see .env.cogni.example): the NODE account
# (this node's own hub — the bearer used here) and the OPERATOR account
# (cognidao.org — CI/CD only: flight, deploy, secrets; never used by this loader).
set -u

read_env_file_value() {
  var_name="$1"
  env_file="${2:-.env.cogni}"
  [ -f "$env_file" ] || return 0
  awk -F= -v key="$var_name" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$env_file" 2>/dev/null
}

# Node hub URL from repo-spec intent.name (root .cogni/repo-spec.yaml).
node_slug=""
if [ -f .cogni/repo-spec.yaml ]; then
  node_slug="$(awk '
    /^intent:/ { in_intent = 1; next }
    in_intent && /^[^[:space:]]/ { in_intent = 0 }
    in_intent && /^[[:space:]]+name:/ {
      sub(/^[[:space:]]+name:[[:space:]]*/, ""); gsub(/["'"'"']/, ""); print; exit
    }
  ' .cogni/repo-spec.yaml 2>/dev/null)"
fi

# operator is the apex (cognidao.org); its monorepo root repo-spec carries the
# slug `cogni-template`, the same apex node. Every other slug is its own hub.
case "$node_slug" in
  operator | cogni-template | "") URL="https://cognidao.org/api/v1/cognition" ;;
  *) URL="https://${node_slug}.cognidao.org/api/v1/cognition" ;;
esac

fetch_bundle() {
  key="$1"
  if [ -n "$key" ]; then
    curl -fsS --max-time 6 -H "Authorization: Bearer ${key}" "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null
  else
    curl -fsS --max-time 6 "$URL" 2>/dev/null | jq -r '.markdown // empty' 2>/dev/null
  fi
}

# Bearer = this node's NODE account key (environment first, then ./.env.cogni).
AGENT_KEY="${COGNI_NODE_API_KEY:-$(read_env_file_value COGNI_NODE_API_KEY)}"
bundle="$(fetch_bundle "$AGENT_KEY")"

# Defense in depth: a Conductor worktree can hold a stale COPIED .env.cogni that
# shadows the canonical auth-root (main checkout) file. If the local key yielded
# nothing, retry with the auth-root key — derived from git, no hardcoded path —
# before degrading to the self-serve prompt.
if [ -z "$bundle" ]; then
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$common_dir" ]; then
    auth_root="$(cd "$(dirname "$common_dir")" 2>/dev/null && pwd || true)"
    if [ -n "$auth_root" ] && [ "$auth_root" != "$(pwd)" ]; then
      auth_key="$(read_env_file_value COGNI_NODE_API_KEY "$auth_root/.env.cogni")"
      if [ -n "$auth_key" ] && [ "$auth_key" != "$AGENT_KEY" ]; then
        bundle="$(fetch_bundle "$auth_key")"
      fi
    fi
  fi
fi

if [ -n "$bundle" ]; then
  printf '%s\n' "$bundle"
else
  cat <<EOF
COGNI COGNITION BOOTSTRAP BLOCKED

The SessionStart hook ran, but it could not fetch the cognition bundle from:
  $URL

Do not continue silently. Tell the user that session cognition did not load and
ask them to bootstrap the node credentials, then restart or resume the agent.

Most common fixes:
- register a NODE agent on THIS node's hub (same host as the URL above), not the
  apex: POST ${URL%/cognition}/agent/register — an apex-registered key gets a 401
  "Session required" here
- save the returned apiKey as COGNI_NODE_API_KEY in the clone-root .env.cogni
- for Codex, run pnpm codex:cognition:install once and trust the user-level hook with /hooks

If the agent received no bootstrap message at all, the hook probably did not run
(for Codex, missing hook trust is the usual cause).
EOF
fi
