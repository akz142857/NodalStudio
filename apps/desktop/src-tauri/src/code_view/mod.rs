mod analysis;
mod definition;
#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
pub(crate) mod eslint;
#[allow(
    dead_code,
    reason = "Also contains file operations for the retired SQL prototype"
)]
mod files;
mod language_server;
#[allow(
    dead_code,
    reason = "Keep the uncommitted prototype and existing Query draft validation without exposing its operations"
)]
mod legacy_sql;
pub(crate) mod review;
pub(crate) mod search;

pub(crate) use legacy_sql::{QueryHandoff, validate_query_handoff};
