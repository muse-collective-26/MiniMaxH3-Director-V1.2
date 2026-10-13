"""RunPod core audio compatibility repair; no renders or service restarts."""
import argparse
import importlib.metadata
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile

# Exact core used by the successful local two-chunk audio test.
CORE_REVISION = '0df64eb242b7c5759c3e86afd5d1846d923b1033'
# Observed RunPod template snapshot: full checkout, but unrelated upstream history.
TEMPLATE_SNAPSHOTS = {'700a8f6669607a599c1834723f4c006418b5e3fe'}
REQUIRED = {
    'comfy/model_base.py': ('model_type=ModelType.FLOW_AV', 'def audio_scale(',
                            'def _scale_audio_slice(', 'payload["audio_scale"]'),
    'comfy/model_sampling.py': ('class ModelSamplingAV(', 'self.shift / self.audio_shift'),
    'comfy/ldm/minimax/model.py': ('audio_scale',),
    'comfy_extras/nodes_minimax_h3.py': ('ModelSamplingAV',),
}


def missing_support(root):
    missing = []
    for relative, markers in REQUIRED.items():
        path = root / relative
        source = path.read_text(encoding='utf-8') if path.is_file() else ''
        if not all(marker in source for marker in markers):
            missing.append(relative)
    return missing


def ensure_core(root):
    """Keep compatible cores; fast-forward clean official older cores only."""
    if not missing_support(root):
        print('ComfyUI MiniMax FLOW_AV audio support: present.')
        return

    def git(*args):
        result = subprocess.run(['git', '-C', str(root), *args],
                                capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('ComfyUI update stopped; no force/reset attempted.\n' + result.stderr.strip())
        return result.stdout.strip()

    origin = git('remote', 'get-url', 'origin').lower().rstrip('/').removesuffix('.git')
    allowed = ('https://github.com/comfy-org/comfyui', 'https://github.com/comfyanonymous/comfyui',
               'git@github.com:comfy-org/comfyui', 'git@github.com:comfyanonymous/comfyui')
    if origin not in allowed:
        raise RuntimeError('ComfyUI lacks required audio support and is not an official checkout; left untouched.')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('ComfyUI lacks required audio support and has tracked local edits; left untouched. '
                           'Do not reset or delete your changes.')
    previous = git('rev-parse', 'HEAD')
    print('Updating ComfyUI audio support:', previous, '->', CORE_REVISION)
    git('fetch', 'origin', CORE_REVISION)
    if previous in TEMPLATE_SNAPSHOTS:
        # Retain the template commit even when its HEAD was already detached.
        recovery = 'refs/muse-core-before/' + previous
        git('update-ref', recovery, previous)
        print('Retained original core at', recovery)
        # Template images can ship upstream example/config files as ignored or
        # untracked files. Preserve only exact target-file collisions, not folders.
        tracked = set(git('ls-files', '-z').split('\0'))
        target_files = git('ls-tree', '-r', '--name-only', '-z', CORE_REVISION).split('\0')
        collisions = []
        for relative in target_files:
            if not relative or relative in tracked:
                continue
            path = root / relative
            if not path.exists() and not path.is_symlink():
                continue
            if (path.is_symlink() or not path.is_file()
                    or root.resolve() not in path.resolve().parents
                    or any(p.is_symlink() for p in path.parents if p != root and root in p.parents)):
                raise RuntimeError('Unsafe core file collision; left untouched: ' + relative)
            collisions.append((relative, path))
        moved = []
        backup = None
        try:
            if collisions:
                backup_parent = root / '.muse-runpod/core-file-backups'
                if root.resolve() not in backup_parent.resolve().parents:
                    raise RuntimeError('Core backup directory escapes ComfyUI; no files moved.')
                backup_parent.mkdir(parents=True, exist_ok=True)
                backup = Path(tempfile.mkdtemp(prefix='before-' + previous[:12] + '-', dir=backup_parent))
                print('Preserving', len(collisions), 'conflicting template files in', backup, flush=True)
                for relative, path in collisions:
                    destination = backup / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(path), str(destination))
                    moved.append((path, destination))
            # Still refuse other collisions; never force overwrites or reset.
            git('checkout', '--detach', '--no-overwrite-ignore', CORE_REVISION)
        except Exception:
            for path, saved in reversed(moved):
                if not path.exists() and not path.is_symlink():
                    shutil.move(str(saved), str(path))
            if backup:
                print('Update stopped. Unrestored preserved files, if any, remain at', backup)
            raise
    else:
        # Unknown divergent histories still stop rather than switching arbitrarily.
        git('merge', '--ff-only', CORE_REVISION)
    missing = missing_support(root)
    if missing:
        raise RuntimeError('ComfyUI audio support verification failed: ' + ', '.join(missing))
    print('ComfyUI MiniMax FLOW_AV audio source check: passed. Restart required.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfyui', type=Path, required=True)
    args = parser.parse_args()
    root = args.comfyui.resolve()
    if sys.platform != 'linux' or not (root / 'main.py').is_file():
        raise RuntimeError('Select the RunPod Linux ComfyUI folder and its Python executable.')
    protected = {name: importlib.metadata.version(name) for name in ('torch', 'torchvision', 'torchaudio')}
    with tempfile.TemporaryDirectory(prefix='muse-core-repair-') as tmp:
        constraints = Path(tmp) / 'constraints.txt'
        constraints.write_text(''.join(f'{k}=={v}\n' for k, v in protected.items()), encoding='utf-8')
        ensure_core(root)
        # Also run on retry: a previous source update may have succeeded before pip failed.
        subprocess.run([sys.executable, '-m', 'pip', 'install', '-c', str(constraints),
                        '-r', str(root / 'requirements.txt')], check=True)
    for name, version in protected.items():
        if importlib.metadata.version(name) != version:
            raise RuntimeError('Protected package changed: ' + name)
    print('Core audio compatibility repair complete. Restart ComfyUI before testing. '
          'This is not an audio render verification.')


if __name__ == '__main__':
    main()
