import crypto from "node:crypto";

function buildClientVersion(version) {
  const parts = String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders(config) {
  return {
    "iLink-App-Id": config.appId,
    "iLink-App-ClientVersion": String(buildClientVersion(config.appVersion)),
  };
}

function buildAuthedHeaders(config, token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(config),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

export async function postWeixin(config, baseUrl, endpoint, token, body, timeoutMs = 15000) {
  return fetchJson(
    `${baseUrl.replace(/\/+$/, "")}/${endpoint}`,
    {
      method: "POST",
      headers: buildAuthedHeaders(config, token),
      body: JSON.stringify({
        ...body,
        base_info: {
          channel_version: config.appVersion,
          bot_agent: "WeixinOpenAIBridge/0.1.0",
        },
      }),
    },
    timeoutMs,
  );
}

export async function getWeixin(config, baseUrl, endpoint, timeoutMs = 35000) {
  return fetchJson(
    `${baseUrl.replace(/\/+$/, "")}/${endpoint}`,
    {
      method: "GET",
      headers: buildCommonHeaders(config),
    },
    timeoutMs,
  );
}

export async function getUpdates(config, account, getUpdatesBuf) {
  try {
    return await postWeixin(
      config,
      account.baseUrl,
      "ilink/bot/getupdates",
      account.token,
      { get_updates_buf: getUpdatesBuf || "" },
      config.pollTimeoutMs,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf || "" };
    }
    throw error;
  }
}

export async function sendTextMessage(config, account, toUserId, contextToken, text) {
  return sendMessageItems(
    config,
    account,
    toUserId,
    contextToken,
    text,
    [],
  );
}

export async function sendMessageItems(config, account, toUserId, contextToken, text, extraItems = []) {
  const itemList = [];
  if (text) {
    itemList.push({
      type: 1,
      text_item: { text },
    });
  }
  itemList.push(...extraItems);
  return postWeixin(
    config,
    account.baseUrl,
    "ilink/bot/sendmessage",
    account.token,
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken || undefined,
        item_list: itemList,
      },
    },
  );
}

export async function getUploadUrl(config, account, body) {
  return postWeixin(
    config,
    account.baseUrl,
    "ilink/bot/getuploadurl",
    account.token,
    body,
  );
}

export async function fetchLoginQr(config, localTokenList = []) {
  return postWeixin(
    config,
    config.weixinLoginBaseUrl,
    "ilink/bot/get_bot_qrcode?bot_type=3",
    undefined,
    { local_token_list: localTokenList },
  );
}

export async function fetchLoginStatus(config, qrcode, verifyCode) {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set("verify_code", verifyCode);
  return getWeixin(
    config,
    config.weixinLoginBaseUrl,
    `ilink/bot/get_qrcode_status?${query.toString()}`,
  );
}
