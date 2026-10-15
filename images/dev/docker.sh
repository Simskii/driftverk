#!/bin/sh
set -eu
# Respect explicitly selected remote daemons and Docker contexts.
if [ -z "${DOCKER_HOST:-}" ] && [ -z "${DOCKER_CONTEXT:-}" ] && [ "$(/usr/bin/docker context show)" = default ]; then
  case "${1:-}" in
    --version|-v|--help|-h|help|completion|context|login|logout|manifest|'') ;;
    compose|buildx)
      case "${2:-}" in
        version|--help|-h|help|config) ;;
        *) /usr/local/bin/driftverk-start-docker ;;
      esac ;;
    -H|--host|--host=*|--context|--context=*) ;;
    *)
      case "${2:-}" in
        --help|-h) ;;
        *) /usr/local/bin/driftverk-start-docker ;;
      esac ;;
  esac
fi
exec /usr/bin/docker "$@"
