# Public Director installers — Windows and RunPod

These install the **free MiniMaxH3-Director-V1.2 repository**, not paid Director V2.
The current public repository calls its node **Muse Minimax Director V1.4**; the
repository name has stayed V1.2. Neither the node nor the supplied workflow is
renamed by this installer.

## Windows

1. Close ComfyUI. Install Git for Windows if you do not already have it.
2. Download this repository's ZIP and extract it.
3. Put the **whole extracted repository folder** inside `ComfyUI/custom_nodes`.
   Do not copy only the BAT file. Avoid a second copy if already installed.
4. Inside that folder open `Installers`, then double-click `Install-Windows.bat`.
5. Check the displayed ComfyUI and Python paths, then type `y` to install.
6. Restart ComfyUI and refresh the browser.

The ComfyUI root is the folder containing **main.py** and **custom_nodes**.
The installer detects a local `.venv`, `venv`, or portable `python_embeded`.
If it cannot find your Python, run it explicitly, for example:

```cmd
"C:\ComfyUI_windows_portable\python_embeded\python.exe" "C:\ComfyUI_windows_portable\ComfyUI\custom_nodes\MiniMaxH3-Director-V1.2-main\Installers\install.py"
```

## RunPod (Linux x86-64)

### Start here — commands for the video

Keep this GitHub page open beside JupyterLab. Copy each command block below
into the **RunPod JupyterLab terminal**, then press Enter. You do not need to
download a ZIP to your own computer or upload an installer from Downloads.

These instructions install the **free Director**, not paid Director V2.
They use the official RunPod ComfyUI template with ComfyUI at
`/workspace/runpod-slim/ComfyUI`. Other templates may use different paths.

### 1. Before deployment

- Choose your GPU and the official ComfyUI template. RunPod directs RTX 5090
  and other Blackwell users to its **CUDA 13.0** template.
- Attach a **Standard Network Volume before deploying** if you want to retain
  the installation and models after terminating the pod. Store them under `/workspace`.
- **200 GB is a starting recommendation, not a tested minimum** for every model
  combination. Allow more space for multiple models and accumulated outputs.
- At the current standard rate of $0.07/GB/month, 200 GB costs about $14/month,
  separate from GPU rental. Check the deployment screen for the current price.
- Network volumes remain billable when the GPU is not running. Keep account
  credit available and back up important outputs. Container disk is temporary;
  a pod's own volume disk survives stopping but not termination.
- Network volume location limits GPU availability. Check compatibility before
  creating the volume or deploying the pod.

