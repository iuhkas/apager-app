import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlarmEvent } from '@apager/shared'

const MAX_ENTRIES = 500

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

export function loadHistory(retentionDays: number): AlarmEvent[] {
  let entries: AlarmEvent[] = []
  try {
    entries = JSON.parse(readFileSync(historyPath(), 'utf8')) as AlarmEvent[]
  } catch {
    return []
  }
  if (retentionDays <= 0) return entries.slice(0, MAX_ENTRIES)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  return entries.filter((entry) => Date.parse(entry.receivedAt) >= cutoff).slice(0, MAX_ENTRIES)
}

export function saveHistory(entries: AlarmEvent[]): void {
  writeFileSync(historyPath(), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), 'utf8')
}
