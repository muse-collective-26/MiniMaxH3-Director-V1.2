import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import runpod_core as core


class CoreTests(unittest.TestCase):
    def install_fixture(self, root):
        for name, markers in core.REQUIRED.items():
            p = root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('\n'.join(markers), encoding='utf-8')

    def test_compatible_core_is_not_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.install_fixture(root)
            with patch.object(core.subprocess, 'run') as run:
                core.ensure_core(root)
                run.assert_not_called()

    def test_missing_component_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.install_fixture(root)
            (root / 'comfy/model_sampling.py').write_text('class ModelSamplingDiscreteFlow: pass')
            self.assertEqual(core.missing_support(root), ['comfy/model_sampling.py'])

    def exercise(self, origin='https://github.com/Comfy-Org/ComfyUI.git', dirty='', divergent=False, broken=False, snapshot=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            calls = []
            def git(args, **kwargs):
                cmd = args[3:]
                calls.append(cmd)
                result = ''
                if cmd[0] == 'remote': result = origin
                if cmd[0] == 'status': result = dirty
                if cmd[0] == 'rev-parse': result = next(iter(core.TEMPLATE_SNAPSHOTS)) if snapshot else 'old'
                if cmd[0] in ('merge', 'checkout'):
                    if divergent: return subprocess.CompletedProcess(args, 1, '', 'Not possible to fast-forward')
                    if not broken: self.install_fixture(root)
                return subprocess.CompletedProcess(args, 0, result, '')
            with patch.object(core.subprocess, 'run', side_effect=git):
                if dirty or 'untrusted' in origin or broken:
                    with self.assertRaises(RuntimeError): core.ensure_core(root)
                elif divergent:
                    with self.assertRaisesRegex(RuntimeError, 'Not possible to fast-forward'): core.ensure_core(root)
                else:
                    core.ensure_core(root)
                    self.assertFalse(core.missing_support(root))
            return calls

    def test_old_core_fast_forward(self):
        calls = self.exercise()
        self.assertIn(['merge', '--ff-only', core.CORE_REVISION], calls)
        self.assertFalse(any(c[0] in ('reset', 'checkout', 'clean') for c in calls))

    def test_dirty_core_stops_before_fetch(self):
        self.assertFalse(any(c[0] == 'fetch' for c in self.exercise(dirty=' M comfy/model_base.py')))

    def test_unknown_origin_stops_before_fetch(self):
        self.assertEqual(len(self.exercise(origin='https://github.com/untrusted/ComfyUI')), 1)

    def test_divergent_history_not_forced(self):
        calls = self.exercise(divergent=True)
        self.assertEqual(calls[-1], ['merge', '--ff-only', core.CORE_REVISION])

    def test_post_update_validation(self):
        self.exercise(broken=True)

    def test_known_template_retained_before_safe_switch(self):
        calls = self.exercise(snapshot=True)
        old = next(iter(core.TEMPLATE_SNAPSHOTS))
        retained = ['update-ref', 'refs/muse-core-before/' + old, old]
        switch = ['checkout', '--detach', '--no-overwrite-ignore', core.CORE_REVISION]
        self.assertLess(calls.index(retained), calls.index(switch))
        self.assertFalse(any(c[0] in ('merge', 'reset', 'clean') for c in calls))

    def test_real_git_unrelated_history_preserves_user_files(self):
        real_run = subprocess.run
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args):
                return real_run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                                 '-C', str(root), *args], check=True, capture_output=True, text=True).stdout.strip()
            git('init')
            (root / '.gitignore').write_text('models/\n')
            (root / 'main.py').write_text('# old core\n')
            git('add', '.')
            git('commit', '-m', 'template root')
            old = git('rev-parse', 'HEAD')
            git('checkout', '--orphan', 'upstream')
            self.install_fixture(root)
            (root / 'models').mkdir()
            (root / 'models/template.yaml').write_text('upstream config')
            (root / 'main.py').write_text('# target core\n')
            git('add', '.')
            git('add', '-f', 'models/template.yaml')
            git('commit', '-m', 'unrelated upstream root')
            target = git('rev-parse', 'HEAD')
            git('checkout', '--detach', old)
            (root / 'models').mkdir(exist_ok=True)
            (root / 'models/template.yaml').write_text('original template config')
            (root / 'models/test.bin').write_bytes(b'keep model')
            (root / 'personal-workflow.json').write_text('keep workflow')
            def run(args, **kwargs):
                if args[3] == 'remote':
                    return subprocess.CompletedProcess(args, 0, 'https://github.com/Comfy-Org/ComfyUI.git', '')
                if args[3] == 'fetch':
                    return subprocess.CompletedProcess(args, 0, '', '')  # target already fetched in fixture
                return real_run(args, **kwargs)
            with patch.object(core, 'CORE_REVISION', target), \
                 patch.object(core, 'TEMPLATE_SNAPSHOTS', {old}), \
                 patch.object(core.subprocess, 'run', side_effect=run):
                core.ensure_core(root)
            self.assertEqual(git('rev-parse', 'HEAD'), target)
            self.assertEqual(git('rev-parse', 'refs/muse-core-before/' + old), old)
            self.assertEqual((root / 'models/test.bin').read_bytes(), b'keep model')
            self.assertEqual((root / 'personal-workflow.json').read_text(), 'keep workflow')
            self.assertEqual((root / 'models/template.yaml').read_text(), 'upstream config')
            saved = list((root / '.muse-runpod/core-file-backups').glob('*/models/template.yaml'))
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0].read_text(), 'original template config')


if __name__ == '__main__':
    unittest.main()
