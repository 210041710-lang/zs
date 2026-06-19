import fs from "node:fs/promises";
import path from "node:path";

import { extractMemoriesFromConversation, generateImage, generateReply, transcribeAudio } from "./openai.js";
import { getUpdates, getUploadUrl, sendMessageItems, sendTextMessage } from "./weixin-api.js";
import { downloadInboundMedia, extractMediaDirective, fileExists, uploadOutboundMedia } from "./weixin-media.js";
import { buildFileUnderstandingInput, buildVideoUnderstandingInput } from "./media-understanding.js";
import { MemoryStore } from "./memory.js";
import { buildMemoryContext, buildMemoryExtractionMessages } from "./memory-prompts.js";
import { RecentMediaStore } from "./recent-media.js";
import { RecentTurnsStore } from "./recent-turns.js";

function extractInboundText(message) {
  for (const item of message.item_list || []) {
    if (item.type === 1 && item.text_item?.text) {
      return String(item.text_item.text).trim();
    }
    if (item.type === 3 && item.voice_item?.text) {
      return String(item.voice_item.text).trim();
    }
  }
  return "";
}

function findPrimaryMediaItem(message) {
  return (message.item_list || []).find((item) => [2, 3, 4, 5].includes(item.type));
}

function isMediaFollowUp(text) {
  return /(刚才|这个|那张|那条|这个视频|刚才的视频|刚才的图片|这张图|这个文件|那个视频|哪里|哪儿|什么地方|来源|出处)/.test(String(text || ""));
}

function isContextFollowUp(text) {
  return /(这里|那里|这个地方|那个地方|刚才那个地方|什么时候去最好|什么时候去|适合什么时候|最佳时间|值不值得去|怎么去|在哪里|几点去)/.test(String(text || ""));
}

async function buildModelInput(config, message, text, recentMediaStore, accountId) {
  const mediaItem = findPrimaryMediaItem(message);
  let media = null;

  if (mediaItem) {
    media = await downloadInboundMedia(config.stateDir, mediaItem);
  } else if (isMediaFollowUp(text)) {
    media = await recentMediaStore.latestRelevant(accountId, message.from_user_id, ["image", "video", "file"]);
  }

  if (!media) {
    return { promptText: text, replyOptions: {} };
  }

  if (media.kind === "image") {
    const buffer = await fs.readFile(media.filePath);
    const imageDataUrl = `data:${media.mimeType};base64,${buffer.toString("base64")}`;
    return {
      promptText: text
        ? `请结合这张图片和用户当前追问来回答，不要假装没看到图片。\n\n用户追问：${text}`
        : "请描述这张图片，并回答用户与图片相关的问题。",
      replyOptions: { imageDataUrl },
      media,
    };
  }

  if (media.kind === "voice") {
    let transcript = media.transcript?.trim();
    if (!transcript && config.enableVoiceTranscription && media.mimeType === "audio/wav") {
      try {
        transcript = await transcribeAudio(config, media.filePath, media.mimeType);
      } catch {
        transcript = "";
      }
    }
    return {
      promptText: transcript
        ? `${text ? `${text}\n\n` : ""}[用户发送了一条语音，转写文本如下]\n${transcript}`
        : `${text ? `${text}\n\n` : ""}[用户发送了一条语音消息，但当前还没有可用转写。请简短说明你已收到语音，但暂时只能处理带转写的语音。]`,
      replyOptions: {},
      media,
    };
  }

  if (media.kind === "file") {
    const fileInput = await buildFileUnderstandingInput(config, media);
    return {
      ...fileInput,
      promptText: text
        ? `${fileInput.promptText}\n\n用户当前追问：${text}`
        : fileInput.promptText,
      media,
    };
  }

  if (media.kind === "video") {
    const videoInput = await buildVideoUnderstandingInput(config, media, text);
    if (!videoInput.replyOptions?.imageDataUrl) {
      return {
        promptText: `${text ? `${text}\n\n` : ""}[用户发来一个视频，但当前未能成功提取关键帧预览。请明确告诉用户：你暂时无法可靠读取这条视频画面，建议对方补发视频截图、封面或关键帧。]`,
        replyOptions: {},
        media,
      };
    }
    return {
      ...videoInput,
      media,
    };
  }

  return {
    promptText: `${text ? `${text}\n\n` : ""}[用户发送了一个${media.kind === "video" ? "视频" : "文件"}，本地文件路径：${media.filePath}]`,
    replyOptions: {},
    media,
  };
}

function shouldGenerateImage(text) {
  if (!text) return false;
  return /(画一张|生成.*图|做一张图|帮我画|给我画|生成图片|画张|来一张图|做个海报|生成海报)/.test(text);
}

async function maybeGenerateImage(config, text) {
  if (!config.enableImageGeneration || !shouldGenerateImage(text)) return null;
  const imageBuffer = await generateImage(config, text);
  const filePath = path.join(config.stateDir, "media", `generated-${Date.now()}.png`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, imageBuffer);
  return filePath;
}

