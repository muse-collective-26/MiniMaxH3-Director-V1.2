# Download workflow models directly onto RunPod

For the free Director workflow, not paid Director V2. Nothing downloads to your
computer. This downloads only the seven files selected in the screenshot:

- Reference model: minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors
- First/last-frame model: minimax_h3_fl2va_pruned_int8_convrot.safetensors
- Text encoder: qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
- Video VAE: minimax_h3_video_vae_fp16.safetensors
- Audio VAE: minimax_h3_audio_vae_fp32.safetensors
- Latent upscaler: minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors
- Turbo LoRA: minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors

Total: approximately **68.0 GB (63.3 GiB)**. No GGUF alternatives, extra LoRAs
or preview models are downloaded. A 100 GB volume must also accommodate ComfyUI,
its dependencies and your outputs; the script checks actual free space and
requires 2 GiB of extra headroom before downloading. It asks for confirmation.

## Steps for the video

1. Cancel any model downloads in your computer's browser. Do not start another
   model downloader on the pod at the same time.
2. Leave ComfyUI running. Open RunPod → your pod → Connect → JupyterLab.
3. Choose File → New → Terminal. Use a new terminal, not the one running ComfyUI.
4. Paste this complete block and press Enter:

```bash
cd /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers && \
curl -fL --retry 3 -o Download-Models-RunPod.py https://raw.githubusercontent.com/muse-collective-26/MiniMaxH3-Director-V1.2/main/Installers/Download-Models-RunPod.py && \
/workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python Download-Models-RunPod.py --comfyui /workspace/runpod-slim/ComfyUI
```

5. Check the destination and free-space summary, then type **y** and press Enter.
6. Leave the terminal open until it says **All 7 selected model files are present**.
   Each download displays progress. If interrupted, repeat the same block:
   completed same-size files are kept and `.part` files resume.
7. Refresh ComfyUI's model lists. If files are still missing, restart ComfyUI
   using the start command in the installer README and refresh the browser.
8. Select the models in the Unified Loader and the latent upscaler in the Director.
   Do not queue a render while files are still downloading.

## Where the files go

Under `/workspace/runpod-slim/ComfyUI/models/`:

| Files | Folder |
|---|---|
| Two standard generation models | `diffusion_models` |
| Text encoder | `text_encoders` |
| Video/audio VAEs | `vae` |
| Latent upscaler | `latent_upscale_models` |
| Turbo LoRA | `loras/H3` |

Folders are created automatically. The script installs no Python packages and
does not stop ComfyUI, alter model settings, or change your workflow.
Existing files with an unexpected size are left untouched and reported as errors.
File-size checks are not cryptographic verification or a GPU render test.
Files persist only according to the storage mounted at this path; a network
volume must have been attached if you want them retained after pod termination.

Publisher licences still apply. Optional models mentioned elsewhere in the
workflow notes are not part of this seven-file download.

## Check only / different installation path

```bash
python3 Download-Models-RunPod.py --comfyui /workspace/ComfyUI --check
```

`--check` verifies links and storage without downloading weights. Remove it to
download. Use your actual ComfyUI folder (the one containing `main.py`).
