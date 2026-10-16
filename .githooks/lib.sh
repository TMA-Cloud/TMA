# Shared helpers for the hooks in this directory. Sourced, not run.

if [ -t 2 ]; then
  red=$(printf '\033[31m') yellow=$(printf '\033[33m') dim=$(printf '\033[2m') reset=$(printf '\033[0m')
else
  red='' yellow='' dim='' reset=''
fi

fail() { printf '%s✗ %s%s\n' "$red" "$*" "$reset" >&2; }
warn() { printf '%s! %s%s\n' "$yellow" "$*" "$reset" >&2; }
step() { printf '%s→ %s%s\n' "$dim" "$*" "$reset" >&2; }

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