function formatModelError(error, hadImageInput) {
  const messageText = error instanceof Error ? error.message : String(error);
  if (messageText.includes("IMAGE_UNSUPPORTED")) {
    return "抱歉呀，我现在这条模型通道还不支持直接看图。文字聊天已经正常，但图片理解需要换成支持视觉输入的模型或接口。";
  }
  if (hadImageInput && messageText.includes("unknown variant `image_url`")) {
    return "抱歉呀，当前接的模型接口不支持图片输入格式，所以这张图我现在还看不了。";
  }
  if (messageText.includes("IMAGE_GENERATION_UNAVAILABLE")) {
    return "抱歉呀，我这边还没配置可用的出图模型，所以暂时不能直接画图回你。";
  }
  if (messageText.includes("image generation is only supported by certain models")) {
    return "抱歉呀，当前接的豆包模型会看图聊天，但它本身不负责直接出图，所以这次还画不出来。";
  }
  if (messageText.includes("/audio/transcriptions") || messageText.includes("404")) {
    return `I hit an internal error while answering: ${messageText}`;
  }
  return `I hit an internal error while answering: ${messageText}`;
}

function shouldReply(message, account) {
  if (!message?.from_user_id) return false;
  if (message.message_type !== undefined && message.message_type !== 1) return false;
  if (message.from_user_id === account.accountId) return false;
  return true;
}

export async function runBridge(config, store, account) {
  const memoryStore = new MemoryStore(config.stateDir);
  const recentMediaStore = new RecentMediaStore(config.stateDir);
  const recentTurnsStore = new RecentTurnsStore(config.stateDir);
  process.stdout.write(`Listening as ${account.accountId}\n`);

  while (true) {
    const current = store.loadAccount(account.accountId);
    if (!current) {
      throw new Error(`Account disappeared: ${account.accountId}`);
    }

    const updates = await getUpdates(config, current, current.getUpdatesBuf || "");
    if ((updates.ret !== undefined && updates.ret !== 0) || (updates.errcode !== undefined && updates.errcode !== 0)) {
      throw new Error(`Weixin getupdates failed: ret=${updates.ret ?? ""} errcode=${updates.errcode ?? ""} errmsg=${updates.errmsg ?? ""}`);
    }
    const nextBuf = updates.get_updates_buf ?? current.getUpdatesBuf ?? "";
    let changed = nextBuf !== current.getUpdatesBuf;
    const contextTokens = { ...(current.contextTokens || {}) };

    for (const message of updates.msgs || []) {
      if (!shouldReply(message, current)) continue;

      const fromUserId = message.from_user_id;
      const contextToken = message.context_token || contextTokens[fromUserId];
      if (message.context_token) {
        contextTokens[fromUserId] = message.context_token;
        changed = true;
      }

      const text = extractInboundText(message);
      if (!text && !findPrimaryMediaItem(message)) continue;

      process.stdout.write(`\n[${fromUserId}] ${text || "[media]"}\n`);

      let reply;
      let modelInput;
      const recalledMemories = await memoryStore.retrieve(account.accountId, fromUserId, text || "[media]");
      const lastTurn = await recentTurnsStore.latest(account.accountId, fromUserId);
      const turnContext = isContextFollowUp(text) && lastTurn
        ? `以下是上一轮刚聊过的上下文，请优先承接，不要装作不知道“这里”“刚才那个”指什么。\n上一轮用户消息：${lastTurn.userText}\n上一轮助手回复：${lastTurn.assistantText}`
        : "";
      const extraSystemPrompt = [buildMemoryContext(recalledMemories), turnContext]
        .filter(Boolean)
        .join("\n\n");
      try {
        const generatedImagePath = await maybeGenerateImage(config, text);
        if (generatedImagePath) {
          reply = `给你画好啦，快接住～\nMEDIA:${generatedImagePath}`;
        } else {
          modelInput = await buildModelInput(config, message, text, recentMediaStore, account.accountId);
          reply = await generateReply(config, modelInput.promptText, {
            ...modelInput.replyOptions,
            extraSystemPrompt,
          });
        }
      } catch (error) {
        reply = formatModelError(error, Boolean(modelInput?.replyOptions?.imageDataUrl));
      }

      const mediaDirective = extractMediaDirective(reply);
      if (mediaDirective?.mediaPath && fileExists(mediaDirective.mediaPath)) {
        const mediaItem = await uploadOutboundMedia(
          config,
          current,
          getUploadUrl,
          fromUserId,
          mediaDirective.mediaPath,
        );
        await sendMessageItems(
          config,
          current,
          fromUserId,
          contextToken,
          mediaDirective.cleanText,
          [mediaItem],
        );
      } else {
        await sendTextMessage(config, current, fromUserId, contextToken, reply);
      }
      process.stdout.write(`[bot] ${reply}\n`);

      if (modelInput?.media && ["image", "video", "file", "voice"].includes(modelInput.media.kind)) {
        await recentMediaStore.add(account.accountId, fromUserId, modelInput.media);
      }
      await recentTurnsStore.add(account.accountId, fromUserId, {
        userText: text || "[media]",
        assistantText: reply,
      });

      try {
        const memoryCandidates = await extractMemoriesFromConversation(
          config,
          text || modelInput?.promptText || "",
          reply,
          buildMemoryExtractionMessages(text || modelInput?.promptText || "", reply),
        );
        await memoryStore.upsertMemories(account.accountId, fromUserId, memoryCandidates);
      } catch {
        // Best-effort memory extraction; don't interrupt chat flow.
      }
    }

    if (changed) {
      store.updateSession(account.accountId, (session) => ({
        ...session,
        getUpdatesBuf: nextBuf,
        contextTokens,
        savedAt: new Date().toISOString(),
      }));
    }
  }
}
