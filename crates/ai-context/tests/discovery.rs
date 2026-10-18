use ai_context::{
    discovery::{DiscoveryTask, Operation, build_context, known_relationships, validate_output},
    understanding::SendScope,
};
use schema_model::{
    ColumnDefinition, DatabaseInfo, DatabaseSnapshot, DatabaseType, ForeignKeyDefinition,
    MatchType, ObjectKey, PrimaryKeyDefinition, ReferentialAction, SchemaDefinition,
    TableDefinition,
};
use semantic_model::DomainGroup;
use uuid::Uuid;

fn column(name: &str) -> ColumnDefinition {
    ColumnDefinition {
        name: name.into(),
        ordinal_position: 1,
        formatted_type: "bigint".into(),
        type_schema: "pg_catalog".into(),
        type_name: "int8".into(),
        nullable: false,
        default_value: Some("0".into()),
        identity: None,
        generated: false,
        comment: Some("private-column-comment".into()),
    }
}

fn table(name: &str) -> TableDefinition {
    let mut t = TableDefinition::empty("public", name);
    t.columns = vec![column("id"), column("parent_id")];
    t.primary_key = Some(PrimaryKeyDefinition {
        name: format!("{name}_pkey"),
        columns: vec!["id".into()],
    });
    t.comment = Some("private-table-comment".into());
    t
}

fn fk(name: &str, target: &str) -> ForeignKeyDefinition {
    ForeignKeyDefinition {
        name: name.into(),
        columns: vec!["parent_id".into()],
        referenced_schema: "public".into(),
        referenced_table: target.into(),
        referenced_columns: vec!["id".into()],
        on_update: ReferentialAction::NoAction,
        on_delete: ReferentialAction::Restrict,
        match_type: MatchType::Simple,
        deferrable: false,
        initially_deferred: false,
    }
}

fn snapshot() -> DatabaseSnapshot {
    let mut a = table("a");
    a.foreign_keys.push(fk("a_b", "b"));
    let mut b = table("b");
    b.foreign_keys.push(fk("b_secret_c", "secret_c"));
    DatabaseSnapshot::new(
        Uuid::new_v4(),
        DatabaseInfo {
            name: "private-database".into(),
            database_type: DatabaseType::PostgreSql,
            version: "17".into(),
        },
        vec![SchemaDefinition {
            name: "public".into(),
            tables: vec![a, b, table("secret_c")],
            views: vec![],
            enums: vec![],
        }],
    )
}

fn domain(s: &DatabaseSnapshot, names: &[&str]) -> DomainGroup {
    DomainGroup {
        id: Uuid::new_v4(),
        source_id: s.source_id,
        name: "sensitive-domain-label".into(),
        description: Some("sensitive-domain-description".into()),
        color: "blue".into(),
        table_keys: names
            .iter()
            .map(|name| ObjectKey::table("public", *name))
            .collect(),
        updated_at: s.captured_at,
    }
}

