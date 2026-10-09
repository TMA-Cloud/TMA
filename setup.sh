#!/usr/bin/env bash
# ============================================================
#  TMA Cloud – one-command Docker setup
# ============================================================
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/TMA-Cloud/TMA/main/setup.sh | bash
#
#  Or download, read, then run it:
#    curl -fsSLO https://raw.githubusercontent.com/TMA-Cloud/TMA/main/setup.sh
#    bash setup.sh
#
#  Creates ./tma-cloud with compose.yml, .env, secrets/ and rotate.sh,
#  filling every password and key with random values, then starts the stack.
#
#  Re-running is safe: existing files and keys are never replaced, because a
#  new encryption key would make every stored file unreadable.
#
#  Environment (all optional):
#    TMA_DIR          Install directory (default: ./tma-cloud)
#    TMA_REF          Git branch or tag to download files from (default: main)
#    TMA_PORT         Host port for the app (default: 3000)
#    TMA_URL          Public URL users open (default: http://localhost:<port>)
#    TMA_NO_START=1   Prepare the files but do not start the containers
#    TMA_LOCAL_SOURCE Copy files from this repository checkout instead of
#                     downloading them (for testing the script itself)
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

  local repo_url="https://raw.githubusercontent.com/TMA-Cloud/TMA/${TMA_REF:-main}"
  local dir="${TMA_DIR:-$PWD/tma-cloud}"
  local port="${TMA_PORT:-3000}"
  local url="${TMA_URL:-http://localhost:${port}}"
  # The app container runs as this user (see the Dockerfile).
  local app_uid=1001

  # New files are private to the current user from the moment they exist.
  umask 077

  if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    die "TMA_PORT must be a port number"
  fi
  [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || die "TMA_URL must start with http:// or https://"

  # Prints n random bytes as hex, which needs no escaping in .env or sed.
  random_hex() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex "$1"
    else
      head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
  }

  # A 32-byte key in base64, the format FILE_ENCRYPTION_KEY expects.
  random_key() {
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32
    else
      head -c 32 /dev/urandom | base64 | tr -d '\n'
    fi
  }

  fetch() {
    local name="$1" dest="$2"
    if [[ -n "${TMA_LOCAL_SOURCE:-}" ]]; then
      cp "${TMA_LOCAL_SOURCE}/${name}" "$dest"
    else
      # HTTPS only, including redirects, and fail on any HTTP error.
      curl --proto '=https' --tlsv1.2 -fsSL "${repo_url}/${name}" -o "$dest" ||
        die "Could not download ${repo_url}/${name}"
    fi
  }

  # Replace KEY=... in .env, or append it when the line is missing.
  set_env() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
      sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file" && rm -f "${file}.bak"
    else
      printf '%s=%s\n' "$key" "$value" >>"$file"
    fi
  }

  echo -e "\n${BOLD}TMA Cloud setup${NC}\n"

  command -v curl >/dev/null 2>&1 || [[ -n "${TMA_LOCAL_SOURCE:-}" ]] || die "curl is required"
  command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)"
  if ! command -v openssl >/dev/null 2>&1 && [[ ! -r /dev/urandom ]]; then
    die "openssl or /dev/urandom is required to generate keys"
  fi

  mkdir -p "$dir"
  cd "$dir"
  info "Installing into ${dir}"

  if [[ -f compose.yml ]]; then
    info "compose.yml exists, keeping it"
  else
    fetch docker-compose.yml compose.yml
    success "Downloaded compose.yml"
  fi

  # Always refreshed, so rotation fixes reach existing installs.
  fetch rotate.sh rotate.sh
  chmod 700 rotate.sh
  success "Downloaded rotate.sh"

  if [[ -f .env ]]; then
    info ".env exists, keeping its values"
  else
    local tmp_env
    tmp_env="$(mktemp .env.XXXXXX)"
    fetch .env.example "$tmp_env"
    set_env DB_HOST postgres "$tmp_env"
    set_env REDIS_HOST redis "$tmp_env"
    set_env DB_PASSWORD "$(random_hex 32)" "$tmp_env"
    set_env REDIS_PASSWORD "$(random_hex 32)" "$tmp_env"
    set_env JWT_SECRET "$(random_hex 64)" "$tmp_env"
    set_env BPORT "$port" "$tmp_env"
    set_env BACKEND_URL "$url" "$tmp_env"
    # The key comes from secrets/file_encryption_key, mounted by compose.yml.
    set_env FILE_ENCRYPTION_KEY "" "$tmp_env"
    mv "$tmp_env" .env
    success "Created .env with random database, Redis and JWT secrets"
  fi
  chmod 600 .env

  mkdir -p secrets
  chmod 700 secrets
  local key_file=secrets/file_encryption_key
  if [[ -s "$key_file" ]]; then
    info "${key_file} exists, keeping it"
  else
    {
      echo '# TMA Cloud file encryption keys, one "version:key" per line.'
      echo '# The highest version encrypts new data. Older lines decrypt data not yet'
      echo '# rewrapped and data in older backups, so keep them with those backups.'
      printf '1:%s\n' "$(random_key)"
    } >"$key_file"
    success "Generated ${key_file}"
  fi
  # Compose bind-mounts the file with its host owner and mode. As root, hand it
  # to the app user; otherwise leave it world-readable, which the 0700 directory
  # still keeps private on the host.
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "${app_uid}:${app_uid}" "$key_file"
    chmod 400 "$key_file"
  else
    chmod 444 "$key_file"
  fi

  echo
  echo "Files:"
  echo "  Settings:        ${dir}/.env"
  echo "  Encryption key:  ${dir}/${key_file}"
  echo

  if [[ "${TMA_NO_START:-0}" == "1" ]]; then
    success "Files ready. Start with: cd ${dir} && docker compose up -d"
    return
  fi

  info "Starting containers"
  docker compose up -d
  success "TMA Cloud is starting at ${url}"
  echo
  echo "Next:"
  echo "  1. Open ${url} and create the first account; it becomes the admin."
  echo "  2. Connect a storage bucket in Settings > Storage."
  echo "  3. Back up the encryption key: https://tma-cloud.github.io/Wiki/docs/guides/operations/backups"
  echo
  echo "Rotate keys and passwords later with: cd ${dir} && ./rotate.sh <key|db|redis|all>"
  echo
  echo "Logs: cd ${dir} && docker compose logs -f app"
}

main "$@"
