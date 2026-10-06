import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderOffline } from "@unworklet/offline";
import ts from "typescript";
import { expect, test } from "vite-plus/test";

import { classify } from "./classify.ts";
import { containerValueOrigin, isConstDeclaration } from "./container-values.ts";
import { renderLowered } from "./goldenHarness.ts";
import { buildProgram } from "./program.ts";
import { loadUwkProcessor } from "./materialize-lowered.ts";

const shapes = [
  ["array member", "const values = [VALUE];", "values[0]"],
  ["object member", "const values = { left: VALUE };", "values.left"],
  ["object index", "const values = { left: VALUE };", 'values["left"]'],
  ["array binding", "const [value] = [VALUE];", "value"],
  ["object binding", "const { left } = { left: VALUE };", "left"],
  ["renamed binding", "const { left: value } = { left: VALUE };", "value"],
  ["nested member", "const values = { channels: [{ left: VALUE }] };", "values.channels[0].left"],
  ["nested binding", "const { channels: [{ left }] } = { channels: [{ left: VALUE }] };", "left"],
  ["array offset", "const [, value] = [3, VALUE];", "value"],
  ["const assertion", "const values = [VALUE] as const;", "values[0]"],
  ["computed key", 'const values = { ["left"]: VALUE };', "values.left"],
  ["scalar alias", "const value = VALUE; const values = { value };", "values.value"],
] as const;

const config = { sampleRate: 48000, duration: 128 / 48000 };
const processor = (body: string, declarations = ""): string => `
const out = audioOutput({ channels: 1, name: "main" });
${declarations}
process(() => { forSample(i => { ${body} }); });
`;