fn task(operation: Operation) -> DiscoveryTask {
    DiscoveryTask {
        operation,
        question: "Find business records".into(),
        root: Some(ObjectKey::table("public", "a")),
        candidates: ["a", "b", "secret_c"]
            .map(|s| ObjectKey::table("public", s))
            .to_vec(),
        path_tables: vec![],
        path_relationships: vec![],
    }
}
fn path(s: &DatabaseSnapshot) -> DiscoveryTask {
    let relationships = known_relationships(s, &[]);
    DiscoveryTask {
        path_tables: ["a", "b", "secret_c"]
            .map(|s| ObjectKey::table("public", s))
            .to_vec(),
        path_relationships: relationships.iter().map(|r| r.id.clone()).collect(),
        ..task(Operation::Path)
    }
}
#[test]
fn question_expansion_has_no_metadata_in_every_scope_without_root_or_domain() {
    let s = snapshot();
    let mut t = task(Operation::Expand);
    t.root = None;
    for scope in [
        SendScope::CurrentTable,
        SendScope::OneHop,
        SendScope::Domain,
    ] {
        let c = build_context(&s, &t, scope, None, &[], true).unwrap();
        assert!(
            c.tables.is_empty()
                && c.candidates.is_empty()
                && c.evidence.is_empty()
                && c.path.is_empty()
        );
        let body = serde_json::to_string(&c).unwrap();
        for name in ["private", "secret_c", "sensitive"] {
            assert!(!body.contains(name));
        }
    }
}
#[test]
fn ranking_intersects_one_hop_and_never_sends_second_hop_or_comments() {
    let s = snapshot();
    let t = task(Operation::Rank);
    let c = build_context(&s, &t, SendScope::OneHop, None, &[], false).unwrap();
    assert_eq!(
        c.tables,
        [
            ObjectKey::table("public", "a"),
            ObjectKey::table("public", "b")
        ]
    );
    assert_eq!(c.candidates.len(), 2);
    for text in [
        "secret_c",
        "b_secret_c",
        "private-table-comment",
        "private-column-comment",
        "private-database",
    ] {
        assert!(!serde_json::to_string(&c).unwrap().contains(text));
    }
    assert!(c.coverage.iter().any(|c| c.contains("local ranking")));
    assert!(build_context(&s, &t, SendScope::CurrentTable, None, &[], false).is_err());
    assert!(
        build_context(
            &s,
            &DiscoveryTask { root: None, ..t },
            SendScope::OneHop,
            None,
            &[],
            false
        )
        .is_err()
    );
}
#[test]
fn domain_ranking_without_root_needs_one_explicit_domain_and_does_not_merge() {
    let s = snapshot();
    let d = domain(&s, &["a", "secret_c"]);
    let mut t = task(Operation::Rank);
    t.root = None;
    assert!(build_context(&s, &t, SendScope::Domain, None, &[], true).is_err());
    let c = build_context(&s, &t, SendScope::Domain, Some(&d), &[], true).unwrap();
    assert_eq!(c.tables, d.table_keys);
    assert!(
        !serde_json::to_string(&c)
            .unwrap()
            .contains("sensitive-domain")
    );
    t.root = Some(ObjectKey::table("public", "b"));
    assert!(build_context(&s, &t, SendScope::Domain, Some(&d), &[], true).is_err());
}
#[test]
fn full_paths_must_fit_scope_and_budget_never_partial_or_invented() {
    let mut s = snapshot();
    let t = path(&s);
    let d = domain(&s, &["a", "b", "secret_c"]);
    assert!(
        build_context(&s, &t, SendScope::OneHop, None, &[], true)
            .unwrap_err()
            .contains("complete path")
    );
    let c = build_context(&s, &t, SendScope::Domain, Some(&d), &[], false).unwrap();
    assert_eq!(c.path.len(), 2);
    assert_eq!(c.tables.len(), 3);
    let mut invented = t.clone();
    invented.path_relationships[0] = "model-invented-edge".into();
    assert!(build_context(&s, &invented, SendScope::Domain, Some(&d), &[], false).is_err());
    s.schemas[0].tables[1]
        .columns
        .extend((0..1001).map(|n| column(&format!("extra_{n}"))));
    assert!(
        build_context(&s, &t, SendScope::Domain, Some(&d), &[], false)
            .unwrap_err()
            .contains("full path exceeds")
    );
}
#[test]
fn missing_endpoints_and_ordered_composite_keys_are_preserved() {
    let mut s = snapshot();
    s.schemas[0].tables[0].foreign_keys[0].columns = vec!["parent_id".into(), "id".into()];
    s.schemas[0].tables[0].foreign_keys[0].referenced_columns =
        vec!["id".into(), "parent_id".into()];
    s.schemas[0].tables[1]
        .foreign_keys
        .push(fk("missing", "not_collected"));
    let r = known_relationships(&s, &[]);
    assert_eq!(r.len(), 2);
    assert_eq!(r[0].source_columns, ["parent_id", "id"]);
    assert_eq!(r[0].target_columns, ["id", "parent_id"]);
}
#[test]
fn output_ids_and_operation_shape_cannot_invent_navigation_or_evidence() {
    let s = snapshot();
    let c = build_context(
        &s,
        &task(Operation::Rank),
        SendScope::OneHop,
        None,
        &[],
        true,
    )
    .unwrap();
    let valid =
        r#"{"rankings":[{"candidateId":"c1","reason":"Possibly a record","evidenceIds":["e1"]}]}"#;
    assert_eq!(validate_output(valid, &c).unwrap().rankings.len(), 1);
    assert!(validate_output(&valid.replace("c1", "invented_table"), &c).is_err());
    assert!(validate_output(&valid.replace("e1", "fabricated_evidence"), &c).is_err());
    assert!(validate_output(r#"{"terms":["invented_table"]}"#, &c).is_err());
    let expansion = build_context(
        &s,
        &task(Operation::Expand),
        SendScope::CurrentTable,
        None,
        &[],
        false,
    )
    .unwrap();
    assert!(
        validate_output(
            r#"{"terms":["payment"],"meanings":[{"label":"Finance","terms":["ledger"]}]}"#,
            &expansion
        )
        .is_ok()
    );
    assert!(validate_output(valid, &expansion).is_err());
}
#[test]
fn large_catalogs_are_trimmed_with_coverage_and_oversized_evidence_fails_closed() {
    let mut s = snapshot();
    s.schemas[0]
        .tables
        .extend((0..30).map(|n| table(&format!("candidate_{n}"))));
    let mut t = task(Operation::Rank);
    t.root = None;
    t.candidates = s.schemas[0].tables.iter().map(|t| t.key.clone()).collect();
    let mut d = domain(&s, &[]);
    d.table_keys = t.candidates.clone();
    let c = build_context(&s, &t, SendScope::Domain, Some(&d), &[], false).unwrap();
    assert_eq!(c.tables.len(), 20);
    assert!(c.coverage.iter().any(|s| s.contains("budget")));
    s.schemas[0].tables[0].comment = Some("x".repeat(140_000));
    assert!(build_context(&s, &t, SendScope::Domain, Some(&d), &[], true).is_err());
}

#[test]
fn dialect_is_preserved_for_evidence_but_not_attached_to_question_only_expansion() {
    let mut s = snapshot();
    s.database.database_type = DatabaseType::MySql;
    let c = build_context(
        &s,
        &task(Operation::Rank),
        SendScope::OneHop,
        None,
        &[],
        false,
    )
    .unwrap();
    assert_eq!(c.dialect, Some(DatabaseType::MySql));
    let c = build_context(
        &s,
        &task(Operation::Expand),
        SendScope::CurrentTable,
        None,
        &[],
        false,
    )
    .unwrap();
    assert!(c.dialect.is_none());
    assert!(!serde_json::to_string(&c).unwrap().contains("dialect"));
}

#[test]
fn confirmed_team_notes_require_current_status_and_wholly_allowed_basis() {
    use semantic_model::knowledge::{
        KnowledgeBasis, KnowledgeConfirmation, KnowledgeOrigin, KnowledgeState, KnowledgeStatus,
        digest,
    };
    let s = snapshot();
    let key = ObjectKey::table("public", "a");
    let mut state = KnowledgeState {
        source_id: s.source_id,
        object_key: key.clone(),
        status: KnowledgeStatus::Confirmed,
        reason: "local".into(),
        confirmation: Some(KnowledgeConfirmation {
            id: Uuid::new_v4(),
            source_id: s.source_id,
            object_key: key.clone(),
            final_text: "TEAM_NOTE".into(),
            description_digest: digest(&Some("TEAM_NOTE")),
            snapshot_id: s.id,
            fingerprint: s.fingerprint.clone(),
            confirmed_at: s.captured_at,
            basis: KnowledgeBasis::from_tables(
                &s,
                &[key.clone(), ObjectKey::table("public", "secret_c")],
                &[],
            ),
            origin: KnowledgeOrigin {
                kind: "manualReview".into(),
                request_id: None,
                provider: None,
                model: None,
                generated_at: None,
                evidence: serde_json::Value::Null,
            },
        }),
    };
    let mut evidence = vec![];
    assert!(
        ai_context::understanding::append_confirmed_notes(
            &s,
            std::slice::from_ref(&key),
            &mut evidence,
            &[state.clone()]
        )
        .unwrap()
    );
    assert!(evidence.is_empty());
    state.confirmation.as_mut().unwrap().basis =
        KnowledgeBasis::from_tables(&s, std::slice::from_ref(&key), &[]);
    assert!(
        !ai_context::understanding::append_confirmed_notes(
            &s,
            std::slice::from_ref(&key),
            &mut evidence,
            &[state.clone()]
        )
        .unwrap()
    );
    assert_eq!(evidence[0].kind, "teamStatement");
    assert!(evidence[0].detail.contains("TEAM_NOTE"));
    state.status = KnowledgeStatus::PendingReview;
    evidence.clear();
    ai_context::understanding::append_confirmed_notes(&s, &[key], &mut evidence, &[state]).unwrap();
    assert!(evidence.is_empty());
}
