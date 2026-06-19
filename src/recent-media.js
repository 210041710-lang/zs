import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function nowIso() {
  return new Date().toISOString();
}

export class RecentMediaStore {
  constructor(rootDir) {
    this.rootDir = path.join(rootDir, "recent-media");
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  resolveUserPath(accountId, userId) {
    const dir = path.join(this.rootDir, safeId(accountId));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${safeId(userId)}.json`);
  }

  async load(accountId, userId) {
    const filePath = this.resolveUserPath(accountId, userId);
    try {
      if (!fs.existsSync(filePath)) return { items: [] };
      const raw = await fsp.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed : { items: [] };
    } catch {
      return { items: [] };
    }
  }

  async save(accountId, userId, data) {
    const filePath = this.resolveUserPath(accountId, userId);
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async add(accountId, userId, item) {
    const current = await this.load(accountId, userId);
    const nextItems = [
      { ...item, savedAt: nowIso() },
      ...current.items,
    ].slice(0, 8);
    await this.save(accountId, userId, { items: nextItems });
  }

  async latestRelevant(accountId, userId, kinds = []) {
    const current = await this.load(accountId, userId);
    if (!kinds.length) return current.items[0] || null;
    return current.items.find((item) => kinds.includes(item.kind)) || null;
  }
}
