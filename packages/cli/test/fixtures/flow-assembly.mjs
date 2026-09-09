import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createQualifiedFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { createFlowControlRuntime } from "../../dist/flow-control/flow-runtime.js";

/** Build the production assembly the launcher uses, without a host session yet. */
export async function assembledRuntime(t, { root: sharedRoot, ...overrides } = {}) {
	const root = sharedRoot ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-assembly-")));
	const errors = [];
	const flow = createFlowControlRuntime({ root, onError: (error) => errors.push(error), ...overrides });
	t.after(async () => {
		await flow.dispose();
		if (!sharedRoot) await rm(root, { recursive: true, force: true });
	});
	return { flow, root, errors };
}

/** Attach the assembly to a session whose provider route passes qualification. */
export async function assembledSession(
	t,
	{ reverseExtensions = false, producerExtensions = [], script, ...overrides } = {},
) {
	const assembly = await assembledRuntime(t, overrides);
	const sessionManager = SessionManager.inMemory(assembly.root);
	const ingress = await assembly.flow.flowIngressFactory({ cwd: assembly.root, sessionManager });
	// Producer extensions load first so their event listeners exist before the ingress attaches and
	// the bridges run their handshakes.
	const bridges = reverseExtensions ? [...assembly.flow.extensions].reverse() : assembly.flow.extensions;
	const extensions = [...producerExtensions, ...bridges];
	const { session, bodies, runtime } = await createQualifiedFlowSession(t, {
		root: assembly.root,
		sessionManager,
		extensions,
		script,
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	return { ...assembly, ingress, session, sessionManager, bodies, runtime };
}

/**
 * A producer with no plugin-specific support in the controller, used to prove admission policy
 * does not branch on producer names and to drive automated work at exact points in a race.
 */
export function syntheticProducer(namespace = "synthetic") {
	const state = { intents: [], builds: [], buildGate: undefined };
	return {
		state,
		/** Replace the runnable descriptor set the controller will see on its next snapshot. */
		offer(intents) {
			state.intents = intents.map((intent) => ({
				producer: namespace,
				sequence: 1,
				rank: 4,
				independent: true,
				runnable: true,
				...intent,
			}));
		},
		producer: {
			version: 1,
			namespace,
			async snapshot() {
				return state.intents.map((intent) => ({ ...intent }));
			},
			async build(intent) {
				state.builds.push(intent.id);
				if (state.buildGate) await state.buildGate;
				return { id: intent.id, revision: intent.revision, kind: "work", text: `work ${intent.id}` };
			},
		},
	};
}

const cliRoot = join(import.meta.dirname, "../../../..");
// The task extension defaults to one shared /tmp directory, so suites would enumerate each other's
// task logs and slow down as it grows. One directory per test process, left for OS temp cleanup:
// removing it during teardown races the extension's own shutdown.
process.env.PI_BG_TASK_DIR ??= mkdtempSync(join(tmpdir(), "jouzu-flow-tasks-"));
const bundles = new Map();

/** Bundle an installed extension's TypeScript entry so a real session can load it. */
async function bundleExtension(entry) {
	if (bundles.has(entry)) return bundles.get(entry);
	const { build } = await import("esbuild");
	const outputDir = await mkdtemp(join(cliRoot, "packages/cli/node_modules/.jouzu-assembly-"));
	const outfile = join(outputDir, "extension.mjs");
	await build({
		entryPoints: [join(cliRoot, "packages/cli/node_modules", entry)],
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile,
		logLevel: "silent",
	});
	const loaded = import(pathToFileURL(outfile).href).then((module) => ({ module, outputDir }));
	bundles.set(entry, loaded);
	// The cache outlives any one test, so clean the bundle directory when the process exits.
	process.once("exit", () => {
		try {
			rmSync(outputDir, { recursive: true, force: true });
		} catch {
			// A leftover bundle directory is harmless; never fail a suite on cleanup.
		}
	});
	return loaded;
}

/**
 * The installed producer pair, loaded as real extensions rather than the inert Jouzu bridges.
 * Without these the background handshake reports an unavailable source and the multiloop bridge
 * never receives a producer, so ordering and isolation cases would prove nothing about the pair.
 */
export async function installedProducerExtensions() {
	const [loop, background] = await Promise.all([
		bundleExtension("pi-multiloop/extensions/pi-multiloop/index.ts"),
		bundleExtension("@vanillagreen/pi-background-tasks/extensions/background-tasks.ts"),
	]);
	return [
		{ name: "pi-multiloop", factory: loop.module.default },
		{ name: "pi-background-tasks", factory: background.module.default },
	];
}
