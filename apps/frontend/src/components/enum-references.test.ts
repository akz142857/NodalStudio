import { expect, it } from "vitest";
import { enumColumn, enumSnapshot } from "../test/enum-fixture";
import { enumReferences } from "./enum-references";

it("finds every captured direct/array field across schemas, distinguishes same-named types and keeps original identities", () => {
  const before = structuredClone(enumSnapshot);
  const refs = enumReferences(enumSnapshot, enumSnapshot.schemas[0].enums[0]);
  expect(refs.map(({ table, fields }) => [table.key.schema, table.key.name, fields.map(({ column, array }) => [column.name, array])])).toEqual([
    ["public", "orders", [["status", false], ["previous_status", false], ["history", true]]],
    ["archive", "orders", [["public_status", false]]],
  ]);
  expect(refs[0].table).toBe(enumSnapshot.schemas[0].tables[1]);
  expect(refs[0].fields[0].column).toBe(enumSnapshot.schemas[0].tables[1].columns[3]);
  const other = enumReferences(enumSnapshot, enumSnapshot.schemas[1].enums[0]);
  expect(other.map(({ table, fields }) => [table.key.schema, fields.map(({ column }) => column.name)])).toEqual([
    ["public", ["other_status"]], ["archive", ["status"]],
  ]);
  expect(enumSnapshot).toEqual(before);
});

it("matches quoted array identities exactly without guessing generated names, case folding or substring matches", () => {
  const item = { key: { kind: "enum" as const, schema: 'Case.Schema', name: 'Order."State' }, values: [] };
  const columns = [
    enumColumn("scalar", item.key.schema, item.key.name),
    enumColumn("array", item.key.schema, "any_generated_array_name", '"Case.Schema"."Order.""State"[]'),
    enumColumn("unqualified_array", item.key.schema, "different_array_name", '"Order.""State"[]'),
    enumColumn("wrong_schema", "case.schema", item.key.name),
    enumColumn("wrong_case", item.key.schema, 'order."state'),
    enumColumn("similar_array", item.key.schema, "array", '"Order.""StateExtra"[]'),
    enumColumn("wrong_qualified_schema", item.key.schema, "array", '"Other"."Order.""State"[]'),
  ];
  const snapshot = { ...enumSnapshot, schemas: [{ ...enumSnapshot.schemas[0], tables: [{ ...enumSnapshot.schemas[0].tables[1], columns }], enums: [item] }] };
  expect(enumReferences(snapshot, item)[0].fields.map(({ column }) => column.name)).toEqual(["scalar", "array", "unqualified_array"]);
  expect(enumReferences(snapshot, { ...item, key: { ...item.key, name: "unused" } })).toEqual([]);
});