Sources: [RunPod template](https://github.com/runpod-workers/comfyui-base),
[network volumes](https://docs.runpod.io/storage/network-volumes),
[storage types](https://docs.runpod.io/pods/storage/types).

### 2. Open JupyterLab

- Wait until **ComfyUI (8188)** and **JupyterLab (8888)** show Ready.
- Open **JupyterLab**, then **Terminal** from the Launcher.
- No SSH key is needed for this method.

### 3. Check Python and CUDA

```bash
/workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python -c "import torch; print('CUDA:', torch.version.cuda); print('GPU available:', torch.cuda.is_available())"
```

For the CUDA 13 template, expect `CUDA: 13.0` and `GPU available: True`.
For the CUDA 12.8 template, expect `CUDA: 12.8` and `GPU available: True`.
The current official startup script retains the `.venv-cu128` directory name
for both builds; the CUDA version printed above is what matters.
If the path does not exist, CUDA differs from your selected template, or GPU
availability is False, **stop here**. Do not create a replacement environment
or install into an arbitrary Python. Save the output for troubleshooting.

### 4. Stop ComfyUI, but keep the pod running

Do this with no render running. Do not click the pod's Stop or Terminate button.

```bash
pkill -TERM -f '[p]ython.*main.py'
```

### 5. Download the Director and installer onto the pod

```bash
cd /workspace/runpod-slim/ComfyUI/custom_nodes && git clone https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2.git
```

This creates `MiniMaxH3-Director-V1.2` inside the pod's `custom_nodes` folder.
The installer is included in its `Installers` subfolder. Nothing needs moving.

If that repository folder already exists, **do not clone another copy**. Update
the existing copy instead:

```bash
git -C /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2 pull --ff-only
```

If Git reports an error or conflicting local changes, stop rather than forcing it.

### 6. Run the installer

```bash
bash /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers/Install-RunPod.sh \
  --comfyui /workspace/runpod-slim/ComfyUI \
  --python /workspace/runpod-slim/ComfyUI/.venv-cu128/bin/python
```

- Check the displayed ComfyUI and Python paths.
- Type **y** when prompted, then wait for completion.
- If installation reports failure, keep the terminal output and resolve it
  before continuing. Do not treat an incomplete install as success.
- This installs nodes and dependencies, **not model weights**.

### 7. Start ComfyUI again

```bash
bash /workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/Installers/Start-RunPod.sh
```

Leave the terminal running. Return to **Connect → ComfyUI (8188)** and refresh
the browser if it was already open.

### 8. Load the workflow and select models

- In JupyterLab, open:
  `/workspace/runpod-slim/ComfyUI/custom_nodes/MiniMaxH3-Director-V1.2/workflows`.
- Download the installer-created `Muse MiniMax Director - RunPod.json` to your computer.
- Drag that JSON onto the ComfyUI canvas.
- Download the model weights using [Download Models — RunPod](DOWNLOAD-MODELS.md), then select their actual filenames.
- Upload your own reference assets and enter a short prompt.
- Leave DLSS disabled, optional RIFE frames at 0, and use a non-Sage attention
  option unless those optional components are separately configured.
- Run a short generation first.

The **workflow JSON** is downloaded to your computer for dragging into the
browser. The **installer and node code** are downloaded directly onto RunPod
by the clone command in step 5.

### Other ComfyUI folder layouts

For an existing `/workspace/ComfyUI` layout with an autodetectable Python environment:

```bash
cd /workspace/ComfyUI/custom_nodes
git clone https://github.com/muse-collective-26/MiniMaxH3-Director-V1.2.git
bash MiniMaxH3-Director-V1.2/Installers/Install-RunPod.sh
```

If this repository is already installed, do not clone another copy. Update it
with `git pull` from its existing folder and run its `Installers/Install-RunPod.sh`.
If Git reports local changes, stop rather than forcing the update.

For a different layout or Python environment:

```bash
bash /path/to/MiniMaxH3-Director-V1.2/Installers/Install-RunPod.sh --comfyui /path/to/ComfyUI --python /path/to/venv/bin/python
```

Check that the displayed Python is the one your ComfyUI launch command uses.
RunPod container/root environments are supported; ARM64/DGX Spark is not covered.
Use `--check` to inspect the plan without installing or downloading anything.

## RunPod compatibility repairs

RunPod now checks KJNodes for both MiniMax memory optimisation components.
An incompatible, clean official Git checkout is updated to the pinned revision;
modified or non-Git incompatible copies stop with an explanation, not a destructive reset.
KJ animated previews use WebP on RunPod to avoid unavailable NVENC sessions.
This is a small, explicit local modification to KJ's preview module; it does not
change final video encoding. Rerunning the installer is supported.

The RunPod example restores settings by name, includes valid memory/model-selection
defaults, and configures Ollama on port 11435 with gemma3:4b. The installed example
is refreshed on reinstall; any differing previous copy is retained under a
`-saved-` filename. Open the fresh **Muse MiniMax Director - RunPod** entry.
The model download step includes seven generation models plus the tiny H3 preview
model. The copy/paste steps are unchanged; no manual repair commands are required.

## After installation

Open `workflows/muse_minimax_h3_director_V1.4.json` from this repository. Where
available, a copy is added to `user/default/workflows/Muse Collective` without
overwriting an existing workflow. Choose your installed H3 model, text encoder,
video/audio VAEs, upscaler and reference assets; saved model names are examples.

The installer includes the Director/Refine package, Unified Loader, Run Stats,
H3 Multishot, Motion Context MultiRef, H3 latent-upscaler nodes, VideoHelperSuite,
KJNodes, GGUF, LayerStyle, Easy Use and iTools. It installs their Python
requirements into the displayed environment. Existing node folders are kept;
except for the explicit RunPod KJNodes repair described above.
New dependency copies use the revisions in `dependencies.json` (detached Git
checkouts); existing Git checkouts retain their current branch and changes.

H3 model weights, LoRAs, DLSS runtime and SageAttention binaries are not downloaded
by the node installer. The separate model download command provides the H3
weights. RunPod installation now includes Ollama and `gemma3:4b` for image analysis;
Windows installation does not. See [the updated copy/paste guide](README-COPY-PASTE.md)
for disk requirements, model licence and restarting both services.
Use a non-Sage attention option unless SageAttention is already configured.
Optional RIFE seam interpolation is not installed: leave its frame count at 0
unless you separately install ComfyUI-Frame-Interpolation. No ComfyUI core or
PyTorch-family upgrade is performed. Conflicting Python requirements stop the
installer instead of replacing the installed PyTorch versions.

Installer checks are not a GPU render test. Verify a short generation on your
RunPod template before recording the installation video. A dependency failure
is reported as a failure, not as a successful installation; retain the terminal
output for troubleshooting. Temporary download staging is printed for inspection.
