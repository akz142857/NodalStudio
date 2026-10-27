import copy
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
import shutil

spec=importlib.util.spec_from_file_location('compliance',Path(__file__).with_name('check_mas_compliance.py'))
compliance=importlib.util.module_from_spec(spec);spec.loader.exec_module(compliance)

class ComplianceTests(unittest.TestCase):
    def test_development_and_production_identities_cannot_overlap_or_fall_back(self):
        development={'identifier':'com.claycosmos.nodalstudio.dev','productName':'Nodal Studio Dev'}
        production={'identifier':'com.claycosmos.nodalstudio','productName':'Nodal Studio'}
        compliance.validate_distribution_identity(development,production,production)
        for configs in [(production,production,production),(development,{},production),(development,production,development)]:
            with self.assertRaises(ValueError):compliance.validate_distribution_identity(*configs)

    def test_source_resources_and_pinned_sdk(self):
        compliance.validate_source()

    def test_missing_duplicate_or_guessed_reason_rejected(self):
        original=compliance.read_plist(compliance.BASE/'PrivacyInfo.xcprivacy')
        for mutate in [lambda x:x['NSPrivacyAccessedAPITypes'].pop(), lambda x:x['NSPrivacyAccessedAPITypes'].append(x['NSPrivacyAccessedAPITypes'][0]), lambda x:x['NSPrivacyAccessedAPITypes'][0]['NSPrivacyAccessedAPITypeReasons'].append('DDA9.1')]:
            value=copy.deepcopy(original);mutate(value)
            with self.assertRaises(ValueError):compliance.validate_manifest(value)

    def test_no_unreviewed_whole_app_collection_claim(self):
        value=compliance.read_plist(compliance.BASE/'PrivacyInfo.xcprivacy');value['NSPrivacyCollectedDataTypes']=[]
        with self.assertRaisesRegex(ValueError,'data-flow'):compliance.validate_manifest(value)

    def test_export_questionnaire_not_silently_bypassed(self):
        compliance.validate_encryption({})
        for v in [False,True,'false']:
            with self.assertRaises(ValueError):compliance.validate_encryption({'ITSAppUsesNonExemptEncryption':v})
        with self.assertRaises(ValueError):compliance.validate_encryption({'ITSEncryptionExportComplianceCode':'invented'})

    def test_bundle_requires_correct_location_and_exact_resources(self):
        with tempfile.TemporaryDirectory() as tmp:
            app=Path(tmp)/'Fixture.app';contents=app/'Contents';contents.mkdir(parents=True)
            (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'com.claycosmos.nodalstudio','CFBundleShortVersionString':'1.0.0','CFBundleVersion':'2'}))
            with self.assertRaisesRegex(ValueError,'missing or stale'):compliance.validate_bundle(app)
            for dest,src in compliance.RESOURCES.items():
                source=compliance.BASE/src;target=contents/dest;target.parent.mkdir(parents=True,exist_ok=True)
                if source.is_dir():shutil.copytree(source,target)
                else:shutil.copy2(source,target)
            compliance.validate_bundle(app)
            (contents/'Resources/PrivacyInfo.xcprivacy').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'missing or stale'):compliance.validate_bundle(app)

    def test_sdk_upgrade_requires_rereview(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'Cargo.lock').write_text('name = "ring"\nversion = "99.0.0"\n')
            with self.assertRaisesRegex(ValueError,'version changed'):compliance.validate_source(root=root)

    def test_mas_version_and_build_reject_fallback_and_allow_next_upload(self):
        valid={'CFBundleShortVersionString':'1.0.0','CFBundleVersion':'2'}
        compliance.validate_bundle_version(valid)
        for field,value in [('CFBundleShortVersionString','0.2.4'),('CFBundleVersion','1.0.0'),('CFBundleVersion',None)]:
            with self.assertRaises(ValueError):compliance.validate_bundle_version({**valid,field:value})
        compliance.validate_bundle_version({**valid,'CFBundleVersion':'3'},expected_build='3')
        with self.assertRaises(ValueError):compliance.validate_bundle_version(valid,expected_build='3')

if __name__=='__main__':unittest.main()
