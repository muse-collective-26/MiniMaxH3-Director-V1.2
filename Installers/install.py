"""Install the public Director release and its example-workflow dependencies."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
WORKFLOW = "muse_minimax_h3_director_V1.4.json"


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def valid_root(path):
    return (path / "main.py").is_file() and (path / "custom_nodes").is_dir()


def find_root(explicit=None):
    if explicit:
        result = Path(explicit).expanduser().resolve()
        if not valid_root(result):
            raise RuntimeError("ComfyUI folder must contain main.py and custom_nodes: " + str(result))
        return result
    nearby = [Path.cwd(), *HERE.parents]
    for candidate in nearby:
        if valid_root(candidate):
            return candidate
    common = [Path(p) for p in ("/workspace/ComfyUI", "/workspace/runpod-slim/ComfyUI", "/workspace/madapps/ComfyUI")]
    matches = [p for p in common if valid_root(p)]
    if len(matches) == 1:
        return matches[0]
    raise RuntimeError("Cannot identify one ComfyUI installation. Use --comfyui followed by the folder containing main.py.")


def normalize_origin(value):
    return value.strip().lower().replace("git@github.com:", "https://github.com/").removesuffix("/").removesuffix(".git")


def existing_pack(custom, name, repo):
    expected = normalize_origin("https://github.com/" + repo)
    matches = []
    for child in custom.iterdir():
        if not child.is_dir():
            continue
        folder_key = child.name.lower().removesuffix("-main").removesuffix("-master").replace("-", "_")
        matched = folder_key == name.lower().replace("-", "_")
        if (child / ".git").exists():
            result = subprocess.run(["git", "-C", str(child), "remote", "get-url", "origin"], capture_output=True, text=True)
            matched |= result.returncode == 0 and normalize_origin(result.stdout) == expected
        if matched:
            matches.append(child)
    if len(matches) > 1:
        raise RuntimeError(f"Multiple copies of {name}: {matches}. Resolve duplicates before installing.")
    return matches[0] if matches else None


def python_candidates(root):
    executable = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    return [root / ".venv" / executable, root / "venv" / executable,
            root.parent / "python_embeded/python.exe", root.parent / "python_embedded/python.exe",
            root.parent / ".venv" / executable, root.parent / "venv" / executable]


def select_python(root, explicit=None):
    # A Linux venv's bin/python is normally a symlink to the system binary.
    # Resolving it discards the venv and installs into the wrong environment.
    candidate = Path(explicit).expanduser() if explicit else next(
        (p for p in python_candidates(root) if p.is_file()), Path(sys.executable))
    return candidate.absolute()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfyui")
    parser.add_argument("--python", dest="python_path", help="ComfyUI's Python executable")
    parser.add_argument("--check", action="store_true", help="Show plan without installing or downloading")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--runpod", action="store_true", help="RunPod workflow and included local image analysis")
    parser.add_argument("--selected-python", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = find_root(args.comfyui)
    if not args.selected_python:
        selected = select_python(root, args.python_path)
        if selected != Path(sys.executable).absolute():
            result = subprocess.run([str(selected), str(HERE / "install.py"), *sys.argv[1:], "--selected-python"])
            return result.returncode
    if platform.system() not in ("Windows", "Linux"):
        raise RuntimeError("This installer supports Windows and Linux RunPod.")
    if args.runpod and platform.system() != 'Linux':
        raise RuntimeError('--runpod requires Linux; use Install-Windows.bat on Windows.')
    if platform.system() == "Linux" and platform.machine().lower() not in ("x86_64", "amd64"):
        raise RuntimeError("This RunPod installer targets x86-64, not ARM64/DGX Spark. No files changed.")
    if not shutil.which("git"):
        raise RuntimeError("Git is required. Install Git before continuing.")
    if not (root / "comfy_extras/nodes_minimax_h3.py").is_file():
        raise RuntimeError("This ComfyUI lacks native H3 support. Update ComfyUI separately first.")
    # Preserve the working CUDA/PyTorch installation, including CUDA build suffixes.
    protected = {}
    for package in ("torch", "torchvision", "torchaudio"):
        try:
            protected[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            raise RuntimeError(f"{package} missing from {sys.executable}. Select ComfyUI's Python with --python.")
    custom = root / "custom_nodes"
    packages = json.loads((HERE / "dependencies.json").read_text(encoding="utf-8"))
    plan = [(name, repo, sha, existing_pack(custom, name, repo)) for name, repo, sha in packages]
    print("Muse public Director / V1.2 repository installer (current node label: V1.4)")
    print("ComfyUI:", root, "\nPython:", sys.executable)
    print("Protected packages:", protected)
    for name, repo, sha, existing in plan:
        print("KEEP" if existing else "INSTALL", existing or name)
    print("Existing node folders are kept, except the stated RunPod KJNodes compatibility repair; requirements are installed.")
    print("No H3 models, DLSS, SageAttention, ComfyUI updates or renders are included.")
    print("Optional RIFE seam interpolation is not installed; leave seam_interpolation_frames at 0.")
    if args.runpod:
        print('Incompatible official KJNodes checkouts are updated to the pinned revision if clean; local edits are preserved.')
        print('RunPod includes Ollama and gemma3:4b vision (~3.4 GB plus runtime).')
        print('Stored under ComfyUI/.muse-runpod; loopback only, port 11435.')
        print('Gemma licence: https://ollama.com/library/gemma3:4b — review before confirming.')
    if args.check:
        return 0
    if not args.yes and input("Close ComfyUI. Is this its correct Python and folder? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Cancelled. Nothing changed.")
        return 0
    run([sys.executable, "-m", "pip", "--version"])
    # Stage downloads outside custom_nodes; a failed clone must not become a live node.
    stage = Path(tempfile.mkdtemp(prefix="muse-public-installer-"))
    print("Download/log staging folder:", stage)
    constraints = stage / "constraints.txt"
    constraints.write_text("\n".join(f"{key}=={value}" for key, value in protected.items()) + "\n", encoding="utf-8")
    installed = []
    for name, repo, sha, existing in plan:
        target = existing
        if target is None:
            target = stage / name
            run(["git", "clone", "https://github.com/" + repo + ".git", target])
            run(["git", "-C", target, "checkout", "--detach", sha])
            run(["git", "-C", target, "submodule", "update", "--init", "--recursive"])
            destination = custom / name
            if destination.exists():
                raise RuntimeError(f"Folder appeared during installation: {destination}; not overwriting.")
            shutil.move(str(target), str(destination))
            target = destination
        installed.append(target)
        if args.runpod and name == 'ComfyUI-KJNodes':
            import runpod_setup
            runpod_setup.ensure_kjnodes(target, sha)
            runpod_setup.configure_previews(target)
    requirements = []
    for target in installed:
        req = target / "requirements.txt"
        if req.is_file():
            requirements.extend(["-r", str(req)])
    run([sys.executable, "-m", "pip", "install", "-c", constraints, *requirements, "av", "imageio-ffmpeg"])
    for package, version in protected.items():
        if importlib.metadata.version(package) != version:
            raise RuntimeError(f"Unexpected change to {package}. Stop and inspect the installation log.")
    source = installed[0] / "workflows" / WORKFLOW
    if args.runpod:
        import runpod_setup
        runpod_setup.install(root)
        prepared = runpod_setup.workflow(json.loads(source.read_text(encoding='utf-8')))
        source = installed[0] / 'workflows' / runpod_setup.WORKFLOW
        source.write_text(json.dumps(prepared, indent=2) + '\n', encoding='utf-8')
    destination = root / "user/default/workflows/Muse Collective" / WORKFLOW
    if args.runpod:
        destination = destination.with_name(runpod_setup.WORKFLOW)
        runpod_setup.publish_workflow(source, destination)
    if source.is_file() and not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    print("Installation finished. Restart ComfyUI and hard-refresh your browser.")
    print("Load workflow:", source)
    print("Select your installed models and reference assets before rendering.")
    print("If existing nodes were kept, this does not certify their version compatibility.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("INSTALLATION STOPPED:", error, file=sys.stderr)
        sys.exit(1)
