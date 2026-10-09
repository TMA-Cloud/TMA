#!/usr/bin/env bash
# ============================================================
#  TMA Cloud – update a Docker install
# ============================================================
#  Usage, in the install directory (next to compose.yml and .env):
#    ./update.sh
#
#  Without a local copy:
#    curl -fsSL https://raw.githubusercontent.com/TMA-Cloud/TMA/main/update.sh | bash
#
#  Steps:
#    1. Downloads compose.yml, .env.example, setup.sh, rotate.sh,
#       db-backup-restore.sh and update.sh and checks them before anything
#       changes. A newer update.sh replaces this one and runs in its place.
#    2. Backs up the database with pg_dump to backups/.
#    3. Replaces the files, keeping the old ones in .update/backup-<time>/.
#       A file you edited is left alone and the new one saved next to it as
#       <name>.new. Put local compose changes in compose.override.yml instead.
#    4. Adds settings that are new in .env.example to .env. Existing values
#       are never changed.
#    5. Pulls the new image and recreates the containers that changed.
#
#  Environment (all optional):
#    TMA_DIR              Install directory (default: the current directory)
#    TMA_REF              Git branch or tag to download files from (default: main)
#    TMA_NO_START=1       Update the files only; no backup, pull or restart
#    TMA_SKIP_DB_BACKUP=1 Skip the database backup
#    TMA_NO_PULL=1        Use the image already on this machine
#    TMA_FORCE=1          Replace files you edited too (the old ones are backed up)
#    TMA_LOCAL_SOURCE     Copy files from this repository checkout instead of
#                         downloading them (for testing the script itself)
# ============================================================

set -euo pipefail

