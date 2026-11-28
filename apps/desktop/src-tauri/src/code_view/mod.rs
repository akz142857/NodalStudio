mod analysis;
mod definition;
#[cfg(all(target_os = "macos", not(feature = "mac-app-store")))]
pub(crate) mod eslint;
#[cfg(all(
    target_os = "macos",
    any(feature = "code-extensions", feature = "code-syntax-only")
))]
pub(crate) mod extensions;
#[allow(
    dead_code,
    reason = "Also contains file operations for the retired SQL prototype"
)]
mod files;
#[cfg(target_os = "macos")]
mod finder;
mod language_server;
#[allow(
    dead_code,
    reason = "Keep the uncommitted prototype and existing Query draft validation without exposing its operations"
)]
mod legacy_sql;
mod projects;
#[cfg(all(
    target_os = "macos",
    feature = "code-extensions",
    not(feature = "mac-app-store")
))]
pub(crate) mod python_debug;
pub(crate) mod review;
mod review_index;
pub(crate) mod search;

pub(crate) use legacy_sql::{QueryHandoff, validate_query_handoff};
