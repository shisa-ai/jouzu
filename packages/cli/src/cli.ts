#!/usr/bin/env node

const VERSION = "0.0.1";
const PREVIEW_MESSAGE =
	"Jouzu is reserved for an upcoming Japanese-first Pi distribution. This preview package is not functional yet.";

function printDoctor(): void {
	console.log(
		JSON.stringify(
			{
				name: "jouzu",
				version: VERSION,
				status: "package-name-reservation",
				node: process.version,
				platform: process.platform,
				architecture: process.arch,
			},
			null,
			2,
		),
	);
}

const [command] = process.argv.slice(2);

switch (command) {
	case "--version":
	case "-v":
	case "version":
		console.log(VERSION);
		break;
	case "doctor":
		printDoctor();
		break;
	case "--help":
	case "-h":
		console.log("Usage: jouzu [--version|doctor]");
		console.log(PREVIEW_MESSAGE);
		break;
	default:
		console.log(PREVIEW_MESSAGE);
}
