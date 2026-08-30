import { useMemo, useState } from "react";
import type { DatabaseSnapshot, TableDefinition } from "../platform";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  selectedTable?: TableDefinition;
  onSelectTable: (table: TableDefinition) => void;
}

/** Objects are only mounted once their type node is opened. */
type OpenState = Record<string, boolean>;

const TYPE_LABEL = { tables: "Tables", views: "Views", enums: "Enums" } as const;
type ObjectType = keyof typeof TYPE_LABEL;

export function SchemaTree({ snapshot, selectedTable, onSelectTable }: SchemaTreeProps) {
  // A single schema is opened for you; more than that and the tree stays quiet
  // until you pick one. Type nodes always start closed — flattening a few
  // hundred tables into the sidebar is what made it scroll for thousands of
  // pixels before you could reach anything below it.
  //
  // Keyed by source, not by snapshot: switching connection starts from that
  // decision again rather than inheriting a tree whose schema names may not
  // exist here, while refreshing or stepping through history keeps whatever you
  // had open — it is the same database either way.
  const [open, setOpen] = useState<OpenState>({});
  const [openFor, setOpenFor] = useState<string>();
  const defaults: OpenState =
    snapshot.schemas.length === 1 ? { [snapshot.schemas[0].name]: true } : {};
  if (openFor !== snapshot.sourceId) {
    setOpenFor(snapshot.sourceId);
    setOpen(defaults);
  }
  const effectiveOpen = openFor === snapshot.sourceId ? open : defaults;
  const toggle = (key: string) =>
    setOpen((current) => ({ ...current, [key]: !current[key] }));

  const totals = useMemo(
    () =>
      snapshot.schemas.reduce(
        (total, schema) => total + schema.tables.length + schema.views.length + schema.enums.length,
        0,
      ),
    [snapshot],
  );

  const selectedId = selectedTable
    ? `${selectedTable.key.schema}.${selectedTable.key.name}`
    : undefined;

  return (
    <section className="schema-tree" aria-label="Database structure">
      <div className="section-heading">
        <h2>Structure</h2>
        <span>{totals}</span>
      </div>

      {snapshot.schemas.map((schema) => {
        const schemaOpen = effectiveOpen[schema.name] ?? false;
        const counts: Record<ObjectType, number> = {
          tables: schema.tables.length,
          views: schema.views.length,
          enums: schema.enums.length,
        };
        return (
          <div className="tree-node" key={schema.name}>
            <button
              type="button"
              className="tree-row tree-row-schema"
              aria-expanded={schemaOpen}
              onClick={() => toggle(schema.name)}
            >
              <span className="tree-twisty" data-open={schemaOpen || undefined} aria-hidden="true" />
              <span className="tree-label">{schema.name}</span>
              <small>{counts.tables + counts.views + counts.enums}</small>
            </button>

            {schemaOpen
              ? (Object.keys(TYPE_LABEL) as ObjectType[]).map((type) => {
                  const key = `${schema.name}:${type}`;
                  const typeOpen = effectiveOpen[key] ?? false;
                  const count = counts[type];
                  return (
                    <div className="tree-node tree-node-type" key={key}>
                      <button
                        type="button"
                        className="tree-row tree-row-type"
                        aria-expanded={typeOpen}
                        disabled={count === 0}
                        onClick={() => toggle(key)}
                      >
                        <span
                          className="tree-twisty"
                          data-open={typeOpen || undefined}
                          aria-hidden="true"
                        />
                        <span className="tree-label">{TYPE_LABEL[type]}</span>
                        <small>{count}</small>
                      </button>

                      {typeOpen && type === "tables"
                        ? schema.tables.map((table) => {
                            const id = `${schema.name}.${table.key.name}`;
                            return (
                              <button
                                type="button"
                                key={id}
                                className="tree-row tree-row-object"
                                aria-current={id === selectedId ? "true" : undefined}
                                onClick={() => onSelectTable(table)}
                              >
                                <span className="tree-label">{table.key.name}</span>
                                <small>{table.columns.length}</small>
                              </button>
                            );
                          })
                        : null}

                      {typeOpen && type === "views"
                        ? schema.views.map((view) => (
                            <div className="tree-row tree-row-object is-static" key={view.key.name}>
                              <span className="tree-label">{view.key.name}</span>
                            </div>
                          ))
                        : null}

                      {typeOpen && type === "enums"
                        ? schema.enums.map((item) => (
                            <div className="tree-row tree-row-object is-static" key={item.key.name}>
                              <span className="tree-label">{item.key.name}</span>
                            </div>
                          ))
                        : null}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </section>
  );
}
