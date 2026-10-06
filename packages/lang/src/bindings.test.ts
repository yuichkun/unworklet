import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { authoredBindingNames } from "./bindings.ts";

const bindings = (source: string): string[] =>
  [
    ...authoredBindingNames(ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest)),
  ].sort();

test("authored bindings include import aliases and type-only imports", () => {
  expect(
    bindings(`import defaultName, { original as alias, type Shape } from "helper";
import * as namespaceName from "other";
import type TypeDefault from "types";
import "side-effect";
import member = namespaceName.member;
export { alias as outward };`),
  ).toEqual(["Shape", "TypeDefault", "alias", "defaultName", "member", "namespaceName"]);
});

test("authored bindings include nested names and binding patterns but exclude property names", () => {
  expect(
    bindings(`const { key: local, ...rest } = object;
const [head, , ...tail] = items;
function fn(param: number) {
  const value = function inner() {};
  const constructor = class Inner {};
  try {} catch (caught) {}
  return { property: param };
}
class Outer {}
enum Choice { Member }
namespace Scope { const nested = 1; }
interface Shape { member: number }
type Alias = number;
declare module "extension" {}`),
  ).toEqual([
    "Alias",
    "Choice",
    "Inner",
    "Outer",
    "Scope",
    "Shape",
    "caught",
    "constructor",
    "fn",
    "head",
    "inner",
    "local",
    "nested",
    "param",
    "rest",
    "tail",
    "value",
  ]);
});
