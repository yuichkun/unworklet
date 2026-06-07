/**
 * IDE virtual-code generator (RFC-001 "Volar.js / TS LSP integration").
 *
 * A `.uwk.ts` file is sugar that stock TypeScript rejects (`a * b` on two
 * `Node<T>` is an "operator cannot be applied" error), which is why authoring it
 * needs a `// @ts-nocheck` header. This generator produces the *virtual* TypeScript
 * the editor should type-check instead: the same file with only the sugar
 * expressions desugared to the chain primitives they lower to (`a * b` →
 * `mul(a, b)`, `out.left[i] = v` → `out.left.at(i).write(v)`, a bare `state` read →
 * `state.read()`), everything else byte-for-byte verbatim.
 *
 * Unlike {@link lower}, the output is NOT wrapped in `defineProcessor` and injects
 * no import: the file keeps its ambient shape (`process(() => {...})`, module-level
 * declarations) and resolves `audioInput` / `state` / `process` / `input` / `out` /
 * `$prev` against the shipped ambient `.d.ts` (the same `AMBIENT_DTS` the lowering's
 * type queries use). The editor only needs the source to *type-check* and to map
 * positions back — it does not need a runnable module.
 *
 * Every generated character carries a Volar {@link CodeMapping}:
 *  - text the author wrote maps 1:1 to its source offset with all features on, so
 *    hover / completion / go-to-def / rename / diagnostics land on the real token;
 *  - injected text (`mul(`, `.read()`, `).write(`, …) maps to a zero-width source
 *    anchor with verification only, so a diagnostic that spans into it still
 *    projects back to source, but it is invisible to hover / navigation.
 *
 * The desugar dispatch reuses the EXACT predicates the lowering passes use
 * (`classify` / `isDspExpr` / `readsAsBareState`), so the editor rewrites precisely
 * the identifiers and operators the build does — the two never diverge.
 */

import type { CodeInformation, CodeMapping } from "@volar/language-core";
import ts from "typescript";

import { argIsInjectable, calledMethod, optionsHaveName, rootCallee } from "../passes/autoName.ts";
import { classify, isDspExpr, isSugarBinaryOperator } from "../classify.ts";
import { readsAsBareState } from "../passes/bareState.ts";
import { detectEmits } from "../passes/ifSugar.ts";
import { BINARY_FN, NEGATED_EQ } from "../passes/operators.ts";
import { prevSlotScalars } from "../passes/prev.ts";
import { buildProgram, type FsSnapshot } from "../program.ts";

/** Author-written code: every language feature maps through 1:1. */
const FULL: CodeInformation = {
  verification: true,
  completion: true,
  semantic: true,
  navigation: true,
  structure: true,
};

/** Injected desugar text: diagnostics project back, but hover / navigation do not. */
const SYNTH: CodeInformation = { verification: true };

/**
 * Prepended to the virtual module. `export {}` (appended) makes the file a module
 * so these local declarations shadow BOTH the ambient `declare global` macros AND
 * the platform globals they collide with — otherwise the platform global wins:
 * - `process` vs `@types/node`'s `var process: Process` ("Type 'Process' has no
 *   call signatures" on every `process(() => {...})`).
 * - `event` vs `lib.dom`'s `var event: Event | undefined` ("Property 'midi' does
 *   not exist on type 'Event'" on every `event.midi(...)` / `event<T>(...)`).
 * The remaining ambient names collide with nothing in lib / node.
 */
const MODULE_PREFIX =
  "declare function process(callback: () => void): void;\n" +
  'declare const event: typeof import("@unworklet/core").event;\n';
const MODULE_SUFFIX = "\nexport {};\n";

/** A name string the auto-name pass would inject, materialised as source text. */
type Insertion = { offset: number; text: string };

export type VirtualCodeResult = { code: string; mappings: CodeMapping[] };

export type GenerateOptions = {
  /** Replay a captured file-system snapshot (browser, no disk). */
  snapshot?: FsSnapshot;
};

/**
 * A generated-text accumulator that records a {@link CodeMapping} for every chunk.
 * `verbatim` copies author source 1:1; `synth` emits desugar glue anchored to a
 * zero-width source point so diagnostics still project back.
 */
