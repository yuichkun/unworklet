// @unworklet/bench — benchmarking utilities (re-exported from @unworklet/cli).
//
// The actual bench harness lives in @unworklet/cli/commands.ts because it's
// shared with the CLI subcommand. @unworklet/bench provides programmatic
// access for in-test benchmarking and CI integration.

export { cmdBench, type BenchOptions } from "@unworklet/cli";
