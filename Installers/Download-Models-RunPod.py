#!/usr/bin/env python3
"""Download seven generation models and the tiny H3 preview model. No pip needed."""
import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

MODELS = json.loads(r'''[{"folder":"vae","url":"https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors","name":"minimax_h3_video_vae_fp16.safetensors"},{"folder":"vae","url":"https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors","name":"minimax_h3_audio_vae_fp32.safetensors"},{"folder":"diffusion_models","url":"https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors","name":"minimax_h3_fl2va_pruned_int8_convrot.safetensors"},{"folder":"diffusion_models","url":"https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors","name":"minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors"},{"folder":"text_encoders","url":"https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors","name":"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"},{"folder":"latent_upscale_models","url":"https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors","name":"minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors"},{"folder":"loras/H3","url":"https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors","name":"minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"}]''')

MODELS.append({'folder': 'vae_approx', 'name': 'taeh3.safetensors',
               'url': 'https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors'})

def remote_size(url):
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Muse-Model-Downloader/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response:
        size = response.headers.get("Content-Length")
        if not size or int(size) <= 0:
            raise RuntimeError("Server did not provide a valid file size: " + url)
        return int(size)

def destination(root, model):
    target = root / "models" / model["folder"] / model["name"]
    target.resolve().relative_to(root.resolve())
    return target

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfyui", type=Path, default=Path("/workspace/runpod-slim/ComfyUI"))
    parser.add_argument("--check", action="store_true", help="Check links, sizes and disk space without downloading")
    args = parser.parse_args()
    root = args.comfyui.resolve()
    if not (root / "main.py").is_file() or not (root / "models").is_dir():
        raise RuntimeError("Not a ComfyUI folder (main.py and models required): " + str(root))
    if not shutil.which("curl"):
        raise RuntimeError("curl is required but was not found.")
    print("Destination: " + str(root / "models"), flush=True)
    print("Includes seven selected generation models plus the tiny H3 preview model. No GGUF alternatives.")
    print("Model licences remain those of their publishers. Checking all URLs before downloading...", flush=True)
    plan = []
    remaining = 0
    for model in MODELS:
        target = destination(root, model)
        size = remote_size(model["url"])
        complete = target.exists()
        if complete and target.stat().st_size != size:
            raise RuntimeError("Existing file has an unexpected size; left untouched: " + str(target))
        partial = target.with_name(target.name + ".part")
        if not complete and partial.exists() and partial.stat().st_size > size:
            raise RuntimeError("Oversized partial file; left untouched: " + str(partial))
        have = partial.stat().st_size if partial.exists() else 0
        if not complete:
            remaining += size - have
        print(("[KEEP] " if complete else "[GET]  ") + str(target.relative_to(root)) +
              "  %.2f GB" % (size / 1e9), flush=True)
        plan.append((model, target, partial, size, complete))
    free = shutil.disk_usage(root / "models").free
    print("Additional download: %.2f GB; free disk: %.2f GB" % (remaining / 1e9, free / 1e9), flush=True)
    if free < remaining + 2 * 1024**3:
        raise RuntimeError("Insufficient disk space. Increase storage or free space first; 2 GiB headroom required.")
    if args.check:
        print("Link and storage checks passed. No models downloaded.")
        return
    if input("Download these models directly onto this machine? Type y: ").strip().lower() != "y":
        print("Cancelled. No models downloaded.")
        return
    for index, (model, target, partial, size, complete) in enumerate(plan, 1):
        if complete:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print("\n[%d/%d] %s" % (index, len(plan), model["name"]), flush=True)
        subprocess.run(["curl", "--fail", "--location", "--retry", "5", "--connect-timeout", "30",
                        "--continue-at", "-", "--output", str(partial), model["url"]], check=True)
        if partial.stat().st_size != size:
            raise RuntimeError("Download size mismatch; partial file retained: " + str(partial))
        if target.exists():
            raise RuntimeError("Destination appeared during download; not replacing it: " + str(target))
        partial.rename(target)
    print("\nAll 8 selected model files are present (file sizes checked; not a render test).")
    print("Refresh ComfyUI model lists, or restart ComfyUI if filenames are not visible.")
    print("Select your model filenames. Keep unused optional LoRA slots disabled.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Re-run the same command to resume partial downloads.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print("\nERROR: " + str(error), file=sys.stderr)
        print("Not complete. Resolve the error and re-run; completed files are kept.", file=sys.stderr)
        sys.exit(1)

