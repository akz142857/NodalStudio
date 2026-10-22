//! Public release discovery only. GitHub metadata never authorizes native installation.
use serde::Deserialize;
use std::time::Duration;

pub const RELEASES_PAGE: &str = "https://github.com/akz142857/NodalStudio/releases";
pub const UPDATE_FEED: &str =
    "https://github.com/akz142857/NodalStudio/releases/latest/download/latest.json";
const API: &str = "https://api.github.com/repos/akz142857/NodalStudio/releases";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    body: Option<String>,
}

pub struct AvailableRelease {
    pub version: String,
    pub notes: Option<String>,
}

pub fn endpoint(channel: &str) -> String {
    if channel == "beta" {
        format!("{API}?per_page=100")
    } else {
        format!("{API}/latest")
    }
}

fn select_release(
    releases: Vec<Release>,
    current: &semver::Version,
    beta: bool,
) -> Result<Option<AvailableRelease>, String> {
    let newest = releases
        .into_iter()
        .filter(|release| !release.draft && (beta || !release.prerelease))
        .filter_map(|release| {
            let version = semver::Version::parse(
                release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name),
            )
            .ok()?;
            (beta || version.pre.is_empty()).then_some((version, release))
        })
        .max_by(|(a, _), (b, _)| a.cmp_precedence(b))
        .ok_or("GitHub has no versioned releases for this channel.")?;
    Ok(newest
        .0
        .cmp_precedence(current)
        .is_gt()
        .then(|| AvailableRelease {
            version: newest.0.to_string(),
            notes: newest.1.body,
        }))
}

pub async fn check(
    channel: &str,
    current: &semver::Version,
) -> Result<Option<AvailableRelease>, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("NodalStudio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Unable to initialize the GitHub update check.")?;
    let mut response = client
        .get(endpoint(channel))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "Unable to reach GitHub Releases. Check your network and retry.")?;
    match response.status().as_u16() {
        200 => (),
        403 | 429 => {
            return Err("GitHub is limiting update requests. Please try again later.".into());
        }
        404 => return Err("No published GitHub release is available for this channel.".into()),
        _ => {
            return Err(
                "GitHub could not provide release information. Please try again later.".into(),
            );
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Unable to read GitHub release information.")?
    {
        if bytes.len() + chunk.len() > 5 * 1024 * 1024 {
            return Err("GitHub release information exceeds the supported size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let beta = channel == "beta";
    let releases = if beta {
        serde_json::from_slice::<Vec<Release>>(&bytes)
    } else {
        serde_json::from_slice::<Release>(&bytes).map(|release| vec![release])
    }
    .map_err(|_| "GitHub returned invalid release information.")?;
    select_release(releases, current, beta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool, draft: bool) -> Release {
        Release {
            tag_name: tag.into(),
            prerelease,
            draft,
            body: Some("Release notes".into()),
        }
    }

    #[test]
    fn stable_excludes_drafts_and_both_kinds_of_prereleases() {
        let releases = vec![
            release("v0.2.0", false, false),
            release("v0.3.0", true, false),
            release("v0.4.0-beta.1", false, false),
            release("v1.0.0", false, true),
        ];
        assert_eq!(
            select_release(releases, &"0.1.0".parse().unwrap(), false)
                .unwrap()
                .unwrap()
                .version,
            "0.2.0"
        );
    }

    #[test]
    fn beta_uses_semver_order_not_api_order_and_never_downgrades() {
        let releases = vec![
            release("v0.2.0-beta.2", true, false),
            release("v0.2.0-beta.10", true, false),
        ];
        assert_eq!(
            select_release(releases, &"0.1.0".parse().unwrap(), true)
                .unwrap()
                .unwrap()
                .version,
            "0.2.0-beta.10"
        );
        for version in ["0.1.0", "0.1.0+rebuild", "0.0.9"] {
            assert!(
                select_release(
                    vec![release(version, false, false)],
                    &"0.1.0".parse().unwrap(),
                    false
                )
                .unwrap()
                .is_none()
            );
        }
        assert!(
            select_release(
                vec![release("nightly", false, false)],
                &"0.1.0".parse().unwrap(),
                false
            )
            .is_err()
        );
    }
}
