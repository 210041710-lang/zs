import fs from "node:fs/promises";
import path from "node:path";

async function fetchResponseJson(url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

async function fetchJsonWithText(url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}: ${text}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function extractText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const texts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        texts.push(content.text);
      }
    }
  }
  return texts.join("\n").trim();
}

function extractChatCompletionsText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function buildResponsesInput(config, inputText, mediaParts = []) {
  const systemBlocks = [{ type: "input_text", text: config.openaiSystemPrompt }];
  if (config.extraSystemPrompt) {
    systemBlocks.push({ type: "input_text", text: config.extraSystemPrompt });
  }
  return [
    {
      role: "system",
      content: systemBlocks,
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: inputText },
        ...mediaParts,
      ],
    },
  ];
}

function buildChatMessages(config, inputText, mediaParts = []) {
  const userContent = mediaParts.length
    ? [{ type: "text", text: inputText }, ...mediaParts]
    : inputText;
  const systemContent = config.extraSystemPrompt
    ? `${config.openaiSystemPrompt}\n\n${config.extraSystemPrompt}`
    : config.openaiSystemPrompt;
  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

export async function generateReply(config, inputText, options = {}) {
  const runtimeConfig = { ...config, extraSystemPrompt: options.extraSystemPrompt || "" };
  const responseMediaParts = options.imageDataUrl
    ? [{ type: "input_image", image_url: options.imageDataUrl }]
    : [];
  try {
    const response = await fetchResponseJson(
      `${runtimeConfig.openaiBaseUrl}/responses`,
      runtimeConfig.openaiApiKey,
      {
        model: options.imageDataUrl ? runtimeConfig.openaiVisionModel : runtimeConfig.openaiModel,
        input: buildResponsesInput(runtimeConfig, inputText, responseMediaParts),
      },
      runtimeConfig.openaiTimeoutMs,
    );

    const text = extractText(response);
    if (!text) {
      throw new Error("Responses API did not contain text output");
    }
    return text;
  } catch (error) {
    if (!(error instanceof Error) || !String(error.message).startsWith("404")) {
      throw error;
    }
  }

  if (options.imageDataUrl) {
    throw new Error("IMAGE_UNSUPPORTED: current model backend does not support image input on the chat/completions fallback path");
  }

  const chatResponse = await fetchJsonWithText(
    `${runtimeConfig.openaiBaseUrl}/chat/completions`,
    runtimeConfig.openaiApiKey,
    {
      model: options.imageDataUrl ? runtimeConfig.openaiVisionModel : runtimeConfig.openaiModel,
      messages: buildChatMessages(
        runtimeConfig,
        inputText,
        options.imageDataUrl
          ? [{ type: "image_url", image_url: { url: options.imageDataUrl } }]
          : [],
      ),
    },
    runtimeConfig.openaiTimeoutMs,
  );

  const fallbackText = extractChatCompletionsText(chatResponse);
  if (!fallbackText) {
    throw new Error("Chat Completions API did not contain text output");
  }
  return fallbackText;
}

function parseImageBase64FromResponse(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      if (item?.b64_json) return item.b64_json;
      if (item?.url) return item.url;
    }
  }
  for (const outputItem of payload.output || []) {
    for (const content of outputItem.content || []) {
      if (content?.type === "output_image" && content?.b64_json) return content.b64_json;
      if (content?.type === "output_image" && content?.image_url) return content.image_url;
    }
  }
  return null;
}

export async function transcribeAudio(config, filePath, mimeType = "audio/wav") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openaiTimeoutMs);
  try {
    const form = new FormData();
    const buffer = await fs.readFile(filePath);
    form.append("model", config.openaiTranscriptionModel);
    form.append("file", new Blob([buffer], { type: mimeType }), path.basename(filePath));

    const response = await fetch(`${config.openaiBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text}`);
    }
    const json = text ? JSON.parse(text) : {};
    return String(json.text || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function generateImage(config, prompt) {
  if (!config.openaiImageModel) {
    throw new Error("IMAGE_GENERATION_UNAVAILABLE: OPENAI_IMAGE_MODEL is not configured");
  }

  const payload = await fetchJsonWithText(
    `${config.openaiBaseUrl}/images/generations`,
    config.openaiApiKey,
    {
      model: config.openaiImageModel,
      prompt,
      size: "1024x1024",
    },
    config.openaiTimeoutMs,
  );

  const imageResult = parseImageBase64FromResponse(payload);
  if (!imageResult) {
    throw new Error("Image generation response did not contain an image");
  }

  if (String(imageResult).startsWith("http://") || String(imageResult).startsWith("https://")) {
    const response = await fetch(String(imageResult));
    if (!response.ok) {
      throw new Error(`Failed to download generated image: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  return Buffer.from(String(imageResult), "base64");
}

export async function extractMemoriesFromConversation(config, userText, assistantText, messages) {
  const chatResponse = await fetchJsonWithText(
    `${config.openaiBaseUrl}/chat/completions`,
    config.openaiApiKey,
    {
      model: config.openaiModel,
      messages,
      temperature: 0.1,
    },
    config.openaiTimeoutMs,
  );

  const content = extractChatCompletionsText(chatResponse);
  if (!content) {
    return [];
  }
  try {
    const parsed = extractJsonObject(content);
    return Array.isArray(parsed.memories) ? parsed.memories : [];
  } catch {
    return [];
  }
}
