import { performance } from "node:perf_hooks";

export async function smokePhase(name, action, log = console.log) {
	const started = performance.now();
	const report = (status) =>
		log(`[${new Date().toISOString()}] ${status} ${name} (${((performance.now() - started) / 1000).toFixed(3)}s)`);
	report("START");
	try {
		const result = await action();
		report("PASS");
		return result;
	} catch (error) {
		report("FAIL");
		throw error;
	}
}
