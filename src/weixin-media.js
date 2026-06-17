import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { aesEcbPaddedSize, decryptAesEcb } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { buildCdnDownloadUrl } from "./cdn-url.js";
import { getMimeFromFilename } from "./mime.js";
import { silkToWav } from "./silk-transcode.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function randomName(prefix, ext) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}${ext}`;
}

function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`Unsupported aes_key length: ${decoded.length}`);
}

async function fetchCdnBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`CDN download failed ${response.status} ${response.statusText}: ${body}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function ensureMediaDir(stateDir) {
  const mediaDir = path.join(stateDir, "media");
  await fsp.mkdir(mediaDir, { recursive: true });
  return mediaDir;
}

async function saveBufferToMediaDir(stateDir, buffer, preferredName) {
  const mediaDir = await ensureMediaDir(stateDir);
  const filePath = path.join(mediaDir, preferredName);
  await fsp.writeFile(filePath, buffer);
  return filePath;
}

export async function downloadInboundMedia(stateDir, item) {
  if (!item?.type) return null;

  if (item.type === 2 && item.image_item?.media) {
    const media = item.image_item.media;
    const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param || "", CDN_BASE_URL);
    const encrypted = await fetchCdnBytes(url);
    let buffer = encrypted;
    if (item.image_item.aeskey || media.aes_key) {
      const aesKeyBase64 = item.image_item.aeskey
        ? Buffer.from(item.image_item.aeskey, "hex").toString("base64")
        : media.aes_key;
      buffer = decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
    }
    const filePath = await saveBufferToMediaDir(stateDir, buffer, randomName("weixin-image", ".jpg"));
    return { kind: "image", filePath, mimeType: getMimeFromFilename(filePath) };
  }

  if (item.type === 4 && item.file_item?.media?.aes_key) {
    const media = item.file_item.media;
    const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param || "", CDN_BASE_URL);
    const encrypted = await fetchCdnBytes(url);
    const buffer = decryptAesEcb(encrypted, parseAesKey(media.aes_key));
    const fileName = item.file_item.file_name || randomName("weixin-file", ".bin");
    const filePath = await saveBufferToMediaDir(stateDir, buffer, fileName);
    return { kind: "file", filePath, mimeType: getMimeFromFilename(filePath) };
  }

  if (item.type === 5 && item.video_item?.media?.aes_key) {
    const media = item.video_item.media;
    const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param || "", CDN_BASE_URL);
    const encrypted = await fetchCdnBytes(url);
    const buffer = decryptAesEcb(encrypted, parseAesKey(media.aes_key));
    const filePath = await saveBufferToMediaDir(stateDir, buffer, randomName("weixin-video", ".mp4"));
    return { kind: "video", filePath, mimeType: "video/mp4" };
  }

  if (item.type === 3 && item.voice_item?.media?.aes_key) {
    const media = item.voice_item.media;
    const url = media.full_url || buildCdnDownloadUrl(media.encrypt_query_param || "", CDN_BASE_URL);
    const encrypted = await fetchCdnBytes(url);
    const buffer = decryptAesEcb(encrypted, parseAesKey(media.aes_key));
    const wavBuffer = await silkToWav(buffer);
    if (wavBuffer) {
      const filePath = await saveBufferToMediaDir(stateDir, wavBuffer, randomName("weixin-voice", ".wav"));
      return { kind: "voice", filePath, mimeType: "audio/wav", transcript: item.voice_item.text || "" };
    }
    const filePath = await saveBufferToMediaDir(stateDir, buffer, randomName("weixin-voice", ".silk"));
    return { kind: "voice", filePath, mimeType: "audio/silk", transcript: item.voice_item.text || "" };
  }

  return null;
}

export function extractMediaDirective(text) {
  const lines = String(text || "").split(/\r?\n/);
  const mediaLine = lines.find((line) => line.startsWith("MEDIA:"));
  if (!mediaLine) return null;
  const mediaPath = mediaLine.slice("MEDIA:".length).trim();
  const cleanText = lines.filter((line) => line !== mediaLine).join("\n").trim();
  return { mediaPath, cleanText };
}

export async function uploadOutboundMedia(config, account, getUploadUrl, toUserId, filePath) {
  const plaintext = await fsp.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const mime = getMimeFromFilename(filePath);

  const mediaType = mime.startsWith("image/")
    ? 1
    : mime.startsWith("video/")
      ? 2
      : 3;

  const uploadUrlResp = await getUploadUrl(config, account, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrlResp.upload_full_url,
    uploadParam: uploadUrlResp.upload_param,
    filekey,
    cdnBaseUrl: CDN_BASE_URL,
    aeskey,
  });

  if (mediaType === 1) {
    return {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: Buffer.from(aeskey).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: filesize,
      },
    };
  }

  if (mediaType === 2) {
    return {
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: downloadParam,
          aes_key: Buffer.from(aeskey).toString("base64"),
          encrypt_type: 1,
        },
        video_size: filesize,
      },
    };
  }

  return {
    type: 4,
    file_item: {
      media: {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: path.basename(filePath),
      len: String(rawsize),
    },
  };
}

export function fileExists(filePath) {
  return fs.existsSync(filePath);
}
