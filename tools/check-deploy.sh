#!/usr/bin/env bash
# Answers one question: is what I am looking at on this computer the same
# thing that is live on the phone?
#
# Run from the project root:  bash tools/check-deploy.sh

set -u

SITE="${1:-https://jparkerpe-afk.github.io/dro-canvass-app}"
ok=0

say()  { printf '%s\n' "$*"; }
pass() { printf '  OK    %s\n' "$*"; }
fail() { printf '  WRONG %s\n' "$*"; ok=1; }

say "Checking deploy against: $SITE"
say ""

# --- 1. Local version constant ---------------------------------------------
LOCAL_VERSION=$(grep -oE "APP_VERSION = '[^']+'" js/version.js | sed "s/.*'\(.*\)'/\1/")
say "Local version:    ${LOCAL_VERSION:-<unreadable>}"

# --- 2. Working tree clean? ------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  fail "uncommitted changes present — commit before trusting this check"
  git status --short | sed 's/^/        /'
else
  pass "working tree clean"
fi

# --- 3. Local vs origin ----------------------------------------------------
git fetch --quiet origin 2>/dev/null
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/master 2>/dev/null || echo "none")
if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  pass "local commit matches origin/master (${LOCAL_SHA:0:7})"
else
  fail "local ${LOCAL_SHA:0:7} != origin/master ${REMOTE_SHA:0:7} — you have unpushed work"
fi

# --- 4. Deployed version ---------------------------------------------------
DEPLOYED_RAW=$(curl -fsS "$SITE/js/version.js?cachebust=$(date +%s)" 2>/dev/null)
if [ -z "$DEPLOYED_RAW" ]; then
  fail "could not reach the live site"
else
  DEPLOYED_VERSION=$(printf '%s' "$DEPLOYED_RAW" | grep -oE "APP_VERSION = '[^']+'" | sed "s/.*'\(.*\)'/\1/")
  say "Deployed version: ${DEPLOYED_VERSION:-<unreadable>}"
  if [ "$LOCAL_VERSION" = "$DEPLOYED_VERSION" ]; then
    pass "live site is serving the same version as this folder"
  else
    fail "live site serves '$DEPLOYED_VERSION' but this folder is '$LOCAL_VERSION' — Pages may still be building (wait ~1 min) or you forgot to push"
  fi
fi

# --- 5. Privacy gate -------------------------------------------------------
if git log --all --pretty=format: --name-only | sort -u | grep -qiE '\.csv$'; then
  fail "A CSV EXISTS IN GIT HISTORY — stop and investigate"
else
  pass "no CSV anywhere in git history"
fi

if curl -fsS -o /dev/null "$SITE/data/" 2>/dev/null; then
  fail "/data/ is reachable on the public site"
else
  pass "/data/ not reachable on the public site"
fi

say ""
if [ "$ok" -eq 0 ]; then
  say "ALL CLEAR — the phone and this computer are on the same version."
else
  say "SOMETHING IS OFF — see WRONG lines above."
fi
exit "$ok"
