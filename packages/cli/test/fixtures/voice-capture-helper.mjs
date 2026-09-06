// Protocol fixture: never opens an audio device.
let device;
process.on("message", (message) => {
	if (message.type === "devices") {
		process.send({ type: "devices", devices: ["Test microphone"] }, () => process.exit(0));
	} else if (message.type === "start") {
		device = message.device;
		if (device === 2) return; // Simulate a blocked native initialization.
		process.send({ type: "ready" });
		process.send({ type: "audio", audio: Buffer.alloc(3200, 7).toString("base64") });
	} else if (message.type === "stop") {
		if (device === 1) return; // Simulate a blocked native read.
		process.send({ type: "audio", audio: Buffer.alloc(3200, 8).toString("base64") });
		process.send({ type: "stopped" }, () => process.exit(0));
	}
});
