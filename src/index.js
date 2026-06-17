import { loadConfig } from "./config.js";
import { StateStore } from "./state.js";
import { loginWeixin } from "./weixin-login.js";
import { runBridge } from "./bridge.js";

async function main() {
  const command = process.argv[2] || "start";
  const config = loadConfig();
  const store = new StateStore(config.stateDir);

  if (command === "login") {
    const account = await loginWeixin(config, store);
    process.stdout.write(`Logged in account: ${account.accountId}\n`);
    return;
  }

  let account = store.getDefaultAccount();
  if (!account) {
    process.stdout.write("No Weixin account found, starting login flow first.\n");
    account = await loginWeixin(config, store);
  }

  await runBridge(config, store, account);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
