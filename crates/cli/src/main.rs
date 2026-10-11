mod api;
mod render;

use anyhow::{bail, Result};
use api::{BinaryStatus, CatalogResponse, Client, CommitInfo, Extension};
use clap::{Parser, Subcommand};
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "ce-map",
    version,
    about = "Audit DuckDB community extension binaries"
)]
struct Cli {
    #[arg(
        long,
        global = true,
        env = "CE_MAP_API_URL",
        default_value = "http://127.0.0.1:3001"
    )]
    api_url: String,
    #[arg(
        long,
        global = true,
        help = "Emit machine-readable JSON instead of human-readable tables"
    )]
    json: bool,
    #[arg(
        long,
        global = true,
        help = "DuckDB version to audit (default: latest stable)"
    )]
    duckdb: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Report binary states (one extension in detail, all extensions compressed)")]
    Status {
        /// Extension name as listed by `catalog` (omit for all extensions)
        name: Option<String>,
        /// Only report this platform
        #[arg(long)]
        platform: Option<String>,
    },
    #[command(about = "List known extensions")]
    Catalog,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusReport<'a> {
    extension: &'a Extension,
    duckdb_version: &'a str,
    results: Vec<BinaryStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_commit: Option<CommitInfo>,
    summary: render::Summary,
}

/// Same charset the API enforces for names, so user input is safe to place in URLs.
fn validated(kind: &str, value: &str) -> Result<String> {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Ok(value.to_string())
    } else {
        bail!("invalid {kind} '{value}'")
    }
}

/// Same `vX.Y.Z` shape the API enforces, so user input is safe to place in URLs.
fn validated_version(value: &str) -> Result<String> {
    let mut parts = value.strip_prefix('v').unwrap_or("").split('.');
    let numeric = |part: Option<&str>| {
        part.is_some_and(|digits| {
            !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
        })
    };
    if numeric(parts.next())
        && numeric(parts.next())
        && numeric(parts.next())
        && parts.next().is_none()
    {
        Ok(value.to_string())
    } else {
        bail!("invalid DuckDB version '{value}' (want vX.Y.Z)")
    }
}

/// One request per platform, fanned out over scoped threads and joined back
/// in platform order. A failed check aborts the report like the sequential
/// loop did.
fn check_all(
    client: &Client,
    extension: &str,
    platforms: &[&str],
    version: Option<&str>,
) -> Result<Vec<(String, BinaryStatus)>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = platforms
            .iter()
            .map(|platform| {
                let worker = client.clone();
                scope.spawn(move || {
                    worker
                        .check(extension, platform, version)
                        .map(|status| (platform.to_string(), status))
                })
            })
            .collect();
        let mut results = Vec::with_capacity(handles.len());
        for handle in handles {
            results.push(
                handle
                    .join()
                    .map_err(|_| anyhow::anyhow!("check worker panicked"))??,
            );
        }
        Ok(results)
    })
}

fn fill_platform(results: Vec<(String, BinaryStatus)>) -> Vec<BinaryStatus> {
    results
        .into_iter()
        .map(|(platform, mut status)| {
            status.platform = Some(platform);
            status
        })
        .collect()
}

fn run_status(
    client: &Client,
    name: Option<&str>,
    platform: Option<&str>,
    version: Option<&str>,
    json: bool,
) -> Result<()> {
    let name = name.map(|name| validated("extension", name)).transpose()?;
    let version = version.map(validated_version).transpose()?;
    let catalog = client.catalog(version.as_deref())?;
    match name {
        Some(name) => {
            let extension = catalog
                .extensions
                .iter()
                .find(|ext| ext.name == name)
                .ok_or_else(|| anyhow::anyhow!("unknown extension '{name}'"))?;
            run_single(
                client,
                &catalog.duckdb_version,
                extension,
                platform,
                version.as_deref(),
                json,
            )
        }
        None => run_overview(client, &catalog, platform, version.as_deref(), json),
    }
}

