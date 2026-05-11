#!/usr/bin/env bash
# Village pre-tag hook
# Full quality gates that run before creating a tag (release).
# Installed by: village up

set -euo pipefail

# Check if this is a Village-managed repo
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -d "$GIT_ROOT/.village" ] || exit 0

echo "Running quality gates before tag..."
echo ""

echo "  ruff check..."
if ! uv run ruff check .; then
    echo ""
    echo "  FAILED: ruff check found errors. Fix before tagging."
    exit 1
fi

echo "  ruff format..."
if ! uv run ruff format --check .; then
    echo ""
    echo "  FAILED: ruff format found issues. Run 'uv run ruff format .' and retry."
    exit 1
fi

echo "  mypy..."
if ! uv run mypy village/; then
    echo ""
    echo "  FAILED: mypy found errors. Fix before tagging."
    exit 1
fi

echo "  pytest..."
if ! uv run pytest -q; then
    echo ""
    echo "  FAILED: tests failed. Fix before tagging."
    exit 1
fi

echo ""
echo "All quality gates passed. Proceeding with tag."
