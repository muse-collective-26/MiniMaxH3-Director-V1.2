import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
import runpod_setup as r

class RunPodTests(unittest.TestCase):
    def setUp(self):
        self.source = json.loads((Path(__file__).parents[1]/'workflows/muse_minimax_h3_director_V1.4.json').read_text(encoding='utf8'))

    def test_settings_and_original_preserved(self):
        before = json.dumps(self.source)
        w = r.workflow(self.source)
        self.assertEqual(json.dumps(self.source), before)
        for n in w['nodes']:
            named = n.get('widgets_values_named', {})
            if n['type'] == 'MuseMiniMaxH3UnifiedLoader':
                self.assertEqual(named['lora_2'], '(disabled)')
                self.assertEqual(named['lora_3'], '(disabled)')
                self.assertIn('H3/minimax_h3_fl2v_turbo_8step', named['lora_1'])
                self.assertFalse(named['sage_attention'])
                self.assertEqual(named['models_to_load'], 'Both / Mixed')
                self.assertEqual(named['pinned_memory_cap'], '10 GB')
                self.assertTrue(n['properties']['muse_runpod_named_widgets'])
                self.assertEqual(list(named.values()), n['widgets_values'])
            if n['type'] == 'MuseMinimaxDirectorV1_4':
                self.assertEqual(named['seam_interpolation_frames'], 0)
                t = json.loads(named['timeline_data'])
                self.assertEqual(t['analyze_model'], r.MODEL)
                self.assertEqual(t['analyze_base_url'], r.URL)
                self.assertEqual(t['analyze_provider'], 'ollama')
                self.assertEqual(list(named.values()), n['widgets_values'])
        self.assertEqual(w['links'], self.source['links'])

    def test_reject_widget_drift(self):
        n = next(n for n in self.source['nodes'] if n['type']=='MuseMiniMaxH3UnifiedLoader')
        n['widgets_values'].pop()
        with self.assertRaises(RuntimeError):
            r.workflow(self.source)

    def test_refresh_example_preserves_previous(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, dest = Path(tmp)/'new.json', Path(tmp)/'saved.json'
            source.write_text('new')
            dest.write_text('personal settings')
            r.publish_workflow(source, dest)
            self.assertEqual(dest.read_text(), 'new')
            backups = list(Path(tmp).glob('saved-saved-*.json'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), 'personal settings')
            r.publish_workflow(source, dest)
            self.assertEqual(len(list(Path(tmp).glob('saved-saved-*.json'))), 1)

    def test_kj_clean_old_checkout_updated(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            calls = []
            def git(args, **kwargs):
                command = args[3:]
                calls.append(command)
                result = ''
                if command[:1] == ['remote']:
                    result = 'https://github.com/kijai/ComfyUI-KJNodes.git'
                if command[:1] == ['rev-parse']:
                    result = 'old'
                if command[:1] == ['checkout']:
                    (target/'nodes').mkdir()
                    for path in (target/'nodes/minimax_nodes.py', target/'__init__.py'):
                        path.write_text('MiniMaxLowVRAMAttention MiniMaxChunkFeedForward')
                return subprocess.CompletedProcess(args, 0, result, '')
            with patch.object(r.subprocess, 'run', side_effect=git):
                r.ensure_kjnodes(target, 'pin')
                self.assertIn(['checkout', '--detach', 'pin'], calls)
                calls.clear()
                r.ensure_kjnodes(target, 'pin')
                self.assertEqual(calls, [])

    def test_kj_dirty_checkout_not_changed(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            def git(args, **kwargs):
                value = 'https://github.com/kijai/ComfyUI-KJNodes.git' if 'remote' in args else ' M edited.py'
                return subprocess.CompletedProcess(args, 0, value, '')
            with patch.object(r.subprocess, 'run', side_effect=git) as run:
                with self.assertRaises(RuntimeError):
                    r.ensure_kjnodes(Path(tmp), 'pin')
                self.assertEqual(run.call_count, 2)

    def test_preview_download_included(self):
        import runpy
        models = runpy.run_path(str(Path(__file__).with_name('Download-Models-RunPod.py')))['MODELS']
        self.assertEqual(len(models), 8)
        self.assertEqual(models[-1]['folder'], 'vae_approx')
        self.assertEqual(models[-1]['name'], 'taeh3.safetensors')

    def test_preview_configuration_repeatable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root/'nodes/preview_override_node.py'
            path.parent.mkdir()
            path.write_text('_NVENC_AVAILABLE = _HAS_NVENC and not _csp_blocks_video()\n')
            r.configure_previews(root)
            self.assertIn('_NVENC_AVAILABLE = False', path.read_text())
            before = path.read_text()
            r.configure_previews(root)
            self.assertEqual(before, path.read_text())

    def test_preview_unknown_layout_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'nodes/preview_override_node.py'
            path.parent.mkdir()
            path.write_text('unknown = True\n')
            with self.assertRaises(RuntimeError):
                r.configure_previews(Path(tmp))
            self.assertEqual(path.read_text(), 'unknown = True\n')

    def test_no_windows_setup(self):
        with patch.object(r.platform, 'system', return_value='Windows'):
            with self.assertRaises(RuntimeError):
                r.install(Path('.'))

    def test_windows_launcher_unchanged_scope(self):
        folder = Path(__file__).parent
        self.assertNotIn('--runpod', (folder/'Install-Windows.bat').read_text())
        self.assertIn('--runpod', (folder/'Install-RunPod.sh').read_text())

    def test_existing_runtime_pull_and_vision_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root/'.muse-runpod/ollama'
            runtime.mkdir(parents=True)
            (runtime/'.installation-complete').touch()
            with patch.object(r.platform, 'system', return_value='Linux'), \
                 patch.object(r.platform, 'machine', return_value='x86_64'), \
                 patch.object(r, 'start', return_value=runtime/'bin/ollama'), \
                 patch.object(r.subprocess, 'run') as run, \
                 patch.object(r, 'api', return_value={'capabilities':['vision']}) as api:
                r.install(root)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0][-2:], ['pull', 'gemma3:4b'])
                self.assertEqual(run.call_args.kwargs['env']['OLLAMA_HOST'], r.URL)
                api.assert_called_once_with('/api/show', {'model': r.MODEL})

    def test_incomplete_runtime_not_started(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root/'.muse-runpod/ollama/bin/ollama'
            binary.parent.mkdir(parents=True)
            binary.touch()
            with patch.object(r.subprocess, 'Popen') as start:
                with self.assertRaises(RuntimeError):
                    r.start(root)
                start.assert_not_called()

if __name__ == '__main__':
    unittest.main()
