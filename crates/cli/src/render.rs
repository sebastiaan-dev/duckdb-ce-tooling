use std::fmt::{self, Display};

use owo_colors::{OwoColorize, Stream};
use serde::Serialize;

use crate::api::{
    BinaryState, BinaryStatus, CatalogResponse, CommitInfo, Extension, COMMUNITY_EXTENSIONS_REPO,
};

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct Summary {
    pub current: usize,
    pub stale: usize,
    pub missing: usize,
    pub error: usize,
}

pub fn summarize(results: &[(String, BinaryStatus)]) -> Summary {
    let mut summary = Summary::default();
    for (_, status) in results {
        match status.status {
            BinaryState::Current => summary.current += 1,
            BinaryState::Stale => summary.stale += 1,
            BinaryState::Missing => summary.missing += 1,
            BinaryState::Error => summary.error += 1,
        }
    }
    summary
}

pub fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn state_label(state: BinaryState) -> &'static str {
    match state {
        BinaryState::Current => "current",
        BinaryState::Stale => "stale",
        BinaryState::Missing => "missing",
        BinaryState::Error => "error",
    }
}

fn paint(text: &str, state: BinaryState) -> String {
    text.to_string()
        .if_supports_color(Stream::Stdout, |styled| match state {
            BinaryState::Current => styled.green().to_string(),
            BinaryState::Stale => styled.yellow().to_string(),
            BinaryState::Missing => styled.red().to_string(),
            BinaryState::Error => styled.red().bold().to_string(),
        })
        .to_string()
}

fn dim(text: &str) -> String {
    text.if_supports_color(Stream::Stdout, |styled| styled.dimmed().to_string())
        .to_string()
}

fn bold(text: &str) -> String {
    text.if_supports_color(Stream::Stdout, |styled| styled.bold().to_string())
        .to_string()
}

struct Hyperlink<'a>(&'a str);

impl Display for Hyperlink<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "\x1b]8;;{url}\x1b\\\x1b[4;34m{url}\x1b[0m\x1b]8;;\x1b\\",
            url = self.0
        )
    }
}

/// Plain URL when piped, clickable OSC-8 hyperlink on a capable terminal.
fn link(url: &str) -> String {
    url.to_string()
        .if_supports_color(Stream::Stdout, |owned| {
            Hyperlink(owned.as_str()).to_string()
        })
        .to_string()
}

fn descriptor_url(ext: &Extension) -> String {
    format!(
        "https://github.com/{COMMUNITY_EXTENSIONS_REPO}/blob/main/{}",
        ext.descriptor_path_resolved()
    )
}

/// Mirrors the API's binaryUrl for stale caches that predate the field.
fn fallback_binary_url(duckdb: &str, platform: &str, name: &str) -> String {
    let suffix = if platform.starts_with("wasm") {
        "wasm"
    } else {
        "gz"
    };
    format!("https://community-extensions.duckdb.org/{duckdb}/{platform}/{name}.duckdb_extension.{suffix}")
}

fn colored_summary(summary: &Summary, total: usize) -> String {
    let parts = [
        (summary.current, "current", BinaryState::Current),
        (summary.stale, "stale", BinaryState::Stale),
        (summary.missing, "missing", BinaryState::Missing),
        (summary.error, "error", BinaryState::Error),
    ]
    .into_iter()
    .map(|(count, label, state)| paint(&format!("{count} {label}"), state))
    .collect::<Vec<_>>()
    .join(", ");
    format!("{parts} ({total} total)")
}

