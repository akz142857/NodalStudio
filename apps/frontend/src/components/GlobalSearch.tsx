import { useEffect, useId, useMemo, type RefObject } from "react";
import type { DatabaseSnapshot, TableDefinition } from "../platform";
import { searchSchema, type SchemaSearchResult, type SearchContext } from "../graph/schema-search";
import type { Translate } from "../i18n";
import { ActionIcon } from "./ActionIcon";
import { useSchemaSearch, type SchemaSearchStore } from "./schema-search-store";

export interface GlobalSearchProps {
  store: SchemaSearchStore;
  inputRef: RefObject<HTMLInputElement | null>;
  snapshot: DatabaseSnapshot | undefined;
  context: SearchContext;
  showActions: boolean;
  canOpenInQuery: boolean;
  t: Translate;
  onLocate: (result: SchemaSearchResult) => void;
  onShowRelated: (table: TableDefinition) => void;
  onOpenInQuery: (table: TableDefinition) => void;
}

/** Toolbar schema search; owns its keystroke state so typing does not re-render the workspace. */
export function GlobalSearch({ store, inputRef, snapshot, context, showActions, canOpenInQuery, t, onLocate, onShowRelated, onOpenInQuery }: GlobalSearchProps) {
  const query = useSchemaSearch(store, (state) => state.query);
  const open = useSchemaSearch(store, (state) => state.open);
  const active = useSchemaSearch(store, (state) => state.active);
  const { setQuery, setOpen, setActive } = store.getState();
  const searchListId = useId();
  const schemaSearchResults = useMemo(() => searchSchema(snapshot, query, 10, context), [context, query, snapshot]);
  const showSearchResults = open && Boolean(query.trim());
  const searchIndex = Math.min(active, Math.max(0, schemaSearchResults.length - 1));
  const selectedSearchResult = schemaSearchResults[searchIndex];
  const searchMatch = selectedSearchResult?.match;
  const activeSearchOption = showSearchResults && selectedSearchResult ? `${searchListId}-${searchIndex}` : undefined;
  useEffect(() => {
    if (activeSearchOption) document.getElementById(activeSearchOption)?.scrollIntoView?.({ block: "nearest" });
  }, [activeSearchOption, query]);

  return (
    <div className="global-search" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDown={(event) => {
      if (event.key !== "Escape" || !showSearchResults || event.target === inputRef.current) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(false);
    }}>
      <ActionIcon name="search" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label={t("navigation.searchSchema")}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={showSearchResults && schemaSearchResults.length > 0}
        aria-controls={showSearchResults && schemaSearchResults.length > 0 ? searchListId : undefined}
        aria-activedescendant={activeSearchOption}
        placeholder={t("navigation.searchTableFieldOrTerm")}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            if (!showSearchResults) return;
            event.preventDefault();
            setOpen(false);
            setQuery("");
          } else if (event.key === "ArrowDown" && schemaSearchResults.length) {
            event.preventDefault();
            setActive(showSearchResults ? (searchIndex + 1) % schemaSearchResults.length : 0);
            setOpen(true);
          } else if (event.key === "ArrowUp" && schemaSearchResults.length) {
            event.preventDefault();
            setActive(showSearchResults ? (searchIndex - 1 + schemaSearchResults.length) % schemaSearchResults.length : schemaSearchResults.length - 1);
            setOpen(true);
          } else if (event.key === "Enter" && showSearchResults && selectedSearchResult) {
            event.preventDefault();
            onLocate(selectedSearchResult);
          }
        }}
        disabled={!snapshot}
      />
      {showSearchResults ? <div className="global-search-panel ds-surface">
        {snapshot ? <div className="global-search-scope">{t("navigation.searchInDatabase", { value0: snapshot.database.name })}</div> : null}
        <div className="global-search-results" id={searchListId} role={schemaSearchResults.length ? "listbox" : "status"} aria-label={t("navigation.schemaSearchResults")}>
        {schemaSearchResults.length ? schemaSearchResults.map((result, index) => <button
          type="button"
          role="option"
          id={`${searchListId}-${index}`}
          tabIndex={-1}
          aria-selected={index === searchIndex}
          key={`${result.schema}.${result.table.key.name}`}
          onPointerEnter={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onLocate(result)}
        >
          <strong>{result.table.key.name}</strong>
          <span>{result.schema}{result.matchingColumns.length ? ` · ${result.matchingColumns.slice(0, 3).join(", ")}` : ""}</span>
        </button>) : <p>{t("navigation.noMatchingTablesOrFields")}</p>}
        </div>
        {selectedSearchResult ? <div className="global-search-context">
          <p>{searchMatch
            ? t(searchMatch.expanded ? "navigation.searchExpansionMatch" : "navigation.searchMetadataMatch", {
              value0: [t(`navigation.searchEvidence.${searchMatch.basis}`), searchMatch.column].filter(Boolean).join(" "),
              value1: searchMatch.terms.join(", "),
            })
            : t(selectedSearchResult.nameMatch ? "navigation.searchNameMatch" : "navigation.searchFieldMatch")}</p>
          {showActions && <div className="global-search-actions">
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onShowRelated(selectedSearchResult.table)}>{t("navigation.showRelatedTables")}</button>
            {canOpenInQuery
              ? <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenInQuery(selectedSearchResult.table)}>{t("navigation.useSearchResultInQuery")}</button> : null}
          </div>}
        </div> : null}
      </div> : null}
    </div>
  );
}
