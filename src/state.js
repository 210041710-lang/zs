import fs from "node:fs";
import path from "node:path";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeAccountId(accountId) {
  return accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class StateStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.accountsDir = path.join(rootDir, "accounts");
    ensureDir(this.accountsDir);
  }

  resolveAccountPath(accountId) {
    return path.join(this.accountsDir, `${safeAccountId(accountId)}.json`);
  }

  saveAccount(account) {
    const filePath = this.resolveAccountPath(account.accountId);
    fs.writeFileSync(filePath, JSON.stringify(account, null, 2), "utf-8");
  }

  loadAccount(accountId) {
    const filePath = this.resolveAccountPath(accountId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  listAccounts() {
    return fs
      .readdirSync(this.accountsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.accountsDir, name), "utf-8")));
  }

  getDefaultAccount() {
    const accounts = this.listAccounts().sort((a, b) => {
      return String(b.savedAt || "").localeCompare(String(a.savedAt || ""));
    });
    return accounts[0] || null;
  }

  updateSession(accountId, updater) {
    const current = this.loadAccount(accountId);
    if (!current) {
      throw new Error(`Unknown account: ${accountId}`);
    }
    const next = updater(current);
    this.saveAccount(next);
    return next;
  }
}
