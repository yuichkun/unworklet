// Diagnostic-only: remove this module and its hooks after the bounded observation.
export class BoundaryTrace {
  readonly rows: Float64Array;
  used = 0;
  dropped = 0;
  requestId = 0;
  protocol = 0;
  constructor(capacity = 2048) {
    this.rows = new Float64Array(capacity * 9);
  }
  record(
    phase: number,
    requestId: number,
    clock: number,
    state: number,
    count: number,
    freeze: number,
    length: number,
    last: number,
    mirror: number,
  ): void {
    if (this.used * 9 === this.rows.length) {
      this.dropped++;
      return;
    }
    const at = this.used++ * 9;
    this.rows[at] = phase;
    this.rows[at + 1] = requestId;
    this.rows[at + 2] = clock;
    this.rows[at + 3] = state;
    this.rows[at + 4] = count;
    this.rows[at + 5] = freeze;
    this.rows[at + 6] = length;
    this.rows[at + 7] = last;
    this.rows[at + 8] = mirror;
  }
}

export const boundaryContexts = new WeakMap<object, BoundaryTrace>();
