#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

export START_SH_TEST_LOG="${test_dir}/commands.log"
export CARGO_TARGET_DIR="${test_dir}/target"
mkdir -p "${CARGO_TARGET_DIR}/release"

fnm() {
    printf 'fnm %s\n' "$*" >>"$START_SH_TEST_LOG"
}

pnpm() {
    printf 'pnpm %s\n' "$*" >>"$START_SH_TEST_LOG"
}

cargo() {
    printf 'cargo %s\n' "$*" >>"$START_SH_TEST_LOG"
}

export -f fnm pnpm cargo

service_bin="${CARGO_TARGET_DIR}/release/omni-stream"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "service\n" >>"$START_SH_TEST_LOG"' \
    >"$service_bin"
chmod +x "$service_bin"
touch "${service_bin}.duckdb-enabled"

(
    cd "$repo_root"
    ./start.sh run
)

expected=$'fnm use\npnpm build\ncargo build --release --bin omni-stream --features duckdb\nservice'
actual=$(<"$START_SH_TEST_LOG")
[[ "$actual" == "$expected" ]] || {
    printf 'unexpected command order:\n%s\n' "$actual" >&2
    exit 1
}
