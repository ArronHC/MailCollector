import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "mobile", "android");
const java = path.join(root, "android", "app", "src", "main", "java", "com", "openspace", "mailcollector");
const xml = path.join(root, "android", "app", "src", "main", "res", "xml");
const manifestPath = path.join(root, "android", "app", "src", "main", "AndroidManifest.xml");

await mkdir(java, { recursive: true });
await mkdir(xml, { recursive: true });
await copyFile(path.join(source, "MainActivity.java"), path.join(java, "MainActivity.java"));
await copyFile(path.join(source, "AppUpdatePlugin.java"), path.join(java, "AppUpdatePlugin.java"));
await copyFile(path.join(source, "update_file_paths.xml"), path.join(xml, "update_file_paths.xml"));

let manifest = await readFile(manifestPath, "utf8");
if (!manifest.includes("android.permission.REQUEST_INSTALL_PACKAGES")) {
  manifest = manifest.replace(/(<manifest[^>]*>)/, `$1\n\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`);
}
if (!manifest.includes(".fileprovider")) {
  manifest = manifest.replace(/\s*<\/application>/, `
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/update_file_paths" />
        </provider>
    </application>`);
}
await writeFile(manifestPath, manifest);

console.log("Prepared Android in-app updater sources and manifest.");