class Builder {
  private readonly parts: string[] = [];
  private length = 0;
  readonly mappings: CodeMapping[] = [];

  verbatim(text: string, sourceOffset: number, data: CodeInformation = FULL): void {
    this.mappings.push({
      sourceOffsets: [sourceOffset],
      generatedOffsets: [this.length],
      lengths: [text.length],
      data,
    });
    this.parts.push(text);
    this.length += text.length;
  }

  synth(text: string, sourceAnchor: number): void {
    this.mappings.push({
      sourceOffsets: [sourceAnchor],
      generatedOffsets: [this.length],
      lengths: [0],
      generatedLengths: [text.length],
      data: SYNTH,
    });
    this.parts.push(text);
    this.length += text.length;
  }

  /** Generated-only structural text with no source correspondence (module glue). */
  raw(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/**
 * The names the auto-name pass (S9) injects, as source-offset insertions. Only the
 * sites where the un-named form is a *type* error need filling: a no-arg `.named()`
 * (the core signature requires a name) and an `event` / `event.midi` with no `name`
 * in its options (`EventOptions.name` is required). `audioInput` / `audioOutput`
 * names are optional in the ambient, `.expose({})` names are optional in core, and
 * `param.f32({...})` is a complete `Param` un-named — none of those need a fill.
 * The injected value is irrelevant to type-checking; the binding name is used so a
 * hover reads naturally and the virtual matches the lowered build.
 */
function autoNameInsertions(sourceFile: ts.SourceFile): Insertion[] {
  const out: Insertion[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (stmt.declarationList.declarations.length !== 1) continue;
    const decl = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
    const name = decl.name.text;
    const init = decl.initializer;

    // No-arg `.named()` → `.named("name")`.
    if (
      ts.isCallExpression(init) &&
      calledMethod(init) === "named" &&
      init.arguments.length === 0
    ) {
      out.push({ offset: init.getEnd() - 1, text: `"${name}"` });
      continue;
    }
    // `event(...)` / `event.midi(...)` with no `name` in its options.
    if (
      rootCallee(init) === "event" &&
      ts.isCallExpression(init) &&
      !optionsHaveName(init) &&
      argIsInjectable(init)
    ) {
      const arg = init.arguments[0];
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        out.push({ offset: arg.getStart(sourceFile) + 1, text: ` name: "${name}",` });
      } else {
        out.push({ offset: init.getEnd() - 1, text: `{ name: "${name}" }` });
      }
    }
  }
  return out.sort((a, c) => a.offset - c.offset);
}

/**
 * A `port.emit(payload)` call that sits in the then-branch of a DSP-guarded `if`
 * with no else, where EVERY statement of that branch is an emit — exactly the shape
 * {@link tryIfSugar} rewrites to `port.emitIf(cond, payload)`. The worklet `EventDecl`
 * exposes only `emitIf`, so a verbatim `emit` would draw a bogus "Property 'emit'
 * does not exist".
 *
 * The all-emits gate (`detectEmits`, the build's own check) is load-bearing: a branch
 * mixing an emit with any other statement is rejected by the build
 * (`uwk-unsupported-if`), so the editor must leave `emit` unrewritten there too —
 * otherwise it would green-light a `.uwk.ts` the build refuses to compile.
 */
function isGuardedEmit(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const stmt = call.parent;
  if (!ts.isExpressionStatement(stmt)) return false;
  const container = stmt.parent;
  const inBlock = ts.isBlock(container);
  const ifStmt = inBlock ? container.parent : container;
  // With no else, the statement under the `if` is always its then-branch.
  if (!ts.isIfStatement(ifStmt) || ifStmt.elseStatement !== undefined) return false;
  if (!isDspExpr(checker, ifStmt.expression)) return false;
  return detectEmits(ifStmt.thenStatement) !== undefined;
}

/**
 * Lower a `.uwk.ts` source string to the virtual TypeScript the editor type-checks,
 * plus the source↔generated mappings Volar maps positions through.
 */
export function generateVirtualCode(
  source: string,
  options: GenerateOptions = {},
): VirtualCodeResult {
  const { checker, sourceFile } = buildProgram(source, { snapshot: options.snapshot });
  const text = sourceFile.text;
  const b = new Builder();
  b.raw(MODULE_PREFIX);
  let cursor = 0;

  // `$prev` sites (by source offset) → the slot scalar the lowering would assign.
  const prevScalars = prevSlotScalars(checker, sourceFile);

  const insertions = autoNameInsertions(sourceFile);
  let nextInsertion = 0;

  /** Copy author source verbatim from the cursor up to `pos`, emitting any
   * auto-name insertion whose anchor falls within the copied range, then advance.
   * Insertions sit in declaration option-objects / `.named()` parens — never inside
   * a sugar node — so the cursor always reaches an insertion before it skips past. */
  const flushTo = (pos: number): void => {
    while (nextInsertion < insertions.length && insertions[nextInsertion]!.offset <= pos) {
      const ins = insertions[nextInsertion]!;
      b.verbatim(text.slice(cursor, ins.offset), cursor);
      b.synth(ins.text, ins.offset);
      cursor = ins.offset;
      nextInsertion += 1;
    }
    if (pos > cursor) {
      b.verbatim(text.slice(cursor, pos), cursor);
      cursor = pos;
    }
  };

  /** Emit `e` as a value: desugar it, then read-wrap a bare `State` (mirrors the
   * operator / index pass, which read-wrap every operand). */
  const operandValue = (e: ts.Expression): void => {
    walk(e);
    flushTo(e.getEnd());
    if (classify(checker, e) === "state") b.synth(".read()", e.getEnd());
  };

  /** Emit the object of an index access (a channel view / param / buffer — never a
   * bare state, so no read-wrap), desugaring any nested sugar. */
  const operandObject = (e: ts.Expression): void => {
    walk(e);
    flushTo(e.getEnd());
  };

  /** Try to emit `node` as a sugar rewrite; return false if it is not sugar. The
   * cursor is left at `node.getEnd()` on success. */
  const tryEmitSugar = (node: ts.Node): boolean => {
    // Guarded emit: `port.emit(payload)` inside a DSP-guarded `if` (no else) lowers
    // to `port.emitIf(cond, payload)`; the worklet EventDecl exposes only `emitIf`,
    // so a verbatim `emit` is a bogus "Property 'emit' does not exist". Rewrite the
    // method to `emitIf` with a `true` guard — the real guard stays the surrounding
    // `if`, and a literal `true` satisfies emitIf's `Node<"bool"> | boolean` first
    // param, so the payload type-checks exactly as the build checks it.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "emit" &&
      node.arguments.length === 1 &&
      isGuardedEmit(checker, node)
    ) {
      const access = node.expression;
      flushTo(node.getStart(sourceFile));
      operandObject(access.expression);
      b.synth(".emitIf(true, ", access.name.getStart(sourceFile));
      cursor = node.arguments[0]!.getStart(sourceFile);
      operandObject(node.arguments[0]!);
      b.synth(")", node.getEnd());
      cursor = node.getEnd();
      return true;
    }

    // Binary operator: `L op R` → `add(L, R)` / `not(eq(L, R))` (DSP operands only).
    if (ts.isBinaryExpression(node) && isSugarBinaryOperator(node.operatorToken.kind)) {
      if (!isDspExpr(checker, node.left) && !isDspExpr(checker, node.right)) return false;
      flushTo(node.getStart(sourceFile));
      const negated = NEGATED_EQ.has(node.operatorToken.kind);
      b.synth(
        negated ? "not(eq(" : `${BINARY_FN[node.operatorToken.kind]!}(`,
        node.getStart(sourceFile),
      );
      operandValue(node.left);
      b.synth(", ", node.left.getEnd());
      cursor = node.right.getStart(sourceFile);
      operandValue(node.right);
      b.synth(negated ? "))" : ")", node.getEnd());
      cursor = node.getEnd();
      return true;
    }

    // Index write: `obj[i] = v` → `obj.at(i).write(v)` / `obj.write(i, v)`.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left)
    ) {
      const el = node.left;
      const cls = classify(checker, el.expression);
      if (cls === "outputChannel" || cls === "buffer") {
        flushTo(node.getStart(sourceFile));
        operandObject(el.expression);
        if (cls === "outputChannel") {
          b.synth(".at(", el.expression.getEnd());
          cursor = el.argumentExpression.getStart(sourceFile);
          operandValue(el.argumentExpression);
          b.synth(").write(", el.argumentExpression.getEnd());
        } else {
          b.synth(".write(", el.expression.getEnd());
          cursor = el.argumentExpression.getStart(sourceFile);
          operandValue(el.argumentExpression);
          b.synth(", ", el.argumentExpression.getEnd());
        }
        cursor = node.right.getStart(sourceFile);
        operandValue(node.right);
        b.synth(")", node.getEnd());
        cursor = node.getEnd();
        return true;
      }
    }

