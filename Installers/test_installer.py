import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("muse_installer", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "Comfy With Spaces"
        self.root.mkdir()
        (self.root / "main.py").touch()
        self.custom = self.root / "custom_nodes"
        self.custom.mkdir()

    def test_root(self):
        self.assertEqual(installer.find_root(str(self.root)), self.root.resolve())
        with self.assertRaises(RuntimeError):
            installer.find_root(str(self.custom))

    def test_zip_folder_preserved(self):
        node = self.custom / "MiniMaxH3-Director-V1.2-main"
        node.mkdir()
        self.assertEqual(installer.existing_pack(self.custom, "MiniMaxH3-Director-V1.2", "muse-collective-26/MiniMaxH3-Director-V1.2"), node)

    def test_duplicate_stops(self):
        (self.custom / "ComfyUI-KJNodes").mkdir()
        (self.custom / "comfyui-kjnodes-main").mkdir()
        with self.assertRaises(RuntimeError):
            installer.existing_pack(self.custom, "ComfyUI-KJNodes", "kijai/ComfyUI-KJNodes")

    def test_absent(self):
        self.assertIsNone(installer.existing_pack(self.custom, "missing", "user/missing"))

    def test_origin(self):
        self.assertEqual(installer.normalize_origin("git@github.com:User/Repo.git"), "https://github.com/user/repo")

    def test_public_only_pins(self):
        rows = json.loads(Path(__file__).with_name("dependencies.json").read_text())
        self.assertEqual(len(rows), 12)
        for name, repo, sha in rows:
            self.assertEqual(len(sha), 40)
            int(sha, 16)
            self.assertNotIn("Director-version-2", repo)
            self.assertNotIn("DLSS", name)


if __name__ == "__main__":
    unittest.main()