fn run_single(
    client: &Client,
    duckdb: &str,
    extension: &Extension,
    platform: Option<&str>,
    version: Option<&str>,
    json: bool,
) -> Result<()> {
    let mut platforms: Vec<&str> = extension.platforms.iter().map(String::as_str).collect();
    if let Some(filter) = platform {
        let filter = validated("platform", filter)?;
        if !platforms.contains(&filter.as_str()) {
            bail!("extension '{}' has no platform '{filter}'", extension.name);
        }
        platforms.retain(|item| *item == filter);
    }
    let results = check_all(client, &extension.name, &platforms, version)?;
    // Best-effort: an offline machine or GitHub rate limit degrades to "unavailable".
    let commit = client
        .descriptor_commit(&extension.descriptor_path_resolved())
        .ok();
    if json {
        let summary = render::summarize(&results);
        let report = StatusReport {
            extension,
            duckdb_version: duckdb,
            results: fill_platform(results),
            last_commit: commit,
            summary,
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!(
            "{}",
            render::status_human(extension, duckdb, &results, commit.as_ref())
        );
    }
    Ok(())
}
fn run_overview(
    client: &Client,
    catalog: &CatalogResponse,
    platform: Option<&str>,
    version: Option<&str>,
    json: bool,
) -> Result<()> {
    let filter = platform
        .map(|filter| validated("platform", filter))
        .transpose()?;
    let filter = filter.as_deref();
    let extensions: Vec<&Extension> = catalog.extensions.iter().collect();
    let workers = extensions.len().clamp(1, 16);
    let entries = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in extensions.chunks(extensions.len().div_ceil(workers).max(1)) {
            let worker = client.clone();
            handles.push(scope.spawn(move || {
                let mut entries = Vec::with_capacity(chunk.len());
                for extension in chunk {
                    let platforms: Vec<&str> = extension
                        .platforms
                        .iter()
                        .map(String::as_str)
                        .filter(|platform| filter.is_none_or(|only| *platform == only))
                        .collect();
                    entries.push(render::OverviewEntry {
                        extension: (*extension).clone(),
                        results: check_all(&worker, &extension.name, &platforms, version)?,
                    });
                }
                Ok::<_, anyhow::Error>(entries)
            }));
        }
        let mut entries = Vec::with_capacity(extensions.len());
        for handle in handles {
            entries.extend(
                handle
                    .join()
                    .map_err(|_| anyhow::anyhow!("overview worker panicked"))??,
            );
        }
        Ok::<_, anyhow::Error>(entries)
    })?;
    if json {
        let reports: Vec<StatusReport> = entries
            .iter()
            .map(|entry| StatusReport {
                extension: &entry.extension,
                duckdb_version: &catalog.duckdb_version,
                results: fill_platform(entry.results.clone()),
                last_commit: None,
                summary: render::summarize(&entry.results),
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&reports)?);
    } else {
        print!(
            "{}",
            render::overview_human(&catalog.duckdb_version, &entries, filter)
        );
    }
    Ok(())
}

fn run_catalog(client: &Client, version: Option<&str>, json: bool) -> Result<()> {
    let version = version.map(validated_version).transpose()?;
    let catalog = client.catalog(version.as_deref())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&catalog)?);
    } else {
        print!("{}", render::catalog_human(&catalog));
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let client = Client::new(&cli.api_url)?;
    match &cli.command {
        Command::Status { name, platform } => run_status(
            &client,
            name.as_deref(),
            platform.as_deref(),
            cli.duckdb.as_deref(),
            cli.json,
        ),
        Command::Catalog => run_catalog(&client, cli.duckdb.as_deref(), cli.json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duckdb_versions_validate_shape() {
        assert_eq!(validated_version("v1.5.5").unwrap(), "v1.5.5");
        assert!(validated_version("1.5.5").is_err());
        assert!(validated_version("v1.5").is_err());
        assert!(validated_version("v1.5.5.1").is_err());
        assert!(validated_version("v1.x.5").is_err());
        assert!(validated_version("v1.5.5;rm").is_err());
    }

    #[test]
    fn checks_platforms_concurrently_in_order() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        struct StubServer {
            listener: TcpListener,
            requests: usize,
        }

        impl StubServer {
            fn serve(requests: usize) -> Self {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                Self { listener, requests }
            }

            fn url(&self) -> String {
                format!("http://{}", self.listener.local_addr().unwrap())
            }

            /// Serve check calls, slowest platform first so completion order
            /// differs from request order.
            fn run(self) {
                for _ in 0..self.requests {
                    let (mut stream, _) = self.listener.accept().unwrap();
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).unwrap() == 0 {
                            break;
                        }
                        head.push(byte[0]);
                    }
                    let request: String = String::from_utf8_lossy(&head).into_owned();
                    let platform = request
                        .split("platform=")
                        .nth(1)
                        .unwrap_or("unknown")
                        .split(['&', ' '])
                        .next()
                        .unwrap_or("unknown");
                    let delay = match platform {
                        "linux_amd64" => 150,
                        "osx_arm64" => 100,
                        _ => 50,
                    };
                    std::thread::sleep(Duration::from_millis(delay));
                    let body = format!(
                        "{{\"status\":\"current\",\"checkedDescriptorRef\":\"abc\",\"checkedDescriptorSha\":\"s\",\
                         \"builtRef\":\"built-{platform}\",\"platform\":\"{platform}\",\"checkedAt\":\"t\"}}"
                    );
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len(),
                    )
                    .unwrap();
                }
            }
        }

        let server = StubServer::serve(3);
        let url = server.url();
        let served = std::thread::spawn(|| server.run());
        let client = Client::new(&url).unwrap();
        let platforms = ["linux_amd64", "osx_arm64", "wasm_mvp"];
        let results = check_all(&client, "demo", &platforms, None).unwrap();
        served.join().unwrap();
        assert_eq!(results.len(), 3);
        for (index, platform) in platforms.iter().enumerate() {
            assert_eq!(&results[index].0, platform);
            let want = format!("built-{platform}");
            assert_eq!(results[index].1.built_ref.as_deref(), Some(want.as_str()));
        }
    }
}
