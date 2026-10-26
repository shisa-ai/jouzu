#!/usr/bin/env node
// Exact-source equality is a review lead, not proof of an untranslated UI surface.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FluentParser } from "@fluent/syntax";

const root = resolve(import.meta.dirname, "../../..");
const parser = new FluentParser({ withSpans: true });
const catalogs = {};
const receipts = [];
for (const locale of ["en", "ja"]) {
	const messages = new Map();
	const directory = join(root, "packages/cli/locales", locale);
	for (const filename of readdirSync(directory).filter((name) => name.endsWith(".ftl")).sort()) {
		const path = join(directory, filename);
		const source = readFileSync(path, "utf8");
		receipts.push({ source_file: `packages/cli/locales/${locale}/${filename}`, sha256: createHash("sha256").update(source).digest("hex") });
		for (const entry of parser.parse(source).body) {
			if (entry.type === "Junk") throw new Error(`invalid Fluent source in ${filename}`);
			if (entry.type !== "Message") continue;
			if (messages.has(entry.id.name)) throw new Error(`duplicate Fluent ID: ${entry.id.name}`);
			messages.set(entry.id.name, {
				file: `packages/cli/locales/${locale}/${filename}`,
				value: entry.value ? source.slice(entry.value.span.start, entry.value.span.end) : "",
				attributes: entry.attributes.map((attribute) => [attribute.id.name, source.slice(attribute.value.span.start, attribute.value.span.end)]),
			});
		}
	}
	catalogs[locale] = messages;
}
const enIds = [...catalogs.en.keys()].sort();
if (JSON.stringify(enIds) !== JSON.stringify([...catalogs.ja.keys()].sort())) throw new Error("catalog ID sets differ");
const rows = [];
for (const id of enIds) {
	const english = catalogs.en.get(id);
	const japanese = catalogs.ja.get(id);
	if (english.value !== japanese.value || JSON.stringify(english.attributes) !== JSON.stringify(japanese.attributes)) continue;
	rows.push([id, japanese.file, english.value, japanese.value, JSON.stringify(japanese.attributes), "same-source-needs-context"]);
}
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const header = ["fluent_id", "source_file", "english_source", "japanese_source", "attributes_json", "source_equality"];
writeFileSync(join(import.meta.dirname, "catalog-identical.csv"), `${[header, ...rows].map((row) => row.map(quote).join(",")).join("\n")}\n`);
writeFileSync(join(import.meta.dirname, "catalog-receipt.json"), `${JSON.stringify({ schema_version: 1, messages_per_locale: enIds.length, identical_source_candidates: rows.length, receipts }, null, 2)}\n`);
console.log(`Compared ${enIds.length} messages per locale; saved ${rows.length} identical-source candidates.`);