test.each(shapes)("renders DSP arithmetic through a stable %s", async (_, declaration, value) => {
  const actual = await renderLowered(
    processor(`${declaration.replaceAll("VALUE", "f32(0.5) * 2")} out.ch(0)[i] = ${value} * 2;`),
    config,
  );
  const explicit = await renderLowered(
    processor(
      `${declaration.replaceAll("VALUE", "mul(f32(0.5), 2)")} out.ch(0).at(i).write(mul(${value}, 2));`,
    ),
    config,
  );
  expect(explicit.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
  expect(actual.outputs).toEqual(explicit.outputs);
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each(shapes)(
  "does not read a lowered boolean Node through a stable %s",
  async (_, declaration, value) => {
    const actual = await renderLowered(
      processor(
        `${declaration.replaceAll("VALUE", "a && b")} out.ch(0)[i] = ${value} ? 2 : 1;`,
        'const a = state.bool(true).named("a"); const b = state.bool(false).named("b");',
      ),
      config,
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(1));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["i32", "i32(7) / 2", "div(i32(7), 2)", "value / 2", "div(value, 2)"],
  ["i64", "i64(7n) / i64(2n)", "div(i64(7n), i64(2n))", "value / i64(2n)", "div(value, i64(2n))"],
  ["f64", "f64(16777217) - 0", "sub(f64(16777217), 0)", "value - 16777216", "sub(value, 16777216)"],
] as const)(
  "preserves %s arithmetic through destructuring",
  async (_, initial, explicitInitial, expression, explicitExpression) => {
    const actual = await renderLowered(
      processor(`const { value } = { value: ${initial} }; out.ch(0)[i] = f32(${expression});`),
      config,
    );
    const explicit = await renderLowered(
      processor(
        `const { value } = { value: ${explicitInitial} }; out.ch(0).at(i).write(f32(${explicitExpression}));`,
      ),
      config,
    );
    expect(explicit.outputs.main[0]).toEqual(new Float32Array(128).fill(1));
    expect(actual.outputs).toEqual(explicit.outputs);
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

const mutable = [
  ["direct object write", "const values = { left: f32(0.5) * 2 }; values.left = 3;", "values.left"],
  ["direct array write", "const values = [f32(0.5) * 2]; values[0] = 3;", "values[0]"],
  [
    "alias write",
    "const values = { left: f32(0.5) * 2 }; const alias = values; alias.left = 3;",
    "values.left",
  ],
  [
    "original write",
    "const values = { left: f32(0.5) * 2 }; const alias = values; values.left = 3;",
    "alias.left",
  ],
  [
    "nested alias write",
    "const values = { inner: { left: f32(0.5) * 2 } }; const { inner } = values; inner.left = 3;",
    "values.inner.left",
  ],
  [
    "mutator escape",
    "const values = [f32(0.5) * 2]; function reset(items: number[]) { items[0] = 3; } reset(values);",
    "values[0]",
  ],
  ["array mutator", "const values = [f32(0.5) * 2]; values.fill(3);", "values[0]"],
  ["binding reassignment", "let { value } = { value: f32(0.5) * 2 }; value = 3;", "value"],
  [
    "direct nested binding alias",
    "const { inner } = { inner: { left: f32(0.5) * 2 } }; inner.left = 3;",
    "inner.left",
  ],
  [
    "parenthesized method receiver",
    "const values = { left: f32(0.5) * 2, reset: function () { this.left = 3; } }; (values.reset)();",
    "values.left",
  ],
  [
    "generic method receiver",
    "const values = { left: f32(0.5) * 2, reset: function <T>() { this.left = 3; } }; (values.reset<number>)();",
    "values.left",
  ],
  [
    "stale scalar",
    "let value = f32(0.5) * 2; value = 3; const values = { value };",
    "values.value",
  ],
  ["array rest target", "const values={left:f32(0.5)*2}; [...values.left]=[3];", "values.left"],
  [
    "nested array rest target",
    "const values={left:f32(0.5)*2}; [...[values.left]]=[3];",
    "values.left",
  ],
  [
    "wrapped array rest target",
    "const values={left:f32(0.5)*2}; [...(values.left)]=[3];",
    "values.left",
  ],
  [
    "asserted array rest target",
    "const values={left:f32(0.5)*2}; [...(values.left as number[])]=[3];",
    "values.left",
  ],
  [
    "object rest target",
    "const values={left:f32(0.5)*2}; ({...values.left}={valueOf(){return 3;}});",
    "values.left",
  ],
  [
    "wrapped object rest target",
    "const values={left:f32(0.5)*2}; ({...(values.left)}={valueOf(){return 3;}});",
    "values.left",
  ],
  [
    "array rest iteration target",
    "const values={left:f32(0.5)*2}; for([...values.left] of [[3]]){}",
    "values.left",
  ],
  [
    "object rest iteration target",
    "const values={left:f32(0.5)*2}; for({...values.left} of [{valueOf(){return 3;}}]){}",
    "values.left",
  ],
] as const;

test.each(mutable)("preserves build-time arithmetic after %s", async (_, declarations, value) => {
  const actual = await renderLowered(
    processor(`${declarations} out.ch(0)[i] = Math.max(0, ${value} * 2);`),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each([
  ["numeric sibling", "const values = { left: f32(0.5) * 2, gain: 3 };", "values.gain", "other"],
  ["array length", "const values = [f32(0.5) * 2];", "values.length", "other"],
  ["numeric element", "const values = [f32(0.5) * 2, 3];", "values[1]", "other"],
  ["bare container", "const values = { left: f32(0.5) * 2 };", "values", "other"],
  ["numeric binding", "const { gain } = { left: f32(0.5) * 2, gain: 3 };", "gain", "other"],
  ["real State", "const values = { left: a };", "values.left", "state"],
  [
    "mixed dynamic State",
    "const values = [a && b, a]; const index = Math.floor(1);",
    "values[index]",
    "state",
  ],
  [
    "mixed numeric index",
    "const values = [f32(0.5) * 2, 3]; const index = Math.floor(1);",
    "values[index]",
    "other",
  ],
  [
    "later spread",
    "const values = { left: f32(0.5) * 2, ...{ left: 3 } };",
    "values.left",
    "other",
  ],
  ["earlier array spread", "const values = [...[2, 3], f32(0.5) * 2];", "values[1]", "other"],
  ["duplicate property", "const values = { left: f32(0.5) * 2, left: 3 };", "values.left", "other"],
  [
    "getter replacement",
    "const values = { left: f32(0.5) * 2, get left() { return 3; } };",
    "values.left",
    "other",
  ],
  [
    "unknown key",
    'const key: string = "left"; const values = { left: f32(0.5) * 2, [key]: 3 };',
    "values.left",
    "other",
  ],
  ["default", "const { left = f32(0.5) * 2 } = { left: 3 };", "left", "other"],
  ["rest", "const [left, ...rest] = [f32(0.5) * 2, 3];", "rest[0]", "other"],
  [
    "mixed helper result",
    "function get(flag: boolean) { if (flag) return f32(1) * 2; return 3; } const values = { left: get(false) };",
    "values.left",
    "other",
  ],
] as const)("keeps existing classification for %s", (_, declarations, value, expected) => {
  const { checker, sourceFile } = buildProgram(
    `const a = state.bool(true); const b = state.bool(false); ${declarations} const result = ${value};`,
  );
  const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
  expect(classify(checker, statement.declarationList.declarations[0]!.initializer!)).toBe(expected);
});

test("reads an actual State selected from a mixed dynamic array", async () => {
  const actual = await renderLowered(
    processor(
      "const values = [a && b, a]; const index = Math.floor(1); out.ch(0)[i] = values[index] ? 1 : 0;",
      'const a = state.bool(true).named("a"); const b = state.bool(false).named("b");',
    ),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(1));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each([
  [
    "array length sibling",
    "const values = [f32(1) * 2]; const count = values.length;",
    "values[0]",
    "node",
  ],
  [
    "numeric sibling use",
    "const values = { left: f32(1) * 2, gain: 3 }; const gain = Math.max(values.gain, 0);",
    "values.left",
    "node",
  ],
  [
    "unrelated shadow",
    "const values = [f32(1) * 2]; function shadow() { const values = [3]; values[0] = 4; }",
    "values[0]",
    "node",
  ],
  ["parenthesized container", "const values = { left: f32(1) * 2 };", "(values).left", "node"],
  [
    "asserted container",
    "const values = { left: f32(1) * 2 };",
    "(values as {left:number}).left",
    "node",
  ],
  [
    "type assertion",
    "const values = { left: f32(1) * 2 };",
    "(<{left:number}>values).left",
    "node",
  ],
  [
    "satisfies container",
    "const values = { left: f32(1) * 2 };",
    "(values satisfies {left:number}).left",
    "node",
  ],
  ["non-null container", "const values = { left: f32(1) * 2 };", "values!.left", "node"],
  ["inline member", "", "({left:f32(1)*2}).left", "node"],
  ["numeric property", "const values = { 0: f32(1) * 2 };", "values[0]", "node"],
  [
    "earlier object spread",
    "const values = { ...{ left: 3 }, left: f32(1) * 2 };",
    "values.left",
    "node",
  ],
  ["later array spread", "const values = [f32(1) * 2, ...[3]];", "values[0]", "node"],
  ["unary value", "const values = {left: -f32(1)};", "values.left", "node"],
  ["conditional value", "const values = {left: a ? 2 : 1};", "values.left", "node"],
  ["build-time conditional", "const values = {left: true ? a : b};", "values.left", "state"],
  ["nullish State", "const values = {left: a ?? b};", "values.left", "state"],
  ["missing field", "const values = {left:f32(1)*2};", "values.missing", "other"],
  ["missing element", "const values = [f32(1)*2];", "values[1]", "other"],
  ["omitted element", "const values = [,f32(1)*2];", "values[0]", "other"],
  [
    "shorthand escape",
    "const values = {left:f32(1)*2}; const escaped = {values};",
    "values.left",
    "other",
  ],
  [
    "unknown binding key",
    'const key:string="left"; const {[key]:value} = {left:f32(1)*2};',
    "value",
    "other",
  ],
  ["compound write", "const values = {left:f32(1)*2}; values.left += 3;", "values.left", "other"],
  ["prefix write", "const values = {left:f32(1)*2}; ++values.left;", "values.left", "other"],
  ["postfix write", "const values = {left:f32(1)*2}; values.left--;", "values.left", "other"],
  ["delete", "const values = {left:f32(1)*2}; delete values.left;", "values.left", "other"],
  [
    "for-of write",
    "const values = {left:f32(1)*2}; for (values.left of [3]) {}",
    "values.left",
    "other",
  ],
  [
    "for-in write",
    "const values = {left:f32(1)*2}; for (values.left in {key:3}) {}",
    "values.left",
    "other",
  ],
  [
    "object target",
    "const values = {left:f32(1)*2}; ({left:values.left}={left:3});",
    "values.left",
    "other",
  ],
  ["array target", "const values = {left:f32(1)*2}; [values.left]=[3];", "values.left", "other"],
  ["mutable container", "let values = {left:f32(1)*2}; values = {left:3};", "values.left", "other"],
  ["cyclic scalar", "const x=y; const y=x; const values = {left:x};", "values.left", "other"],
] as const)("checks source-local provenance for %s", (_, declarations, value, expected) => {
  const { checker, sourceFile } = buildProgram(
    `const a = state.bool(true); const b = state.bool(false); ${declarations} const result = ${value};`,
  );
  const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
  expect(classify(checker, statement.declarationList.declarations[0]!.initializer!)).toBe(expected);
});

test("preserves build-time arithmetic after a direct eval mutation", async () => {
  const actual = await renderLowered(
    processor(
      'const values = { left: f32(0.5) * 2 }; eval("values.left = 3"); out.ch(0)[i] = Math.max(0, values.left * 2);',
    ),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test("preserves indexed DSP reads inside containers", async () => {
  const actual = await renderLowered(
    processor(
      "storage[0] = f32(1); const values = [storage[0]]; out.ch(0)[i] = values[0] * 2;",
      'const storage = state.buffer.f32({size:1}).named("storage");',
    ),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each(["values.reset?.()", "values.reset``", "(values.reset)``"] as const)(
  "preserves a container mutated through %s",
  async (call) => {
    const actual = await renderLowered(
      processor(
        `const values = { left: f32(0.5) * 2, reset: function () { this.left = 3; } }; ${call}; out.ch(0)[i] = Math.max(0, values.left * 2);`,
      ),
      config,
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["const values = {__proto__:f32(1)*2};", "values.__proto__", "other"],
  ["const values = {__proto__:{left:f32(1)*2}};", "values.left", "other"],
  ['const values = {["__proto__"]:f32(1)*2};', 'values["__proto__"]', "other"],
  ["const values = {left:3,left:f32(1)*2};", "values.left", "node"],
  ['const key:string="left"; const values = {[key]:3,left:f32(1)*2};', "values.left", "node"],
] as const)(
  "respects object property definition semantics: %s",
  (declarations, value, expected) => {
    const { checker, sourceFile } = buildProgram(`${declarations} const result = ${value};`);
    const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
    expect(classify(checker, statement.declarationList.declarations[0]!.initializer!)).toBe(
      expected,
    );
  },
);

test.each(mutable)("rejects stale provenance after %s", (_, declarations, value) => {
  const { checker, sourceFile } = buildProgram(`${declarations} const result = ${value};`);
  const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
  expect(classify(checker, statement.declarationList.declarations[0]!.initializer!)).toBe("other");
});

function literalOrigin(source: string): string | undefined {
  const file = ts.createSourceFile("/fixture.ts", source, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram(
    [file.fileName],
    { noLib: true, noResolve: true },
    {
      getSourceFile: (name) => (name === file.fileName ? file : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getDirectories: () => [],
      fileExists: (name) => name === file.fileName,
      readFile: (name) => (name === file.fileName ? source : undefined),
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    },
  );
  const statement = file.statements.at(-1)! as ts.VariableStatement;
  const expression = statement.declarationList.declarations[0]!.initializer!;
  return containerValueOrigin(program.getTypeChecker(), expression)?.getText();
}

test.each(shapes)("resolves the literal origin of %s", (name, declarations, value) => {
  expect(literalOrigin(`${declarations} const result = ${value};`)).toBe(
    name === "scalar alias" ? "value" : "VALUE",
  );
});

test.each([
  ["const values={left:VALUE,other:3};", "values.left", "VALUE"],
  ["const values={left:VALUE};", "((values as {left:number})!).left", "VALUE"],
  ["const values={left:VALUE};", "(<{left:number}>values).left", "VALUE"],
  ["const values={left:VALUE};", "(values satisfies {left:number}).left", "VALUE"],
  ["const values=[VALUE];const count=values.length;", "values[0]", "VALUE"],
  ["const values=[VALUE];", "values.length", undefined],
  ["const values={left:VALUE}; const alias=values;", "values.left", undefined],
  ["const values={left:VALUE}; const escaped={values};", "values.left", undefined],
  ["const values={left:VALUE}; values.left=3;", "values.left", undefined],
  ["const values=[VALUE]; values[0]=3;", "values[0]", undefined],
  ["const values={left:VALUE}; values.left+=3;", "values.left", undefined],
  ["const values={left:VALUE}; ++values.left;", "values.left", undefined],
  ["const values={left:VALUE}; values.left--;", "values.left", undefined],
  ["const values={left:VALUE}; delete values.left;", "values.left", undefined],
  ["const values={left:VALUE}; for(values.left of [3]){}", "values.left", undefined],
  ["const values={left:VALUE}; for(values.left in {key:3}){}", "values.left", undefined],
  ["const values={left:VALUE}; ({left:values.left}={left:3});", "values.left", undefined],
  ["const values={left:VALUE}; [values.left]=[3];", "values.left", undefined],
  ["const values={left:VALUE}; (values.left)=3;", "values.left", undefined],
  ["const values={left:VALUE}; values.left.deep=3;", "values.left", undefined],
  ["const values={left:VALUE}; values.left[0]=3;", "values.left", undefined],
  ["const values={left:VALUE}; reset(values);", "values.left", undefined],
  ["const values={left:VALUE}; const x=values.missing;", "values.left", undefined],
  ["const values={left:VALUE}; (eval)('values.left=3');", "values.left", undefined],
  [
    "const values={left:VALUE,reset:function(){this.left=3}}; values.reset();",
    "values.left",
    undefined,
  ],
  [
    "const values={left:VALUE,reset:function(){this.left=3}}; (values.reset)();",
    "values.left",
    undefined,
  ],
  [
    "const values={left:VALUE,reset:function(){this.left=3}}; values.reset?.();",
    "values.left",
    undefined,
  ],
  [
    "const values={left:VALUE,reset:function(){this.left=3}}; values.reset``;",
    "values.left",
    undefined,
  ],
  [
    "const values={left:VALUE,reset:function(){this.left=3}}; (values.reset)``;",
    "values.left",
    undefined,
  ],
  ["const values={left:VALUE,reset:function(){}}; use(values.reset);", "values.left", "VALUE"],
  [
    "const values={left:VALUE}; function shadow(){const values={left:3};values.left=4}",
    "values.left",
    "VALUE",
  ],
  ["const values={left:VALUE};", "values.missing", undefined],
  ["const values=[VALUE];", "values[1]", undefined],
  ["const values=[,VALUE];", "values[0]", undefined],
  ["const values={left:VALUE}; const key:string='left';", "values[key]", undefined],
  ["const values={left:VALUE,left:3};", "values.left", "3"],
  ["const values={left:3,left:VALUE};", "values.left", "VALUE"],
  ["const values={left:VALUE,get left(){return 3}};", "values.left", undefined],
  ["const values={left:VALUE,set left(value:number){}};", "values.left", undefined],
  ["const values={left:VALUE,left(){return 3}};", "values.left", undefined],
  ["const key:string='left';const values={left:VALUE,[key]:3};", "values.left", undefined],
  ["const key:string='left';const values={[key]:3,left:VALUE};", "values.left", "VALUE"],
  ["const values={left:VALUE,...{left:3}};", "values.left", undefined],
  ["const values={...{left:3},left:VALUE};", "values.left", "VALUE"],
  ["const values=[...[3],VALUE];", "values[1]", undefined],
  ["const values=[VALUE,...[3]];", "values[0]", "VALUE"],
  ["const values={__proto__:VALUE};", "values.__proto__", undefined],
  ["const values={__proto__:{left:VALUE}};", "values.left", undefined],
  ["const values={['__proto__']:VALUE};", "values['__proto__']", undefined],
  ["const [left,...rest]=[VALUE,3];", "rest[0]", undefined],
  ["const {left,...rest}={left:VALUE,right:3};", "rest", undefined],
  ["const {left=VALUE}={left:3};", "left", undefined],
  ["const key:string='left';const {[key]:left}={left:VALUE};", "left", undefined],
  ["const {inner}={inner:{left:VALUE}};inner.left=3;", "inner.left", undefined],
  ["let values={left:VALUE};", "values.left", undefined],
  ["declare const values:{left:number};", "values.left", undefined],
  ["const values=foreign;", "values.left", undefined],
  ["", "foreign.left", undefined],
  ["", "({left:VALUE}).left", "VALUE"],
  ["", "{left:VALUE}", undefined],
  ["", "(3).missing", undefined],
] as const)("checks a literal provenance boundary: %s %s", (declarations, value, expected) => {
  expect(literalOrigin(`${declarations} const result=${value};`)).toBe(expected);
});

test("a catch binding is not an immutable declaration", () => {
  const file = ts.createSourceFile(
    "/fixture.ts",
    "try {} catch (value) {}",
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0]! as ts.TryStatement;
  expect(isConstDeclaration(statement.catchClause!.variableDeclaration!)).toBe(false);
});

test.each([
  [
    "forward",
    false,
    'function scale(x:Node<"f32">, again:boolean) { if(again) return scale(x,false)*2; return x*1; }',
  ],
  [
    "preceding",
    true,
    'function scale(x:Node<"f32">, again:boolean) { if(again) return scale(x,false)*2; return x*1; }',
  ],
  [
    "container return",
    false,
    'function scale(x:Node<"f32">, again:boolean) { if(again) {const values=[scale(x,false)*2]; return values[0];} return x*1; }',
  ],
  [
    "mutual",
    false,
    'function scale(x:Node<"f32">, again:boolean) { if(again) return finish(x)*2; return x*1; } function finish(x:Node<"f32">) {return scale(x,false);}',
  ],
] as const)(
  "preserves finite %s recursive helper values in a literal",
  async (_, before, helper) => {
    const wrap = (declarations: string, body: string): string => `
    const out=audioOutput({channels:1,name:"main"});
    ${before ? declarations : ""}
    process(()=>{forSample(i=>{${body}})});
    ${before ? "" : declarations}
  `;
    const actual = await renderLowered(
      wrap(helper, "const values={left:scale(f32(0.5),true)*2}; out.ch(0)[i]=values.left*2;"),
      config,
    );
    const explicitHelper = helper
      .replaceAll("scale(x,false)*2", "mul(scale(x,false),2)")
      .replaceAll("finish(x)*2", "mul(finish(x),2)")
      .replaceAll("x*1", "mul(x,1)");
    const explicit = await renderLowered(
      wrap(
        explicitHelper,
        "const values={left:mul(scale(f32(0.5),true),2)}; out.ch(0).at(i).write(mul(values.left,2));",
      ),
      config,
    );
    expect(explicit.outputs.main[0]).toEqual(new Float32Array(128).fill(4));
    expect(actual.outputs).toEqual(explicit.outputs);
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["declaration", "export const values={left:f32(0.5)*2};", "values"],
  ["specifier", "const values={left:f32(0.5)*2}; export {values};", "values"],
  ["renamed specifier", "const values={left:f32(0.5)*2}; export {values as shared};", "shared"],
] as const)(
  "preserves consumer mutation through an exported %s",
  async (_, declaration, imported) => {
    const directory = mkdtempSync(path.join(import.meta.dirname, "..", ".container-export-"));
    try {
      writeFileSync(
        path.join(directory, "library.uwk.ts"),
        `${declaration}
export function read() {return Math.max(0,values.left*2);}`,
      );
      const entry = path.join(directory, "main.uwk.ts");
      writeFileSync(
        entry,
        `import {${imported} as values,read} from "./library.uwk.ts"; const out=audioOutput({channels:1,name:"main"}); values.left=3; process(()=>{forSample(i=>{out.ch(0)[i]=read();});});`,
      );
      const actual = await renderOffline(await loadUwkProcessor(entry), config);
      expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
      expect(actual.diagnostics.scrubbedSamples).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["exponent", "1e2", "100"],
  ["exponent index", "1e2", "1e2"],
  ["hexadecimal", "0x64", "100"],
  ["binary", "0b1100100", "100"],
  ["octal", "0o144", "100"],
  ["decimal", "100", "100"],
  ["decimal fraction", "100.0", "100"],
  ["negative exponent", "1e-2", "0.01"],
] as const)("renders a DSP value under a %s numeric property", async (_, property, access) => {
  const actual = await renderLowered(
    processor(`const values={${property}:f32(0.5)*2};out.ch(0)[i]=values[${access}]*2;`),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each([
  ["export const values={left:VALUE};", "values.left", undefined],
  ["const values={left:VALUE};export {values};", "values.left", undefined],
  ["const values={left:VALUE};export {values as shared};", "values.left", undefined],
  ["const values={left:VALUE};export {values as default};", "values.left", undefined],
  ["const values={left:VALUE};export default values;", "values.left", undefined],
  ["const values={1e2:VALUE};", "values[100]", "VALUE"],
  ["const values={0x64:VALUE};", "values[100]", "VALUE"],
  ["const values={0b1100100:VALUE};", "values[100]", "VALUE"],
  ["const values={100:VALUE};", "values[100]", "VALUE"],
  ["const values={left:VALUE};const other=3;export {other};", "values.left", "VALUE"],
  ["const values={left:VALUE};export {values} from './foreign';", "values.left", "VALUE"],
  ["const values={100:3,1e2:VALUE};", "values[100]", "VALUE"],
  ["const values={1e2:VALUE,100:3};", "values[100]", "3"],
  ["const values={'1e2':VALUE,100:3};", "values['1e2']", "VALUE"],
] as const)("checks exported and numeric literal origins: %s", (declarations, value, expected) => {
  expect(literalOrigin(`${declarations} const result=${value};`)).toBe(expected);
});

test.each(["export type {values};", "export {type values};", "export {type values as shared};"])(
  "keeps type-only exports from escaping a literal: %s",
  (exports) => {
    expect(literalOrigin(`const values={left:VALUE};${exports}const result=values.left;`)).toBe(
      "VALUE",
    );
  },
);

const erasedReferences = [
  ["type query", "type Snapshot = typeof values;"],
  ["member type query", "type Snapshot = typeof values.left;"],
  ["indexed type query", 'type Snapshot = (typeof values)["left"];'],
  ["mapped type", "type Snapshot = { [K in keyof typeof values]: (typeof values)[K] };"],
  ["annotation", "let snapshot: typeof values;"],
  ["parameter annotation", "function accept(snapshot: typeof values) {}"],
  ["satisfies type", "const empty = {} satisfies Partial<typeof values>;"],
  ["class type argument", "class Base<T> {} class Child extends Base<typeof values> {}"],
] as const;

test.each(erasedReferences)("ignores an erased container reference in a %s", (_, reference) => {
  expect(literalOrigin(`const values={left:VALUE};${reference}const result=values.left;`)).toBe(
    "VALUE",
  );
});

const templateKeys = [
  ["object read", "const values={left:VALUE};", "values[`left`]"],
  ["computed property", "const values={[`left`]:VALUE};", "values.left"],
  ["destructuring", "const {[`left`]:left}={left:VALUE};", "left"],
  ["array read", "const values=[VALUE];", "values[`0`]"],
  ["nested read", "const values={inner:[{left:VALUE}]};", "values[`inner`][`0`][`left`]"],
  ["empty key", "const values={[``]:VALUE};", "values[``]"],
  ["cooked escape", "const values={left:VALUE};", "values[`\\u006ceft`]"],
  ["numeric string", "const values={[`1e2`]:VALUE,100:3};", "values[`1e2`]"],
] as const;

test.each(templateKeys)(
  "resolves a no-substitution template key for %s",
  (_, declarations, value) => {
    expect(literalOrigin(`${declarations}const result=${value};`)).toBe("VALUE");
  },
);

test.each(templateKeys)(
  "renders DSP with a no-substitution template key for %s",
  async (_, declarations, value) => {
    const actual = await renderLowered(
      processor(`${declarations.replaceAll("VALUE", "f32(0.5)*2")}out.ch(0)[i]=${value}*2;`),
      config,
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["const values={left:VALUE,[`left`]:3};", "values.left", "3"],
  ["const values={[`left`]:3,left:VALUE};", "values[`left`]", "VALUE"],
  ["const values={[`1e2`]:VALUE};", "values[100]", undefined],
  ["const values={left:VALUE};", 'values[`le${"ft"}`]', undefined],
  ["const values={left:VALUE};const key=`left`;", "values[key]", undefined],
  ["const values={[`__proto__`]:VALUE};", "values[`__proto__`]", undefined],
] as const)("keeps template key boundaries: %s %s", (declarations, value, expected) => {
  expect(literalOrigin(`${declarations}const result=${value};`)).toBe(expected);
});

test.each([
  ["write", "values[`left`]=3;"],
  ["escape", "function reset(v:{left:number}){v.left=3;}reset(values);"],
  ["method receiver", "values[`reset`]();"],
])("preserves mutation with a template key after %s", async (_, mutation) => {
  const actual = await renderLowered(
    processor(
      `const values={left:f32(0.5)*2,reset:function(){this.left=3;}};${mutation}out.ch(0)[i]=Math.max(0,values[\`left\`]*2);`,
    ),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each(erasedReferences)(
  "renders DSP with an erased container reference in a %s",
  async (_, reference) => {
    const actual = await renderLowered(
      processor(`const values={left:f32(0.5)*2};${reference}out.ch(0)[i]=values.left*2;`),
      config,
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  "const runtimeType = typeof values;",
  "const runtimeType = typeof reset(values);",
  "class Child extends reset(values) {}",
])("retains runtime container references beside erased types: %s", (reference) => {
  expect(
    literalOrigin(
      `const values={left:VALUE};type Snapshot=typeof values;${reference}const result=values.left;`,
    ),
  ).toBeUndefined();
});

test.each([
  ["typeof expression", "const runtimeType = typeof reset(values);"],
  ["class extends", "class Child extends reset(values) {}"],
  ["asserted alias", "const alias = values as typeof values; reset(alias);"],
])("preserves runtime mutation beside an erased type in a %s", async (_, mutation) => {
  const actual = await renderLowered(
    processor(`
      const values={left:f32(0.5)*2};
      type Snapshot=typeof values;
      function reset(value: Snapshot) { value.left=3; return class {}; }
      ${mutation}
      out.ch(0)[i]=Math.max(0,values.left*2);
    `),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test("preserves local literals inside exported functions", async () => {
  const directory = mkdtempSync(path.join(import.meta.dirname, "..", ".container-export-local-"));
  try {
    writeFileSync(
      path.join(directory, "library.uwk.ts"),
      "export function read(){const values={left:f32(0.5)*2};return values.left*2;}",
    );
    const entry = path.join(directory, "main.uwk.ts");
    writeFileSync(
      entry,
      'import {read} from "./library.uwk.ts";const out=audioOutput({channels:1,name:"main"});process(()=>{forSample(i=>{out.ch(0)[i]=read();});});',
    );
    const actual = await renderOffline(await loadUwkProcessor(entry), config);
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  ["negative integer", "[-1]", "-1"],
  ["unary plus", "[+1]", "+1"],
  ["negative exponent", "[-1e2]", "-100"],
  ["negative hexadecimal", "[-0x10]", "-16"],
  ["negative binary", "[-0b10]", "-2"],
  ["negative fractional", "[-0.5]", "-0.5"],
  ["negative zero", "[-0]", "0"],
  ["parenthesized operand", "[-(1)]", "-(1)"],
  ["string property", '"-1"', "-1"],
] as const)("renders a signed numeric literal key: %s", async (_, key, access) => {
  const actual = await renderLowered(
    processor(`const values={${key}:f32(0.5)*2};out.ch(0)[i]=values[${access}]*2;`),
    config,
  );
  const expected = await renderLowered(
    processor(
      `const values={${key}:mul(f32(0.5),2)};out.ch(0).at(i).write(mul(values[${access}],2));`,
    ),
    config,
  );
  expect(expected.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
  expect(actual.outputs).toEqual(expected.outputs);
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test.each([
  ["const values={[-1]:VALUE};", "values[-1]", "VALUE"],
  ["const values={[+1]:VALUE};", "values[+1]", "VALUE"],
  ["const values={[-0]:VALUE};", "values[0]", "VALUE"],
  ["const values=[VALUE];", "values[-0]", "VALUE"],
  ["const values=[VALUE];", "values[+0]", "VALUE"],
  ["const values={[-(1)]:VALUE};", "values[-(1)]", "VALUE"],
  ["const values={[-1]:VALUE,'-1':3};", "values[-1]", "3"],
  ["const values={'-1':3,[-1]:VALUE};", "values[-1]", "VALUE"],
  ["const key=1;const values={[-1]:VALUE};", "values[-key]", undefined],
  ["const values={[-1]:VALUE};values[-1]=3;", "values[-1]", undefined],
  ["const values={[-1]:VALUE};reset(values);", "values[-1]", undefined],
  ["const values={[-1]:VALUE};const alias=values;", "values[-1]", undefined],
  ["const key=1;const values={[-1]:VALUE,[-key]:3};", "values[-1]", undefined],
  ["const values={[-1]:VALUE};", "values[~1]", undefined],
  ["const values={[-1]:VALUE};", "values[!1]", undefined],
  ["const values={1:VALUE};", 'values[+"1"]', undefined],
] as const)("checks signed numeric literal provenance: %s %s", (declarations, value, expected) => {
  expect(literalOrigin(`${declarations}const result=${value};`)).toBe(expected);
});

test.each([
  [
    "logical negation",
    'const gate=state.bool(false).named("gate");',
    "const values=[!gate];out.ch(0)[i]=values[0]?2:1;",
    2,
  ],
  ["build-time unary plus", "", "const values=[+3];out.ch(0)[i]=Math.max(0,values[0]*2);", 6],
  [
    "numeric indexed member",
    "",
    "const source=[3];const values={left:source[0]};out.ch(0)[i]=Math.max(0,values.left*2);",
    6,
  ],
  [
    "DSP indexed member",
    "",
    "const source=[f32(0.5)*2];const values={left:source[0]};out.ch(0)[i]=values.left*2;",
    2,
  ],
  [
    "parameter indexed member",
    'const gain=param.f32({default:1,min:0,max:2,automationRate:"a-rate"}).named("gain");',
    "const values=[gain[i]];out.ch(0)[i]=values[0]*2;",
    2,
  ],
  [
    "input indexed member",
    'const input=audioInput({channels:1,name:"main"});',
    "const values=[input.ch(0)[i]];out.ch(0)[i]=values[0]*2;",
    2,
  ],
  [
    "unsupported output read",
    "",
    "const values=[out.ch(0)[i]];out.ch(0)[i]=Math.max(0,(values[0]||3)*2);",
    6,
  ],
] as const)("preserves container origin boundary: %s", async (_, declarations, body, expected) => {
  const actual = await renderLowered(processor(body, declarations), {
    ...config,
    inputs: { main: [new Float32Array(128).fill(1)] },
  });
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(expected));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});

test("an indexed output read is not a proven emitted Node", () => {
  const { checker, sourceFile } = buildProgram(
    'const out=audioOutput({channels:1,name:"main"});const values=[out.ch(0)[0]];const result=values[0];',
  );
  const statement = sourceFile.statements.at(-1)! as ts.VariableStatement;
  expect(classify(checker, statement.declarationList.declarations[0]!.initializer!)).toBe("other");
});

test.each([
  ["input", "", "input.ch(0)[i].add(1)", "values.left*2", 4],
  ["buffer", "storage[0]=f32(1);", "storage[0].add(1)", "values.left*2", 4],
  ["parameter", "", "gain[i].add(1)", "values.left*2", 4],
  ["sugar", "", "(f32(0.5)*2).add(1)", "values.left*2", 4],
  ["const alias", "const raw=f32(0.5)*2;", "raw.add(1)", "values.left*2", 4],
  ["chain", "", "input.ch(0)[i].abs().add(1).floor()", "values.left*2", 4],
  ["computed method", "", 'input.ch(0)[i]["add"](1)', "values.left*2", 4],
  ["template method", "", "input.ch(0)[i][`add`](1)", "values.left*2", 4],
  ["wrapped callee", "", "(input.ch(0)[i].add)(1)", "values.left*2", 4],
  ["boolean result", "", "input.ch(0)[i].gt(2)", "values.left?2:1", 1],
  ["i32 result", "", "(i32(7)/2).div(2)", "f32(values.left*2)", 2],
] as const)(
  "preserves an intrinsic DSP method result in a container: %s",
  async (_, prelude, value, output, expected) => {
    const actual = await renderLowered(
      processor(
        `${prelude}const values={left:${value}};out.ch(0)[i]=${output};`,
        `
      const input=audioInput({channels:1,name:"main"});
      const storage=state.buffer.f32({size:1}).named("storage");
      const gain=param.f32({default:1,min:0,max:2,automationRate:"a-rate"}).named("gain");
    `,
      ),
      { ...config, inputs: { main: [new Float32Array(128).fill(1)] } },
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(expected));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test("intrinsic method provenance matches the public Node return signatures", () => {
  const publicProgram = buildProgram(
    'declare const value:Node<"f32"|"f64"|"i32"|"i64"|"bool"|"f32x4">;',
  );
  const statement = publicProgram.sourceFile.statements[0]! as ts.VariableStatement;
  const declaration = statement.declarationList.declarations[0]!;
  const nodeType = publicProgram.checker.getTypeAtLocation(declaration.name);
  const methods = publicProgram.checker.getPropertiesOfType(nodeType).flatMap((property) => {
    const type = publicProgram.checker.getTypeOfSymbolAtLocation(property, declaration.name);
    const signatures = publicProgram.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (signatures.length === 0) return [];
    const expected =
      property.name !== "pipe" &&
      signatures.every((signature) => {
        const result = publicProgram.checker.getReturnTypeOfSignature(signature);
        return (
          (result.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) === 0 &&
          publicProgram.checker.isTypeAssignableTo(result, nodeType)
        );
      });
    return [{ name: property.name, expected }];
  });
  expect(methods.map((method) => method.name)).toEqual(
    expect.arrayContaining(["add", "pipe", "lane"]),
  );
  const program = buildProgram(
    "const seed=f32(1)*2;" +
      methods
        .map(
          (method, index) =>
            `const values${index}={left:seed[${JSON.stringify(method.name)}]()};const result${index}=values${index}.left;`,
        )
        .join(""),
  );
  methods.forEach((method, index) => {
    const statement = program.sourceFile.statements[2 + index * 2]! as ts.VariableStatement;
    expect(
      classify(program.checker, statement.declarationList.declarations[0]!.initializer!),
      method.name,
    ).toBe(method.expected ? "node" : "other");
  });
});

test.each([
  ["pipe callback", "", "input.ch(0)[i].pipe(()=>3)", "values.left*2", 6],
  ["Object method", "", 'input.ch(0)[i].hasOwnProperty("missing")', "values.left?2:1", 1],
  ["numeric method", "", "(3).toFixed(0)", "values.left*2", 6],
  ["ordinary method", "const source={add(){return 3;}};", "source.add()", "values.left*2", 6],
  [
    "mixed indexed receiver",
    "const source=[input.ch(0)[i],{add(){return 3;}}];const index=Math.floor(1);",
    "source[index].add(1)",
    "values.left*2",
    6,
  ],
  ["output read", "", "out.ch(0)[i]?.add(1)", "(values.left??3)*2", 6],
  ["method value", "", "input.ch(0)[i].add", "values.left?3:1", 3],
  ["wrapped method value", "", "(input.ch(0)[i].add)", "values.left?3:1", 3],
  ["dynamic method", "const method='pipe';", "input.ch(0)[i][method](()=>3)", "values.left*2", 6],
] as const)(
  "preserves a build-time method result in a container: %s",
  async (_, prelude, value, output, expected) => {
    const actual = await renderLowered(
      processor(
        `${prelude}const values={left:${value}};out.ch(0)[i]=Math.max(0,${output});`,
        'const input=audioInput({channels:1,name:"main"});',
      ),
      { ...config, inputs: { main: [new Float32Array(128).fill(1)] } },
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(expected));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each(["const copy={...values.left};", "let copy;copy={...values.left};"])(
  "keeps a spread source distinct from a write target: %s",
  async (copy) => {
    const actual = await renderLowered(
      processor(`const values={left:f32(0.5)*2};${copy}out.ch(0)[i]=values.left*2;`),
      config,
    );
    expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(2));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
  },
);

test.each([
  ["direct write", "values[-1]=3;"],
  ["escape", "function reset(value:Record<number,number>){value[-1]=3;}reset(values);"],
] as const)("preserves signed-key build-time values after %s", async (_, mutation) => {
  const actual = await renderLowered(
    processor(`const values={[-1]:f32(0.5)*2};${mutation}out.ch(0)[i]=Math.max(0,values[-1]*2);`),
    config,
  );
  expect(actual.outputs.main[0]).toEqual(new Float32Array(128).fill(6));
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});
