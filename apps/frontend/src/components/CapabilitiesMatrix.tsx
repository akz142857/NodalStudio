import { capabilityMessages, capabilityTargetMessages, capabilityStatusMessages } from "../i18n/capabilities";
import { useI18n } from "../i18n";
import { useState } from "react";
import type { DatabaseInfo, RuntimeInfo } from "../platform";
import { capabilityDefinitions, capabilityTargets, currentCapabilityTarget, type CapabilityId, type CapabilityStatus } from "../platform/capabilities";

export function CapabilitiesMatrix({ runtime, database }: { runtime?: RuntimeInfo; database?: DatabaseInfo }) {
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CapabilityStatus | "">("");
  const [selected, setSelected] = useState<CapabilityId>("read-only-query");
  const current = currentCapabilityTarget(runtime?.kind, database?.databaseType);
  const definitions = capabilityDefinitions.filter((definition) =>
    (!status || capabilityTargets.some((target) => definition.targets[target.id].status === status))
    && [definition.name, definition.category, t(capabilityMessages[definition.id].name), t(capabilityMessages[definition.id].category), ...capabilityTargets.map((target) => t(capabilityMessages[definition.id].targets[target.id])), ...capabilityTargets.map((target) => definition.targets[target.id].scope)].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const detail = definitions.find((definition) => definition.id === selected) ?? definitions[0];
  return <section className="capabilities-matrix" aria-label={t("capabilities.productCapabilities")}>
    <div className="capabilities-overview">
      <p>{t("capabilities.thisBuildSSupportScopeComparedAcrossRuntime")}</p>
      <p className="capabilities-current">{t("capabilities.currentContext")}{" "}{runtime ? runtime.kind === "desktop" ? t("settings.desktop") : t("capabilities.web") : t("capabilities.runtimeNotDetected")} · {database ? `${database.databaseType === "postgreSql" ? "PostgreSQL" : database.databaseType === "mySql" ? "MySQL" : t("capabilities.unknownDialect")} ${database.version}` : t("capabilities.noLoadedDatabase")}. {current ? t("capabilities.theMatchingColumnIsHighlighted") : t("capabilities.noColumnSelectedAnUnknownContextIsNot")}</p>
      <p className="capabilities-legend">{t("capabilities.supportedAvailableWithinTheStatedScopePartialLimited")}</p>
    </div>
    <div className="capabilities-toolbar">
      <div className="capabilities-filters">
        <label>{t("capabilities.searchCapabilities")}<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label>{t("capabilities.status")}<select value={status} onChange={(event) => setStatus(event.target.value as CapabilityStatus | "")}><option value="">{t("capabilities.allStatuses")}</option>{Object.entries(capabilityStatusMessages).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      </div>
      <p className="capabilities-results" role="status">{definitions.length} {t("capabilities.of")}{" "}{capabilityDefinitions.length} {t("capabilities.capabilitiesStatusFilterMatchesAnyOfTheFour")}</p>
    </div>
    {definitions.length ? <>
      <div className="capabilities-table-scroll" role="region" aria-label={t("capabilities.scrollableCapabilityComparison")} tabIndex={0}>
        <table><caption>{t("capabilities.capabilityMatrixCurrentBuild")}</caption><thead><tr><th scope="col">{t("capabilities.featureSelectForDetails")}</th>{capabilityTargets.map((target) => <th key={target.id} scope="col" data-current={current === target.id || undefined}>{t(capabilityTargetMessages[target.id])}{current === target.id ? <> <small>{t("capabilities.current")}</small></> : null}</th>)}</tr></thead>
          <tbody>{definitions.map((definition) => <tr key={definition.id} data-selected={detail?.id === definition.id || undefined}><th scope="row"><button type="button" aria-pressed={detail?.id === definition.id} aria-controls="capability-detail" onClick={() => setSelected(definition.id)}>{t(capabilityMessages[definition.id].name)}</button><small>{t(capabilityMessages[definition.id].category)}</small></th>
            {capabilityTargets.map((target) => <td key={target.id} data-current={current === target.id || undefined}><span className="capability-status" data-status={definition.targets[target.id].status}>{t(capabilityStatusMessages[definition.targets[target.id].status])}</span></td>)}
          </tr>)}</tbody></table>
      </div>
      {detail ? <section className="capability-detail" id="capability-detail" aria-label={t("capabilities.capabilityDetails")}><h3>{t(capabilityMessages[detail.id].name)}</h3>
        <div>{capabilityTargets.map((target) => <article key={target.id} data-current={current === target.id || undefined}><h4>{t(capabilityTargetMessages[target.id])}{current === target.id ? t("capabilities.currentDetail") : ""}</h4><span className="capability-status" data-status={detail.targets[target.id].status}>{t(capabilityStatusMessages[detail.targets[target.id].status])}</span><p>{t(capabilityMessages[detail.id].targets[target.id])}</p></article>)}</div>
      </section> : null}
    </> : <p className="settings-empty">{t("capabilities.noCapabilitiesMatchTheCurrentFiltersClearThe")}</p>}
  </section>;
}
