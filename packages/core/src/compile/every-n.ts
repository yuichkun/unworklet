// The call site advances in stride-sized steps, so it fires every N/gcd(N, stride)
// invocations. BigInt is compile-time only and preserves every accepted number.
export function everyNResetWords(divisor: number, stride: number): number[] {
  // Layout runs before the diagnostic error gate; invalid loops still need a
  // placeholder slot so analysis can report all errors together.
  if (!Number.isInteger(divisor) || divisor < 1 || !Number.isInteger(stride) || stride < 1) {
    return [0];
  }
  const period = BigInt(divisor);
  let a = period;
  let b = BigInt(stride);
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  let remaining = period / a - 1n;
  const words: number[] = [];
  do {
    words.push(Number(remaining & 0xffff_ffffn));
    remaining >>= 32n;
  } while (remaining !== 0n);
  return words;
}
