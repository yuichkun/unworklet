import type { BinaryenAPI, BinaryenModule } from "./emit.ts";

/**
 * Reduce integer IEEE significands rather than rounding a floating quotient.
 * A remainder has at most 24/53 bits; shifting it by 8/11 bits fits i32/i64.
 * The finite encoded exponent gap is at most 253/2045, so reduction takes at most
 * 32/186 iterations. No allocation, host call, or data-dependent unbounded work.
 */
export function remainderFunction(
  type: "f32" | "f64",
  mod: BinaryenModule,
  binaryen: BinaryenAPI,
): string {
  const name = `$unworklet_mod_${type}`;
  if (mod.getFunction(name)) return name;

  const wide = type === "f64";
  const floatType = binaryen[type];
  const integerType = wide ? binaryen.i64 : binaryen.i32;
  const float = mod[type];
  const integer = wide ? mod.i64 : mod.i32;
  const fractionBits = wide ? 52 : 23;
  const chunkBits = wide ? 11 : 8;
  const exponentMask = wide ? 0x7ff : 0xff;
  const hiddenBit = 2 ** fractionBits;
  const constant = (value: number): number =>
    wide
      ? (mod.i64.const as unknown as (value: bigint) => number)(BigInt(value))
      : mod.i32.const(value);
  const get = (index: number): number => mod.local.get(index, integerType);
  const a = (): number => mod.local.get(0, floatType);
  const b = (): number => mod.local.get(1, floatType);
  const MA = 2;
  const MB = 3;
  const EA = 4;
  const EB = 5;
  const GAP = 6;
  const SHIFT = 7;

  const decode = (value: number, mantissa: number, exponent: number): number[] => [
    mod.local.set(mantissa, integer.reinterpret(float.abs(value))),
    mod.local.set(
      exponent,
      integer.and(integer.shr_u(get(mantissa), constant(fractionBits)), constant(exponentMask)),
    ),
    mod.local.set(
      mantissa,
      integer.or(
        integer.and(get(mantissa), constant(hiddenBit - 1)),
        mod.select(integer.eqz(get(exponent)), constant(0), constant(hiddenBit)),
      ),
    ),
    // Subnormals share the minimum normal exponent but have no implicit bit.
    mod.local.set(exponent, mod.select(integer.eqz(get(exponent)), constant(1), get(exponent))),
  ];

  const body = mod.block(
    null,
    [
      mod.if(
        mod.i32.eqz(
          mod.i32.and(
            float.lt(float.abs(a()), float.const(Infinity)),
            float.gt(float.abs(b()), float.const(0)),
          ),
        ),
        mod.return(float.const(NaN)),
      ),
      // Also preserves either signed zero and finite % either infinity.
      mod.if(float.lt(float.abs(a()), float.abs(b())), mod.return(a())),
      ...decode(a(), MA, EA),
      ...decode(b(), MB, EB),
      mod.local.set(GAP, integer.sub(get(EA), get(EB))),
      mod.local.set(MA, integer.rem_u(get(MA), get(MB))),
      mod.block("remainder_done", [
        mod.loop(
          "remainder_reduce",
          mod.block(null, [
            mod.br("remainder_done", mod.i32.or(integer.eqz(get(GAP)), integer.eqz(get(MA)))),
            mod.local.set(
              SHIFT,
              mod.select(
                integer.lt_u(get(GAP), constant(chunkBits)),
                get(GAP),
                constant(chunkBits),
              ),
            ),
            mod.local.set(MA, integer.rem_u(integer.shl(get(MA), get(SHIFT)), get(MB))),
            mod.local.set(GAP, integer.sub(get(GAP), get(SHIFT))),
            mod.br("remainder_reduce"),
          ]),
        ),
      ]),
      // The integer remainder and its power-of-two scale are exact, including
      // when that scale is subnormal. copysign keeps negative exact multiples -0.
      float.copysign(
        float.mul(
          wide ? mod.f64.convert_u.i64(get(MA)) : mod.f32.convert_u.i32(get(MA)),
          float.mul(
            float.reinterpret(integer.shl(get(EB), constant(fractionBits))),
            float.const(2 ** -fractionBits),
          ),
        ),
        a(),
      ),
    ],
    floatType,
  );
  mod.addFunction(
    name,
    binaryen.createType([floatType, floatType]),
    floatType,
    Array<number>(6).fill(integerType),
    body,
  );
  return name;
}