pub fn status_human(
    ext: &Extension,
    duckdb: &str,
    results: &[(String, BinaryStatus)],
    commit: Option<&CommitInfo>,
) -> String {
    let commit_line = match commit {
        Some(info) => format!(
            "{} {} · {} {}",
            &info.sha[..info.sha.len().min(7)],
            info.message,
            info.date,
            link(&info.url)
        ),
        None => dim("unavailable"),
    };
    let mut out = format!(
        "{}\n  {} {} @ {}\n  {} {duckdb}\n  {} {}\n  {} {}\n  {} {}\n\n",
        bold(&ext.name),
        dim("repo:"),
        ext.repo,
        ext.ref_,
        dim("duckdb:"),
        dim("descriptor:"),
        link(&descriptor_url(ext)),
        dim("last commit:"),
        commit_line,
        dim("platforms:"),
        colored_summary(&summarize(results), results.len()),
    );
    for (index, (platform, status)) in results.iter().enumerate() {
        let last = index + 1 == results.len();
        let (branch, gutter) = if last {
            ("└─", "     ")
        } else {
            ("├─", "  │  ")
        };
        out.push_str(&format!(
            "  {branch} {platform} — {}\n",
            paint(state_label(status.status), status.status)
        ));
        if let Some(built) = &status.built_ref {
            out.push_str(&format!("{gutter}built:    {built}\n"));
        }
        if let Some(size) = status.size {
            out.push_str(&format!("{gutter}size:     {}\n", format_size(size)));
        }
        let binary_url = status
            .binary_url
            .clone()
            .unwrap_or_else(|| fallback_binary_url(duckdb, platform, &ext.name));
        out.push_str(&format!("{gutter}binary:   {}\n", link(&binary_url)));
        if let Some(detail) = &status.detail {
            out.push_str(&format!("{gutter}note:     {detail}\n"));
        }
        out.push_str(&format!("{gutter}checked:  {}\n", status.checked_at));
    }
    out
}

pub fn catalog_human(catalog: &CatalogResponse) -> String {
    let mut out = String::new();
    let width = catalog
        .extensions
        .iter()
        .map(|ext| ext.name.len())
        .max()
        .unwrap_or(0);
    for ext in &catalog.extensions {
        // Pad before styling: ANSI codes would otherwise break the column.
        out.push_str(&format!(
            "{}  {}\n",
            bold(&format!("{:<width$}", ext.name)),
            dim(&ext.description)
        ));
    }
    out.push_str(&format!(
        "\n{} extension{} · DuckDB {}\n",
        catalog.extensions.len(),
        if catalog.extensions.len() == 1 {
            ""
        } else {
            "s"
        },
        catalog.duckdb_version,
    ));
    out
}

fn worst_state(results: &[(String, BinaryStatus)]) -> BinaryState {
    let rank = |state: BinaryState| match state {
        BinaryState::Current => 0,
        BinaryState::Stale => 1,
        BinaryState::Missing => 2,
        BinaryState::Error => 3,
    };
    results
        .iter()
        .map(|(_, status)| status.status)
        .max_by_key(|state| rank(*state))
        .unwrap_or(BinaryState::Current)
}

pub struct OverviewEntry {
    pub extension: Extension,
    pub results: Vec<(String, BinaryStatus)>,
}

