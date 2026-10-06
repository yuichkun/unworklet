export const GENERATED_HELPER_EXPRESSIONS = [
  ["add", "f32(2) + f32(1)"],
  ["sub", "f32(2) - f32(1)"],
  ["mul", "f32(2) * f32(1)"],
  ["div", "f32(2) / f32(1)"],
  ["mod", "f32(2) % f32(1)"],
  ["pow", "f32(2) ** f32(1)"],
  ["lt", "f32(2) < f32(1)"],
  ["gt", "f32(2) > f32(1)"],
  ["lte", "f32(2) <= f32(1)"],
  ["gte", "f32(2) >= f32(1)"],
  ["eq", "f32(2) == f32(1)"],
  ["and", "bool(true) && bool(false)"],
  ["or", "bool(true) || bool(false)"],
  ["neg", "-f32(1)"],
  ["not", "!bool(false)"],
  ["select", "bool(true) ? f32(1) : f32(2)"],
] as const;

export const COLLIDING_HELPERS = `${GENERATED_HELPER_EXPRESSIONS.map(
  ([name]) => `const ${name} = (a: number, b = 0) => a + b;`,
).join("\n")}
const __uwk_mul = 10;
const __uwk_mul_1 = 20;
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => {
  const __uwk_mul_2 = 30;
  ${GENERATED_HELPER_EXPRESSIONS.map(([, expression]) => `${expression};`).join("\n  ")}
  f32(2) === f32(1);
  f32(2) != f32(1);
  f32(2) !== f32(1);
  out.ch(0)[i] = f32(mul(1, 2) + __uwk_mul + __uwk_mul_1 + __uwk_mul_2) * f32(2);
}); });`;

export const COLLIDING_SCOPE_BODIES = [
  "const mul = (a: number, b: number) => a + b;",
  "function mul(a: number, b: number) { return a + b; }",
  "class mul {}",
  "const { value: mul } = { value: 0 };",
  "const [mul] = [0];",
  "if (false) { var mul = 0; }",
].map(
  (binding) => `const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => {
  ${binding}
  out.ch(0)[i] = f32(0.5) * f32(2);
}); });`,
);

export const COLLIDING_IMPORTS = [
  'import { f32 as mul } from "@unworklet/core";',
  'import * as mul from "@unworklet/core";',
  'import type { Node as mul } from "@unworklet/core";',
].map(
  (binding) => `${binding}
const out = audioOutput({ channels: 1, name: "main" });
process(() => { forSample(i => { out.ch(0)[i] = f32(0.5) * f32(2); }); });`,
);
