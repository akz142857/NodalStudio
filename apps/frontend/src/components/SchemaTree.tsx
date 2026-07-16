import type { DatabaseSnapshot, TableDefinition } from "../platform";

interface SchemaTreeProps {
  snapshot: DatabaseSnapshot;
  onSelectTable: (table: TableDefinition) => void;
}

export function SchemaTree({ snapshot, onSelectTable }: SchemaTreeProps) {
  return (
    <section className="schema-tree" aria-label="Database structure">
      <div className="section-heading">
        <h2>Structure</h2>
        <span>{snapshot.schemas.length}</span>
      </div>
      {snapshot.schemas.map((schema) => (
        <details key={schema.name} open={snapshot.schemas.length < 4}>
          <summary>
            <strong>{schema.name}</strong>
            <span>{schema.tables.length}</span>
          </summary>
          <div className="schema-objects">
            {schema.tables.map((table) => (
              <button type="button" key={table.key.name} onClick={() => onSelectTable(table)}>
                <span className="object-icon">T</span>
                <span>{table.key.name}</span>
                <small>{table.columns.length}</small>
              </button>
            ))}
            {schema.views.map((view) => (
              <div className="schema-object-static" key={view.key.name}>
                <span className="object-icon">V</span>
                <span>{view.key.name}</span>
              </div>
            ))}
            {schema.enums.map((item) => (
              <div className="schema-object-static" key={item.key.name}>
                <span className="object-icon">E</span>
                <span>{item.key.name}</span>
              </div>
            ))}
          </div>
        </details>
      ))}
    </section>
  );
}

