use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Mirrors `Extension` in `packages/contracts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extension {
    pub name: String,
    pub description: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub ref_: String,
    pub platforms: Vec<String>,
    pub descriptor_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub descriptor_path: Option<String>,
}

/// Mirrors `BinaryState` in `packages/contracts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BinaryState {
    Current,
    Stale,
    Missing,
    Error,
}

/// Mirrors `BinaryStatus` in `packages/contracts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub status: BinaryState,
    pub checked_descriptor_ref: String,
    pub checked_descriptor_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duckdb_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Mirrors `CatalogResponse` in `packages/contracts`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub duckdb_version: String,
    pub extensions: Vec<Extension>,
}

#[derive(Clone)]
pub struct Client {
    agent: ureq::Agent,
    base: String,
}

impl Client {
    pub fn new(base: &str) -> Result<Self> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .build();
        Ok(Self {
            agent: config.into(),
            base: base.trim_end_matches('/').to_string(),
        })
    }

    pub fn catalog(&self, version: Option<&str>) -> Result<CatalogResponse> {
        let mut url = format!("{}/api/catalog", self.base);
        if let Some(version) = version {
            url.push_str(&format!("?duckdb={version}"));
        }
        self.agent
            .get(&url)
            .call()
            .map_err(|err| api_error(&self.base, err))?
            .body_mut()
            .read_json()
            .context("decoding catalog response")
    }

    pub fn check(
        &self,
        extension: &str,
        platform: &str,
        version: Option<&str>,
    ) -> Result<BinaryStatus> {
        let mut url = format!(
            "{}/api/check?extension={extension}&platform={platform}",
            self.base
        );
        if let Some(version) = version {
            url.push_str(&format!("&duckdb={version}"));
        }
        self.agent
            .get(&url)
            .call()
            .map_err(|err| api_error(&self.base, err))?
            .body_mut()
            .read_json()
            .context("decoding check response")
    }
}

fn api_error(base: &str, err: ureq::Error) -> anyhow::Error {
    match err {
        ureq::Error::StatusCode(code) => anyhow::anyhow!("API at {base} returned HTTP {code}"),
        other => anyhow::anyhow!("request to API at {base} failed: {other}"),
    }
}

/// Repository holding every extension descriptor.
pub const COMMUNITY_EXTENSIONS_REPO: &str = "duckdb/community-extensions";

impl Extension {
    /// Exact descriptor path from the catalog, or the conventional location
    /// for caches that predate the field.
    pub fn descriptor_path_resolved(&self) -> String {
        self.descriptor_path
            .clone()
            .unwrap_or_else(|| format!("extensions/{}/description.yml", self.name))
    }
}

/// Most recent commit touching a descriptor file on GitHub.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub url: String,
    pub message: String,
    pub date: String,
}

#[derive(Debug, Deserialize)]
struct GhCommit {
    sha: String,
    html_url: String,
    commit: GhCommitDetail,
}

#[derive(Debug, Deserialize)]
struct GhCommitDetail {
    message: String,
    committer: Option<GhUser>,
    author: Option<GhUser>,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    date: Option<String>,
}

impl Client {
    /// Best-effort lookup of the most recent commit touching `path`.
    /// Callers degrade to "unavailable" on any failure (rate limit, offline).
    pub fn descriptor_commit(&self, path: &str) -> Result<CommitInfo> {
        let entries: Vec<GhCommit> = self
            .agent
            .get(&format!(
                "https://api.github.com/repos/{COMMUNITY_EXTENSIONS_REPO}/commits?path={path}&per_page=1"
            ))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "ce-map-cli")
            .call()
            .map_err(|err| api_error("https://api.github.com", err))?
            .body_mut()
            .read_json()
            .context("decoding commit response")?;
        let entry = entries.into_iter().next().context("no commits found")?;
        let message = entry
            .commit
            .message
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        let date = entry
            .commit
            .committer
            .and_then(|user| user.date)
            .or_else(|| entry.commit.author.and_then(|user| user.date))
            .unwrap_or_else(|| "unknown date".to_string());
        Ok(CommitInfo {
            sha: entry.sha,
            url: entry.html_url,
            message,
            date,
        })
    }
}
