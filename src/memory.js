import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

export class MemoryStore {
  constructor(rootDir) {
    this.rootDir = path.join(rootDir, "memory");
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
      if (!fs.existsSync(filePath)) {
        return { memories: [] };
      }
      const raw = await fsp.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.memories)) {
        return { memories: [] };
      }
      return parsed;
    } catch {
      return { memories: [] };
    }
  }

  async save(accountId, userId, data) {
    const filePath = this.resolveUserPath(accountId, userId);
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async retrieve(accountId, userId, query, limit = 6) {
    const data = await this.load(accountId, userId);
    const queryTokens = new Set(tokenize(query));
    const scored = data.memories
      .map((memory) => {
        const memoryTokens = tokenize(`${memory.text || ""} ${(memory.tags || []).join(" ")}`);
        let overlap = 0;
        for (const token of memoryTokens) {
          if (queryTokens.has(token)) overlap += 1;
        }
        const pinnedBoost = memory.pinned ? 5 : 0;
        const importanceBoost = Number(memory.importance || 0);
        const score = overlap * 3 + pinnedBoost + importanceBoost;
        return { memory, score };
      })
      .filter((item) => item.score > 0 || item.memory.pinned)
      .sort((a, b) => b.score - a.score || String(b.memory.updatedAt || "").localeCompare(String(a.memory.updatedAt || "")))
      .slice(0, limit)
      .map((item) => item.memory);

    return scored;
  }

  async upsertMemories(accountId, userId, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    const data = await this.load(accountId, userId);
    const existing = data.memories || [];

    for (const candidate of candidates) {
      const text = String(candidate.text || "").trim();
      if (!text) continue;
      const normalized = text.toLowerCase();
      const found = existing.find((item) => String(item.text || "").trim().toLowerCase() === normalized);
      if (found) {
        found.updatedAt = nowIso();
        found.category = candidate.category || found.category || "general";
        found.tags = Array.isArray(candidate.tags) && candidate.tags.length ? candidate.tags : found.tags || [];
        found.importance = Math.max(Number(found.importance || 0), Number(candidate.importance || 0));
        if (typeof candidate.pinned === "boolean") {
          found.pinned = candidate.pinned;
        }
      } else {
        existing.push({
          text,
          category: candidate.category || "general",
          tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 8) : [],
          importance: Number(candidate.importance || 1),
          pinned: Boolean(candidate.pinned),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }

    const trimmed = existing
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.importance || 0) - Number(a.importance || 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .slice(0, 200);

    await this.save(accountId, userId, { memories: trimmed });
  }
}
