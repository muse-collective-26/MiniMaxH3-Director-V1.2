# RunPod installation — copy and paste

Free Muse MiniMax Director (V1.2 repository / V1.4 workflow).
For the official RunPod ComfyUI template with ComfyUI installed at
`/workspace/runpod-slim/ComfyUI`.

Open JupyterLab → File → New → Terminal. Run each block in order.
These are the installation commands, not commands for deleting or resetting a pod.

## 1. Check the GPU

```bash
/workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python -c "import torch; print('CUDA:', torch.version.cuda); print('GPU available:', torch.cuda.is_available())"
```

On the CUDA 13 template used in the video: CUDA 13.0, GPU available True.
The `.venv-cu128` folder name is also used by this template's CUDA 13 build.
If GPU available is False, stop here.

## 2. Stop ComfyUI before installing

Keep the pod running. Do not run this during a render.

```bash
pkill -TERM -f '[p]ython.*main.py'
```

## 3. Download the node and installer

For a first installation. If Git says the folder already exists, stop;
do not delete it or create a second copy.

```bash
cd /workspace/runpod-slim/ComfyUI/custom_nodes && git clone https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2.git
```

## 4. Install

```bash
bash /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers/Install-RunPod.sh \
  --comfyui /workspace/runpod-slim/ComfyUI \
  --python /workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python
```

Check the displayed paths. Type **y** and press Enter.
Wait for **Installation finished**. If it reports an error, stop here.

This same install step checks ComfyUI's MiniMax audio-sampling support (FLOW_AV).
An older, clean official core is fast-forwarded to revision
`0df64eb242b7c5759c3e86afd5d1846d923b1033`, used by the successful local two-chunk
audio test. Compatible cores are kept. Core requirements are installed with the
existing PyTorch/CUDA packages pinned. Local core edits or divergent histories
stop the update rather than being overwritten. No extra installation step is needed.
This source/dependency check is not a guarantee of RunPod render quality.

The RunPod installer includes Ollama and the Gemma 3 4B vision model for Analyze.
That adds about 3.4 GB of model weights plus the Ollama runtime. Both are kept in
`ComfyUI/.muse-runpod` on your persistent storage. Review the
[model licence](https://ollama.com/library/gemma3:4b) before confirming installation.
No hosted API key is required. Port 11435 is local-only; do not expose it in RunPod.

## 5. Start ComfyUI

```bash
bash /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers/Start-RunPod.sh
```

Wait for **To see the GUI…**. Leave this terminal running.
Open RunPod → your pod → Connect → ComfyUI. Press Ctrl+F5 if already open.

## 6. Load the workflow

In ComfyUI, open **Workflows → Muse Collective → Muse MiniMax Director - RunPod**.
The installer puts it there automatically. No download or dragging is needed.
Use this RunPod example, not the standard V1.4 example or an older saved copy.

## 7. Download the models directly onto RunPod

Open a **NEW** JupyterLab terminal: File → New → Terminal.
Do not paste this into the terminal still running ComfyUI.
Cancel any browser model downloads or other model downloads before starting.

```bash
cd /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers && \
curl -fL --retry 3 -o Download-Models-RunPod.py https://raw.githubusercontent.com/muse-collective-26/MiniMaxH3-Director-V1.2/main/Installers/Download-Models-RunPod.py && \
/workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python Download-Models-RunPod.py --comfyui /workspace/runpod-slim/ComfyUI
```

Check the space summary. Type **y** and press Enter.
Wait for **All 8 selected model files are present**.

This downloads approximately **68 GB** into the correct model folders on the pod.
Includes the seven generation models plus the small `taeh3.safetensors` preview model.
No GGUF alternatives. Actual free space is checked first;
100 GB total storage must also hold ComfyUI, dependencies, Ollama and outputs.
If interrupted, repeat this block to resume. No reinstall required.

## 8. Select models and references

Refresh ComfyUI's model lists, then select the downloaded filenames.
If they do not appear, stop ComfyUI with step 2 in the available terminal and
restart with step 5 after the original ComfyUI terminal returns to its prompt.
Refresh the browser. Do not start a second ComfyUI process alongside the first.

Upload your own reference images using ComfyUI's upload controls.
Keep unused LoRA slots disabled. Do not render until all downloads finish.

The RunPod workflow has only the Turbo LoRA selected (Linux path), the two extra
LoRAs disabled, SageAttention off, and RIFE seam interpolation disabled (0 frames).
Do not load the Windows example instead. No RIFE installation is required.

Analyze is configured automatically: Ollama, `http://127.0.0.1:11435`, `gemma3:4b`.
Analyse references before rendering, not at the same time. The analysis request
unloads its Ollama model afterwards to release memory. First analysis can take
longer while loading the model. A service/model check is not a full inference test.

When returning after a pod restart, use **step 5** again to start both services.
Do not repeat the installation or model downloads. This assumes the same persistent
storage is attached and mounted at the same path. The Windows workflow is unchanged.
