import { useState } from "react";
import type { DatabaseInfo, RuntimeInfo } from "../platform";
import { capabilityDefinitions, capabilityStatusLabels, capabilityTargets, currentCapabilityTarget, type CapabilityId, type CapabilityStatus } from "../platform/capabilities";

export function CapabilitiesMatrix({ runtime, database }: { runtime?: RuntimeInfo; database?: DatabaseInfo }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CapabilityStatus | "">("");
  const [selected, setSelected] = useState<CapabilityId>("read-only-query");
  const current = currentCapabilityTarget(runtime?.kind, database?.databaseType);
  const definitions = capabilityDefinitions.filter((definition) =>
    (!status || capabilityTargets.some((target) => definition.targets[target.id].status === status))
    && [definition.name, definition.category, ...capabilityTargets.map((target) => definition.targets[target.id].scope)].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const detail = definitions.find((definition) => definition.id === selected) ?? definitions[0];
  return <section className="capabilities-matrix" aria-label="Product capabilities">
    <p>This build's support scope, compared across runtime and database dialect. Permissions, credentials, loaded snapshots, server metadata and policy still determine actual availability; this view does not test a connection.</p>
    <p className="capabilities-current">Current context: {runtime ? runtime.kind === "desktop" ? "Desktop" : "Web" : "Runtime not detected"} · {database ? `${database.databaseType === "postgreSql" ? "PostgreSQL" : database.databaseType === "mySql" ? "MySQL" : "Unknown dialect"} ${database.version}` : "No loaded database"}. {current ? "The matching column is highlighted." : "No column selected; an unknown context is not treated as supported."}</p>
    <p>Supported: available within the stated scope. Partial: limited metadata or functionality. Unavailable: absent or outside this runtime's scope. Open a feature's details for the exact limits.</p>
    <div className="capabilities-filters">
      <label>Search capabilities<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as CapabilityStatus | "")}><option value="">All statuses</option>{Object.entries(capabilityStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p>{definitions.length} of {capabilityDefinitions.length} capabilities · Status filter matches any of the four combinations.</p>
    {definitions.length ? <>
      <div className="capabilities-table-scroll" role="region" aria-label="Scrollable capability comparison" tabIndex={0}>
        <table><caption>Capability matrix · current build</caption><thead><tr><th scope="col">Feature · select for details</th>{capabilityTargets.map((target) => <th key={target.id} scope="col" data-current={current === target.id || undefined}>{target.label}{current === target.id ? <> <small>Current</small></> : null}</th>)}</tr></thead>
          <tbody>{definitions.map((definition) => <tr key={definition.id}><th scope="row"><button type="button" aria-pressed={detail?.id === definition.id} aria-controls="capability-detail" onClick={() => setSelected(definition.id)}>{definition.name}</button><small>{definition.category}</small></th>
            {capabilityTargets.map((target) => <td key={target.id} data-current={current === target.id || undefined}><span className="capability-status" data-status={definition.targets[target.id].status}>{capabilityStatusLabels[definition.targets[target.id].status]}</span></td>)}
          </tr>)}</tbody></table>
      </div>
      {detail ? <section className="capability-detail" id="capability-detail" aria-label="Capability details"><h3>{detail.name}</h3>
        <div>{capabilityTargets.map((target) => <article key={target.id} data-current={current === target.id || undefined}><h4>{target.label}{current === target.id ? " · Current" : ""}</h4><span className="capability-status" data-status={detail.targets[target.id].status}>{capabilityStatusLabels[detail.targets[target.id].status]}</span><p>{detail.targets[target.id].scope}</p></article>)}</div>
      </section> : null}
    </> : <p>No capabilities match the current filters. Clear the search or change the status filter.</p>}
  </section>;
}
