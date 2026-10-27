# Legal content shipped with the app

- `PRIVACY.mas.zh-CN.txt` / `PRIVACY.mas.en.txt`: bundled Mac App Store policy, aligned with the public policy at studio.nodalos.com; contact is support@nodalos.com. MAS users do not see community distribution or update-service copy.
- `PRIVACY.zh-CN.txt` / `PRIVACY.en.txt`: community policy, retaining the disclosures for its actual update and cloud services; support also uses support@nodalos.com.
- Root `LICENSE`: MIT text matching the existing workspace and in-app license declaration; this change does not close-source the project.
- `THIRD_PARTY_NOTICES.txt`: generated upstream notices, lazy-loaded in Settings → About.
- `NOTICE_INVENTORY_GAPS.txt`: unresolved source-text inventory gaps, not a declaration that these packages have no license.

Regenerate with `python3 Scripts/generate_third_party_notices.py` after installing locked dependencies. The script is offline and does not infer missing copyright notices. Rust dependencies include build and platform-specific packages; review the actual shipping closure and resolve applicable gaps before release. Do not replace missing upstream notices with guessed text.

## 2026-10-25 license-text closure

The conservative inventory contains **603 packages with 0 missing-text entries**. `upstream/manifest.json` supplements missing packaged texts with version-bound upstream files and SHA-256 digests. Most use the exact `.cargo_vcs_info.json` revision; older architecture support crates use their documented repository release, tao-macros uses its version tag commit. Standard SPDX texts are explicitly labeled for selectors (MPL-2.0), cesu8 (Apache-2.0) and railroad-diagrams (CC0-1.0), based on the published package's declaration. They do not fabricate upstream copyright ownership. r-efi's complete MIT terms are retained from AUTHORS; cesu8's COPYRIGHT-RUST notices are retained.

Each Cargo entry also includes its exact-version upstream source download URL, including MPL-covered sources. Sources are unmodified by this task. This closes the recorded text inventory gaps; it is not a legal opinion or proof that all distribution obligations and third-party SDK privacy requirements have been audited.

Offline checks:

```sh
python3 Scripts/test_third_party_notices.py
python3 Scripts/generate_third_party_notices.py --check
```

The MAS packaging script runs `--check` before building: missing texts, stale generated output, changed supplemental bytes or stale package versions fail the check. Regeneration is explicit and offline; fetching new upstream texts requires review of the package version and provenance.
