import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import type { Language } from "../platform/settings-types";
import { reportSnapshot } from "../test/schema-report-fixture";
import type { ProgramDefinition, DatabaseSnapshot } from "../platform/types";
import { SchemaTree } from "./SchemaTree";
import { createTranslator } from "../i18n";
import { operationProperties, propertyValue } from "./schema-change-details";
const program: ProgramDefinition = {key:{kind:"function",schema:"public",name:"total(integer)"},arguments:"id integer",definition:"SELECT '<script>literal</script>'",language:"sql",owner:"fixture",resultType:"integer",table:null,enabled:null};
const snapshot: DatabaseSnapshot = {...reportSnapshot, schemas:[{...reportSnapshot.schemas[0],programs:[program,{...program,key:{...program.key,name:"total(text)"},definition:null}],dependencies:[{source:program.key,target:reportSnapshot.schemas[0].tables[0].key}]}]};
function Scope({language="en"}: {language?:Language}) {return <I18nProvider value={useI18n(language)}><SchemaTree snapshot={snapshot} onSelectTable={vi.fn()}/></I18nProvider>;}
it("searches overloaded functions, shows escaped definition and catalog dependencies, and retranslates selection",()=>{
 const view=render(<Scope/>);
 fireEvent.change(screen.getByRole("searchbox"),{target:{value:"total"}});
 fireEvent.click(screen.getByRole("button",{name:"total(integer)"}));
 const detail=screen.getByRole("region",{name:"Function total(integer)"});
 expect(detail).toHaveTextContent(program.definition!);
 expect(detail.querySelector("script")).toBeNull();
 expect(within(detail).getByRole("button",{name:`${snapshot.schemas[0].tables[0].key.schema}.${snapshot.schemas[0].tables[0].key.name}`})).toBeVisible();
 expect(screen.getByRole("button",{name:"total(integer)"})).toHaveAttribute("aria-current","true");
 view.rerender(<Scope language="zhCn"/>);
 expect(screen.getByRole("region",{name:"函数 total(integer)"})).toHaveTextContent("依赖对象");
 expect(screen.getByRole("searchbox")).toHaveValue("total");
 fireEvent.click(screen.getByRole("button",{name:"total(text)"}));
 expect(screen.getByRole("region",{name:"函数 total(text)"})).toHaveTextContent("定义不可见");
 fireEvent.keyDown(screen.getByRole("region",{name:"函数 total(text)"}),{key:"Escape"});
 expect(screen.queryByRole("region",{name:"函数 total(text)"})).not.toBeInTheDocument();
});
it("resolves history definitions by kind and signature and preserves dependency targets",()=>{
 expect(propertyValue("D", createTranslator("zh-CN"), "enabled")).toBe("禁用");
 expect(propertyValue("D", createTranslator("en"), "definition")).toBe("D");
 const operation={operationType:"alterProgram" as const,object:program.key,risk:"medium" as const,before:"old",after:"new"};
 expect(operationProperties(snapshot,operation,"after")?.definition).toBe(program.definition);
 expect(operationProperties(snapshot,{...operation,object:{...program.key,kind:"procedure"}},"after")).toBeUndefined();
 expect(operationProperties(snapshot,{...operation,operationType:"alterDependencies"},"after")?.dependencies).toEqual([snapshot.schemas[0].tables[0].key]);
});
