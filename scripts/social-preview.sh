#!/usr/bin/env bash
# Renders .github/social-preview.html into .github/social-preview.png: the 1280×640
# picture that GitHub, chats and social networks show for a link to the template,
# with the diagram of how a job runs. GitHub keeps it apart from the files, so after a
# change, upload the picture under Settings → General → Social preview of the
# template. A control repository is private and shows no social preview, so `own` of
# .github/template.json keeps this script, the page and the picture out of every copy.
#
#   bash scripts/social-preview.sh
#
# It needs Google Chrome or Chromium, or the browser that CHROME names, which
# photographs the page in its headless mode. The page loads nothing from the
# network, and the browser starts with a profile of its own that it throws away.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

page=.github/social-preview.html
picture=.github/social-preview.png

# The browser: the one that CHROME names, else the first that is installed.
browser() {
  local candidate
  if [[ -n "${CHROME:-}" ]]; then
    echo "$CHROME"
    return 0
  fi
  for candidate in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  for candidate in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# A path as the browser reads it: Git Bash on Windows hands a Windows browser its own
# kind of path.
native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    echo "$1"
  fi
}

if ! chrome="$(browser)"; then
  echo "The social preview needs Google Chrome or Chromium; name another one in CHROME." >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
root="$(native "$(pwd)")"
shot="$(native "$work")/social-preview.png"

if ! "$chrome" --headless --no-first-run --no-default-browser-check \
  --disable-extensions --disable-background-networking --disable-gpu \
  --user-data-dir="$(native "$work")/profile" \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=1280,640 \
  --virtual-time-budget=5000 --screenshot="$shot" \
  "file:///${root#/}/$page" >"$work/log" 2>&1 || [[ ! -s "$work/social-preview.png" ]]; then
  cat "$work/log" >&2
  echo "Rendering $page failed; the log above says why." >&2
  exit 1
fi
cp "$work/social-preview.png" "$picture"
echo "Rendered $picture; upload it under Settings → General → Social preview of the template."
