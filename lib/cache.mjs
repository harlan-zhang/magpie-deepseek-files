import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function defaultCachePath() {
  if (process.env.MAGPIE_DEEPSEEK_FILES_CACHE) return process.env.MAGPIE_DEEPSEEK_FILES_CACHE
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "magpie", "deepseek-files", "cache.json")
}

const sharedCaches = new Map()

export function sharedCache(options) {
  const key = `${options.filePath}\u0000${options.accountHash}`
  let cache = sharedCaches.get(key)
  if (!cache) {
    cache = new FileIdCache(options)
    sharedCaches.set(key, cache)
  }
  return cache
}

export class FileIdCache {
  constructor({ filePath = defaultCachePath(), accountHash, now = Date.now, logger = console }) {
    if (!accountHash) throw new Error("FileIdCache needs an accountHash")
    this.filePath = filePath
    this.accountHash = accountHash
    this.now = now
    this.logger = logger
    this.data = null
    this.loading = null
    this.writeChain = Promise.resolve()
  }

  async load() {
    if (this.data) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, "utf8"))
        if (parsed?.version === 1 && parsed.accounts && typeof parsed.accounts === "object") {
          this.data = parsed
          return
        }
        this.logger.warn?.("deepseek-files: ignoring an unsupported cache format")
      } catch (error) {
        if (error?.code !== "ENOENT") {
          this.logger.warn?.(`deepseek-files: ignoring an unreadable cache: ${error.message}`)
        }
      }
      this.data = { version: 1, accounts: {} }
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async get(imageHash) {
    await this.load()
    const entry = this.entries()[imageHash]
    if (!entry) return null
    if (!entry.fileId || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= this.now()) {
      delete this.entries()[imageHash]
      await this.save()
      return null
    }
    return entry
  }

  async set(imageHash, entry) {
    await this.load()
    this.entries()[imageHash] = {
      fileId: entry.fileId,
      mime: entry.mime,
      bytes: entry.bytes,
      createdAt: entry.createdAt ?? this.now(),
      expiresAt: entry.expiresAt,
    }
    await this.save()
  }

  async delete(imageHash) {
    await this.load()
    if (!this.entries()[imageHash]) return
    delete this.entries()[imageHash]
    await this.save()
  }

  async deleteMany(imageHashes) {
    await this.load()
    let changed = false
    for (const imageHash of imageHashes) {
      if (this.entries()[imageHash]) {
        delete this.entries()[imageHash]
        changed = true
      }
    }
    if (changed) await this.save()
  }

  async snapshot() {
    await this.load()
    return JSON.parse(JSON.stringify(this.entries()))
  }

  entries() {
    this.data.accounts[this.accountHash] ??= {}
    return this.data.accounts[this.accountHash]
  }

  async save() {
    await this.load()
    const snapshot = JSON.stringify(this.data, null, 2)
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temp, snapshot, { mode: 0o600 })
        await rename(temp, this.filePath)
        await chmod(this.filePath, 0o600).catch(() => {})
      })
      .catch((error) => {
        this.logger.warn?.(`deepseek-files: could not write the file-id cache: ${error.message}`)
      })
    return this.writeChain
  }

  async flush() {
    await this.writeChain
  }
}
