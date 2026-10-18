use ai_context::understanding::{SendScope, build_context, validate_model_output};
use schema_model::{
    ColumnDefinition, DatabaseInfo, DatabaseSnapshot, DatabaseType, ForeignKeyDefinition,
    LogicalRelationship, LogicalRelationshipOrigin, LogicalRelationshipStatus, MatchType,
    ObjectKey, PrimaryKeyDefinition, ReferentialAction, RelationshipCardinality,
    RelationshipEndpoint, SchemaDefinition, TableDefinition,
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

#[test]
fn current_table_omits_outside_fk_names_and_all_comment_channels() {
    let s = snapshot();
    let context = build_context(
        &s,
        &ObjectKey::table("public", "a"),
        None,
        SendScope::CurrentTable,
        None,
        &[],
        false,
    )
    .unwrap();
    let payload = serde_json::to_string(&context).unwrap();
    assert_eq!(context.tables, [ObjectKey::table("public", "a")]);
    for excluded in [
        "a_b",
        "b_secret_c",
        "secret_c",
        "private-database",
        "private-column-comment",
        "private-table-comment",
    ] {
        assert!(!payload.contains(excluded), "leaked {excluded}");
    }
    assert!(
        context
            .evidence
            .iter()
            .any(|e| e.kind == "column" && e.detail.contains("nullable"))
    );
    assert!(context.evidence.iter().any(|e| e.kind == "primaryKey"));
    assert!(context.coverage.iter().any(|s| s.contains("outside")));
}

#[test]
fn one_hop_includes_inbound_edges_but_never_the_second_hop() {
    let s = snapshot();
    let a = build_context(
        &s,
        &ObjectKey::table("public", "a"),
        None,
        SendScope::OneHop,
        None,
        &[],
        true,
    )
    .unwrap();
    assert_eq!(a.tables.len(), 2);
    assert!(!serde_json::to_string(&a).unwrap().contains("secret_c"));
    assert!(
        a.evidence
            .iter()
            .any(|e| e.kind == "physicalRelationship" && e.detail.contains("parent_id"))
    );
    let c = build_context(
        &s,
        &ObjectKey::table("public", "secret_c"),
        None,
        SendScope::OneHop,
        None,
        &[],
        false,
    )
    .unwrap();
    assert_eq!(c.tables[0], ObjectKey::table("public", "secret_c"));
    assert!(c.tables.contains(&ObjectKey::table("public", "b")));
    assert!(!c.tables.contains(&ObjectKey::table("public", "a")));
}

#[test]
fn domain_is_explicit_source_scoped_and_never_includes_other_domains() {
    let s = snapshot();
    let target = ObjectKey::table("public", "a");
    assert!(build_context(&s, &target, None, SendScope::Domain, None, &[], false).is_err());
    assert!(
        build_context(
            &s,
            &target,
            None,
            SendScope::Domain,
            Some(&domain(&s, &["b"])),
            &[],
            false
        )
        .is_err()
    );
    let mut foreign = domain(&s, &["a", "b"]);
    foreign.source_id = Uuid::new_v4();
    assert!(
        build_context(
            &s,
            &target,
            None,
            SendScope::Domain,
            Some(&foreign),
            &[],
            false
        )
        .is_err()
    );
    let context = build_context(
        &s,
        &target,
        None,
        SendScope::Domain,
        Some(&domain(&s, &["a"])),
        &[],
        false,
    )
    .unwrap();
    assert_eq!(context.tables, [target]);
    let payload = serde_json::to_string(&context).unwrap();
    assert!(!payload.contains("sensitive-domain"));
    assert!(!payload.contains("a_b"));
}

#[test]
fn logical_relations_are_distinct_and_disabled_foreign_or_incomplete_links_cannot_expand_scope() {
    let s = snapshot();
    let relation = LogicalRelationship {
        id: Uuid::new_v4(),
        source_id: s.source_id,
        name: "private-relation-name".into(),
        source: RelationshipEndpoint::new("public", "a", vec!["id".into()]),
        target: RelationshipEndpoint::new("public", "secret_c", vec!["id".into()]),
        cardinality: RelationshipCardinality::ManyToOne,
        status: LogicalRelationshipStatus::Active,
        origin: LogicalRelationshipOrigin::Manual,
        note: Some("unreviewed-note".into()),
        evidence: vec!["unreviewed-evidence".into()],
        created_at: s.captured_at,
        updated_at: s.captured_at,
    };
    let target = ObjectKey::table("public", "a");
    let context = build_context(
        &s,
        &target,
        None,
        SendScope::OneHop,
        None,
        std::slice::from_ref(&relation),
        false,
    )
    .unwrap();
    assert_eq!(context.tables.len(), 3);
    assert!(
        context
            .evidence
            .iter()
            .any(|e| e.kind == "logicalRelationship"
                && e.detail.contains("not a database constraint"))
    );
    assert!(
        !serde_json::to_string(&context)
            .unwrap()
            .contains("unreviewed")
    );
    for variant in 0..3 {
        let mut bad = relation.clone();
        match variant {
            0 => bad.status = LogicalRelationshipStatus::Disabled,
            1 => bad.source_id = Uuid::new_v4(),
            _ => bad.target.columns = vec!["missing".into()],
        }
        let context =
            build_context(&s, &target, None, SendScope::OneHop, None, &[bad], false).unwrap();
        assert_eq!(context.tables.len(), 2);
    }
}

#[test]
fn composite_mappings_and_schema_qualified_targets_are_preserved() {
    let mut s = snapshot();
    let mut other = table("a");
    other.key.schema = "archive".into();
    s.schemas.push(SchemaDefinition {
        name: "archive".into(),
        tables: vec![other],
        views: vec![],
        enums: vec![],
    });
    let a = &mut s.schemas[0].tables[0];
    let mut relation = fk("composite", "a");
    relation.referenced_schema = "archive".into();
    relation.columns = vec!["parent_id".into(), "id".into()];
    relation.referenced_columns = vec!["id".into(), "parent_id".into()];
    a.foreign_keys = vec![relation];
    let context = build_context(
        &s,
        &ObjectKey::table("public", "a"),
        Some("parent_id"),
        SendScope::OneHop,
        None,
        &[],
        false,
    )
    .unwrap();
    let evidence = context
        .evidence
        .iter()
        .find(|e| e.kind == "physicalRelationship")
        .unwrap();
    let value: serde_json::Value = serde_json::from_str(&evidence.detail).unwrap();
    assert_eq!(value["columns"], serde_json::json!(["parent_id", "id"]));
    assert_eq!(
        value["referencedColumns"],
        serde_json::json!(["id", "parent_id"])
    );
    assert_eq!(value["referencedSchema"], "archive");
}

#[test]
fn missing_target_column_and_oversized_metadata_fail_before_sending() {
    let mut s = snapshot();
    let target = ObjectKey::table("public", "a");
    assert!(
        build_context(
            &s,
            &ObjectKey::table("public", "missing"),
            None,
            SendScope::CurrentTable,
            None,
            &[],
            true
        )
        .is_err()
    );
    assert!(
        build_context(
            &s,
            &target,
            Some("missing"),
            SendScope::CurrentTable,
            None,
            &[],
            true
        )
        .is_err()
    );
    s.schemas[0].tables[0].comment = Some("x".repeat(131_073));
    assert!(build_context(&s, &target, None, SendScope::CurrentTable, None, &[], true).is_err());
    assert!(build_context(&s, &target, None, SendScope::CurrentTable, None, &[], false).is_ok());
    s.schemas[0].tables[0].columns = (0..1001).map(|i| column(&format!("c{i}"))).collect();
    assert!(build_context(&s, &target, None, SendScope::CurrentTable, None, &[], false).is_err());
}

#[test]
fn model_cannot_author_facts_actions_or_invent_evidence_ids() {
    let context = build_context(
        &snapshot(),
        &ObjectKey::table("public", "a"),
        None,
        SendScope::CurrentTable,
        None,
        &[],
        false,
    )
    .unwrap();
    for invalid in [
        r#"{"interpretations":[{"text":"guess","evidenceIds":["e999"]}],"unknowns":[]}"#,
        r#"{"interpretations":[{"text":"guess","evidenceIds":[]}],"unknowns":[]}"#,
        r#"{"interpretations":[],"unknowns":["unsure"],"facts":["invented"]}"#,
        r#"{"interpretations":[],"unknowns":["unsure"],"actions":["query"]}"#,
    ] {
        assert!(validate_model_output(invalid, &context).is_err());
    }
    let valid = r#"{"interpretations":[{"text":"Could be a record; business grain unknown.","evidenceIds":["e1"]}],"unknowns":["What is the business grain?"]}"#;
    assert!(validate_model_output(valid, &context).is_ok());
}

#[test]
fn budget_keeps_target_and_reports_partial_neighbourhood_without_dangling_edges() {
    let mut s = snapshot();
    s.database.database_type = DatabaseType::MySql;
    for i in 0..25 {
        let mut neighbour = table(&format!("neighbour_{i}"));
        neighbour.foreign_keys.push(fk(&format!("link_{i}"), "a"));
        s.schemas[0].tables.push(neighbour);
    }
    let context = build_context(
        &s,
        &ObjectKey::table("public", "a"),
        None,
        SendScope::OneHop,
        None,
        &[],
        false,
    )
    .unwrap();
    assert_eq!(context.tables.len(), 20);
    assert_eq!(context.tables[0], ObjectKey::table("public", "a"));
    assert_eq!(context.dialect, DatabaseType::MySql);
    assert!(
        context
            .coverage
            .iter()
            .any(|line| line.contains("partial context"))
    );
    for evidence in context
        .evidence
        .iter()
        .filter(|e| e.kind == "physicalRelationship")
    {
        let fk: ForeignKeyDefinition = serde_json::from_str(&evidence.detail).unwrap();
        assert!(context.tables.contains(&evidence.table_key));
        assert!(
            context
                .tables
                .contains(&ObjectKey::table(fk.referenced_schema, fk.referenced_table))
        );
    }
}
