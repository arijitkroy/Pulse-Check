import fs from "node:fs";

const requiredPages = [
  "index.html",
  "login.html",
  "register.html",
  "dashboard.html",
  "status.html",
  "monitor.html",
  "incidents.html",
  "settings.html",
];
const missing = requiredPages.filter((file) => !fs.existsSync(`out/${file}`));

if (missing.length) {
  console.error(
    `Static export is missing required pages: ${missing.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Verified ${requiredPages.length} exported pages in out/.`);
}
