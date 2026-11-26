import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** Which version this build is (shown in Ajustes), so an app still running an old build can be told apart. */
function buildId(): string {
  let commit = "";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // not a git checkout: the date alone
  }
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  return commit ? `${commit} (${date} UTC)` : `${date} UTC`;
}

export default defineConfig({ plugins: [react()], server: { port: 5173 }, define: { __APP_BUILD__: JSON.stringify(buildId()) } });
