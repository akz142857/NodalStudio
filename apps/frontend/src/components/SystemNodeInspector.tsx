import type { SystemMapSelection } from "./SystemMap";

export function SystemNodeInspector({ selection }: { selection?: SystemMapSelection }) {
  if (!selection) {
    return <p className="inspector-hint">Select an API, service, query, ORM model, table, or relation to inspect its evidence.</p>;
  }
  return (
    <section className="system-node-inspector">
      <dl>
        <div><dt>Type</dt><dd>{selection.node.kind}</dd></div>
        <div><dt>Name</dt><dd>{selection.node.qualifiedName}</dd></div>
        {selection.node.relativePath ? <div><dt>Location</dt><dd>{selection.node.relativePath}{selection.node.line ? `:${selection.node.line}` : ""}</dd></div> : null}
      </dl>
      <h3>Relations & evidence</h3>
      {selection.edges.length ? selection.edges.map((edge) => (
        <article key={edge.id}>
          <header><strong>{edge.kind}</strong><span>{edge.certainty} · {edge.reviewStatus}</span></header>
          {edge.evidence.map((evidence) => (
            <div key={evidence.id}>
              <p>{evidence.explanation ?? "Structural evidence"}</p>
              <small>{evidence.relativePath}{evidence.startLine ? `:${evidence.startLine}` : ""} · {evidence.analyzer}</small>
            </div>
          ))}
        </article>
      )) : <p>No visible relations under the current filters.</p>}
    </section>
  );
}
