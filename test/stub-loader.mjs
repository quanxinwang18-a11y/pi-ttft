/**
 * Module resolution hooks for the test run.
 *
 * Points `@earendil-works/pi-coding-agent` at test/pi-stub.mjs so the extension
 * can be exercised outside Pi, where that specifier has nothing to resolve to.
 * Installed by test/harness.mjs before it imports the extension.
 */

export const STUB_SPECIFIER = "@earendil-works/pi-coding-agent";

export function resolve(specifier, context, nextResolve) {
	if (specifier === STUB_SPECIFIER) {
		return { url: new URL("./pi-stub.mjs", import.meta.url).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
