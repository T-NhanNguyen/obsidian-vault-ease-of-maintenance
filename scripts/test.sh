#!/bin/bash
# Test runner — token-efficient output for the coding agent.
# Ported from scripts/test.sh
#
# Usage:
#   scripts/test.sh                 # full suite
#   scripts/test.sh tests/unit/     # one folder
#   scripts/test.sh -t "chunker"    # by test name pattern

set -uo pipefail

cd "$(dirname "$0")/.."

npx vitest run "$@" 2>&1
