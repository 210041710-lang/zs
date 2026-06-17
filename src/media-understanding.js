import fs from "node:fs/promises";
import path from "node:path";

import { execCommand } from "./shell.js";
import { extractPdfText, extractVideoFrames } from "./swift-helpers.js";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".js",
  ".ts",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
]);

function truncateText(text, maxChars = 6000) {
  const clean = String(text || "").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n\n[内容已截断]`;
}

function extnameLower(filePath) {
  return path.extname(filePath).toLowerCase();
}

async function tryReadTextFile(filePath) {
  const ext = extnameLower(filePath);
  if (!TEXT_EXTENSIONS.has(ext)) return null;
  const raw = await fs.readFile(filePath, "utf-8");
  return truncateText(raw);
}

async function tryTextutilExtract(filePath) {
  try {
    const output = await execCommand("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath]);
    const text = truncateText(output.trim());
    return text || null;
  } catch {
    return null;
  }
}

async function tryPdfExtract(filePath) {
  if (extnameLower(filePath) !== ".pdf") return null;
  const output = await extractPdfText(filePath);
  return output ? truncateText(output) : null;
}

async function tryQuickLookThumbnail(filePath, outputDir) {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await execCommand("/usr/bin/qlmanage", ["-t", "-s", "1200", "-o", outputDir, filePath]);
    const expected = path.join(outputDir, `${path.basename(filePath)}.png`);
    return expected;
  } catch {
    return null;
  }
}

async function tryVideoPoster(filePath, outputPath) {
  try {
    await execCommand("/usr/bin/qlmanage", ["-t", "-s", "1200", "-o", path.dirname(outputPath), filePath]);
    const guessed = path.join(path.dirname(outputPath), `${path.basename(filePath)}.png`);
    return guessed;
  } catch {
    return null;
  }
}

export async function buildFileUnderstandingInput(config, media) {
  const previewDir = path.join(config.stateDir, "media-previews");
  let extractedText =
    await tryReadTextFile(media.filePath) ||
    await tryPdfExtract(media.filePath) ||
    await tryTextutilExtract(media.filePath);

  const previewImagePath = await tryQuickLookThumbnail(media.filePath, previewDir);
  let imageDataUrl = null;

  if (previewImagePath) {
    try {
      const buffer = await fs.readFile(previewImagePath);
      imageDataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    } catch {
      imageDataUrl = null;
    }
  }

  const promptParts = [];
  promptParts.push("用户发来一个文件，请结合文件内容、文件预览图和用户问题做真正理解，不要只复述路径。");
  promptParts.push(`文件路径：${media.filePath}`);
  if (media.mimeType) promptParts.push(`文件类型：${media.mimeType}`);
  if (extractedText) {
    promptParts.push("以下是文件中提取出的文本内容：");
    promptParts.push(extractedText);
  } else {
    promptParts.push("当前未能直接提取出正文文本，请优先利用文件预览图和文件类型来判断内容。");
  }

  return {
    promptText: promptParts.join("\n\n"),
    replyOptions: imageDataUrl ? { imageDataUrl } : {},
  };
}

export async function buildVideoUnderstandingInput(config, media, userText) {
  const previewDir = path.join(config.stateDir, "media-previews");
  const frameDir = path.join(previewDir, `${path.basename(media.filePath)}-frames`);
  let framePaths = await extractVideoFrames(media.filePath, frameDir);
  if (framePaths.length === 0) {
    const outputPath = path.join(previewDir, `${path.basename(media.filePath)}.png`);
    const posterPath = await tryVideoPoster(media.filePath, outputPath);
    framePaths = posterPath ? [posterPath] : [];
  }

  let imageDataUrl = null;
  if (framePaths[0]) {
    try {
      const buffer = await fs.readFile(framePaths[0]);
      imageDataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
    } catch {
      imageDataUrl = null;
    }
  }

  const frameNote = framePaths.length > 1
    ? `已额外抽取 ${framePaths.length} 张关键帧供理解参考，当前主输入使用第 1 张关键帧。`
    : framePaths.length === 1
      ? "已抽取 1 张关键帧供理解参考。"
      : "未能抽取关键帧，只能基于视频文件信息理解。";

  return {
    promptText: `${userText ? `${userText}\n\n` : ""}用户发来一个视频，请结合视频关键帧预览来理解内容，不要只复述路径。视频路径：${media.filePath}\n${frameNote}`,
    replyOptions: imageDataUrl ? { imageDataUrl } : {},
  };
}
