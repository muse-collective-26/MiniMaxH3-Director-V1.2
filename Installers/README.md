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

Use a pod that already has a working ComfyUI with native MiniMax H3 support.
Stop ComfyUI while installing, but keep the pod running. Open its terminal.
For the common `/workspace/ComfyUI` layout:

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

## After installation

Open `workflows/muse_minimax_h3_director_V1.4.json` from this repository. Where
available, a copy is added to `user/default/workflows/Muse Collective` without
overwriting an existing workflow. Choose your installed H3 model, text encoder,
video/audio VAEs, upscaler and reference assets; saved model names are examples.

The installer includes the Director/Refine package, Unified Loader, Run Stats,
H3 Multishot, Motion Context MultiRef, H3 latent-upscaler nodes, VideoHelperSuite,
KJNodes, GGUF, LayerStyle, Easy Use and iTools. It installs their Python
requirements into the displayed environment. Existing node folders are kept;
it does not silently update them. Update old dependencies separately if needed.
New dependency copies use the revisions in `dependencies.json` (detached Git
checkouts); existing Git checkouts retain their current branch and changes.

No model weights, LoRAs, DLSS runtime or SageAttention binaries are downloaded.
Use a non-Sage attention option unless SageAttention is already configured.
Optional RIFE seam interpolation is not installed: leave its frame count at 0
unless you separately install ComfyUI-Frame-Interpolation. No ComfyUI core or
PyTorch-family upgrade is performed. Conflicting Python requirements stop the
installer instead of replacing the installed PyTorch versions.

Installer checks are not a GPU render test. Verify a short generation on your
RunPod template before recording the installation video. A dependency failure
is reported as a failure, not as a successful installation; retain the terminal
output for troubleshooting. Temporary download staging is printed for inspection.
