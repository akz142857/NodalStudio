import { expect, it } from "vitest";
import { createTranslator } from "./messages";
import { translateConnectionFailure } from "./connection-errors";
import { translateRelationshipValidation } from "./relationship-validation";
import { connectionFailure } from "../components/connection-test-state";
const zh = createTranslator("zh-CN"), en = createTranslator("en");
it("preserves native codes across transport and renders them in the current locale", () => {
  const failure = connectionFailure({ stage: "database", code: "passwordRequired", message: "Enter the database password before testing.", sshConnected: false });
  expect(translateConnectionFailure(failure, zh)).toBe("请先输入数据库密码，再测试连接。");
  expect(translateConnectionFailure(failure, en)).toBe(failure.message);
  expect(translateConnectionFailure({ code: "authenticationRejected", message: "fallback" }, zh)).toContain("身份验证失败");
});
it("does not guess translations for unknown or legacy diagnostics", () => {
  for (const code of [undefined, "futureCode", "constructor", "__proto__"]) {
    expect(translateConnectionFailure({ code, message: "driver diagnostic" }, zh)).toBe("driver diagnostic");
    expect(translateRelationshipValidation("custom evidence", code, zh)).toBe("custom evidence");
  }
});
it("localizes coded relationship validation without changing its evidence", () => {
  expect(translateRelationshipValidation("Source and target column types differ.", "typeMismatch", zh)).toBe("源字段与目标字段的类型不同。");
  expect(translateRelationshipValidation("fallback", "duplicate", en)).toBe("This logical relationship already exists.");
});
