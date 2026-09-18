/**
 * Test stub for the `@earendil-works/pi-coding-agent` module.
 *
 * The extension imports SettingsManager / getAgentDir / CONFIG_DIR_NAME at
 * runtime, which Pi provides from its bundled copy. Outside Pi there is nothing
 * to resolve, so test/stub-loader.mjs redirects the specifier here.
 *
 * Tests control the returned settings through setStubSettings().
 */

let globalSettings = {};
let projectSettings = {};

export function setStubSettings({ global = {}, project = {} } = {}) {
	globalSettings = global;
	projectSettings = project;
}

export function getAgentDir() {
	return "/stub/agent";
}

export const CONFIG_DIR_NAME = ".pi";

export const SettingsManager = {
	create() {
		return {
			getGlobalSettings: () => globalSettings,
			getProjectSettings: () => projectSettings,
		};
	},
};
