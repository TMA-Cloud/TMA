#!/usr/bin/env bash
# ============================================================
#  TMA Cloud – rotate keys and passwords on a Docker install
# ============================================================
#  Usage, in the install directory (next to compose.yml and .env):
#    ./rotate.sh key      Add a new master key and rewrap stored file keys
#    ./rotate.sh db       Set a new random database password
#    ./rotate.sh redis    Set a new random Redis password
#    ./rotate.sh all      All three, with one restart
#    ./rotate.sh status   Key versions and how many file keys each wraps
#
#  Without a local copy:
#    curl -fsSL https://raw.githubusercontent.com/TMA-Cloud/TMA/main/rotate.sh | bash -s -- key
#
#  The containers restart once, so expect a few seconds of downtime. Older
#  master keys stay in secrets/file_encryption_key: data in older database
#  backups still needs them.
#
#  Environment (optional):
#    TMA_DIR   Install directory (default: the current directory)
# ============================================================

set -euo pipefail

# Everything lives in main(), called on the last line: if the download is cut
# off, bash never reaches the call and nothing half-runs.
main() {
  RED='\033[0;31m'; GREEN='\033[0;32m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

  info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
  success() { echo -e "${GREEN}[OK]${NC}    $*"; }
  die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

  local command="${1:-}"
  local dir="${TMA_DIR:-$PWD}"
  local key_file=secrets/file_encryption_key
  local backup=.rotate-backup
  local backup_guide="https://tma-cloud.github.io/Wiki/docs/guides/operations/backups"
  # The app container runs as this user (see the Dockerfile).
  local app_uid=1001

  case "$command" in
    key | db | redis | all | status) ;;
    *) die "Usage: rotate.sh <key|db|redis|all|status>" ;;
  esac

  umask 077
  cd "$dir"
  [[ -f compose.yml || -f docker-compose.yml ]] || die "No compose.yml in ${dir}. Run this in the install directory or set TMA_DIR."
  [[ -f .env ]] || die "No .env in ${dir}"
  command -v docker >/dev/null 2>&1 || die "Docker is required"

  # stdin stays closed unless a command needs it, so a piped script is never read as input.
  app_cli() { docker compose exec -T app node backend/scripts/rotate.js "$@"; }

  # A key rotation works with the app stopped, as it is when it refuses a passphrase key.
  if [[ "$command" != "key" ]]; then
    docker compose ps --status running --services 2>/dev/null | grep -qx app ||
      die "The app container is not running. Start it with: docker compose up -d"
  fi

  if [[ "$command" == "status" ]]; then
    app_cli status </dev/null
    return
  fi

  random_hex() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex "$1"
    else
      head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
  }

  random_key() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32
    else
      head -c 32 /dev/urandom | base64 | tr -d '\n'
    fi
  }

  set_env() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
      sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file" && rm -f "${file}.bak"
    else
      printf '%s=%s\n' "$key" "$value" >>"$file"
    fi
  }

  # Compose bind-mounts the key file with its host owner and mode, as setup.sh sets them.
  secure_key_file() {
    if [[ "$(id -u)" -eq 0 ]]; then
      chown "${app_uid}:${app_uid}" "$1"
      chmod 400 "$1"
    else
      chmod 444 "$1"
    fi
  }

  # One rotation at a time: two would each start from the same old files.
  mkdir .rotate.lock 2>/dev/null ||
    die "Another rotation is running. If none is, remove ${dir}/.rotate.lock"
  trap 'rm -rf .rotate.lock' EXIT

  # A failed run leaves its backup for recovery; never overwrite it.
  [[ -e "$backup" ]] &&
    die "A previous rotation did not finish. Its files are in ${dir}/${backup}; remove that folder once things work."
  mkdir "$backup"
  # The backup is kept only when a run fails after it changed something.
  # Literal paths: the trap runs after main() returns, when its locals are gone.
  ROTATE_CHANGED=0
  trap 'rm -rf .rotate.lock .env.rotate secrets/file_encryption_key.new; ((ROTATE_CHANGED)) || rm -rf .rotate-backup' EXIT
  cp -p .env "${backup}/env"
  [[ -f "$key_file" ]] && cp -p "$key_file" "${backup}/file_encryption_key"

  echo -e "\n${BOLD}TMA Cloud rotation: ${command}${NC}\n"

  local do_key=0 do_db=0 do_redis=0
  [[ "$command" == "key" || "$command" == "all" ]] && do_key=1
  [[ "$command" == "db" || "$command" == "all" ]] && do_db=1
  [[ "$command" == "redis" || "$command" == "all" ]] && do_redis=1

  local new_env=.env.rotate
  cp -p .env "$new_env"

  local new_version=""
  if ((do_key)); then
    [[ -s "$key_file" ]] || die "${key_file} is missing or empty"
    # Entries as "version:key", one per line; a plain key from setup.sh is version 1.
    local entries
    entries="$(grep -v '^[[:space:]]*#' "$key_file" | tr ',' '\n' | tr -d ' \t\r' | grep -v '^$' || true)"
    if [[ "$(printf '%s\n' "$entries" | wc -l)" -eq 1 && ! "$entries" =~ ^[0-9]+: ]]; then
      entries="1:${entries}"
    fi
    printf '%s\n' "$entries" | grep -qv '^[0-9][0-9]*:.' && die "${key_file} has a line that is not \"version:key\""
    local newest recorded db_user db_name
    newest="$(printf '%s\n' "$entries" | cut -d: -f1 | sort -n | tail -1)"
    # A version the app already recorded a check value for, from an earlier
    # attempt, would never match a new key, so the next number must pass it.
    docker compose up -d --wait --wait-timeout 180 postgres redis </dev/null || die "PostgreSQL or Redis did not start"
    db_user="$(grep '^DB_USER=' .env | tail -n1 | cut -d= -f2-)"
    db_name="$(grep '^DB_NAME=' .env | tail -n1 | cut -d= -f2-)"
    recorded="$(docker compose exec -T postgres psql -U "${db_user:-postgres}" -d "${db_name:-tma_cloud_storage}" \
      -tAc 'SELECT COALESCE(MAX(version), 0) FROM kek_checks' </dev/null 2>/dev/null || true)"
    [[ "$recorded" =~ ^[0-9]+$ ]] || recorded=0
    ((recorded > newest)) && newest=$recorded
    new_version=$((newest + 1))
    {
      echo '# TMA Cloud file encryption keys, one "version:key" per line.'
      echo '# The highest version encrypts new data. Older lines decrypt data not yet'
      echo '# rewrapped and data in older backups, so keep them with those backups.'
      printf '%s\n' "$entries" | sort -t: -k1,1n
      printf '%s:%s\n' "$new_version" "$(random_key)"
    } >"${key_file}.new"
    secure_key_file "${key_file}.new"
    info "Prepared master key version ${new_version}"
  fi

  if ((do_redis)); then
    set_env REDIS_PASSWORD "$(random_hex 32)" "$new_env"
    info "Prepared a new Redis password"
  fi

  if ((do_db)); then
    local db_password
    db_password="$(random_hex 32)"
    set_env DB_PASSWORD "$db_password" "$new_env"
    # The running app changes its own role's password; .env follows right after.
    ROTATE_CHANGED=1
    printf '%s' "$db_password" | app_cli db-password --stdin ||
      { ROTATE_CHANGED=0; die "The database password was not changed. Nothing else was changed."; }
    success "Database password changed"
  fi

  ROTATE_CHANGED=1
  [[ -f "${key_file}.new" ]] && mv -f "${key_file}.new" "$key_file"
  mv -f "$new_env" .env
  chmod 600 .env

  info "Restarting containers"
  if ((do_db || do_redis)); then
    # New .env values recreate every service that uses them.
    docker compose up -d --wait --wait-timeout 180 </dev/null || {
      echo -e "${RED}[ERROR]${NC} Containers did not come back healthy. Check: docker compose logs app" >&2
      echo "The previous .env is in ${dir}/${backup}" >&2
      ((do_key)) && echo "Keep ${key_file} as it is: it holds every key version, including ${new_version}." >&2
      exit 1
    }
  fi
  if ((do_key && !do_db && !do_redis)); then
    # A single-file mount keeps the old file until the container is recreated.
    # On failure the new key file stays: it still holds every older key, and the
    # worker may already have wrapped file keys under the new version.
    docker compose up -d --wait --wait-timeout 180 --no-deps --force-recreate app worker </dev/null ||
      die "The app did not become healthy. ${key_file} keeps key version ${new_version}; do not remove it. Check: docker compose logs app. The previous key file is in ${dir}/${backup}"
  fi
  success "Containers are running"
  # The new values are in use, so the backup of the old ones goes (read by the EXIT trap).
  # shellcheck disable=SC2034
  ROTATE_CHANGED=0

  if ((do_key)); then
    info "Rewrapping stored file keys under version ${new_version}"
    app_cli rewrap </dev/null ||
      die "Some file keys were not rewrapped. They still open with their old key, and the worker retries on its next start. Check: ./rotate.sh status"
    success "Master key rotated to version ${new_version}"
  fi
  ((do_redis)) && success "Redis password rotated"

  echo
  if ((do_key)); then
    echo "Back up the key file again now; it holds the new key:"
    echo "  ${dir}/${key_file}"
    echo "  ${backup_guide}"
  fi
}

main "$@"
