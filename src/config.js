import path from "node:path";
import fs from "node:fs";

const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_WEIXIN_LOGIN_URL = "https://ilinkai.weixin.qq.com";

function normalizeApiBaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/v1";
  }
  return url.toString().replace(/\/+$/, "");
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadDotEnvFile() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadConfig() {
  loadDotEnvFile();
  const configuredOpenAiBaseUrl =
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.ANTHROPIC_BASE_URL?.trim() ||
    "https://api.openai.com/v1";
  return {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    openaiModel: requireEnv("OPENAI_MODEL"),
    openaiVisionModel: process.env.OPENAI_VISION_MODEL?.trim() || requireEnv("OPENAI_MODEL"),
    openaiImageModel: process.env.OPENAI_IMAGE_MODEL?.trim() || "",
    openaiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "whisper-1",
    openaiBaseUrl: normalizeApiBaseUrl(configuredOpenAiBaseUrl),
    openaiSystemPrompt: process.env.OPENAI_SYSTEM_PROMPT?.trim() || "You are a helpful assistant chatting with a user on WeChat. Keep replies concise, natural, and useful.",
    weixinBaseUrl: (process.env.WEIXIN_BASE_URL?.trim() || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, ""),
    weixinLoginBaseUrl: (process.env.WEIXIN_LOGIN_BASE_URL?.trim() || DEFAULT_WEIXIN_LOGIN_URL).replace(/\/+$/, ""),
    appId: process.env.WEIXIN_APP_ID?.trim() || "bot",
    appVersion: process.env.WEIXIN_APP_VERSION?.trim() || "0.1.0",
    stateDir: path.resolve(process.env.STATE_DIR?.trim() || "./state"),
    pollTimeoutMs: Number(process.env.WEIXIN_POLL_TIMEOUT_MS?.trim() || 35000),
    openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS?.trim() || 120000),
    enableVision: String(process.env.ENABLE_VISION_INPUT?.trim() || "true").toLowerCase() !== "false",
    enableImageGeneration: String(process.env.ENABLE_IMAGE_GENERATION?.trim() || "true").toLowerCase() !== "false",
    enableVoiceTranscription: String(process.env.ENABLE_VOICE_TRANSCRIPTION?.trim() || "true").toLowerCase() !== "false",
  };
}
