#!/usr/bin/env bash

set -euo pipefail

export OMNI_BACKEND_URL=${OMNI_BACKEND_URL:-http://127.0.0.1:28080}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-/tmp/cargo_build_target}

build_service() {
    cargo build --release --bin omni-stream
}

build_frontend() {
    cd frontend
    fnm use
    pnpm build
    cd ..
}

build_all() {
    build_service
    build_frontend
}

run_service() {
    OMNI_CONFIG=./config.toml cargo run --bin omni-stream
}

run_frontend() {
    cd frontend
    fnm use
    pnpm dev
    cd ..
}

usage() {
    echo "Usage: $0 [run|build] [options]" >&2
    echo "  $0                  same as: $0 run" >&2
    echo "  $0 run              run backend service" >&2
    echo "  $0 run --frontend|-f  run frontend dev server only" >&2
    echo "  $0 build            same as: $0 build --all" >&2
    echo "  $0 build --all|-a       build backend + frontend" >&2
    echo "  $0 build --frontend|-f  build frontend only" >&2
    echo "  $0 build --backend|-b    build backend only" >&2
    exit 1
}

set_build_target() {
    local new=$1
    if [[ -z ${BUILD_TARGET:-} ]]; then
        BUILD_TARGET=$new
    elif [[ "$BUILD_TARGET" != "$new" ]]; then
        echo "error: conflicting build options (use only one of --all/-a, --frontend/-f, --backend/-b)" >&2
        exit 1
    fi
}

main() {
    local cmd=""
    local run_frontend_only=0

    if [[ $# -eq 0 ]]; then
        cmd=run
    elif [[ "$1" == "-h" || "$1" == "--help" ]]; then
        usage
    else
        case "$1" in
            run | build)
                cmd=$1
                shift
                ;;
            *)
                echo "error: unknown command: $1" >&2
                usage
                ;;
        esac
    fi

    BUILD_TARGET=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h | --help)
                usage
                ;;
            --frontend | -f)
                if [[ "$cmd" == "run" ]]; then
                    run_frontend_only=1
                else
                    set_build_target frontend
                fi
                shift
                ;;
            --all | -a)
                [[ "$cmd" == "run" ]] && {
                    echo "error: unknown option: $1" >&2
                    exit 1
                }
                set_build_target all
                shift
                ;;
            --backend | -b)
                [[ "$cmd" == "run" ]] && {
                    echo "error: unknown option: $1" >&2
                    exit 1
                }
                set_build_target backend
                shift
                ;;
            *)
                echo "error: unknown option: $1" >&2
                usage
                ;;
        esac
    done

    case "$cmd" in
        build)
            [[ -z $BUILD_TARGET ]] && BUILD_TARGET=all
            case "$BUILD_TARGET" in
                all) build_all ;;
                frontend) build_frontend ;;
                backend) build_service ;;
            esac
            ;;
        run)
            if [[ $run_frontend_only -eq 1 ]]; then
                run_frontend
            else
                run_service
            fi
            ;;
    esac
}

main "$@"
