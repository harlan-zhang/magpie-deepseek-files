import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export function defaultDataDir() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "magpie", "deepseek-files")
}

export function defaultImagesDir() {
  return join(defaultDataDir(), "images")
}

function validHash(hash) {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
}

export function createMediaStore({ dir = defaultImagesDir(), logger = console } = {}) {
  return {
    dir,

    async save({ hash, bytes }) {
      if (!validHash(hash)) throw new Error("Invalid image hash")
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const filePath = join(dir, hash)
      try {
        await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 })
      } catch (error) {
        if (error?.code !== "EEXIST") {
          logger.warn?.(`deepseek-files: could not save a local image preview: ${error.message}`)
          return null
        }
      }
      await chmod(filePath, 0o600).catch(() => {})
      return filePath
    },

    async read(hash) {
      if (!validHash(hash)) return null
      try {
        return await readFile(join(dir, hash))
      } catch (error) {
        if (error?.code === "ENOENT") return null
        throw error
      }
    },

    async has(hash) {
      return (await this.read(hash)) !== null
    },

    async remove(hash) {
      if (!validHash(hash)) return
      try {
        await unlink(join(dir, hash))
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
      }
    },
  }
}
