/**
 * Plugin test fixture: a source file that does not named-export the return value
 * of `defineProcessor()`. Ensures the plugin's load hook reaches the
 * "zero results" error path of `pickCompiledProcessor`.
 */

export const notAProcessor = 42;
export const anotherValue = { foo: "bar" };
