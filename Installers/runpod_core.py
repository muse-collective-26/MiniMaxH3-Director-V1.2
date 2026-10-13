"""RunPod core audio compatibility repair; no renders or service restarts."""
import argparse
import importlib.metadata
from pathlib import Path
import subprocess
import sys
import tempfile

# Exact core used by the successful local two-chunk audio test.
CORE_REVISION = '0df64eb242b7c5759c3e86afd5d1846d923b1033'
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
    # A divergent history or an untracked-file collision stops safely, without force/reset.
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
