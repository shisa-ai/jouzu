export const voiceBundleFiles = [
	"dist/voice/integration.js",
	"dist/voice/capture.js",
	"dist/voice/capture-worker.js",
	"dist/voice/realtime.js",
	"dist/voice/transcript.js",
	"dist/voice/errors.js",
	"node_modules/ws/index.js",
	"node_modules/ws/LICENSE",
	"node_modules/@picovoice/pvrecorder-node/dist/index.js",
	...[
		"linux/x86_64",
		"mac/arm64",
		"mac/x86_64",
		"windows/amd64",
		"windows/arm64",
		"raspberry-pi/cortex-a53",
		"raspberry-pi/cortex-a53-aarch64",
		"raspberry-pi/cortex-a72",
		"raspberry-pi/cortex-a72-aarch64",
		"raspberry-pi/cortex-a76",
		"raspberry-pi/cortex-a76-aarch64",
	].map((platform) => `node_modules/@picovoice/pvrecorder-node/lib/${platform}/pv_recorder.node`),
];

export function assertVoiceBundlePresent(packedFiles) {
	const paths = new Set(packedFiles.map((file) => file.path));
	for (const path of voiceBundleFiles) {
		if (!paths.has(path)) throw new Error(`jouzu tarball is missing voice file ${path}`);
	}
}
