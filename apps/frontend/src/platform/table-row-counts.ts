export interface TableRowCountTarget {
  schema: string;
  name: string;
}

export interface TableRowCountRequest {
  sourceId: string;
  connectionRevision: string;
  target?: TableRowCountTarget;
}

export interface TableRowCount extends TableRowCountTarget {
  count: string;
}

export function tableRowCountKey({ schema, name }: TableRowCountTarget) {
  return JSON.stringify([schema, name]);
}
