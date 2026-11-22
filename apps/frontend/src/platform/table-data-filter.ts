import { z } from "zod";

export const MAX_FILTER_RULES = 10;
export const MAX_FILTER_VALUE_BYTES = 4096;
export const MAX_FILTER_LIST_VALUES = 50;

const equality = ["equals", "notEquals"] as const;
const ordering = ["less", "lessOrEqual", "greater", "greaterOrEqual"] as const;

export const filterOperatorGroups = {
  comparison: [...equality, ...ordering],
  text: ["contains", "notContains", "startsWith", "notStartsWith", "endsWith", "notEndsWith"],
  missing: ["isNull", "isNotNull", "isEmpty", "isNotEmpty"],
  range: ["between", "notBetween", "inList", "notInList"],
} as const;

export type TableFilterOperator = (typeof filterOperatorGroups)[keyof typeof filterOperatorGroups][number];

const column = z.string();
const encoder = new TextEncoder();
const value = z.string().max(MAX_FILTER_VALUE_BYTES)
  .refine((text) => !text.includes("\0") && encoder.encode(text).length <= MAX_FILTER_VALUE_BYTES);
const nonempty = value.min(1);

export const tableFilterRuleSchema = z.discriminatedUnion("kind", [
  z.object({ column, kind: z.enum(filterOperatorGroups.missing) }),
  z.object({ column, kind: z.enum(equality), value }),
  z.object({ column, kind: z.enum([...ordering, ...filterOperatorGroups.text]), value: nonempty }),
  z.object({ column, kind: z.enum(["between", "notBetween"]), value: nonempty, end: nonempty }),
  z.object({ column, kind: z.enum(["inList", "notInList"]), values: z.array(nonempty.refine((text) => !text.includes("\n")))
    .min(1).max(MAX_FILTER_LIST_VALUES) }),
]);

export const tableFilterSchema = z.object({
  match: z.enum(["all", "any"]),
  rules: z.array(tableFilterRuleSchema).min(1).max(MAX_FILTER_RULES),
});

export type TableFilterRule = z.infer<typeof tableFilterRuleSchema>;
export type TableFilter = z.infer<typeof tableFilterSchema>;

const tableFilterConditionSchema = z.object({
  enabled: z.boolean(),
  column,
  kind: z.enum([
    ...filterOperatorGroups.comparison, ...filterOperatorGroups.text,
    ...filterOperatorGroups.missing, ...filterOperatorGroups.range,
  ]),
  value: z.string().max(MAX_FILTER_LIST_VALUES * (MAX_FILTER_VALUE_BYTES + 1) - 1),
  end: z.string().max(MAX_FILTER_VALUE_BYTES),
});

export type TableFilterCondition = z.infer<typeof tableFilterConditionSchema>;

export function tableFilterRule(condition: TableFilterCondition): TableFilterRule | undefined {
  const { column, kind, value, end } = condition;
  const values = kind === "inList" || kind === "notInList" ? value.split("\n").filter(Boolean) : undefined;
  return tableFilterRuleSchema.safeParse({ column, kind, value, end, values }).data;
}

export const tableFilterSettingsSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(tableFilterConditionSchema).min(1).max(MAX_FILTER_RULES),
}).refine(({ conditions }) => conditions.every((condition) => !condition.enabled || Boolean(tableFilterRule(condition))));

export type TableFilterSettings = z.infer<typeof tableFilterSettingsSchema>;

export function tableFilterSettingsFromLegacy(filter: TableFilter): TableFilterSettings {
  return {
    match: filter.match,
    conditions: filter.rules.map((rule) => ({
      enabled: true,
      column: rule.column,
      kind: rule.kind,
      value: "values" in rule ? rule.values.join("\n") : "value" in rule ? rule.value : "",
      end: "end" in rule ? rule.end : "",
    })),
  };
}

export function enabledTableFilter(settings?: TableFilterSettings): TableFilter | undefined {
  if (!settings) return;
  const rules = settings.conditions.flatMap((condition) => {
    const rule = condition.enabled ? tableFilterRule(condition) : undefined;
    return rule ? [rule] : [];
  });
  return rules.length ? { match: settings.match, rules } : undefined;
}
