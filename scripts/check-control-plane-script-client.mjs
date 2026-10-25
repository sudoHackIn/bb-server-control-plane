import { spawn } from "node:child_process";
const child = spawn(
  "/usr/bin/sudo",
  [
    "-n",
    "--",
    "/opt/bb-control-plane/launcher/helper.py",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
