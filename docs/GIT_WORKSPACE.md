# Git-friendly Nodal Studio Workspace

Nodal Studio keeps the physical schema derived from migrations and the live
database. The Git workspace contains reviewable team knowledge only; it is not
an alternative schema source of truth.

## Exported layout

The desktop `Export .nodalstudio` action writes an explicitly selected
repository directory:

```text
.nodalstudio/
├── .gitattributes
├── .gitignore
├── README.md
├── project.json
├── semantics/      # one physical object per deterministic JSON file
├── domains/        # one business domain per stable UUID
├── relationships/  # one confirmed model-only relationship per endpoint pair
├── views/          # relationship-view definitions, not canvas coordinates
├── provenance/     # branch, commit, PR, and migration associations
└── lineage/        # ORM/code links grouped by database object
```

The exporter deliberately excludes:

- immutable Snapshot bodies and ChangeSet caches;
- personal or shared canvas coordinates;
- database credentials and connection strings;
- cloud tokens, local source IDs, and capture timestamps;
- table rows, samples, and query results;
- AI or naming candidates that have not been confirmed into the semantic layer.

`project.json` contains a format version, database identity, current schema
fingerprint, and the exact managed-file list. A later export removes stale files
only when the previous manifest explicitly marked them as managed. It never
deletes arbitrary repository content.

## Merge driver

Semantic JSON uses a field-aware three-way merge:

- edits to different tables or fields merge automatically;
- tags merge as a sorted set union;
- one-sided edits replace the unchanged base value;
- concurrent edits to the same scalar create a structured conflict report;
- canvas positions are never merged because they are not exported.

Install and configure the merge driver in a development checkout:

```bash
cargo install --path crates/git-workspace --bin nodalstudio-semantic-merge
git config merge.nodalstudio-semantic.name "Nodal Studio semantic merge"
git config merge.nodalstudio-semantic.driver \
  "nodalstudio-semantic-merge %O %A %B"
```

The generated `.nodalstudio/.gitattributes` applies this driver only to
`semantics/*.json`. When an ambiguous edit remains, the driver:

1. writes the safely merged document to Git's `ours` path;
2. preserves the local value for the ambiguous field;
3. writes a sibling `*.conflicts.json` report with JSON paths and both values;
4. exits with status `1`, leaving Git aware that human resolution is required.

Logical relationships use one deterministic file per endpoint pair. A conflict
therefore affects only one relationship instead of a monolithic diagram file.
Import previews compare Git relationship values with local values and require
explicit confirmation before overwriting a conflict. A missing relationship
file never silently deletes the local relationship.

Domain, view, provenance, lineage, and relationship documents are already split by stable
identity, making ordinary Git line merging substantially less collision-prone.

## Import after Git merge

After a pull, rebase, or conflict resolution, use `Import semantics` in the
desktop panel to read the repository workspace back into the current local
project. Import is deliberately additive and scoped:

- it updates only confirmed annotations, domains, logical relationships,
  relationship-view definitions, migration provenance, and code lineage found
  in the manifest;
- it does not import connection profiles, credentials, snapshots, change
  caches, or canvas coordinates;
- it does not delete local semantic records merely because a file is absent;
- it refreshes the visible semantic layer immediately after a successful
  import.

The panel compares `project.json`'s schema fingerprint with the latest local
snapshot. A mismatch is reported explicitly: metadata may still be imported
for review, but the database should be refreshed before treating every object
reference as current. Resolve any generated `*.conflicts.json` report before
importing; conflict reports are evidence for a human decision, not model data.

## Team workflow

```text
Migration/DDL in Git
        ↓
Database migration
        ↓
Nodal Studio captures a local immutable Snapshot
        ↓
Team edits semantic knowledge
        ├── optional Cloud sync for live collaboration
        └── export split .nodalstudio files for code review/audit
                ↓
            Git merge/review
                ↓
            import merged semantics locally
```

Do not commit `.nodalmodel` bundles. They remain portable backup and offline
transfer artifacts, while the split workspace is the Git-review format.
