"""Export a result directory without repeating its outer folder inside the ZIP.

Source bytes and relative paths are preserved, including historical evidence.
Windows extended paths allow reading files that Explorer cannot compress.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import zipfile


def disk_path(path):
    value = os.path.abspath(path)
    if os.name != 'nt' or value.startswith('\\\\?\\'):
        return Path(value)
    return Path('\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value)


def inventory(root):
    files = []
    for folder, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            entry = Path(folder) / name
            details = entry.lstat()
            if stat.S_ISLNK(details.st_mode) or getattr(details, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Result export does not follow links or junctions.')
        for name in names:
            file = Path(folder) / name
            if not file.is_file():
                raise ValueError('Result export requires regular files.')
            files.append(file)
    return sorted(files, key=lambda file: file.relative_to(root).as_posix())


def missing_reports(root):
    manifest = root / 'batch_manifest.json'
    if not manifest.is_file():
        return None
    batch = json.loads(manifest.read_text(encoding='utf-8-sig'))
    missing = []
    for target in batch['targets']:
        relative = str(target.get('reportDirectory') or '').replace('\\', '/')
        parts = PurePosixPath(relative)
        if not relative or parts.is_absolute() or '..' in parts.parts or ':' in relative:
            missing.append({'file': target.get('file'), 'target': target.get('target'), 'reason': 'no-safe-report-path'})
        elif not (root.joinpath(*parts.parts) / 'final_report.md').is_file():
            missing.append({'file': target.get('file'), 'target': target.get('target'), 'reason': 'missing-report'})
    return missing


def export_results(source, destination):
    root = disk_path(source).resolve()
    output = disk_path(destination)
    if not root.is_dir():
        raise ValueError('Result directory does not exist.')
    if output.suffix.lower() != '.zip':
        raise ValueError('Export destination must end in .zip.')
    if root == output.resolve() or root in output.resolve().parents:
        raise ValueError('Write the ZIP outside the source result directory.')
    files = inventory(root)
    if not files:
        raise ValueError('Result directory is empty.')
    names = [file.relative_to(root).as_posix() for file in files]
    if len({name.casefold() for name in names}) != len(names) or any(name.casefold() == '_transfer.json' for name in names):
        raise ValueError('Export names collide on Windows or with the transfer manifest.')
    missing = missing_reports(root)
    records = []
    snapshots = []
    created = False
    try:
        # Exclusive create protects existing exports, even under concurrent runs.
        with output.open('xb') as stream:
            created = True
            with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for file, name in zip(files, names):
                    before = file.stat()
                    digest = hashlib.sha256()
                    with file.open('rb') as reader, archive.open(name, 'w', force_zip64=True) as writer:
                        for chunk in iter(lambda: reader.read(1024 * 1024), b''):
                            writer.write(chunk)
                            digest.update(chunk)
                    after = file.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        raise ValueError('Results changed during export; stop the run before exporting.')
                    records.append({'path': name, 'bytes': after.st_size, 'sha256': digest.hexdigest()})
                    snapshots.append((after.st_size, after.st_mtime_ns))
                if files != inventory(root):
                    raise ValueError('Result files changed during export.')
                if any((file.stat().st_size, file.stat().st_mtime_ns) != snapshot
                       for file, snapshot in zip(files, snapshots)):
                    raise ValueError('Result contents changed during export.')
                relative_length = max(len(name.encode('utf-16-le')) // 2 for name in names)
                summary = {'schemaVersion': 'result-transfer-v1', 'sourceName': root.name,
                           'files': len(records), 'missingReports': missing,
                           'maxRelativePathLength': relative_length,
                           'extractionDirectoryBudget': max(0, 240 - relative_length - 1),
                           'note': 'Original bytes and relative paths preserved. Extract to a short directory, e.g. C:\\r. '
                                   'A missingReports list describes absent source reports; export cannot recover them.',
                           'entries': records}
                archive.writestr('_transfer.json', json.dumps(summary, ensure_ascii=False, indent=2))
        # Check every uncompressed byte against the source digest, not just ZIP creation success.
        with zipfile.ZipFile(output) as archive:
            for record in records:
                digest = hashlib.sha256()
                with archive.open(record['path']) as reader:
                    for chunk in iter(lambda: reader.read(1024 * 1024), b''):
                        digest.update(chunk)
                if digest.hexdigest() != record['sha256']:
                    raise ValueError('ZIP content verification failed.')
        return {key: value for key, value in summary.items() if key != 'entries'}
    except Exception:
        if created:
            output.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='Completed result directory (one batch or function)')
    parser.add_argument('destination', help='New ZIP file outside the source directory')
    args = parser.parse_args()
    try:
        result = export_results(args.source, args.destination)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f'Export failed: {error}\n')
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == '__main__':
    main()
