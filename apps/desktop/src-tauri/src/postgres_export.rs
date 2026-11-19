use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::TryStreamExt;
use postgres_adapter::{PostgresConnectionOptions, connect};
use schema_model::{DataSourceProfile, ObjectKey, SslMode};
use sqlx::{AssertSqlSafe, PgConnection};
use tempfile::{NamedTempFile, TempDir};
use tokio::{
    fs::File,
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufWriter},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use crate::database_export::{DumpMode, ExportError, Format};

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn table_name(table: &ObjectKey) -> String {
    format!("{}.{}", quote(&table.schema), quote(&table.name))
}

fn read_error(error: sqlx::Error) -> ExportError {
    let sqlx::Error::Database(error) = error else {
        return ExportError::ReadFailed;
    };
    match error.code().as_deref() {
        Some("42501") => ExportError::Permission,
        Some("42P01" | "3F000") => ExportError::TableUnavailable,
        Some("42703") => ExportError::ColumnsUnavailable,
        Some("55P03") => ExportError::LockTimeout,
        _ => ExportError::ReadFailed,
    }
}

async fn open(options: &PostgresConnectionOptions) -> Result<PgConnection, ExportError> {
    let pool = connect(options)
        .await
        .map_err(|_| ExportError::Connection)?;
    let connection = pool
        .acquire()
        .await
        .map_err(|_| ExportError::Connection)?
        .detach();
    Ok(connection)
}

async fn relation_kind(
    connection: &mut PgConnection,
    table: &ObjectKey,
) -> Result<String, ExportError> {
    sqlx::query_scalar("SELECT c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')")
        .bind(&table.schema).bind(&table.name).fetch_optional(connection).await
        .map_err(read_error)?.ok_or(ExportError::TableUnavailable)
}

pub async fn is_partitioned(
    options: &PostgresConnectionOptions,
    table: &ObjectKey,
) -> Result<bool, ExportError> {
    Ok(relation_kind(&mut open(options).await?, table).await? == "p")
}

async fn export_columns(
    connection: &mut PgConnection,
    table: &ObjectKey,
    columns: &[String],
) -> Result<HashMap<String, bool>, ExportError> {
    let matched: HashMap<_, _> = sqlx::query_as::<_, (String, bool)>(
        "WITH RECURSIVE column_types(name, type_id) AS (
            SELECT a.attname::text, a.atttypid
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0
                AND NOT a.attisdropped AND a.attname::text = ANY($3)
            UNION ALL
            SELECT col.name, t.typbasetype FROM column_types col
            JOIN pg_catalog.pg_type t ON t.oid = col.type_id WHERE t.typtype = 'd'
        )
        SELECT col.name, t.typnamespace = 'pg_catalog'::regnamespace AND t.typcategory IN ('N', 'B')
        FROM column_types col JOIN pg_catalog.pg_type t ON t.oid = col.type_id WHERE t.typtype <> 'd'",
    ).bind(&table.schema).bind(&table.name).bind(columns).fetch_all(connection).await.map_err(read_error)?
        .into_iter().collect();
    if matched.len() != columns.len() {
        return Err(ExportError::ColumnsUnavailable);
    }
    Ok(matched)
}

