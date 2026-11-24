use std::{env, path::Path, process::Stdio, time::Instant};

use postgres_adapter::{PostgresConnectionOptions, PostgresSslMode};
use schema_model::{ConnectionSecurity, DataSourceProfile, SslMode};
use sqlx::{AssertSqlSafe, PgPool};
use tokio::process::Command;

use super::*;
use postgres_export::DumpTarget;

const USER: &str = "nodal_export";
const PASSWORD: &str = "nodal_local_fixture";
const SOURCE: &str = "nodal_export_source";

struct Fixture {
    port: u16,
    dump: PathBuf,
    psql: PathBuf,
}

impl Fixture {
    fn configured() -> Option<Self> {
        let port = env::var("NODAL_EXPORT_TEST_PORT").ok()?.parse().unwrap();
        let dump = postgres_export::find_pg_dump()
            .expect("install pg_dump to run the local restore tests");
        let psql = dump.with_file_name(if cfg!(windows) { "psql.exe" } else { "psql" });
        Some(Self { port, dump, psql })
    }

    fn options(&self, database: &str) -> PostgresConnectionOptions {
        PostgresConnectionOptions::from_fields(
            "127.0.0.1",
            self.port,
            database,
            USER,
            PASSWORD,
            PostgresSslMode::Disable,
        )
    }