    // Index read: `obj[i]` → `obj.at(i)` (input channel / param) / `obj.read(i)`
    // (buffer). An output channel has no read form (write-only), so it is left
    // verbatim and correctly errors — matching the lowering's index pass.
    if (ts.isElementAccessExpression(node)) {
      const cls = classify(checker, node.expression);
      const method =
        cls === "inputChannel" || cls === "param" ? "at" : cls === "buffer" ? "read" : undefined;
      if (method !== undefined) {
        flushTo(node.getStart(sourceFile));
        operandObject(node.expression);
        b.synth(`.${method}(`, node.expression.getEnd());
        cursor = node.argumentExpression.getStart(sourceFile);
        operandValue(node.argumentExpression);
        b.synth(")", node.getEnd());
        cursor = node.getEnd();
        return true;
      }
    }

    // Prefix `-x` / `!x` → `neg(x)` / `not(x)` (DSP operand only).
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken ||
        node.operator === ts.SyntaxKind.ExclamationToken) &&
      isDspExpr(checker, node.operand)
    ) {
      flushTo(node.getStart(sourceFile));
      b.synth(
        node.operator === ts.SyntaxKind.MinusToken ? "neg(" : "not(",
        node.getStart(sourceFile),
      );
      cursor = node.operand.getStart(sourceFile);
      operandValue(node.operand);
      b.synth(")", node.getEnd());
      cursor = node.getEnd();
      return true;
    }

    // Ternary `c ? t : e` → `select(c, t, e)` (DSP condition only).
    if (ts.isConditionalExpression(node) && isDspExpr(checker, node.condition)) {
      flushTo(node.getStart(sourceFile));
      b.synth("select(", node.getStart(sourceFile));
      operandValue(node.condition);
      b.synth(", ", node.condition.getEnd());
      cursor = node.whenTrue.getStart(sourceFile);
      operandValue(node.whenTrue);
      b.synth(", ", node.whenTrue.getEnd());
      cursor = node.whenFalse.getStart(sourceFile);
      operandValue(node.whenFalse);
      b.synth(")", node.getEnd());
      cursor = node.getEnd();
      return true;
    }

    // `$prev` inside a defineSubgraph method: the lowering rewrites it to a typed
    // slot read (`state.<scalar>(0).read()` → Node<scalar>). Cast it to that same
    // scalar so the editor type-checks the concrete type the build assigns, not the
    // broad ambient `Node<ScalarType>` (which draws bogus errors on valid feedback).
    // `$prev` itself stays author text, so hover / navigation land on the real token.
    if (ts.isIdentifier(node) && node.text === "$prev") {
      const scalar = prevScalars.get(node.getStart(sourceFile));
      if (scalar !== undefined) {
        flushTo(node.getStart(sourceFile));
        b.synth("(", node.getStart(sourceFile));
        flushTo(node.getEnd());
        b.synth(` as Node<"${scalar}">)`, node.getEnd());
        return true;
      }
    }

    // Bare `state` read: `gain` → `gain.read()` (value positions only).
    if (ts.isIdentifier(node) && readsAsBareState(checker, node)) {
      flushTo(node.getEnd());
      b.synth(".read()", node.getEnd());
      return true;
    }

    return false;
  };

  function walk(node: ts.Node): void {
    if (tryEmitSugar(node)) return;
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  flushTo(text.length);
  b.raw(MODULE_SUFFIX);

  return { code: b.toString(), mappings: b.mappings };
}
