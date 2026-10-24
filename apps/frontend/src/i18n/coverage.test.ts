import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { capabilityDefinitions, capabilityTargets, capabilityStatusLabels } from "../platform/capabilities";
import { capabilityMessages, capabilityTargetMessages, capabilityStatusMessages } from "./capabilities";
import { en } from "./messages/en";

it("keeps translated capability declarations aligned with the owning capability catalog", () => {
  for (const definition of capabilityDefinitions) {
    const keys = capabilityMessages[definition.id];
    expect(en[keys.name]).toBe(definition.name);
    expect(en[keys.category]).toBe(definition.category);
    for (const target of capabilityTargets) expect(en[keys.targets[target.id]]).toBe(definition.targets[target.id].scope);
  }
  for (const target of capabilityTargets) expect(en[capabilityTargetMessages[target.id]]).toBe(target.label);
  for (const status of Object.keys(capabilityStatusLabels) as (keyof typeof capabilityStatusLabels)[]) {
    expect(en[capabilityStatusMessages[status]]).toBe(capabilityStatusLabels[status]);
  }
});

it("prevents new static JSX copy in the migrated settings/navigation surfaces", () => {
  const files = ["App.tsx", "components/SettingsPage.tsx", "components/settings/UpdatePanel.tsx", "components/settings/UpdateBanner.tsx", "components/CapabilitiesMatrix.tsx", "components/CommandPalette.tsx", "components/ModelViewNavigation.tsx", "components/SidebarRail.tsx", "design-system/forms.tsx"];
  // Product/technical identifiers and literal path examples are deliberately not translated.
  const identifiers = new Set(["Nodal Studio", "AI", "Git", "PostgreSQL", "MySQL", "English", "v", "s", "· SSL", ".gitattributes", "px", "ms", "%"]);
  const untranslated: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(`src/${file}`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      let text: string | undefined;
      if (ts.isJsxText(node)) text = node.text.trim();
      if (ts.isJsxAttribute(node) && ["label", "title", "description", "aria-label", "placeholder", "retryLabel"].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) text = node.initializer.text;
      if (text && /[a-z]/i.test(text) && !identifiers.has(text) && !text.startsWith("/") && !text.startsWith("https://")) untranslated.push(`${file}: ${text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(untranslated).toEqual([]);
});
