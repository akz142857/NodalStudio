//! Deterministic graph aggregation and reverse code-impact traversal.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use project_model::{EdgeCertainty, ProjectEdge, ProjectNode};
use schema_model::ObjectKey;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactPath {
    pub target: ObjectKey,
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
    pub potential: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphContextSlice {
    pub target_node_ids: Vec<String>,
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
}

/// Builds deterministic one-hop model contexts without ever emitting the full graph as one request.
pub fn bounded_context_slices(
    nodes: &[ProjectNode],
    edges: &[ProjectEdge],
    roots_per_slice: usize,
    max_nodes: usize,
) -> Vec<GraphContextSlice> {
    let roots = nodes
        .iter()
        .filter(|node| {
            matches!(
                node.kind,
                project_model::ProjectNodeKind::Page
                    | project_model::ProjectNodeKind::Endpoint
                    | project_model::ProjectNodeKind::Service
                    | project_model::ProjectNodeKind::Repository
                    | project_model::ProjectNodeKind::Query
                    | project_model::ProjectNodeKind::OrmModel
            )
        })
        .map(|node| node.id.clone())
        .collect::<Vec<_>>();
    roots
        .chunks(roots_per_slice.max(1))
        .map(|chunk| {
            let target_node_ids = chunk.to_vec();
            let roots = chunk.iter().cloned().collect::<BTreeSet<_>>();
            let mut node_ids = roots.clone();
            let mut edge_ids = BTreeSet::new();
            let limit = max_nodes.max(chunk.len());
            for edge in edges
                .iter()
                .filter(|edge| roots.contains(&edge.source_id) || roots.contains(&edge.target_id))
            {
                for endpoint in [&edge.source_id, &edge.target_id] {
                    if node_ids.len() < limit || node_ids.contains(endpoint) {
                        node_ids.insert(endpoint.clone());
                    }
                }
                if node_ids.contains(&edge.source_id) && node_ids.contains(&edge.target_id) {
                    edge_ids.insert(edge.id.clone());
                }
            }
            GraphContextSlice {
                target_node_ids,
                node_ids: node_ids.into_iter().collect(),
                edge_ids: edge_ids.into_iter().collect(),
            }
        })
        .collect()
}

/// Walks incoming graph relationships from matching database objects to code consumers.
///
/// Results are bounded by `max_depth`, cycle-safe, and distinguish convention/AI paths as potential.
pub fn reverse_impact_paths(
    nodes: &[ProjectNode],
    edges: &[ProjectEdge],
    targets: &[ObjectKey],
    max_depth: usize,
) -> Vec<ImpactPath> {
    let node_map = nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let incoming = edges.iter().fold(
        BTreeMap::<&str, Vec<&ProjectEdge>>::new(),
        |mut result, edge| {
            result.entry(&edge.target_id).or_default().push(edge);
            result
        },
    );
    let mut paths = Vec::new();
    for target in targets {
        for root in nodes
            .iter()
            .filter(|node| node.database_object.as_ref() == Some(target))
        {
            let mut queue = VecDeque::from([(
                root.id.clone(),
                vec![root.id.clone()],
                Vec::new(),
                false,
                0_usize,
            )]);
            let mut visited = BTreeSet::new();
            while let Some((current, node_ids, edge_ids, potential, depth)) = queue.pop_front() {
                if !visited.insert((current.clone(), depth)) || depth >= max_depth {
                    continue;
                }
                for edge in incoming.get(current.as_str()).into_iter().flatten() {
                    let Some(source) = node_map.get(edge.source_id.as_str()) else {
                        continue;
                    };
                    let mut next_nodes = node_ids.clone();
                    next_nodes.push(source.id.clone());
                    let mut next_edges = edge_ids.clone();
                    next_edges.push(edge.id.clone());
                    let next_potential = potential
                        || matches!(
                            edge.certainty,
                            EdgeCertainty::Convention | EdgeCertainty::AiInferred
                        );
                    if !matches!(
                        source.kind,
                        project_model::ProjectNodeKind::Table
                            | project_model::ProjectNodeKind::Column
                    ) {
                        paths.push(ImpactPath {
                            target: target.clone(),
                            node_ids: next_nodes.clone(),
                            edge_ids: next_edges.clone(),
                            potential: next_potential,
                        });
                    }
                    queue.push_back((
                        source.id.clone(),
                        next_nodes,
                        next_edges,
                        next_potential,
                        depth + 1,
                    ));
                }
            }
        }
    }
    paths.sort_by(|a, b| {
        a.node_ids
            .len()
            .cmp(&b.node_ids.len())
            .then_with(|| a.node_ids.cmp(&b.node_ids))
    });
    paths.dedup_by(|a, b| a.node_ids == b.node_ids && a.edge_ids == b.edge_ids);
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use project_model::{EdgeEvidence, ProjectEdgeKind, ProjectNodeKind, ReviewStatus};
    use uuid::Uuid;

    #[test]
    fn walks_table_to_query_to_service_and_marks_conventions_potential() {
        let project_id = Uuid::new_v4();
        let scan_id = Uuid::new_v4();
        let key = ObjectKey {
            kind: schema_model::ObjectKind::Table,
            schema: "public".into(),
            name: "orders".into(),
        };
        let node = |id: &str, kind, database_object| ProjectNode {
            id: id.into(),
            project_id,
            kind,
            name: id.into(),
            qualified_name: id.into(),
            relative_path: None,
            line: None,
            database_object,
            attributes: BTreeMap::new(),
        };
        let evidence = EdgeEvidence {
            id: "ev".into(),
            project_id,
            relative_path: "src/orders.ts".into(),
            start_line: Some(1),
            end_line: Some(1),
            symbol: None,
            analyzer: "test".into(),
            excerpt_hash: None,
            explanation: None,
        };
        let edge = |id: &str, source: &str, target: &str, certainty| ProjectEdge {
            id: id.into(),
            source_id: source.into(),
            target_id: target.into(),
            kind: ProjectEdgeKind::Calls,
            certainty,
            review_status: ReviewStatus::NotRequired,
            evidence: vec![evidence.clone()],
            scan_id,
        };
        let paths = reverse_impact_paths(
            &[
                node("table", ProjectNodeKind::Table, Some(key.clone())),
                node("query", ProjectNodeKind::Query, None),
                node("service", ProjectNodeKind::Service, None),
            ],
            &[
                edge("read", "query", "table", EdgeCertainty::Declared),
                edge("call", "service", "query", EdgeCertainty::Convention),
            ],
            &[key],
            3,
        );
        assert_eq!(paths.len(), 2);
        assert!(!paths[0].potential);
        assert!(paths[1].potential);
    }

    #[test]
    fn ai_context_is_split_and_bounded() {
        let project_id = Uuid::new_v4();
        let nodes = (0..20)
            .map(|index| ProjectNode {
                id: format!("service-{index}"),
                project_id,
                kind: ProjectNodeKind::Service,
                name: index.to_string(),
                qualified_name: index.to_string(),
                relative_path: None,
                line: None,
                database_object: None,
                attributes: BTreeMap::new(),
            })
            .collect::<Vec<_>>();
        let slices = bounded_context_slices(&nodes, &[], 4, 8);
        assert_eq!(slices.len(), 5);
        assert!(
            slices
                .iter()
                .all(|slice| slice.target_node_ids.len() <= 4 && slice.node_ids.len() <= 8)
        );
    }
}
