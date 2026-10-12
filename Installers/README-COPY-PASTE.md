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

## 5. Start ComfyUI

```bash
cd /workspace/runpod-slim/ComfyUI && .venv-cu128/bin/python main.py --listen 0.0.0.0 --port 8188 --enable-cors-header
```

Wait for **To see the GUI…**. Leave this terminal running.
Open RunPod → your pod → Connect → ComfyUI. Press Ctrl+F5 if already open.

## 6. Load the workflow

In JupyterLab's file browser, open this folder:

```text
/workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/workflows
```

Download **muse_minimax_h3_director_V1.4.json** to your computer, then drag it
onto the ComfyUI canvas. Only the workflow JSON needs downloading to your computer.

## 7. Download the seven models directly onto RunPod

Open a **NEW** JupyterLab terminal: File → New → Terminal.
Do not paste this into the terminal still running ComfyUI.
Cancel any browser model downloads or other model downloads before starting.

```bash
cd /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers && \
curl -fL --retry 3 -o Download-Models-RunPod.py https://raw.githubusercontent.com/muse-collective-26/MiniMaxH3-Director-V1.2/main/Installers/Download-Models-RunPod.py && \
/workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python Download-Models-RunPod.py --comfyui /workspace/runpod-slim/ComfyUI
```

Check the space summary. Type **y** and press Enter.
Wait for **All 7 selected model files are present**.

This downloads approximately **68 GB** into the correct model folders on the pod.
No GGUF alternatives or preview models. Actual free space is checked first;
100 GB total storage must also hold ComfyUI, dependencies and outputs.
If interrupted, repeat this block to resume. No reinstall required.

## 8. Select models and references

Refresh ComfyUI's model lists, then select the downloaded filenames.
If they do not appear, stop ComfyUI with step 2 in the available terminal and
restart with step 5 after the original ComfyUI terminal returns to its prompt.
Refresh the browser. Do not start a second ComfyUI process alongside the first.

Upload your own reference images using ComfyUI's upload controls.
Keep unused LoRA slots disabled. Do not render until all downloads finish.
