import type { useI18n } from "../i18n";
type Translate = ReturnType<typeof useI18n>["t"];
const messages = {
  "Primary key presence": "preflight.text0",
  "Key references": "preflight.text1",
  "PostgreSQL FK types": "preflight.text2",
  "MySQL FK types": "preflight.text3",
  "Names containing whitespace": "preflight.text4",
  "Ordinary and partitioned tables only. A missing primary key is a design suggestion; foreign tables and views are outside this rule.": "preflight.text5",
  "Checks captured PK/FK column lists and endpoints. A target absent from this snapshot may be outside introspection scope; it is not proof of a dangling database constraint.": "preflight.text6",
  "Checks captured built-in type identities and flags different known type families for review. Cross-type operators, casts, domains, collation and constraint validation state are not captured.": "preflight.text7",
  "Not applicable: this is not a PostgreSQL snapshot.": "preflight.text8",
  "Checks integer size/sign and DECIMAL precision/scale/sign. String length alone is not a mismatch. Character set, collation, storage engine and server-specific restrictions are not captured.": "preflight.text9",
  "Not applicable: this is not a MySQL snapshot.": "preflight.text10",
  "Optional style hint for table and column names. Quoted identifiers containing whitespace are legal; this is not a database error.": "preflight.text11",
  "Disabled by default. Enable the optional table/column naming style hint.": "preflight.text12",
  "No primary key is captured for this table.": "preflight.text13",
  "Review whether this table needs a stable row identifier. A primary key is optional; views and some analytical tables use other designs.": "preflight.text14",
  "The captured primary key column list is inconsistent with the table metadata.": "preflight.text15",
  "Refresh metadata or review capture coverage before drawing conclusions about the live database.": "preflight.text16",
  "This name contains whitespace and may require quoting in SQL.": "preflight.text17",
  "Keep quoted names if intentional, or follow your team's naming convention. No rename is performed.": "preflight.text18",
  "The captured foreign key column lists are inconsistent.": "preflight.text19",
  "Review the captured column lists and refresh metadata. A snapshot inconsistency does not establish that a physical constraint is invalid.": "preflight.text20",
  "The referenced table is outside the loaded snapshot.": "preflight.text21",
  "Capture the referenced schema/table to inspect it. Cross-schema references can be valid even when their target is not captured.": "preflight.text22",
  "Review catalog metadata and the existing physical constraint on the database. This snapshot cannot establish complete foreign key compatibility.": "preflight.text23",
  "Review these captured type differences and refresh metadata. Existing physical constraints may rely on details not captured here; no invalidity or repair is inferred.": "preflight.text24",
  "Available type metadata agrees.": "preflight.text25",
  "PostgreSQL domain or custom-type compatibility needs catalog information absent from this snapshot.": "preflight.text26",
  "These PostgreSQL types need catalog/operator information absent from this snapshot.": "preflight.text27",
  "Different PostgreSQL types may support cross-type comparisons; the required operators and casts are not captured.": "preflight.text28",
  "The captured PostgreSQL columns belong to different built-in type families.": "preflight.text29",
  "MySQL type metadata is not identified as MySQL catalog data.": "preflight.text30",
  "MySQL character foreign keys require matching character set and collation; neither is captured. String length differences alone are not a mismatch.": "preflight.text31",
  "MySQL integer formatted types are missing or inconsistent; signedness cannot be established.": "preflight.text32",
  "MySQL integer foreign key columns differ in storage size or signedness; display width is ignored.": "preflight.text33",
  "MySQL DECIMAL precision/scale is not available in the captured formatted types.": "preflight.text34",
  "MySQL DECIMAL foreign key columns differ in precision, scale or signedness.": "preflight.text35",
  "This MySQL type pair is outside the first version's integer/DECIMAL checks; compatibility cannot be determined from this snapshot.": "preflight.text36",
  "Snapshot primaryKey: absent": "preflight.text37",
} as const;
const prefixes = {
  "Table kind: ": "preflight.prefix0",
  "Primary key columns: ": "preflight.prefix1",
  "Missing columns: ": "preflight.prefix2",
  "Table name: ": "preflight.prefix3",
  "Column name: ": "preflight.prefix4",
  "Foreign key: ": "preflight.prefix5",
  "Source columns: ": "preflight.prefix6",
  "Target: ": "preflight.prefix7",
  "Target columns: ": "preflight.prefix8",
  "Missing source columns: ": "preflight.prefix9",
  "Missing target columns: ": "preflight.prefix10",
  "Source type: ": "preflight.prefix11",
  "Target type: ": "preflight.prefix12",
} as const;
export function preflightText(text: string, t: Translate): string {
  const key = messages[text as keyof typeof messages];
  if (key) return t(key);
  for (const [prefix, key] of Object.entries(prefixes)) if (text.startsWith(prefix)) return t(key, {value: text.slice(prefix.length)});
  if (/^Pair \d+:/.test(text)) return t("preflight.pair", {value: text.slice(5)});
  return text;
}
