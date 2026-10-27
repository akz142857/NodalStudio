#!/usr/bin/env python3
"""Collect installed production JS and resolved Cargo dependency license notices.
No network access or license inference. Run after dependency/lockfile changes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/legal/THIRD_PARTY_NOTICES.txt'

def texts(directory):
    files = []
    for p in directory.iterdir():
        if p.is_file() and p.name.lower().startswith(('license', 'licence', 'copying', 'copyright', 'notice')):
            files.append(p)
    # r-efi carries its complete MIT terms and copyright in AUTHORS.
    authors = directory / 'AUTHORS'
    if authors.is_file() and 'Permission is hereby granted' in authors.read_text(errors='replace'):
        files.append(authors)
    return [(p.name, p.read_text(errors='replace')) for p in sorted(files)]

def resolve_package(start, name):
    for parent in [start, *start.parents]:
        candidate = parent / 'node_modules' / name / 'package.json'
        if candidate.is_file():
            return candidate.resolve()
    return None

def load_supplements(directory):
    result = {}
    seen = set()
    for entry in json.loads((directory/'manifest.json').read_text()):
        key = (entry['ecosystem'], entry['name'], entry['version'])
        path = (directory/entry['file']).resolve()
        if directory.resolve() not in path.parents:
            raise ValueError('Supplement path escapes inventory')
        if entry['file'] in seen:
            raise ValueError('Duplicate supplement')
        seen.add(entry['file'])
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError(f'License checksum mismatch: {entry["file"]}')
        if not entry['url'].startswith('https://') or not entry['revision']:
            raise ValueError('Missing license provenance')
        heading = entry['file'] + '\nSource: ' + entry['url']
        if entry.get('note'):
            heading += '\n' + entry['note']
        result.setdefault(key, []).append((heading, data.decode('utf-8')))
    return result

def main(check=False):
    packages = {}
    missing = []
    def visit(manifest):
        data = json.loads(manifest.read_text())
        key = ('npm', data['name'], data['version'])
        if key in packages:
            return
        packages[key] = (data.get('license', 'UNDECLARED'), texts(manifest.parent))
        for name in data.get('dependencies', {}):
            dependency = resolve_package(manifest.parent, name)
            if dependency:
                visit(dependency)
            else:
                missing.append('Unresolved npm dependency: ' + name)

    frontend = ROOT / 'apps/frontend'
    for name in json.loads((frontend/'package.json').read_text())['dependencies']:
        manifest = resolve_package(frontend, name)
        if manifest:
            visit(manifest)
        else:
            missing.append('Unresolved npm dependency: ' + name)
    metadata = json.loads(subprocess.check_output(['cargo', 'metadata', '--offline', '--format-version', '1'], cwd=ROOT))
    # Includes build/target-specific Rust crates so the notices are a conservative superset.
    for data in metadata['packages']:
        if data['source'] is None:
            continue
        directory = Path(data['manifest_path']).parent
        notices = texts(directory)
        if data.get('license_file'):
            file = directory/data['license_file']
            if file.is_file() and file.name not in [name for name, _ in notices]:
                notices.append((file.name, file.read_text(errors='replace')))
        packages[('cargo', data['name'], data['version'])] = (data.get('license', 'UNDECLARED'), notices)
    supplements = load_supplements(ROOT / 'docs/legal/upstream')
    for key, extra in supplements.items():
        if key not in packages:
            raise ValueError(f'Stale supplemental license: {key}')
        license_id, notices = packages[key]
        notices.extend(extra)
    lines = ['Nodal Studio — third-party notices', 'Generated from installed frontend production dependencies and Cargo.lock resolution. Rust entries include build and target-specific dependencies. Individual upstream notices follow; this inventory does not change their licenses.']
    for (ecosystem, name, version), (license_id, notices) in sorted(packages.items()):
        lines.append('\n' + '='*72 + '\n' + f'{ecosystem}: {name} {version}\nDeclared license: {license_id}')
        if ecosystem == 'cargo':
            lines.append(f'Unmodified upstream source: https://crates.io/api/v1/crates/{name}/{version}/download')
        if not notices:
            missing.append(f'No top-level license text: {ecosystem}:{name}@{version} ({license_id})')
        for filename, body in notices:
            lines.append(filename+'\n'+body)
    outputs = {OUT: '\n\n'.join(lines)+'\n', ROOT/'docs/legal/NOTICE_INVENTORY_GAPS.txt': '\n'.join(sorted(set(missing)))+'\n'}
    for path, content in outputs.items():
        if check:
            if not path.exists() or path.read_text() != content:
                raise ValueError(f'Stale notices: {path.name}; regenerate before building.')
        else:
            path.write_text(content)
    if missing:
        raise ValueError(f'{len(missing)} unresolved license inventory gaps')
    print(f'{len(packages)} packages; {len(missing)} inventory gaps. Review docs/legal/NOTICE_INVENTORY_GAPS.txt before distribution.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail on missing or stale notices, without writing')
    main(parser.parse_args().check)
