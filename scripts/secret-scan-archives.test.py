#!/usr/bin/env python3
"""Security boundary regressions for the release archive scanner."""
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('scanner', pathlib.Path(__file__).with_name('secret-scan-archives.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


def tar_bytes(name, data=b'canary', kind=tarfile.REGTYPE):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        member = tarfile.TarInfo(name)
        member.type = kind
        if kind == tarfile.REGTYPE:
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        else:
            member.linkname = '/outside'
            archive.addfile(member)
    return output.getvalue()


class ArchiveBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / 'input.tgz'
        self.output = self.root / 'contents'

    def expand(self, data):
        self.source.write_bytes(data)
        return scanner.expand(self.source, self.output)

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            self.expand(tar_bytes('../escaped.txt'))
        self.assertFalse((self.root / 'escaped.txt').exists())

    def test_rejects_links(self):
        with self.assertRaises(ValueError):
            self.expand(tar_bytes('linked', kind=tarfile.SYMTYPE))
        self.assertFalse((self.output / 'linked').exists())

    def test_nested_archive_members_are_visible(self):
        self.expand(tar_bytes('nested.tgz', tar_bytes('package/data.txt')))
        self.assertEqual((self.output / 'nested.tgz.contents/package/data.txt').read_bytes(), b'canary')

    def test_zip_members_are_visible(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('package/data.txt', 'canary')
        self.expand(data.getvalue())
        self.assertEqual((self.output / 'package/data.txt').read_text(), 'canary')

    def test_size_limit_fails_without_truncation(self):
        previous = scanner.MAX_FILE_BYTES
        scanner.MAX_FILE_BYTES = 3
        try:
            with self.assertRaises(ValueError):
                self.expand(tar_bytes('too-large.txt', b'oversize'))
            self.assertFalse((self.output / 'too-large.txt').exists())
        finally:
            scanner.MAX_FILE_BYTES = previous

    def test_nesting_limit_fails(self):
        data = tar_bytes('data.txt')
        for _ in range(scanner.MAX_DEPTH):
            data = tar_bytes('nested.tgz', data)
        with self.assertRaises(ValueError):
            self.expand(data)


if __name__ == '__main__':
    unittest.main()
