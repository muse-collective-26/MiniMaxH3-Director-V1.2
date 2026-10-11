#!/usr/bin/env bash
set -euo pipefail
installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v python3 >/dev/null 2>&1; then
    exec python3 "$installer_dir/install.py" "$@"
elif command -v python >/dev/null 2>&1; then
    exec python "$installer_dir/install.py" "$@"
else
    echo "Python was not found. Use a RunPod template with ComfyUI already installed." >&2
    exit 1
fi
