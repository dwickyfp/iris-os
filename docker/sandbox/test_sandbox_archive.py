import io
import pathlib
import tarfile
import tempfile
import unittest
import zipfile

import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import sandbox_archive


class SandboxArchiveTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.TemporaryDirectory().name)
        self.root.mkdir(parents=True)
        self.destination = self.root / "extract"
        self.limits = {
            "max_files": 10,
            "max_file_bytes": 100,
            "max_total_bytes": 100,
        }

    def tearDown(self):
        import shutil

        shutil.rmtree(self.root, ignore_errors=True)

    def test_rejects_zip_slip_symlink_and_special_members(self):
        archive = self.root / "unsafe.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("../escape.txt", "bad")
            symlink = zipfile.ZipInfo("linked.txt")
            symlink.external_attr = (0o120777 << 16) | 0
            output.writestr(symlink, "/etc/passwd")
        with self.assertRaisesRegex(ValueError, "unsafe archive"):
            sandbox_archive.extract_zip(archive, self.destination, self.limits)

        tar_archive = self.root / "unsafe.tar"
        with tarfile.open(tar_archive, "w") as output:
            member = tarfile.TarInfo("../escape.txt")
            member.size = 3
            output.addfile(member, io.BytesIO(b"bad"))
        with self.assertRaisesRegex(ValueError, "unsafe archive"):
            sandbox_archive.extract_tar(tar_archive, self.destination, self.limits)

    def test_enforces_count_file_size_and_total_size(self):
        archive = self.root / "bomb.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for index in range(11):
                output.writestr(f"file-{index}.txt", "x")
        with self.assertRaisesRegex(ValueError, "too many files"):
            sandbox_archive.extract_zip(archive, self.destination, self.limits)

        oversized = self.root / "oversized.zip"
        with zipfile.ZipFile(oversized, "w") as output:
            output.writestr("large.txt", "a" * 101)
        with self.assertRaisesRegex(ValueError, "size limit"):
            sandbox_archive.extract_zip(oversized, self.destination, self.limits)

        total = self.root / "total.zip"
        with zipfile.ZipFile(total, "w") as output:
            output.writestr("one.txt", "a" * 60)
            output.writestr("two.txt", "a" * 60)
        with self.assertRaisesRegex(ValueError, "total size limit"):
            sandbox_archive.extract_zip(total, self.destination, self.limits)

    def test_extracts_regular_files_and_creates_bounded_zip(self):
        source = self.root / "project"
        (source / "app").mkdir(parents=True)
        (source / "app" / "main.py").write_text("print('ok')\n")
        (source / "test.txt").write_text("hello")
        output = self.root / "project.zip"
        sandbox_archive.create_zip(
            source,
            output,
            {"max_files": 10, "max_total_bytes": 1_000},
        )
        extracted = self.root / "extracted"
        count = sandbox_archive.extract_zip(
            output,
            extracted,
            {"max_files": 10, "max_file_bytes": 100, "max_total_bytes": 100},
        )
        self.assertEqual(count, 2)
        self.assertEqual((extracted / "app/main.py").read_text(), "print('ok')\n")


if __name__ == "__main__":
    unittest.main()
