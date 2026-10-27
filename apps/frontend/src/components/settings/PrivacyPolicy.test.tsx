import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { I18nProvider, useI18n } from "../../i18n";
import type { Language } from "../../platform/settings-types";
import { PrivacyPolicy } from "./PrivacyPolicy";

function LocalizedPolicy({ language, isMas }: { language: Language; isMas: boolean }) {
  const i18n = useI18n(language);
  return <I18nProvider value={i18n}><PrivacyPolicy isMas={isMas} /></I18nProvider>;
}

it.each(["en", "zhCn"] as const)("shows the store policy without community links in %s", (language) => {
  render(<LocalizedPolicy language={language} isMas />);
  const policy = screen.getByRole("region");
  expect(policy).toHaveTextContent("support@nodalos.com");
  expect(policy).toHaveTextContent("Apple StoreKit");
  expect(policy).not.toHaveTextContent(/github|akz142857|community edition|社区版/i);
  expect(policy).toHaveTextContent(language === "en" ? "Retention and deletion" : "保留与删除");
});

it.each(["en", "zhCn"] as const)("preserves actual community service disclosures in %s", (language) => {
  render(<LocalizedPolicy language={language} isMas={false} />);
  const policy = screen.getByRole("region");
  expect(policy).toHaveTextContent("GitHub");
  expect(policy).toHaveTextContent("support@nodalos.com");
  expect(policy).not.toHaveTextContent("github.com/akz142857/NodalStudio/issues");
});
