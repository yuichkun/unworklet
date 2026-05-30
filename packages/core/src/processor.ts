/**
 * Processor / subgraph constructors (`01-dsl.md` §1 + §5.6).
 *
 * - `defineProcessor((ctx) => ...)`: declares a processor body, returns
 *   `CompiledProcessor<C>` (= graph + schemaHash + worklet namespace).
 * - `defineSubgraph((...args) => ...)`: declares a reusable subgraph at
 *   module scope; lambda args are bound per-instance at `createSubgraph` time.
 * - `createSubgraph(subgraph, ...lambdaArgs, options?)`: instantiates a
 *   subgraph in declaration scope. Returns the subgraph body's method
 *   record directly (= no `SubgraphInstance<S>` wrapper, per Q54).
 */

import type {
  CompiledProcessor,
  ProcessorBody,
  ProcessorContext,
  ProcessorGraph,
  ProcessorOptions,
} from "./types.ts";
import type { CapturedGraph } from "./compile/ast.ts";
import {
  finalize,
  getCurrentCapture,
  isWrappedNode,
  newCaptureContext,
  runCapture,
} from "./compile/capture.ts";
import { makeWorkletNamespace } from "./worklet.ts";

/**
 * Brand the internal `CapturedGraph` as the opaque public
 * `ProcessorGraph` token. `compile()` (= Step 3.5) recovers the AST
 * through the same identity; external consumers see only the brand.
 */
function brandGraph(graph: CapturedGraph): ProcessorGraph {
  return graph as unknown as ProcessorGraph;
}

export function defineProcessor<C = unknown>(
  body: (ctx: ProcessorContext) => ProcessorBody,
  _options?: ProcessorOptions,
): CompiledProcessor<C> {
  const captureCtx = newCaptureContext();

  // Declarations + the process lambda are gathered first. `ctx.sampleRate`
  // is a Phase 3 placeholder — the host (= `renderOffline`) will supply
  // the real rate when `compile()` is invoked end-to-end.
  const compiledBody = runCapture(captureCtx, () => {
    const procCtx: ProcessorContext = { sampleRate: 0 };
    return body(procCtx);
  });

  // Invoke `process` once during capture so its top-level statements
  // (= per-block code + `forSample` invocations) populate
  // `captureCtx.statements`.
  runCapture(captureCtx, () => {
    compiledBody.process();
  });

  const captured = finalize(captureCtx);

  return {
    graph: brandGraph(captured),
    schemaHash: "phase-3-stub",
    worklet: makeWorkletNamespace(captured),
    __compiledProcessor: undefined as unknown as C,
  };
}

/**
 * Opaque subgraph constructor result. Concrete generic constraint for
 * lambda args + method record is impl-phase fill (Q53).
 */
declare const subgraphBrand: unique symbol;

export interface SubgraphDecl<Args extends unknown[], Methods> {
  readonly [subgraphBrand]: { args: Args; methods: Methods };
}

const SUBGRAPH_BODY = Symbol("unworklet.subgraphBody");

export function defineSubgraph<Args extends unknown[], Methods>(
  body: (...args: Args) => Methods,
): SubgraphDecl<Args, Methods> {
  // body を symbol-keyed で carry (= createSubgraph が取り出して現 capture 内で実行)。
  return { [SUBGRAPH_BODY]: body } as unknown as SubgraphDecl<Args, Methods>;
}

export type CreateSubgraphOptions = {
  name?: string;
};

// 末尾引数が `{ name }` のみの plain object なら createSubgraph options と判定
// (= lambda arg の Node / array / 多 key object とは区別)。
function isCreateSubgraphOptions(v: unknown): v is CreateSubgraphOptions {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !isWrappedNode(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => k === "name")
  );
}

