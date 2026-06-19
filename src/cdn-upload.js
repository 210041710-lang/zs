import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";

const UPLOAD_MAX_RETRIES = 3;

export async function uploadBufferToCdn({
  buf,
  uploadFullUrl,
  uploadParam,
  filekey,
  cdnBaseUrl,
  aeskey,
}) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = uploadFullUrl?.trim()
    ? uploadFullUrl.trim()
    : buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });

  let lastError;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (response.status >= 400 && response.status < 500) {
        const message = response.headers.get("x-error-message") || await response.text();
        throw new Error(`CDN upload client error ${response.status}: ${message}`);
      }
      if (response.status !== 200) {
        const message = response.headers.get("x-error-message") || `status ${response.status}`;
        throw new Error(`CDN upload server error: ${message}`);
      }
      const downloadParam = response.headers.get("x-encrypted-param");
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      return { downloadParam };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("client error")) {
        throw error;
      }
    }
  }
  throw lastError || new Error("CDN upload failed");
}
