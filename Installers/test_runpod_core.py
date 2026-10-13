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

    def exercise(self, origin='https://github.com/Comfy-Org/ComfyUI.git', dirty='', divergent=False, broken=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            calls = []
            def git(args, **kwargs):
                cmd = args[3:]
                calls.append(cmd)
                result = ''
                if cmd[0] == 'remote': result = origin
                if cmd[0] == 'status': result = dirty
                if cmd[0] == 'rev-parse': result = 'old'
                if cmd[0] == 'merge':
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


if __name__ == '__main__':
    unittest.main()
