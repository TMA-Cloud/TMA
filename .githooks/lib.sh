# Shared helpers for the hooks in this directory. Sourced, not run.

NODE_PACKAGES='backend frontend electron'

if [ -t 2 ]; then
  red=$(printf '\033[31m') yellow=$(printf '\033[33m') dim=$(printf '\033[2m') reset=$(printf '\033[0m')
else
  red='' yellow='' dim='' reset=''
fi

fail() { printf '%s✗ %s%s\n' "$red" "$*" "$reset" >&2; }
warn() { printf '%s! %s%s\n' "$yellow" "$*" "$reset" >&2; }
step() { printf '%s→ %s%s\n' "$dim" "$*" "$reset" >&2; }

# Warns and returns 1 when a package's tools aren't installed, so the hook skips
# that package instead of blocking a commit that only touched docs.
has_node_modules() {
  [ -d "$1/node_modules/.bin" ] && return 0
  warn "$1: node_modules missing, skipping checks (run npm ci in $1/)"
  return 1
}

# Lines of list $1 that are (with $3=keep) or aren't (with $3=drop) in list $2.
filter_by() {
  _patterns=$(mktemp)
  printf '%s\n' "$2" | sed '/^$/d' >"$_patterns"
  if [ "$3" = keep ]; then
    printf '%s\n' "$1" | sed '/^$/d' | grep -Fx -f "$_patterns" || true
  else
    printf '%s\n' "$1" | sed '/^$/d' | grep -Fxv -f "$_patterns" || true
  fi
  rm -f "$_patterns"
}

# Newline-separated list on stdin → NUL-separated, so xargs survives spaces.
nul() { sed '/^$/d' | tr '\n' '\0'; }
