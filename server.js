import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());
const { default: app } = await import("./server/app.js");

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`PulseCheck Node server listening on http://localhost:${port}`);
});
