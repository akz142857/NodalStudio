import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('notices', Path(__file__).with_name('generate_third_party_notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)

class NoticeTests(unittest.TestCase):
    def test_supplements_are_version_bound_and_digest_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            text = b'upstream license text\n'
            (root/'LICENSE').write_bytes(text)
            entry = dict(ecosystem='cargo', name='fixture', version='1.0.0', file='LICENSE', url='https://example.org/commit/LICENSE', revision='commit', sha256=hashlib.sha256(text).hexdigest())
            (root/'manifest.json').write_text(json.dumps([entry]))
            self.assertIn(('cargo','fixture','1.0.0'), notices.load_supplements(root))
            (root/'LICENSE').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                notices.load_supplements(root)

    def test_duplicate_and_escaping_paths_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            entry=dict(ecosystem='cargo',name='fixture',version='1',file='../LICENSE',url='https://example.org',revision='a',sha256='x')
            (root/'manifest.json').write_text(json.dumps([entry]))
            with self.assertRaisesRegex(ValueError, 'escapes'):
                notices.load_supplements(root)
            entry['file']='LICENSE'; entry['sha256']=hashlib.sha256(b'text').hexdigest()
            (root/'LICENSE').write_text('text')
            (root/'manifest.json').write_text(json.dumps([entry,entry]))
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                notices.load_supplements(root)

    def test_nonstandard_license_locations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'COPYRIGHT-RUST.txt').write_text('copyright and notices')
            (root/'AUTHORS').write_text('Permission is hereby granted, free of charge')
            self.assertEqual({name for name,_ in notices.texts(root)}, {'AUTHORS','COPYRIGHT-RUST.txt'})

    def test_repository_supplement_checksums(self):
        self.assertGreater(len(notices.load_supplements(notices.ROOT/'docs/legal/upstream')),40)

if __name__ == '__main__': unittest.main()
