import { useI18n } from "../../i18n";
import type { RelationshipEndpoint } from "../../platform";

export function RelationshipEndpoints({ source, target }: { source: RelationshipEndpoint; target: RelationshipEndpoint }) {
  const { t: bt } = useI18n();
  return <dl className="relationship-endpoints">{([[bt("business.from"), source], [bt("business.to"), target]] as const).map(([label, endpoint]) => <div key={label}><dt>{label}</dt><dd><span>{endpoint.schema ? `${endpoint.schema}.` : ""}{endpoint.table}</span><code>{endpoint.columns.join(", ")}</code></dd></div>)}</dl>;
}