# Everything lives in main(), called on the last line: if the download is cut
# off, bash never reaches the call and nothing half-runs. It also means bash
# has read the whole script before update.sh replaces itself.
main() {
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

  info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
  success() { echo -e "${GREEN}[OK]${NC}    $*"; }
  warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
  die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

  local repo_url="https://raw.githubusercontent.com/TMA-Cloud/TMA/${TMA_REF:-main}"
  local dir="${TMA_DIR:-$PWD}"
  local manifest=.tma-manifest
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local backup=".update/backup-${stamp}"
  local keep_backups=5
  local keep_dumps=3

  # New files are private to the current user from the moment they exist.
  umask 077
  cd "$dir"
  [[ -f compose.yml && -f .env ]] ||
    die "No compose.yml and .env in ${dir}. Run this in the install directory, set TMA_DIR, or install with setup.sh."
  command -v docker >/dev/null 2>&1 || die "Docker is required"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)"
  command -v curl >/dev/null 2>&1 || [[ -n "${TMA_LOCAL_SOURCE:-}" ]] || die "curl is required"

  file_hash() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | cut -d' ' -f1
    else
      shasum -a 256 "$1" | cut -d' ' -f1
    fi
  }
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
    die "sha256sum or shasum is required"

  fetch() {
    local name="$1" dest="$2"
    if [[ -n "${TMA_LOCAL_SOURCE:-}" ]]; then
      cp "${TMA_LOCAL_SOURCE}/${name}" "$dest"
    else
      # HTTPS only, including redirects, and fail on any HTTP error.
      curl --proto '=https' --tlsv1.2 -fsSL "${repo_url}/${name}" -o "$dest" ||
        die "Could not download ${repo_url}/${name}"
    fi
    [[ -s "$dest" ]] || die "${name} downloaded empty"
  }

  # The hash of a file as update.sh or setup.sh last installed it.
  recorded_hash() {
    [[ -f "$manifest" ]] || return 0
    awk -v f="$1" '$2 == f { print $1 }' "$manifest"
  }

  record_hash() {
    local name="$1" hash="$2" tmp
    tmp="$(mktemp "${manifest}.XXXXXX")"
    [[ -f "$manifest" ]] && awk -v f="$name" '$2 != f' "$manifest" >"$tmp"
    printf '%s %s\n' "$hash" "$name" >>"$tmp"
    mv -f "$tmp" "$manifest"
  }

  # One process at a time, and never during a rotation: both rewrite .env.
  [[ -e .rotate.lock ]] && die "A rotation is running (.rotate.lock). Try again when it finishes."
  mkdir .update.lock 2>/dev/null ||
    die "Another update is running. If none is, remove ${dir}/.update.lock"
  local staging
  staging="$(mktemp -d .update-staging.XXXXXX)"
  # Compose resolves env_file and secrets paths from the file's own folder,
  # so the new compose file is checked from the install directory.
  local new_compose=.compose.update.yml
  # Expanded now: the trap runs after main() returns, when its locals are gone.
  # shellcheck disable=SC2064
  trap "rm -rf .update.lock '${staging}' '${new_compose}'" EXIT

  echo -e "\n${BOLD}TMA Cloud update${NC}\n"
  info "Downloading from ${TMA_LOCAL_SOURCE:-$repo_url}"

  fetch docker-compose.yml "$new_compose"
  fetch .env.example "${staging}/.env.example"
  local script name
  for script in setup.sh rotate.sh update.sh scripts/db-backup-restore.sh; do
    name="${script##*/}"
    fetch "$script" "${staging}/${name}"
    head -n1 "${staging}/${name}" | grep -q '^#!/usr/bin/env bash' || die "${name} is not a bash script"
    bash -n "${staging}/${name}" || die "${name} has a syntax error; nothing was changed"
  done
  local -a compose_files=(-f "$new_compose")
  [[ -f compose.override.yml ]] && compose_files+=(-f compose.override.yml)
  docker compose "${compose_files[@]}" config -q ||
    die "The new compose.yml does not load with this .env; nothing was changed"
  success "Downloaded and checked the new files"

  # Copy a new file into place unless the current one has local edits.
  # Prints nothing when the file is already current.
  local -a replaced=() kept=()
  install_file() {
    local src="$1" name="$2" mode="$3" new_hash current_hash recorded
    new_hash="$(file_hash "$src")"
    if [[ -f "$name" ]]; then
      current_hash="$(file_hash "$name")"
      if [[ "$current_hash" == "$new_hash" ]]; then
        record_hash "$name" "$new_hash"
        return 0
      fi
      recorded="$(recorded_hash "$name")"
      # No record means an install from before update.sh: nothing to compare, so update it.
      if [[ -n "$recorded" && "$current_hash" != "$recorded" && "${TMA_FORCE:-0}" != "1" ]]; then
        cp "$src" "${name}.new"
        chmod "$mode" "${name}.new"
        kept+=("$name")
        return 0
      fi
      mkdir -p "$backup"
      cp -p "$name" "${backup}/${name}"
    fi
    # Same-directory rename: atomic, and a running copy keeps reading the old file.
    cp "$src" "${name}.tmp-update"
    chmod "$mode" "${name}.tmp-update"
    mv -f "${name}.tmp-update" "$name"
    record_hash "$name" "$new_hash"
    replaced+=("$name")
  }

  # A newer update.sh runs the rest of the update, so its own steps apply.
  if [[ -z "${TMA_UPDATE_REEXEC:-}" ]]; then
    install_file "${staging}/update.sh" update.sh 700
    if [[ " ${replaced[*]} " == *" update.sh "* ]]; then
      info "update.sh changed; running the new version"
      rm -rf .update.lock "$staging" "$new_compose"
      trap - EXIT
      TMA_UPDATE_REEXEC=1 TMA_DIR="$dir" exec bash ./update.sh "$@"
    fi
  fi

  local start=1
  [[ "${TMA_NO_START:-0}" == "1" ]] && start=0
  local running=0
  docker compose ps --status running --services 2>/dev/null | grep -qx postgres && running=1

  # A backup before new migrations run: the only way back after one.
  if ((start)) && ((running)) && [[ "${TMA_SKIP_DB_BACKUP:-0}" != "1" ]]; then
    local db_user db_name dump
    db_user="$(grep '^DB_USER=' .env | tail -n1 | cut -d= -f2-)"
    db_name="$(grep '^DB_NAME=' .env | tail -n1 | cut -d= -f2-)"
    mkdir -p backups
    chmod 700 backups
    dump="backups/pre-update-${stamp}.dump"
    info "Backing up the database to ${dump}"
    # Same options as scripts/db-backup-restore.sh: a consistent snapshot that
    # does not block writers, restorable into a fresh database.
    if ! docker compose exec -T postgres pg_dump -U "${db_user:-postgres}" -d "${db_name:-tma_cloud_storage}" \
      --format=custom --compress=6 --lock-wait-timeout=15000 --no-owner --no-privileges --serializable-deferrable \
      </dev/null >"${dump}.part" || [[ ! -s "${dump}.part" ]] ||
      ! docker compose exec -T postgres pg_restore --list <"${dump}.part" >/dev/null; then
      rm -f "${dump}.part"
      die "The database backup failed; nothing was changed. Skip it with TMA_SKIP_DB_BACKUP=1."
    fi
    mv -f "${dump}.part" "$dump"
    success "Database backed up ($(du -h "$dump" | cut -f1))"
    local -a dumps=(backups/pre-update-*.dump)
    if ((${#dumps[@]} > keep_dumps)); then
      rm -f "${dumps[@]:0:${#dumps[@]}-keep_dumps}"
    fi
  elif ((start)) && ! ((running)); then
    warn "PostgreSQL is not running, so the database was not backed up"
  fi

  install_file "$new_compose" compose.yml 600
  install_file "${staging}/setup.sh" setup.sh 700
  install_file "${staging}/rotate.sh" rotate.sh 700
  install_file "${staging}/db-backup-restore.sh" db-backup-restore.sh 700
  # Kept for reference: the comments explain each setting.
  cp "${staging}/.env.example" .env.example.tmp-update
  chmod 600 .env.example.tmp-update
  mv -f .env.example.tmp-update .env.example

  # Append settings the new .env.example has and .env lacks, each with the
  # comment lines right above it. Existing lines are never touched.
  local additions="${staging}/env-additions"
  local -a added=()
  local line key
  local -a comments=()
  : >"$additions"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" =~ ^#\ *-+$ ]]; then
      comments=()
    elif [[ "$line" == \#* ]]; then
      comments+=("$line")
    elif [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      key="${BASH_REMATCH[1]}"
      if ! grep -q "^${key}=" .env; then
        ((${#comments[@]})) && printf '%s\n' "${comments[@]}" >>"$additions"
        printf '%s\n' "$line" >>"$additions"
        added+=("$key")
      fi
      comments=()
    fi
  done <"${staging}/.env.example"

  if ((${#added[@]})); then
    mkdir -p "$backup"
    cp -p .env "${backup}/.env"
    cp -p .env .env.tmp-update
    [[ -n "$(tail -c1 .env.tmp-update)" ]] && echo >>.env.tmp-update
    {
      echo
      echo "# Added by update.sh on ${stamp}"
      cat "$additions"
    } >>.env.tmp-update
    chmod 600 .env.tmp-update
    mv -f .env.tmp-update .env
  fi

  # Settings .env still sets that the new .env.example no longer lists.
  local -a unused=()
  while IFS= read -r key; do
    grep -q "^#* *${key}=" "${staging}/.env.example" || unused+=("$key")
  done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d '=' | sort -u)

  local -a backups=(.update/backup-*)
  if [[ -d "${backups[0]}" ]] && ((${#backups[@]} > keep_backups)); then
    rm -rf "${backups[@]:0:${#backups[@]}-keep_backups}"
  fi

  ((${#replaced[@]})) && success "Updated: ${replaced[*]}"
  ((${#replaced[@]})) || info "compose.yml and the scripts were already current"
  ((${#added[@]})) && success "Added to .env: ${added[*]}. Review them: ${dir}/.env"
  ((${#unused[@]})) && info "No longer used by this version (safe to remove from .env): ${unused[*]}"
  local name
  for name in "${kept[@]}"; do
    warn "${name} has local edits, so it was kept. The new version is ${name}.new; merge it, or rerun with TMA_FORCE=1."
  done

  if ! ((start)); then
    success "Files updated. Apply them with: cd ${dir} && docker compose pull && docker compose up -d"
    return
  fi

  # Keep the running image under a name of its own before the pull moves the
  # tag away from it, so a rollback does not need the registry.
  local old_image="" rollback_tag=""
  local app_id
  app_id="$(docker compose ps -q app 2>/dev/null || true)"
  [[ -n "$app_id" ]] && old_image="$(docker inspect -f '{{.Image}}' "$app_id" 2>/dev/null || true)"
  if [[ -n "$old_image" ]] && docker tag "$old_image" "tma-cloud/tma:pre-update-${stamp}" 2>/dev/null; then
    rollback_tag="tma-cloud/tma:pre-update-${stamp}"
  fi

  if [[ "${TMA_NO_PULL:-0}" != "1" ]]; then
    info "Pulling images"
    if ! docker compose pull --quiet </dev/null; then
      [[ -n "$rollback_tag" ]] && docker rmi "$rollback_tag" >/dev/null 2>&1
      die "Could not pull the images. The running containers were not changed."
    fi
  fi

  info "Restarting changed containers"
  if ! docker compose up -d --wait --wait-timeout 300 --remove-orphans </dev/null; then
    echo -e "${RED}[ERROR]${NC} The containers did not come back healthy. Check: docker compose logs app" >&2
    [[ -d "$backup" ]] && echo "Previous files: ${dir}/${backup}" >&2
    [[ -n "${dump:-}" ]] && echo "Database backup: ${dir}/${dump}" >&2
    [[ -n "$rollback_tag" ]] && echo "Previous image: ${rollback_tag}" >&2
    exit 1
  fi

  local new_image version
  app_id="$(docker compose ps -q app)"
  new_image="$(docker inspect -f '{{.Image}}' "$app_id")"
  version="$(docker inspect -f '{{index .Config.Labels "version"}}' "$app_id" 2>/dev/null || true)"
  if [[ -n "$old_image" && "$old_image" == "$new_image" ]]; then
    success "TMA Cloud is running; the image was already current${version:+ (${version})}"
    [[ -n "$rollback_tag" ]] && docker rmi "$rollback_tag" >/dev/null 2>&1
  else
    success "TMA Cloud is running the new image${version:+ (${version})}"
    if [[ -n "$rollback_tag" ]]; then
      # One rollback image is enough: drop those from earlier updates.
      docker images --format '{{.Repository}}:{{.Tag}}' 'tma-cloud/tma' |
        grep ':pre-update-' | grep -vxF "$rollback_tag" | xargs -r docker rmi >/dev/null 2>&1 || true
      info "Previous image kept as ${rollback_tag}"
    fi
  fi
  return 0
}

main "$@"
