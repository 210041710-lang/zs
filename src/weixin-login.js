import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { fetchLoginQr, fetchLoginStatus } from "./weixin-api.js";

async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loginWeixin(config, store) {
  const localTokenList = store.listAccounts().map((account) => account.token).filter(Boolean).slice(-10);
  const qr = await fetchLoginQr(config, localTokenList);

  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error("Failed to obtain Weixin QR code");
  }

  output.write("Use WeChat to scan this QR code URL:\n");
  output.write(`${qr.qrcode_img_content}\n\n`);

  let verifyCode;
  let currentLoginBase = config.weixinLoginBaseUrl;
  const deadline = Date.now() + 8 * 60_000;

  while (Date.now() < deadline) {
    const status = await fetchLoginStatus({ ...config, weixinLoginBaseUrl: currentLoginBase }, qr.qrcode, verifyCode);

    switch (status.status) {
      case "wait":
        await sleep(1000);
        break;
      case "scaned":
        output.write("QR code scanned, waiting for confirmation...\n");
        verifyCode = undefined;
        await sleep(1000);
        break;
      case "need_verifycode":
        verifyCode = await prompt("Enter the digits shown in WeChat: ");
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) {
          currentLoginBase = `https://${status.redirect_host}`;
        }
        await sleep(1000);
        break;
      case "confirmed": {
        if (!status.bot_token || !status.ilink_bot_id) {
          throw new Error("Login confirmed but token/account id missing");
        }
        const account = {
          accountId: status.ilink_bot_id,
          token: status.bot_token,
          userId: status.ilink_user_id || "",
          baseUrl: status.baseurl || config.weixinBaseUrl,
          getUpdatesBuf: "",
          contextTokens: {},
          savedAt: new Date().toISOString(),
        };
        store.saveAccount(account);
        return account;
      }
      case "binded_redirect":
        throw new Error("This Weixin bot is already bound to the current client");
      case "expired":
        throw new Error("QR code expired, please run login again");
      case "verify_code_blocked":
        throw new Error("Too many invalid verification attempts");
      default:
        await sleep(1000);
        break;
    }
  }

  throw new Error("Timed out waiting for Weixin login confirmation");
}