pub fn overview_human(duckdb: &str, entries: &[OverviewEntry], filter: Option<&str>) -> String {
    let mut out = String::new();
    let width = entries
        .iter()
        .map(|entry| entry.extension.name.len())
        .max()
        .unwrap_or(0);
    let mut totals = Summary::default();
    let mut checks = 0;
    for entry in entries {
        let summary = summarize(&entry.results);
        totals.current += summary.current;
        totals.stale += summary.stale;
        totals.missing += summary.missing;
        totals.error += summary.error;
        checks += entry.results.len();
        // Pad before styling: ANSI codes would otherwise break the column.
        let coverage = if entry.results.is_empty() {
            dim("—")
        } else {
            let raw = format!("{}/{} current", summary.current, entry.results.len());
            paint(&format!("{raw:<14}"), worst_state(&entry.results))
        };
        let mut attention: Vec<String> = entry
            .results
            .iter()
            .filter(|(_, status)| status.status != BinaryState::Current)
            .map(|(platform, status)| {
                format!(
                    "{platform} {}",
                    paint(state_label(status.status), status.status)
                )
            })
            .collect();
        if attention.is_empty() {
            attention.push(if entry.results.is_empty() {
                dim(if filter.is_some() {
                    "not supported"
                } else {
                    "no platforms"
                })
            } else {
                dim("all current")
            });
        }
        out.push_str(&format!(
            "{:<width$}  {coverage}  {}\n",
            entry.extension.name,
            attention.join(" · ")
        ));
    }
    out.push_str(&format!(
        "\n{} extension{} · {} · DuckDB {duckdb}\n",
        entries.len(),
        if entries.len() == 1 { "" } else { "s" },
        colored_summary(&totals, checks),
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(state: BinaryState) -> BinaryStatus {
        BinaryStatus {
            status: state,
            checked_descriptor_ref: "abc1234".to_string(),
            checked_descriptor_sha: "sha".to_string(),
            built_ref: None,
            binary_url: None,
            platform: None,
            duckdb_version: None,
            size: None,
            checked_at: "2026-09-09T00:00:00Z".to_string(),
            detail: None,
        }
    }

    #[test]
    fn sizes_and_summary() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(5 * 1024 * 1024), "5.0 MB");
        let summary = summarize(&[
            ("a".to_string(), status(BinaryState::Current)),
            ("b".to_string(), status(BinaryState::Stale)),
            ("c".to_string(), status(BinaryState::Missing)),
            ("d".to_string(), status(BinaryState::Error)),
        ]);
        assert_eq!(
            (
                summary.current,
                summary.stale,
                summary.missing,
                summary.error
            ),
            (1, 1, 1, 1)
        );
    }

    #[test]
    fn status_report_renders_links_and_hierarchy() {
        let ext = Extension {
            name: "demo".to_string(),
            description: "Demo extension".to_string(),
            repo: "duckdb/demo".to_string(),
            ref_: "abc1234".to_string(),
            platforms: vec!["linux_amd64".to_string()],
            descriptor_sha: "sha".to_string(),
            descriptor_path: Some("extensions/demo/description.yml".to_string()),
        };
        let commit = CommitInfo {
            sha: "9f8e7d6abc".to_string(),
            url: "https://github.com/duckdb/community-extensions/commit/9f8e7d6".to_string(),
            message: "Bump demo".to_string(),
            date: "2026-09-01".to_string(),
        };
        let mut current = status(BinaryState::Current);
        current.platform = Some("linux_amd64".to_string());
        current.built_ref = Some("abc1234".to_string());
        current.binary_url = Some("https://example.com/demo.gz".to_string());
        current.size = Some(2048);
        let report = status_human(
            &ext,
            "v1.5.5",
            &[("linux_amd64".to_string(), current)],
            Some(&commit),
        );
        assert!(report.contains("linux_amd64 — current"));
        assert!(report.contains("extensions/demo/description.yml"));
        assert!(report.contains("https://example.com/demo.gz"));
        assert!(report.contains("9f8e7d6 Bump demo"));
        assert!(report.contains("1 current, 0 stale, 0 missing, 0 error (1 total)"));
    }

    #[test]
    fn catalog_starts_descriptions_in_one_column() {
        let extension = |name: &str, description: &str| Extension {
            name: name.to_string(),
            description: description.to_string(),
            repo: String::new(),
            ref_: String::new(),
            platforms: Vec::new(),
            descriptor_sha: String::new(),
            descriptor_path: None,
        };
        let catalog = CatalogResponse {
            duckdb_version: "v1.5.5".to_string(),
            extensions: vec![extension("a", "First"), extension("longer", "Second")],
        };
        let report = catalog_human(&catalog);
        let mut lines = report.lines();
        let first = lines.next().unwrap().find("First").unwrap();
        let second = lines.next().unwrap().find("Second").unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn overview_compresses_to_one_row_per_extension() {
        let entry = |name: &str, results: Vec<(String, BinaryStatus)>| OverviewEntry {
            extension: Extension {
                name: name.to_string(),
                description: String::new(),
                repo: String::new(),
                ref_: String::new(),
                platforms: Vec::new(),
                descriptor_sha: String::new(),
                descriptor_path: None,
            },
            results,
        };
        let mut stale = status(BinaryState::Stale);
        stale.built_ref = Some("def5678".to_string());
        let entries = vec![
            entry(
                "demo",
                vec![
                    ("linux_amd64".to_string(), status(BinaryState::Current)),
                    ("osx_arm64".to_string(), stale),
                ],
            ),
            entry(
                "other",
                vec![("linux_amd64".to_string(), status(BinaryState::Current))],
            ),
            entry("tiny", Vec::new()),
        ];
        let report = overview_human("v1.5.5", &entries, None);
        assert!(report.contains("1/2 current"));
        assert!(report.contains("osx_arm64 stale"));
        assert!(report.contains("no platforms"));
        assert!(report.contains("3 extensions"));
        assert!(report.contains("2 current, 1 stale, 0 missing, 0 error (3 total)"));
    }
}
