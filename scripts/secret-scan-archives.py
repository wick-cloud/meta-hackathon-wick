#!/usr/bin/env python3
"""Expand release archives for scanning without tar/zip extraction side effects.

Only regular files/directories are accepted. Limits fail the release gate rather
than silently skipping large, nested, or unsupported entries.
"""
import io
import pathlib
import stat
import sys
import tarfile
import zipfile

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_DEPTH = 4
ARCHIVE_SUFFIXES = ('.tgz', '.tar', '.tar.gz', '.zip')


def expand(source, destination):
    totals = {'entries': 0, 'bytes': 0}

    def write_member(name, size, read, target, depth):
        parts = pathlib.PurePosixPath(name)
        if (not name or parts.is_absolute() or '..' in parts.parts
                or '\\' in name or any(ord(char) < 32 for char in name)):
            raise ValueError('unsafe archive member path')
        totals['entries'] += 1
        totals['bytes'] += size
        if size > MAX_FILE_BYTES or totals['bytes'] > MAX_TOTAL_BYTES or totals['entries'] > MAX_ENTRIES:
            raise ValueError('archive scan limit exceeded')
        data = read(MAX_FILE_BYTES + 1)
        if len(data) != size:
            raise ValueError('archive member size mismatch')
        output = target.joinpath(*parts.parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as handle:
            handle.write(data)
        if name.lower().endswith(ARCHIVE_SUFFIXES):
            unpack(data, output.with_name(output.name + '.contents'), depth + 1)

    def unpack(data, target, depth):
        if depth > MAX_DEPTH:
            raise ValueError('archive nesting limit exceeded')
        target.mkdir(parents=True, exist_ok=False)
        if zipfile.is_zipfile(io.BytesIO(data)):
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for entry in archive.infolist():
                    mode = entry.external_attr >> 16
                    if entry.is_dir():
                        continue
                    if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) and not stat.S_ISREG(mode)):
                        raise ValueError('archive contains a non-regular file')
                    with archive.open(entry) as handle:
                        write_member(entry.filename, entry.file_size, handle.read, target, depth)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
                for entry in archive:
                    if entry.isdir():
                        continue
                    if not entry.isfile():
                        raise ValueError('archive contains a non-regular file')
                    with archive.extractfile(entry) as handle:
                        write_member(entry.name, entry.size, handle.read, target, depth)

    source = pathlib.Path(source)
    if source.stat().st_size > MAX_TOTAL_BYTES:
        raise ValueError('archive compressed size limit exceeded')
    unpack(source.read_bytes(), pathlib.Path(destination), 1)
    return totals


if __name__ == '__main__':
    try:
        expand(sys.argv[1], sys.argv[2])
    except Exception:
        # Do not print archive contents, file names, passwords, or exception context.
        print('Archive scan expansion failed (invalid content, unsafe entry, or size/depth limit).', file=sys.stderr)
        sys.exit(1)
