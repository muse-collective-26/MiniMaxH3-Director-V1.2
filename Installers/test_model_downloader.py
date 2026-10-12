import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('downloader', Path(__file__).with_name('Download-Models-RunPod.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

class DownloaderTests(unittest.TestCase):
    def test_manifest(self):
        self.assertEqual(len(d.MODELS), 7)
        self.assertEqual(len({(m['folder'], m['name']) for m in d.MODELS}), 7)
        self.assertTrue(all(m['url'].startswith('https://') for m in d.MODELS))

    def run_plan(self, root, check=True):
        args = ['download', '--comfyui', str(root)] + (['--check'] if check else [])
        return patch.multiple(d.shutil, which=lambda _: 'curl', disk_usage=lambda _: SimpleNamespace(free=10000000000)), patch.object(d, 'remote_size', return_value=10), patch.object(d.sys, 'argv', args)

    def test_check_does_not_download(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'main.py').touch()
            (root/'models').mkdir()
            a,b,c = self.run_plan(root)
            with a,b,c,patch.object(d.subprocess, 'run') as run:
                d.main()
                run.assert_not_called()
            self.assertEqual(list((root/'models').iterdir()), [])

    def test_download_resume_and_skip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'main.py').touch()
            (root/'models').mkdir()
            first = d.destination(root, d.MODELS[0])
            first.parent.mkdir(parents=True)
            first.write_bytes(b'0123456789')
            second = d.destination(root, d.MODELS[1])
            second.with_name(second.name+'.part').write_bytes(b'012')
            def fake_curl(command, check):
                self.assertIn('--continue-at', command)
                Path(command[command.index('--output')+1]).write_bytes(b'0123456789')
            a,b,c = self.run_plan(root, False)
            with a,b,c,patch('builtins.input', return_value='y'),patch.object(d.subprocess, 'run', side_effect=fake_curl) as run:
                d.main()
                self.assertEqual(run.call_count, 6)
            self.assertTrue(all(d.destination(root,m).stat().st_size == 10 for m in d.MODELS))
            self.assertEqual(list(root.rglob('*.part')), [])

    def test_bad_existing_file_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'main.py').touch()
            target=d.destination(root,d.MODELS[0])
            target.parent.mkdir(parents=True)
            target.write_bytes(b'old')
            a,b,c=self.run_plan(root)
            with a,b,c,self.assertRaisesRegex(RuntimeError,'unexpected size'):
                d.main()
            self.assertEqual(target.read_bytes(),b'old')

if __name__ == '__main__':
    unittest.main()
