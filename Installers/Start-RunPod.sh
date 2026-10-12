#!/usr/bin/env bash
set -euo pipefail
installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
comfy_root="${1:-/workspace/runpod-slim/ComfyUI}"
comfy_python="${2:-$comfy_root/.venv-cu128/bin/python}"
"$comfy_python" "$installer_dir/runpod_setup.py" --comfyui "$comfy_root" --start-only
cd -- "$comfy_root"
exec "$comfy_python" main.py --listen 0.0.0.0 --port 8188 --enable-cors-header
