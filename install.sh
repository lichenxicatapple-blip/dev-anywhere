#!/usr/bin/env bash
# Public VPS installer. Deployment logic lives in scripts/deploy/install-relay.sh.
# Keep execution after the complete function definition so a partial download
# cannot start an installation.
install_dev_anywhere() {
  set -euo pipefail

  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    printf '%s\n' \
      'Usage: bash install.sh <domain-or-public-ip>' \
      '       bash install.sh --ssh <user@vps> <domain-or-public-ip>' \
      '' \
      'Run directly on a Linux VPS as root, or deploy over SSH from macOS/Linux.' \
      'Optional environment: IMAGE_TAG, REGISTRY_BASE, DEV_ANYWHERE_RELAY_PORT.'
    return 0
  fi

  if [[ "${1:-}" == "--ssh" ]]; then
    if [[ "$#" != 3 || -z "$2" || "$2" == -* || -z "$3" || "$3" == -* ]]; then
      echo 'error: expected --ssh <user@vps> <domain-or-public-ip>' >&2
      return 2
    fi
  elif [[ "$#" != 1 || -z "${1:-}" || "$1" == -* ]]; then
    echo 'error: expected a domain or public IPv4 address; use --help for usage' >&2
    return 2
  fi

  local revision source_base relative_file
  # Resolve once: both payload files must come from the same immutable commit.
  revision="$(curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
    -H 'Accept: application/vnd.github.sha' \
    'https://api.github.com/repos/lichenxicatapple-blip/dev-anywhere/commits/main')"
  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'error: could not resolve the deployment script revision' >&2
    return 1
  fi

  # The trap owns only this newly created directory, including on failure.
  deploy_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/dev-anywhere-install.XXXXXX")"
  trap 'rm -rf -- "$deploy_tmp_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir -p "$deploy_tmp_dir/scripts/deploy" "$deploy_tmp_dir/scripts/lib"
  source_base="https://raw.githubusercontent.com/lichenxicatapple-blip/dev-anywhere/$revision"
  for relative_file in scripts/lib/install-relay-render.sh scripts/deploy/install-relay.sh; do
    curl --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 60 \
      --output "$deploy_tmp_dir/$relative_file" "$source_base/$relative_file"
    if [[ ! -s "$deploy_tmp_dir/$relative_file" ]]; then
      echo "error: downloaded an empty deployment script: $relative_file" >&2
      return 1
    fi
    bash -n "$deploy_tmp_dir/$relative_file"
  done

  bash "$deploy_tmp_dir/scripts/deploy/install-relay.sh" "$@"
}

install_dev_anywhere "$@"