    async fn create_database(&self) -> (String, PgPool) {
        let name = format!("export_test_{}", Uuid::new_v4().simple());
        let admin = postgres_adapter::connect(&self.options(SOURCE))
            .await
            .unwrap();
        sqlx::query(AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .unwrap();
        let db = postgres_adapter::connect(&self.options(&name))
            .await
            .unwrap();
        (name, db)
    }

    async fn drop_database(&self, db: PgPool, name: &str) {
        db.close().await;
        let admin = postgres_adapter::connect(&self.options(SOURCE))
            .await
            .unwrap();
        sqlx::query(AssertSqlSafe(format!("DROP DATABASE {name}")))
            .execute(&admin)
            .await
            .unwrap();
    }

    async fn client(&self, database: &str) -> postgres_export::DumpClient {
        let profile = direct_profile(database, self.port);
        postgres_export::DumpClient::new(&profile, PASSWORD, 10)
            .await
            .unwrap()
    }

    async fn restore(&self, file: &Path, database: &str) {
        let output = Command::new(&self.psql)
            .args(["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", database, "-f"])
            .arg(file)
            .env("PGHOST", "127.0.0.1")
            .env("PGPORT", self.port.to_string())
            .env("PGUSER", USER)
            .env("PGPASSWORD", PASSWORD)
            .env("PGSSLMODE", "disable")
            .stdout(Stdio::null())
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

const SCHEMA: &str = r#"CREATE SCHEMA "Ops.Sales";"#;
const TABLE: &str = r#""Ops.Sales"."Line.*""Items""#;

async fn inspect_rows(db: &PgPool) -> (i64, Option<String>) {
    sqlx::query_as(AssertSqlSafe(format!(
        "SELECT count(*), md5(string_agg(row(t.*)::text, '' ORDER BY id)) FROM {TABLE} t"
    )))
    .fetch_one(db)
    .await
    .unwrap()
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "One fixture is shared across the independent restore cases and file formats"
)]
async fn postgres_export_round_trip() {
    let Some(fixture) = Fixture::configured() else {
        eprintln!("skipping local PostgreSQL export acceptance: NODAL_EXPORT_TEST_PORT is not set");
        return;
    };
    let (source, db) = fixture.create_database().await;
    sqlx::raw_sql(AssertSqlSafe(format!(
        r#"
        {SCHEMA}
        CREATE TABLE {TABLE} (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            "very.exact" numeric(40,10) NOT NULL,
            payload bytea NOT NULL,
            note text,
            CHECK (octet_length(payload) = 4)
        );
        CREATE INDEX special_table_note ON {TABLE} (note);
        INSERT INTO {TABLE} ("very.exact", payload, note)
          SELECT 12345678901234567890.1234567890, decode('00ff8081', 'hex'),
                 CASE WHEN i % 2 = 0 THEN NULL ELSE E'测试,"line"\nnext' END
          FROM generate_series(1, 5501) i;
        CREATE TABLE "Ops.Sales"."Line.lookalike""Items" (id integer);
        CREATE SCHEMA "OpsXSales";
        CREATE TABLE public.other (id integer PRIMARY KEY);
        INSERT INTO public.other VALUES (1);
        CREATE VIEW public.other_view AS SELECT id FROM public.other;
        CREATE TABLE public.events (id integer) PARTITION BY RANGE (id);
        CREATE TABLE public.events_first PARTITION OF public.events FOR VALUES FROM (0) TO (100);
        INSERT INTO public.events VALUES (7);
    "#
    )))
    .execute(&db)
    .await
    .unwrap();
    let expected = inspect_rows(&db).await;
    assert_eq!(expected.0, 5501);
    let table = ObjectKey::table("Ops.Sales", "Line.*\"Items");
    let options = fixture.options(&source);
    let client = fixture.client(&source).await;
    let folder = tempfile::tempdir().unwrap();
    let partitions = ObjectKey::table("public", "events");
    assert!(
        postgres_export::is_partitioned(&options, &partitions)
            .await
            .unwrap()
    );

    let table_target = DumpTarget::Table {
        table: &table,
        partitioned: false,
    };
    let partitions_target = DumpTarget::Table {
        table: &partitions,
        partitioned: true,
    };
    let public_target = DumpTarget::Schema("public");
    let sales_target = DumpTarget::Schema("Ops.Sales");
    for (index, (target, mode, include_rows)) in [
        (DumpTarget::Database, DumpMode::StructureAndData, true),
        (DumpTarget::Database, DumpMode::StructureOnly, false),
        (table_target, DumpMode::StructureAndData, true),
        (table_target, DumpMode::StructureOnly, false),
        (partitions_target, DumpMode::StructureAndData, true),
        (public_target, DumpMode::StructureAndData, true),
        (public_target, DumpMode::StructureOnly, false),
        (sales_target, DumpMode::StructureAndData, true),
        (sales_target, DumpMode::StructureOnly, false),
    ]
    .into_iter()
    .enumerate()
    {
        let (database, restored) = fixture.create_database().await;
        if target == table_target {
            sqlx::query(SCHEMA).execute(&restored).await.unwrap();
        } else if target == public_target {
            // Schema-specific pg_dump includes CREATE SCHEMA public.
            sqlx::query("DROP SCHEMA public RESTRICT")
                .execute(&restored)
                .await
                .unwrap();
        }
        let destination = Destination {
            path: folder.path().join(format!("case-{index}.sql")),
        };
        let temp = destination.create_temp().unwrap();
        let mut dump = client.command(&fixture.dump, target, mode).unwrap();
        postgres_export::write_dump(&mut dump, &temp, &CancellationToken::new(), &mut |_| {})
            .await
            .unwrap();
        drop(dump);
        let receipt = destination
            .commit(temp, CancellationToken::new())
            .await
            .unwrap();
        fixture.restore(Path::new(&receipt.path), &database).await;
        if target == partitions_target || target == public_target {
            let data: i64 = sqlx::query_scalar("SELECT count(*) FROM public.events WHERE id=7")
                .fetch_one(&restored)
                .await
                .unwrap();
            assert_eq!(data, i64::from(include_rows));
        } else {
            assert_eq!(
                inspect_rows(&restored).await,
                if include_rows {
                    expected.clone()
                } else {
                    (0, None)
                }
            );
            let index_exists: bool = sqlx::query_scalar(
                "SELECT to_regclass('\"Ops.Sales\".special_table_note') IS NOT NULL",
            )
            .fetch_one(&restored)
            .await
            .unwrap();
            assert!(index_exists);
        }
        let other: bool = sqlx::query_scalar("SELECT to_regclass('public.other_view') IS NOT NULL")
            .fetch_one(&restored)
            .await
            .unwrap();
        assert_eq!(
            other,
            matches!(target, DumpTarget::Database | DumpTarget::Schema("public"))
        );
        let lookalike: bool = sqlx::query_scalar(
            r#"SELECT to_regclass('"Ops.Sales"."Line.lookalike""Items"') IS NOT NULL"#,
        )
        .fetch_one(&restored)
        .await
        .unwrap();
        assert_eq!(
            lookalike,
            matches!(
                target,
                DumpTarget::Database | DumpTarget::Schema("Ops.Sales")
            )
        );
        if matches!(target, DumpTarget::Schema(_)) {
            let unrelated_present: bool =
                sqlx::query_scalar(r#"SELECT to_regnamespace('"OpsXSales"') IS NOT NULL"#)
                    .fetch_one(&restored)
                    .await
                    .unwrap();
            assert!(!unrelated_present);
        }
        eprintln!("restored {target:?} {mode:?}: {} bytes", receipt.bytes);
        fixture.drop_database(restored, &database).await;
    }

    let temp = tempfile::NamedTempFile::new_in(folder.path()).unwrap();
    let mut missing = client
        .command(
            &fixture.dump,
            DumpTarget::Schema("missing"),
            DumpMode::StructureOnly,
        )
        .unwrap();
    assert_eq!(
        postgres_export::write_dump(&mut missing, &temp, &CancellationToken::new(), &mut |_| {})
            .await,
        Err(ExportError::SchemaUnavailable)
    );

    let csv = tempfile::NamedTempFile::new().unwrap();
    let columns = [
        "id".to_owned(),
        "very.exact".to_owned(),
        "payload".to_owned(),
        "note".to_owned(),
    ];
    postgres_export::write_table(
        &options,
        &csv,
        &table,
        &columns,
        Format::Csv,
        false,
        &mut |_| {},
    )
    .await
    .unwrap();
    let text = std::fs::read_to_string(csv.path()).unwrap();
    assert!(text.starts_with("id,very.exact,payload,note\n"));
    assert_eq!(
        text.matches("12345678901234567890.1234567890,\\x00ff8081")
            .count(),
        5501
    );
    assert!(text.contains("\"测试,\"\"line\"\"\nnext\""));
    let json = tempfile::NamedTempFile::new().unwrap();
    postgres_export::write_table(
        &options,
        &json,
        &table,
        &columns[1..],
        Format::Json,
        true,
        &mut |_| {},
    )
    .await
    .unwrap();
    let text = std::fs::read_to_string(json.path()).unwrap();
    assert_eq!(
        text.matches("12345678901234567890.1234567890").count(),
        5501
    );
    let values: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
    assert_eq!(values.len(), 5501);
    assert!(
        values
            .iter()
            .all(|row| row.get("id").is_none() && row["payload"] == "\\x00ff8081")
    );
    assert!(values.iter().any(|row| row["note"].is_null()));
    assert!(
        values
            .iter()
            .any(|row| row["note"] == "测试,\"line\"\nnext")
    );
    eprintln!(
        "CSV and JSON each exported all 5501 rows including numeric, bytea, NULL and multiline values"
    );
    verify_formula_protection(&db, &options).await;
    fixture.drop_database(db, &source).await;
}

#[tokio::test]
async fn postgres_large_dump_streams_and_cancels() {
    let Some(fixture) = Fixture::configured() else {
        return;
    };
    let Ok(rows) = env::var("NODAL_EXPORT_TEST_LARGE_ROWS") else {
        return;
    };
    let rows: i32 = rows.parse().unwrap();
    assert!((20_000..=200_000).contains(&rows));
    let (source, db) = fixture.create_database().await;
    sqlx::query("CREATE TABLE bulk (id bigint PRIMARY KEY, payload text)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO bulk SELECT i, repeat(md5(i::text), 2048) FROM generate_series(1, $1) i",
    )
    .bind(rows)
    .execute(&db)
    .await
    .unwrap();
    let client = fixture.client(&source).await;
    let folder = tempfile::tempdir().unwrap();
    let destination = Destination {
        path: folder.path().join("bulk.sql"),
    };
    for quit in [false, true] {
        interrupt_large_dump(&fixture, &client, &destination, quit).await;
    }
    let temp = destination.create_temp().unwrap();
    let mut command = client
        .command(
            &fixture.dump,
            DumpTarget::Schema("public"),
            DumpMode::StructureAndData,
        )
        .unwrap();
    let started = Instant::now();
    postgres_export::write_dump(&mut command, &temp, &CancellationToken::new(), &mut |_| {})
        .await
        .unwrap();
    drop(command);
    let receipt = destination
        .commit(temp, CancellationToken::new())
        .await
        .unwrap();
    assert!(receipt.bytes > u64::try_from(rows).unwrap() * 65_536);
    let secs = started.elapsed().as_secs_f64();
    eprintln!(
        "large dump: {} bytes in {secs:.2}s including final fsync",
        receipt.bytes
    );
    fixture.drop_database(db, &source).await;
}

fn direct_profile(database: &str, port: u16) -> DataSourceProfile {
    DataSourceProfile {
        connection_sync: None,
        id: Uuid::new_v4(),
        display_name: database.to_owned(),
        host: "127.0.0.1".into(),
        port,
        database: database.to_owned(),
        username: USER.into(),
        database_type: DatabaseType::PostgreSql,
        ssl_mode: SslMode::Disable,
        security: ConnectionSecurity::default(),
        sqlite: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    }
}

#[tokio::test]
async fn ssh_dump_is_rejected_before_starting_the_native_client() {
    let mut profile = direct_profile("isolated", 5432);
    profile.ssl_mode = SslMode::VerifyFull;
    profile.security.ssh = Some(schema_model::SshConfig {
        host: "127.0.0.1".into(),
        port: 22,
        username: "fixture".into(),
        authentication: schema_model::SshAuthentication::Agent,
        private_key: None,
        known_hosts: None,
    });
    assert_eq!(
        postgres_export::DumpClient::require_direct(&profile),
        Err(ExportError::SshDumpUnsupported)
    );
    assert!(matches!(
        postgres_export::DumpClient::new(&profile, PASSWORD, 10).await,
        Err(ExportError::SshDumpUnsupported)
    ));
}

#[tokio::test]
async fn export_preserves_existing_and_concurrently_created_destinations() {
    use std::io::Write;

    let folder = tempfile::tempdir().unwrap();
    let destination = Destination {
        path: folder.path().join("backup.sql"),
    };
    std::fs::write(&destination.path, b"existing backup").unwrap();
    assert!(matches!(
        destination.create_temp(),
        Err(ExportError::DestinationExists)
    ));
    assert_eq!(
        std::fs::read(&destination.path).unwrap(),
        b"existing backup"
    );

    let destination = Destination {
        path: folder.path().join("next.sql"),
    };
    let mut temp = destination.create_temp().unwrap();
    temp.write_all(b"export in progress").unwrap();
    let part = temp.path().to_owned();
    let path = destination.path.clone();
    std::fs::write(&path, b"concurrent backup").unwrap();
    assert!(matches!(
        destination.commit(temp, CancellationToken::new()).await,
        Err(ExportError::DestinationExists)
    ));
    assert_eq!(std::fs::read(path).unwrap(), b"concurrent backup");
    assert!(!part.exists());
}

async fn verify_formula_protection(db: &PgPool, options: &PostgresConnectionOptions) {
    sqlx::raw_sql(r#"CREATE TABLE public.formulas ("=heading" text, n numeric, b boolean);
        INSERT INTO public.formulas VALUES (' =1+1', -12.50, true), (E'\ttext', 7, false), (NULL, NULL, NULL)"#)
        .execute(db).await.unwrap();
    let key = ObjectKey::table("public", "formulas");
    let columns = ["=heading".to_owned(), "n".to_owned(), "b".to_owned()];
    for protect in [true, false] {
        let temp = tempfile::NamedTempFile::new().unwrap();
        postgres_export::write_table(
            options,
            &temp,
            &key,
            &columns,
            Format::Csv,
            protect,
            &mut |_| {},
        )
        .await
        .unwrap();
        let csv = std::fs::read_to_string(temp.path()).unwrap();
        if protect {
            assert!(csv.starts_with("\"'=heading\",\"n\",\"b\"\n"));
            assert!(csv.contains("' =1+1,-12.50,t\n"));
            assert!(csv.contains("'\ttext,7,f\n"));
        } else {
            assert!(csv.starts_with("=heading,n,b\n"));
            assert!(csv.contains(" =1+1,-12.50,t\n"));
            assert!(csv.contains("\ttext,7,f\n"));
        }
        assert!(csv.ends_with(",,\n"));
    }
}

async fn interrupt_large_dump(
    fixture: &Fixture,
    client: &postgres_export::DumpClient,
    destination: &Destination,
    quit: bool,
) {
    let jobs = Jobs::default();
    let id = Uuid::new_v4();
    let source_id = Uuid::new_v4();
    let job = jobs.start(id, source_id).unwrap();
    let temp = destination.create_temp().unwrap();
    let part = temp.path().to_path_buf();
    let (signal, progress) = tokio::sync::oneshot::channel();
    let stop = async {
        let bytes = progress.await.expect("dump must write before interruption");
        if quit {
            assert_eq!(jobs.request_exit(), ExitAction::Wait);
            assert_eq!(jobs.request_exit(), ExitAction::AlreadyWaiting);
            assert!(matches!(
                jobs.start(Uuid::new_v4(), source_id),
                Err(ExportError::Busy)
            ));
            jobs.wait_for_idle().await;
            assert_eq!(jobs.request_exit(), ExitAction::Allow);
            assert!(!part.exists());
        } else {
            assert!(jobs.cancel(id));
        }
        eprintln!(
            "{} interrupted the large dump after {bytes} bytes",
            if quit { "app exit" } else { "cancel" }
        );
    };
    let dump = async {
        let mut signal = Some(signal);
        let mut command = client
            .command(
                &fixture.dump,
                DumpTarget::Schema("public"),
                DumpMode::StructureAndData,
            )
            .unwrap();
        let result = postgres_export::write_dump(&mut command, &temp, &job.token, &mut |bytes| {
            if bytes >= 16 * 1024 * 1024
                && let Some(signal) = signal.take()
            {
                let _ = signal.send(bytes);
            }
        })
        .await;
        drop(command);
        drop(temp);
        drop(job);
        assert_eq!(result, Err(ExportError::Cancelled));
    };
    tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(dump, stop);
    })
    .await
    .unwrap();
    assert!(!part.exists());
    assert!(!destination.path.exists());
    assert!(!jobs.has_active_jobs());
}
