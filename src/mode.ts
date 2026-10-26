/** The Semi Auto runtime mode: a durable on/off switch the composer toggle drives. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin-owned durable state directory, mirroring `~/.dsh/plugins/<name>/`. */
function stateDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'semi-auto')
}

function modeFile(): string {
  return join(stateDir(), 'mode.json')
}

/** Read the persisted mode synchronously; a missing or unreadable file defaults to enabled. */
export function readModeFileSync(): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(modeFile(), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null
      && typeof (parsed as { enabled?: unknown }).enabled === 'boolean') {
      return (parsed as { enabled: boolean }).enabled
    }
    return true
  } catch {
    return true
  }
}

/**
 * Persist the mode atomically (tmp file + rename). Callers await it on the RPC
 * failure path; the in-memory flip must never wait on disk.
 */
export async function writeModeFile(enabled: boolean): Promise<void> {
  const file = modeFile()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify({ enabled })}\n`, 'utf8')
  await rename(tmp, file)
}
