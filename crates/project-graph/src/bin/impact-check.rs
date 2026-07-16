use std::{collections::BTreeMap, env, fs, process::ExitCode};

use project_graph::reverse_impact_paths;
use project_model::{ProjectEdge, ProjectNode};
use schema_diff::{RiskLevel, SchemaChangeSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphInput {
    nodes: Vec<ProjectNode>,
    edges: Vec<ProjectEdge>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpactFinding {
    operation: String,
    object: String,
    risk: RiskLevel,
    direct_paths: usize,
    potential_paths: usize,
    locations: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpactReport {
    passed: bool,
    fail_on: RiskLevel,
    findings: Vec<ImpactFinding>,
}

fn main() -> ExitCode {
    match run() {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&report).expect("report serialization")
            );
            if report.passed {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(2)
            }
        }
        Err(message) => {
            eprintln!("Nodal Studio impact check failed: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ImpactReport, String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() < 2 || args.len() > 3 {
        return Err(
            "usage: impact-check <change-set.json> <project-graph.json> [high|medium|low]".into(),
        );
    }
    let fail_on = args
        .get(2)
        .map_or(Ok(RiskLevel::High), |value| parse_risk(value))?;
    let change_set: SchemaChangeSet = read_json(&args[0])?;
    let graph: GraphInput = read_json(&args[1])?;
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let edges = graph
        .edges
        .iter()
        .map(|edge| (edge.id.as_str(), edge))
        .collect::<BTreeMap<_, _>>();
    let mut findings = Vec::new();
    for operation in &change_set.operations {
        let paths = reverse_impact_paths(
            &graph.nodes,
            &graph.edges,
            std::slice::from_ref(&operation.object),
            6,
        );
        if paths.is_empty() {
            continue;
        }
        let locations = paths
            .iter()
            .filter_map(|path| {
                path.edge_ids
                    .iter()
                    .filter_map(|id| edges.get(id.as_str()))
                    .flat_map(|edge| &edge.evidence)
                    .find_map(|evidence| {
                        (!evidence.relative_path.is_empty()).then(|| {
                            evidence.start_line.map_or_else(
                                || evidence.relative_path.clone(),
                                |line| format!("{}:{line}", evidence.relative_path),
                            )
                        })
                    })
                    .or_else(|| {
                        path.node_ids.iter().rev().find_map(|id| {
                            let node = nodes.get(id.as_str())?;
                            node.relative_path.as_ref().map(|path| {
                                node.line
                                    .map_or_else(|| path.clone(), |line| format!("{path}:{line}"))
                            })
                        })
                    })
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        findings.push(ImpactFinding {
            operation: format!("{:?}", operation.operation_type),
            object: format!(
                "{}.{}.{}",
                operation.object.schema,
                operation.object.name,
                format!("{:?}", operation.object.kind).to_ascii_lowercase()
            ),
            risk: operation.risk,
            direct_paths: paths.iter().filter(|path| !path.potential).count(),
            potential_paths: paths.iter().filter(|path| path.potential).count(),
            locations,
        });
    }
    let passed = !findings
        .iter()
        .any(|finding| finding.direct_paths > 0 && finding.risk >= fail_on);
    Ok(ImpactReport {
        passed,
        fail_on,
        findings,
    })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|_| format!("cannot read {path}"))?;
    serde_json::from_str(&contents).map_err(|_| format!("{path} is not valid Nodal Studio JSON"))
}

fn parse_risk(value: &str) -> Result<RiskLevel, String> {
    match value.to_ascii_lowercase().as_str() {
        "high" => Ok(RiskLevel::High),
        "medium" => Ok(RiskLevel::Medium),
        "low" => Ok(RiskLevel::Low),
        _ => Err("risk threshold must be high, medium, or low".into()),
    }
}
