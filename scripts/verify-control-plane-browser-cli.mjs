import assert from "node:assert/strict";

function invocation({ container, origin, login, args }) {
  return [
    "exec",
    "--user",
    "1000:1000",
    "--workdir",
    "/opt/bb",
    container,
    "env",
    `HOME=/tmp/bb-thread-client-${login}`,
    `BB_SERVER_URL=${origin}`,
    "BB_CLI=",
    "BB_CLI_ERROR_LOG=0",
    "NODE_EXTRA_CA_CERTS=/tmp/bb-test-certificates/ca.crt",
    "/usr/local/bin/node",
    "apps/cli/dist/index.js",
    "server",
    "access",
    ...args,
    "--json",
  ];
}

export async function readLimitedCli(options) {
  const { stdout } = await options.command("docker", invocation(options));
  return JSON.parse(stdout);
}

export async function verifyForeignCliDenied(options) {
  const { command, privateText } = options;
  await assert.rejects(command("docker", invocation(options)), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /404|not found/iu);
    assert.equal(`${error.stdout}${error.stderr}`.includes(privateText), false);
    return true;
  });
}
