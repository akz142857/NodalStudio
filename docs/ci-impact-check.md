# CI / PR database impact check

Nodal Studio includes a deterministic command for CI pipelines. It consumes exported build artifacts, not a committed monolithic model file:

```bash
cargo run -p project-graph --bin impact-check -- \
  artifacts/change-set.json \
  artifacts/project-graph.json \
  high > artifacts/impact-report.json
```

The optional threshold is `high`, `medium`, or `low`. Exit code `2` means at least one schema operation at or above that risk has a confirmed code-impact path. Potential-only paths remain visible in the JSON report but do not block the PR. Exit code `1` means the input is missing or invalid.

Recommended pipeline:

1. Generate the database `SchemaChangeSet` in a trusted migration or preview environment.
2. Run the Nodal Studio scanner against the checked-out PR revision.
3. Pass both JSON artifacts to `impact-check`.
4. Upload `impact-report.json` as a PR artifact and use the process exit code as the required check.

Do not commit project graphs, credentials, absolute paths, database rows, or AI prompts. Team sharing uses a separate sanitized Cloud Bundle and never replaces CI artifacts.
