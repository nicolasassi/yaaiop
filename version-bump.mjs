import { readFileSync, writeFileSync } from "fs";

/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * Run automatically by `npm version` (see the "version" script). Obsidian reads
 * the version from manifest.json, and versions.json tells older app builds which
 * plugin release they can still install — both must move together, and a release
 * tag must match the manifest version exactly, with no leading "v".
 */
const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	console.error("npm_package_version is not set — run this via `npm version`.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Set version ${targetVersion} (minAppVersion ${minAppVersion}).`);
