/**
 * Plugin test fixture = source file が `defineProcessor()` 戻 り 値 を
 * named export し て い な い ケ ー ス。 plugin の load hook が
 * `pickCompiledProcessor` の 「0 件」 error path に 落 ち る こ と を 担 保。
 */

export const notAProcessor = 42;
export const anotherValue = { foo: "bar" };
