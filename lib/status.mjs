import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { defaultDataDir } from "./media.mjs"

export function defaultStatusPath() {
  return join(defaultDataDir(), "status.json")
}

export async function recordStatus(status, { filePath = defaultStatusPath(), logger = console } = {}) {
  try {
    const payload = { version: 1, updatedAt: Date.now(), ...status }
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await rename(temp, filePath)
    await chmod(filePath, 0o600).catch(() => {})
  } catch (error) {
    logger.warn?.(`deepseek-files: could not write request status: ${error.message}`)
  }
}

export async function readStatus({ filePath = defaultStatusPath() } = {}) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"))
    return data?.version === 1 ? data : null
  } catch {
    return null
  }
}
