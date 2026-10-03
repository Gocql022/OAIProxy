import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const repoRoot = path.resolve(__dirname, "..", "..");

function readJson<T>(relativePath: string): T {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

function listSourceFiles(directory: string, extension: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(fullPath, extension));
		} else if (entry.name.endsWith(extension)) {
			files.push(fullPath);
		}
	}
	return files;
}

function unescapeStringLiteral(value: string): string {
	try {
		return JSON.parse(`"${value}"`) as string;
	} catch {
		return value.replace(/\\(["\\/bfnrtu])/g, "$1");
	}
}

/** Collects every string literal passed to `l10n.t("...")` in the extension source. */
function collectRuntimeL10nKeys(): Map<string, string> {
	const keys = new Map<string, string>();
	const pattern = /l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;
	for (const file of listSourceFiles(path.join(repoRoot, "src"), ".ts")) {
		const relativePath = path.relative(repoRoot, file);
		if (relativePath.startsWith(path.join("src", "test"))) {
			continue;
		}
		const contents = fs.readFileSync(file, "utf8");
		for (const match of contents.matchAll(pattern)) {
			keys.set(unescapeStringLiteral(match[1]), relativePath);
		}
	}
	return keys;
}

function collectManifestNlsKeys(): Set<string> {
	const manifest = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
	const keys = new Set<string>();
	for (const match of manifest.matchAll(/%([^%"]+)%/g)) {
		keys.add(match[1]);
	}
	return keys;
}

suite("l10n", () => {
	test("declares the runtime localization folder in package.json", () => {
		const manifest = readJson<{ contributes?: Record<string, unknown>; l10n?: string }>("package.json");

		assert.strictEqual(
			manifest.l10n,
			"./l10n",
			"package.json must declare a top-level \"l10n\": \"./l10n\"; without it vscode.l10n.t() falls back to English."
		);
		assert.ok(!manifest.contributes?.l10n, "the l10n folder must not be declared under \"contributes\"");
		assert.ok(
			fs.existsSync(path.join(repoRoot, "l10n", "bundle.l10n.json")),
			"l10n/bundle.l10n.json is required for runtime localization."
		);
	});

	test("translates every runtime l10n string", () => {
		const keys = collectRuntimeL10nKeys();
		assert.ok(keys.size > 0, "expected at least one vscode.l10n.t() string literal in src");

		const english = readJson<Record<string, string>>("l10n/bundle.l10n.json");
		const chinese = readJson<Record<string, string>>("l10n/bundle.l10n.zh-cn.json");

		for (const [key, file] of keys) {
			assert.ok(key in english, `${file}: missing key in l10n/bundle.l10n.json -> ${key}`);
			assert.ok(key in chinese, `${file}: missing key in l10n/bundle.l10n.zh-cn.json -> ${key}`);
		}

		assert.deepStrictEqual(
			Object.keys(english).sort(),
			Object.keys(chinese).sort(),
			"l10n/bundle.l10n.json and l10n/bundle.l10n.zh-cn.json must expose the same keys"
		);
	});

	test("translates every package.json contribution reference", () => {
		const english = readJson<Record<string, string>>("package.nls.json");
		const chinese = readJson<Record<string, string>>("package.nls.zh-cn.json");

		assert.deepStrictEqual(
			Object.keys(english).sort(),
			Object.keys(chinese).sort(),
			"package.nls.json and package.nls.zh-cn.json must expose the same keys"
		);

		for (const key of collectManifestNlsKeys()) {
			assert.ok(key in english, `package.json: missing key in package.nls.json -> ${key}`);
			assert.ok(key in chinese, `package.json: missing key in package.nls.zh-cn.json -> ${key}`);
		}
	});
});