/**
 * `createSubgraph(subgraph, ...lambdaArgs, options?)` (= §5.6、Q53/54)。
 *
 * declaration scope で subgraph body を**現在の capture 内で実行** → 内部 state /
 * buffer 宣言が親 graph に instance name prefix 付きで登録される (= 複数 instance で
 * 独立 state)。 body が返す method record を**そのまま**返す (= SubgraphInstance ラッパ
 * ナシ、Q54)。 method closure は instance の state を捕捉し、後で expression scope で呼べる。
 */
export function createSubgraph<Args extends unknown[], Methods>(
  subgraph: SubgraphDecl<Args, Methods>,
  ...rest: unknown[]
): Methods {
  const body = (subgraph as unknown as Record<symbol, ((...a: Args) => Methods) | undefined>)[
    SUBGRAPH_BODY
  ];
  if (typeof body !== "function") {
    throw new Error("unworklet: createSubgraph requires a defineSubgraph(...) value");
  }
  let args = rest;
  let instanceName: string | undefined;
  const last = rest[rest.length - 1];
  // 末尾を options 扱いするのは「options 形 ({name} only) かつ rest 数が lambda の arity を
  // 超える」時だけ。さもないと outer lambda が {name} 形 config を取る subgraph で
  // createSubgraph(sg, {name:"osc"}) の object が options と誤認され、型上 lambda 引数に
  // bind されるのに runtime が slice して body が undefined を掴む (= 型⟺動く 違反)。
  // arity を超えた末尾だけ options = TS の `[...Args, options?]` tuple 解釈と一致する。
  if (rest.length > 0 && isCreateSubgraphOptions(last) && rest.length > body.length) {
    instanceName = last.name;
    args = rest.slice(0, -1);
  }
  const ctx = getCurrentCapture();
  // createSubgraph は declaration scope 専用 (§5.6.4 / Q34)。expression scope
  // (= forSample / everyNSamples / handler body = currentLoopBody が立つ間) での
  // instantiation は graph-capture-time error。内部 state を持たない plain subgraph も
  // ここで弾く (= 内部宣言ありの場合は body 内の addDeclaration が同じ error を出す)。
  if (ctx.currentLoopBody !== null) {
    throw new Error(
      "unworklet: createSubgraph(...) inside expression scope " +
        "(forSample / everyNSamples / handler body). Subgraph instantiation is only valid " +
        "in declaration scope — the top of a defineProcessor / defineSubgraph body, before " +
        "the returned process / method record. (stable ID 'scope-violation')",
    );
  }
  const name = instanceName ?? `__sg_${ctx.subgraphCount++}`;
  const prevPrefix = ctx.namePrefix;
  ctx.namePrefix = prevPrefix + name + "/";
  const declStart = ctx.declarations.length;
  let methods: Methods;
  try {
    methods = body(...(args as Args));
  } finally {
    ctx.namePrefix = prevPrefix;
  }
  // §8.1 / Q41: instance 名ナシ + named-factory slot (= user-named / persistent / publish =
  // userNamed true) は snapshot / main-side path が auto prefix '__sg_N/...' = instantiation
  // 順依存になり positional drift を招く → graph-capture-time error。plain-only (= 内部が全
  // anonymous slot) は安定 path が要らないので名前不要 (= 共通ケース、§8.1)。
  if (instanceName === undefined) {
    const named = ctx.declarations
      .slice(declStart)
      .find((d) => "userNamed" in d && (d as { userNamed?: boolean }).userNamed === true);
    if (named !== undefined) {
      const slotName = (named as { name?: string }).name ?? "?";
      throw new Error(
        `unworklet: subgraph instance with a named/persistent/publish slot '${slotName}' ` +
          `must be given an explicit instance name ` +
          `(createSubgraph(subgraph, ...args, { name: '...' })). Without it the snapshot path ` +
          `'__sg_N/...' depends on instantiation order (§8.1 / Q41). ` +
          `(stable ID 'subgraph-missing-name')`,
      );
    }
  }
  return methods;
}
