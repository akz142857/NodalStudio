import type { RelationshipEndpoint } from "../../platform";

export function RelationshipEndpoints({ source, target }: { source: RelationshipEndpoint; target: RelationshipEndpoint }) {
  return <dl className="relationship-endpoints">{([["From", source], ["To", target]] as const).map(([label, endpoint]) => <div key={label}><dt>{label}</dt><dd><span>{endpoint.schema ? `${endpoint.schema}.` : ""}{endpoint.table}</span><code>{endpoint.columns.join(", ")}</code></dd></div>)}</dl>;
}
