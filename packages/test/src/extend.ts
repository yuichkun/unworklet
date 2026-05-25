/**
 * `@unworklet/test/extend` — side-effect import で chain form (=
 * `expect(result).toMatchAudio(...)` 等) を vitest `expect.extend(...)` に
 * 登 録 す る subpath (`docs/06-testing.md` §6)。
 *
 * Phase 4 skeleton stage = 中 身 空 (= chain method 未 登 録)。 chain 名 規
 * 約 + 全 件 fill は impl phase incremental で 別 grill 確 定。 import 自 体
 * は OK = consumer は subpath を 認 識 し て お く、 chain method を 呼 ぶ
 * test は vitest 「matcher not registered」 で fail す る。
 */

export {};
