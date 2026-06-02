/**
 * Observation probe for the type-directed lowering foundation: does the in-memory
 * `TypeChecker` actually resolve a `.uwk.ts`'s DSP values vs build-time numbers?
 * The whole operator-dispatch approach rests on this, so we verify it directly —
 * not by trusting that the program "should" work, but by reading the types back.
 */

import { expect, test } from "vite-plus/test";
import ts from "typescript";

import { buildProgram } from "./program.ts";

const SAMPLE = `
const SAMPLE_RATE = 48000;
const DELAY = Math.round(SAMPLE_RATE * 0.3);
const input = audioInput({ channels: 2, name: "main" });
const gain = state.f32(0.5).named("gain");
process(() => {
  forSample((i) => {
    const dsp = input.left.at(i);
    const blk = SAMPLE_RATE * 0.3;
    const g = gain;
    const lc = i;
  });
});
`;

function typeOfDecl(name: string, source: string): string {
  const { checker, sourceFile } = buildProgram(source);
  let result: string | undefined;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer !== undefined
    ) {
      result = checker.typeToString(checker.getTypeAtLocation(n.initializer));
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  if (result === undefined) throw new Error(`decl '${name}' not found`);
  return result;
}

test('an audio-input sample reads as Node<"f32">', () => {
  // input.left.at(i) — the canonical DSP value the operator pass must lower around.
  expect(typeOfDecl("dsp", SAMPLE)).toBe('Node<"f32">');
});

test("a build-time `number * number` stays a plain number (NOT a DSP value)", () => {
  // SAMPLE_RATE * 0.3 — the crux: a const-fold must NOT be lowered to mul(...).
  expect(typeOfDecl("blk", SAMPLE)).toBe("number");
});

test('a bare state reference reads as State<"f32">', () => {
  // gain — the bare-state pass must recognise this to insert .read().
  expect(typeOfDecl("g", SAMPLE)).toBe('State<"f32">');
});

test('the forSample counter reads as Node<"i32">', () => {
  expect(typeOfDecl("lc", SAMPLE)).toBe('Node<"i32">');
});