pub async fn write_table(
    options: &PostgresConnectionOptions,
    temp: &NamedTempFile,
    table: &ObjectKey,
    columns: &[String],
    format: Format,
    protect_formulas: bool,
    progress: &mut impl FnMut(u64),
) -> Result<(), ExportError> {
    let mut connection = open(options).await?;
    sqlx::raw_sql("BEGIN READ ONLY; SET LOCAL search_path = pg_catalog; SET LOCAL lock_timeout = '10s'; SET LOCAL client_encoding = 'UTF8'; SET LOCAL datestyle = 'ISO'; SET LOCAL bytea_output = 'hex'; SET LOCAL timezone = 'UTC';")
        .execute(&mut connection).await.map_err(read_error)?;
    relation_kind(&mut connection, table).await?;
    let matched = export_columns(&mut connection, table, columns).await?;
    let protect_csv = protect_formulas && matches!(format, Format::Csv);
    let select = format!(
        "SELECT {} FROM {}",
        columns
            .iter()
            .map(|name| {
                let identifier = quote(name);
                if protect_csv && !matched[name] {
                    // COPY still handles escaping and NULLs. Preserve numeric and boolean columns.
                    // format('%s', ...) uses the type's output function, like COPY.
                    let output = format!("pg_catalog.format('%s', {identifier})");
                    format!(r"CASE WHEN {identifier} IS NOT DISTINCT FROM NULL THEN NULL WHEN {output} ~ E'^[[:space:]]*[=+@-]|^[\t\r\n]' THEN pg_catalog.chr(39) || {output} ELSE {output} END")
                } else {
                    identifier
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        table_name(table)
    );
    let mut file = BufWriter::with_capacity(
        256 * 1024,
        File::from_std(temp.reopen().map_err(|_| ExportError::WriteFailed)?),
    );
    let mut bytes = 0;
    match format {
        Format::Csv => {
            if protect_csv {
                let mut header = columns
                    .iter()
                    .map(|column| crate::query_export::csv_field(column, true))
                    .collect::<Vec<_>>()
                    .join(",");
                header.push('\n');
                file.write_all(header.as_bytes())
                    .await
                    .map_err(|_| ExportError::WriteFailed)?;
                bytes += header.len() as u64;
            }
            let header = if protect_csv { "FALSE" } else { "TRUE" };
            let sql = format!(
                "COPY ({select}) TO STDOUT WITH (FORMAT CSV, HEADER {header}, ENCODING 'UTF8')"
            );
            let mut stream = connection.copy_out_raw(&sql).await.map_err(read_error)?;
            while let Some(chunk) = stream.try_next().await.map_err(read_error)? {
                file.write_all(&chunk)
                    .await
                    .map_err(|_| ExportError::WriteFailed)?;
                bytes += chunk.len() as u64;
                progress(bytes);
            }
        }
        Format::Json => {
            let sql = format!(
                "SELECT pg_catalog.row_to_json(export_row)::text FROM ({select}) AS export_row"
            );
            // The dynamic fragments are fully quoted PostgreSQL identifiers.
            let mut stream =
                sqlx::query_scalar::<_, String>(AssertSqlSafe(sql.as_str())).fetch(&mut connection);
            file.write_all(b"[\n")
                .await
                .map_err(|_| ExportError::WriteFailed)?;
            bytes += 2;
            while let Some(row) = stream.try_next().await.map_err(read_error)? {
                if bytes > 2 {
                    file.write_all(b",\n")
                        .await
                        .map_err(|_| ExportError::WriteFailed)?;
                    bytes += 2;
                }
                file.write_all(row.as_bytes())
                    .await
                    .map_err(|_| ExportError::WriteFailed)?;
                bytes += row.len() as u64;
                progress(bytes);
            }
            file.write_all(b"\n]\n")
                .await
                .map_err(|_| ExportError::WriteFailed)?;
        }
    }
    file.flush().await.map_err(|_| ExportError::WriteFailed)
}

pub fn find_pg_dump() -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        "pg_dump.exe"
    } else {
        "pg_dump"
    };
    let from_path = std::env::var_os("PATH").into_iter().flat_map(|path| {
        std::env::split_paths(&path)
            .filter(|directory| directory.is_absolute())
            .collect::<Vec<_>>()
    });
    let common = [
        "/opt/homebrew/opt/libpq/bin",
        "/usr/local/opt/libpq/bin",
        "/Applications/Postgres.app/Contents/Versions/latest/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ];
    from_path
        .chain(common.into_iter().map(PathBuf::from))
        .map(|dir| dir.join(executable))
        .chain(installed_postgres_clients(executable))
        .find(|path| path.is_file())
}

fn installed_postgres_clients(executable: &str) -> impl Iterator<Item = PathBuf> + use<> {
    let installs = if cfg!(windows) {
        std::env::var_os("ProgramFiles")
            .map(|path| (PathBuf::from(path).join("PostgreSQL"), ""))
            .into_iter()
            .collect()
    } else if cfg!(target_os = "macos") {
        vec![
            (PathBuf::from("/Library/PostgreSQL"), ""),
            (PathBuf::from("/opt/homebrew/opt"), "postgresql@"),
            (PathBuf::from("/usr/local/opt"), "postgresql@"),
        ]
    } else {
        vec![(PathBuf::from("/usr/lib/postgresql"), "")]
    };
    let mut versions = installs
        .into_iter()
        .flat_map(|(directory, prefix)| {
            directory
                .read_dir()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(move |entry| {
                    let major = entry
                        .file_name()
                        .to_str()?
                        .strip_prefix(prefix)?
                        .parse::<u32>()
                        .ok()?;
                    Some((major, entry.path().join("bin").join(executable)))
                })
        })
        .collect::<Vec<_>>();
    versions.sort_unstable_by_key(|(major, _)| std::cmp::Reverse(*major));
    versions.into_iter().map(|(_, path)| path)
}

pub struct DumpClient {
    env: Vec<(&'static str, OsString)>,
    _private: TempDir,
    #[cfg(unix)]
    password_line: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DumpTarget<'a> {
    Database,
    Schema(&'a str),
    Table {
        table: &'a ObjectKey,
        partitioned: bool,
    },
}

impl DumpClient {
    pub fn require_direct(profile: &DataSourceProfile) -> Result<(), ExportError> {
        if profile.security.ssh.is_some() {
            return Err(ExportError::SshDumpUnsupported);
        }
        Ok(())
    }

    pub async fn new(
        profile: &DataSourceProfile,
        password: &str,
        timeout: u16,
    ) -> Result<Self, ExportError> {
        Self::require_direct(profile)?;
        if profile.host.is_empty()
            || !profile
                .host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_:%".contains(c))
            || password.contains(['\r', '\n', '\0'])
        {
            return Err(ExportError::Connection);
        }
        let private = tempfile::tempdir().map_err(|_| ExportError::WriteFailed)?;
        let password_line = format!(
            "*:*:*:*:{}\n",
            password.replace('\\', "\\\\").replace(':', "\\:")
        );
        let mut env = vec![
            ("PGHOST", profile.host.clone().into()),
            ("PGPORT", profile.port.to_string().into()),
            ("PGDATABASE", profile.database.clone().into()),
            ("PGUSER", profile.username.clone().into()),
            ("PGCONNECT_TIMEOUT", timeout.to_string().into()),
            ("PGOPTIONS", "-c default_transaction_read_only=on".into()),
            ("PGAPPNAME", "Nodal Studio SQL Dump".into()),
            ("PGGSSENCMODE", "disable".into()),
            ("LC_ALL", "C".into()),
        ];
        #[cfg(unix)]
        env.push(("PGPASSFILE", "/dev/fd/0".into()));
        #[cfg(not(unix))]
        {
            let passfile = private.path().join("pgpass");
            tokio::fs::write(&passfile, &password_line)
                .await
                .map_err(|_| ExportError::WriteFailed)?;
            env.push(("PGPASSFILE", passfile.into_os_string()));
        }
        env.push((
            "PGSSLMODE",
            match profile.ssl_mode {
                SslMode::Disable => "disable",
                SslMode::Prefer => "prefer",
                SslMode::Require => "require",
                SslMode::VerifyCa => "verify-ca",
                SslMode::VerifyFull => "verify-full",
            }
            .into(),
        ));
        let tls = &profile.security.tls;
        let root = match &tls.ca_certificate {
            Some(path) => PathBuf::from(path),
            None if matches!(profile.ssl_mode, SslMode::VerifyCa | SslMode::VerifyFull) => {
                native_roots(private.path().join("roots.pem")).await?
            }
            None => private.path().join("no-root.pem"),
        };
        env.push(("PGSSLROOTCERT", root.into_os_string()));
        for (key, path) in [
            ("PGSSLCERT", &tls.client_certificate),
            ("PGSSLKEY", &tls.client_key),
        ] {
            env.push((
                key,
                path.as_ref().map_or_else(
                    || private.path().join("no-client.pem").into_os_string(),
                    OsString::from,
                ),
            ));
        }
        Ok(Self {
            env,
            _private: private,
            #[cfg(unix)]
            password_line,
        })
    }

    pub fn command(
        &self,
        executable: &Path,
        target: DumpTarget<'_>,
        mode: DumpMode,
    ) -> Result<Command, ExportError> {
        let mut command = Command::new(executable);
        command
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .args([
                "--no-password",
                "--format=plain",
                "--encoding=UTF8",
                "--lock-wait-timeout=10000",
            ]);
        #[cfg(unix)]
        {
            use std::io::{Seek, Write};
            // libpq requires a private regular file. An anonymous file on stdin
            // keeps the password out of process arguments, environment and named files.
            let mut file = tempfile::tempfile().map_err(|_| ExportError::WriteFailed)?;
            file.write_all(self.password_line.as_bytes())
                .and_then(|()| file.rewind())
                .map_err(|_| ExportError::WriteFailed)?;
            command.stdin(Stdio::from(file));
        }
        #[cfg(not(unix))]
        command.stdin(Stdio::null());
        #[cfg(windows)]
        {
            if let Some(root) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", root);
            }
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match target {
            DumpTarget::Database => {}
            DumpTarget::Schema(schema) => {
                command
                    .args(["--strict-names", "--schema"])
                    .arg(quote(schema));
            }
            DumpTarget::Table { table, partitioned } => {
                let option = if partitioned {
                    "--table-and-children"
                } else {
                    "--table"
                };
                command
                    .args(["--strict-names", option])
                    .arg(table_name(table));
            }
        }
        if matches!(mode, DumpMode::StructureOnly) {
            command.arg("--schema-only");
        }
        Ok(command)
    }
}

async fn native_roots(path: PathBuf) -> Result<PathBuf, ExportError> {
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let roots = rustls_native_certs::load_native_certs().certs;
        if roots.is_empty() {
            return Err(ExportError::Tls);
        }
        let mut file = std::fs::File::create(&path).map_err(|_| ExportError::WriteFailed)?;
        for root in roots {
            writeln!(file, "-----BEGIN CERTIFICATE-----").map_err(|_| ExportError::WriteFailed)?;
            for line in STANDARD.encode(root).as_bytes().chunks(64) {
                file.write_all(line)
                    .and_then(|()| file.write_all(b"\n"))
                    .map_err(|_| ExportError::WriteFailed)?;
            }
            writeln!(file, "-----END CERTIFICATE-----").map_err(|_| ExportError::WriteFailed)?;
        }
        Ok(path)
    })
    .await
    .map_err(|_| ExportError::Tls)?
}

pub async fn write_dump(
    command: &mut Command,
    temp: &NamedTempFile,
    token: &CancellationToken,
    progress: &mut impl FnMut(u64),
) -> Result<(), ExportError> {
    if token.is_cancelled() {
        return Err(ExportError::Cancelled);
    }
    let output = temp.reopen().map_err(|_| ExportError::WriteFailed)?;
    let mut child = command
        .stdout(Stdio::from(output))
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ExportError::PgDumpMissing)?;
    let stderr = child.stderr.take().ok_or(ExportError::ReadFailed)?;
    let drain = tokio::spawn(read_diagnostic(stderr));
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let status = loop {
        tokio::select! {
            biased;
            () = token.cancelled() => {
                let _ = child.kill().await;
                drain.abort();
                return Err(ExportError::Cancelled);
            }
            status = child.wait() => break status,
            _ = ticker.tick() => {
                if let Ok(metadata) = tokio::fs::metadata(temp.path()).await { progress(metadata.len()); }
            }
        }
    };
    let detail = drain.await.unwrap_or_default();
    if status.is_ok_and(|status| status.success()) {
        Ok(())
    } else {
        Err(dump_error(&detail))
    }
}

async fn read_diagnostic(mut input: impl AsyncRead + Unpin) -> String {
    let mut first = Vec::new();
    let mut buffer = [0; 4096];
    while let Ok(length @ 1..) = input.read(&mut buffer).await {
        first.extend_from_slice(&buffer[..length.min(16_384 - first.len())]);
    }
    String::from_utf8_lossy(&first).to_ascii_lowercase()
}

fn dump_error(detail: &str) -> ExportError {
    if detail.contains("server version mismatch") || detail.contains("unrecognized option") {
        ExportError::PgDumpVersion
    } else if detail.contains("lock timeout") {
        ExportError::LockTimeout
    } else if detail.contains("permission denied") || detail.contains("row-level security") {
        ExportError::Permission
    } else if detail.contains("no matching tables") {
        ExportError::TableUnavailable
    } else if detail.contains("no matching schemas") {
        ExportError::SchemaUnavailable
    } else if detail.contains("certificate") || detail.contains("ssl error") {
        ExportError::Tls
    } else if detail.contains("connection to server") || detail.contains("could not connect") {
        ExportError::Connection
    } else if detail.contains("no space left")
        || detail.contains("could not write")
        || detail.contains("disk full")
    {
        ExportError::WriteFailed
    } else {
        ExportError::ReadFailed
    }
}
