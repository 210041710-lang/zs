import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function nowIso() {
  return new Date().toISOString();
}

export class RecentTurnsStore {
  constructor(rootDir) {
    this.rootDir = path.join(rootDir, "recent-turns");
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
      if (!fs.existsSync(filePath)) return { turns: [] };
      const raw = await fsp.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.turns) ? parsed : { turns: [] };
    } catch {
      return { turns: [] };
    }
  }

  async save(accountId, userId, data) {
    const filePath = this.resolveUserPath(accountId, userId);
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async add(accountId, userId, turn) {
    const current = await this.load(accountId, userId);
    const nextTurns = [
      {
        ...turn,
        savedAt: nowIso(),
      },
      ...current.turns,
    ].slice(0, 12);
    await this.save(accountId, userId, { turns: nextTurns });
  }

  async latest(accountId, userId) {
    const current = await this.load(accountId, userId);
    return current.turns[0] || null;
  }
}
