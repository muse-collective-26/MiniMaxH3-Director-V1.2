"""RunPod-only workflow and persistent, loopback-only Ollama setup."""
import argparse
import copy
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

WORKFLOW = 'Muse MiniMax Director - RunPod.json'
MODEL = 'gemma3:4b'
# Dedicated port avoids taking over an existing Ollama server.
URL = 'http://127.0.0.1:11435'
ARCHIVE = 'https://ollama.com/download/ollama-linux-amd64.tar.zst'

def workflow(source):
    result = copy.deepcopy(source)
    for node in result['nodes']:
        named = node.get('widgets_values_named', {})
        changes = {}
        if node['type'] == 'MuseMiniMaxH3UnifiedLoader':
            changes = {'sage_attention': False, 'lora_2': '(disabled)',
                       'lora_3': '(disabled)', 'lora_1': named['lora_1'].replace('\\', '/')}
        elif node['type'] == 'MuseMinimaxDirectorV1_4':
            timeline = json.loads(named['timeline_data'])
            timeline.update(analyze_provider='ollama', analyze_base_url=URL, analyze_model=MODEL,
                            prompt_gen_provider='ollama', prompt_gen_base_url=URL, prompt_gen_model=MODEL)
            changes = {'seam_interpolation_frames': 0, 'timeline_data': json.dumps(timeline)}
        if changes:
            # This supplied export stores named and positional widgets in the same order.
            if list(named.values()) != node['widgets_values']:
                raise RuntimeError('Workflow widget layout changed; refusing positional guesses.')
            for key, value in changes.items():
                node['widgets_values'][list(named).index(key)] = value
                named[key] = value
    return result

def api(path, data=None):
    request = urllib.request.Request(URL + path,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)

def start(root):
    runtime = root / '.muse-runpod/ollama'
    binary = runtime / 'bin/ollama'
    if not binary.is_file() or not (runtime / '.installation-complete').is_file():
        raise RuntimeError('Ollama runtime is missing. Run Install-RunPod.sh first.')
    try:
        with socket.create_connection(('127.0.0.1', 11435), timeout=1):
            pass
    except OSError:
        env = os.environ.copy()
        env.update(OLLAMA_HOST='127.0.0.1:11435', OLLAMA_MODELS=str(root / '.muse-runpod/ollama-models'),
                   OLLAMA_KEEP_ALIVE='0', OLLAMA_NUM_PARALLEL='1', OLLAMA_MAX_LOADED_MODELS='1')
        with (runtime / 'server.log').open('ab') as log:
            process = subprocess.Popen([str(binary), 'serve'], env=env, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(30):
            if process.poll() is not None:
                raise RuntimeError('Ollama stopped; inspect ' + str(runtime / 'server.log'))
            try:
                api('/api/version')
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('Ollama did not become ready; inspect ' + str(runtime / 'server.log'))
    # A non-Ollama service occupying the port must fail visibly.
    api('/api/version')
    return binary

def install(root):
    if platform.system() != 'Linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
        raise RuntimeError('Ollama setup is RunPod Linux x86-64 only.')
    runtime = root / '.muse-runpod/ollama'
    if not (runtime / '.installation-complete').is_file():
        if shutil.disk_usage(root).free < 12 * 1024**3:
            raise RuntimeError('Allow at least 12 GiB free for Ollama runtime, model and extraction.')
        subprocess.run([sys.executable, '-m', 'pip', 'install', 'zstandard'], check=True)
        import zstandard
        runtime.parent.mkdir(parents=True, exist_ok=True)
        archive = runtime.parent / 'ollama-linux-amd64.tar.zst.part'
        subprocess.run(['curl', '-fL', '--retry', '5', '-C', '-', '-o', str(archive), ARCHIVE], check=True)
        runtime.mkdir(exist_ok=True)
        # Filter rejects archive traversal and links escaping this dedicated directory.
        with archive.open('rb') as data, zstandard.ZstdDecompressor().stream_reader(data) as stream:
            with tarfile.open(fileobj=stream, mode='r|') as package:
                package.extractall(runtime, filter='data')
        if not (runtime / 'bin/ollama').is_file():
            raise RuntimeError('Unexpected Ollama archive layout; installation stopped.')
        (runtime / '.installation-complete').touch()
        archive.unlink()
    binary = start(root)
    env = dict(os.environ, OLLAMA_HOST=URL)
    subprocess.run([str(binary), 'pull', MODEL], env=env, check=True)
    info = api('/api/show', {'model': MODEL})
    if 'vision' not in info.get('capabilities', []):
        raise RuntimeError('Downloaded model does not advertise vision support.')
    print('Ollama ready:', URL, MODEL, '(service/model check, not a GPU analysis test)')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--comfyui', type=Path, required=True)
    parser.add_argument('--start-only', action='store_true')
    args = parser.parse_args()
    root = args.comfyui.resolve()
    if not (root/'main.py').is_file():
        raise RuntimeError('Invalid ComfyUI folder.')
    if args.start_only:
        if platform.system() != 'Linux':
            raise RuntimeError('Start-RunPod requires Linux.')
        try:
            with socket.create_connection(('127.0.0.1', 8188), timeout=1):
                pass
        except OSError:
            pass
        else:
            raise RuntimeError('Port 8188 is already in use. Stop the existing ComfyUI before starting another.')
        start(root)
        if 'vision' not in api('/api/show', {'model': MODEL}).get('capabilities', []):
            raise RuntimeError('Vision model is missing; rerun the RunPod installer.')
    else:
        install(root)

if __name__ == '__main__':
    main()
