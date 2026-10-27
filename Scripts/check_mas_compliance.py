#!/usr/bin/env python3
"""Validate reviewed MAS privacy resources; not Apple approval or export classification."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'apps/desktop/src-tauri'
RESOURCES = {
    'Resources/PrivacyInfo.xcprivacy': './PrivacyInfo.xcprivacy',
    'Resources/RingPrivacy.bundle': './privacy/RingPrivacy.bundle',
}
REASONS = {
    'NSPrivacyAccessedAPICategoryFileTimestamp': {'C617.1', '3B52.1'},
    'NSPrivacyAccessedAPICategorySystemBootTime': {'35F9.1'},
    'NSPrivacyAccessedAPICategoryUserDefaults': {'CA92.1'},
}

def read_plist(path):
    with path.open('rb') as stream:
        return plistlib.load(stream)

def validate_manifest(value):
    if value.get('NSPrivacyTracking') is not False or value.get('NSPrivacyTrackingDomains') != []:
        raise ValueError('Tracking declaration differs from the reviewed implementation')
    # No guessed no-collection claim for the entire app: optional remote AI still needs ASC review.
    if 'NSPrivacyCollectedDataTypes' in value:
        raise ValueError('App collection declaration requires a separate documented data-flow review')
    seen = {}
    for entry in value.get('NSPrivacyAccessedAPITypes', []):
        category = entry['NSPrivacyAccessedAPIType']
        reasons = entry['NSPrivacyAccessedAPITypeReasons']
        if category in seen or len(set(reasons)) != len(reasons):
            raise ValueError('Duplicate privacy category or reason')
        seen[category] = set(reasons)
    if seen != REASONS:
        raise ValueError('Privacy reasons differ from reviewed uses; do not guess codes for symbol matches')

def validate_encryption(value):
    if 'ITSAppUsesNonExemptEncryption' in value or 'ITSEncryptionExportComplianceCode' in value:
        raise ValueError('Export classification is unresolved: remove unreviewed declarations and complete the Apple questionnaire')

def validate_distribution_identity(development, release, appstore):
    if development.get('identifier') != 'com.claycosmos.nodalstudio.dev' or development.get('productName') != 'Nodal Studio Dev':
        raise ValueError('Default development builds must have a separate application identity')
    for config in (release, appstore):
        if config.get('identifier') != 'com.claycosmos.nodalstudio' or config.get('productName') != 'Nodal Studio':
            raise ValueError('Production overlays must explicitly select the production application identity')

def validate_source(base=BASE, root=ROOT):
    validate_distribution_identity(*(json.loads((base/name).read_text()) for name in
        ('tauri.conf.json', 'tauri.release.conf.json', 'tauri.appstore.conf.json')))
    validate_manifest(read_plist(base/'PrivacyInfo.xcprivacy'))
    validate_encryption(read_plist(base/'Info.appstore.plist'))
    mapping=json.loads((base/'tauri.appstore.conf.json').read_text())['bundle']['macOS']['files']
    if any(mapping.get(k) != v for k,v in RESOURCES.items()):
        raise ValueError('MAS resource mapping must use Contents/Resources destinations')
    ring=base/'privacy/RingPrivacy.bundle/Contents'
    version=read_plist(ring/'Info.plist')['CFBundleShortVersionString']
    locked=set(re.findall(r'name = "ring"\nversion = "([^"]+)"', (root/'Cargo.lock').read_text()))
    if locked != {version}:
        raise ValueError('ring version changed: re-audit source and SDK privacy metadata')
    expected={'NSPrivacyTracking':False,'NSPrivacyTrackingDomains':[], 'NSPrivacyCollectedDataTypes':[], 'NSPrivacyAccessedAPITypes':[]}
    if read_plist(ring/'Resources/PrivacyInfo.xcprivacy') != expected:
        raise ValueError('ring privacy metadata differs from the reviewed crypto-only implementation')

def validate_bundle_version(info, base=BASE, expected_build=None):
    config=json.loads((base/'tauri.appstore.conf.json').read_text())
    if info.get('CFBundleShortVersionString') != config['version']:
        raise ValueError('Built app has the wrong MAS marketing version')
    build=expected_build if expected_build is not None else config['bundle']['macOS']['bundleVersion']
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,2}', build):
        raise ValueError('Invalid expected build number')
    if info.get('CFBundleVersion') != build:
        raise ValueError('Built app has the wrong MAS build number')

def validate_bundle(app, base=BASE, expected_build=None):
    contents=app/'Contents'
    info=read_plist(contents/'Info.plist')
    if info.get('CFBundleIdentifier') != 'com.claycosmos.nodalstudio':
        raise ValueError('Built MAS app has the wrong application identifier')
    validate_encryption(info)
    validate_bundle_version(info, base, expected_build)
    for destination,source in RESOURCES.items():
        origin=base/source
        files=[origin] if origin.is_file() else sorted(p for p in origin.rglob('*') if p.is_file())
        for file in files:
            target=contents/destination if origin.is_file() else contents/destination/file.relative_to(origin)
            if not target.is_file() or target.read_bytes() != file.read_bytes():
                raise ValueError(f'Bundled privacy resource missing or stale: {target}')
    validate_manifest(read_plist(contents/'Resources/PrivacyInfo.xcprivacy'))

def binary_report(app):
    info=read_plist(app/'Contents/Info.plist')
    binary=app/'Contents/MacOS'/info['CFBundleExecutable']
    imports=subprocess.check_output(['nm','-u',str(binary)],text=True)
    watched=('stat','mach_absolute_time','clock_gettime','NSUserDefaults','systemUptime','activeInputModes')
    return {'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
            'reviewCandidates':[line.strip() for line in imports.splitlines() if any(s in line for s in watched)],
            'linkedLibraries':subprocess.check_output(['otool','-L',str(binary)],text=True).splitlines(),
            'limits':'Symbol presence is not a purpose or a full call-graph audit. SQLite statfs/fstatfs filesystem-type/locking use is recorded separately; no guessed DiskSpace reason. App Privacy, SDK-policy interpretation and export questionnaire remain separate.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app',type=Path)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--expected-build', help='Explicit build override used by the signing script')
    args=parser.parse_args()
    validate_source()
    if args.app:
        validate_bundle(args.app, expected_build=args.expected_build)
        if args.report:
            args.report.write_text(json.dumps(binary_report(args.app),indent=2)+'\n')
    elif args.report:
        parser.error('--report requires --app')
    print('Reviewed privacy resources OK. Export classification and App Privacy remain pending; this is not submission approval.')

if __name__=='__main__': main()
