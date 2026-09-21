import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlarmEvent } from '@apager/shared'

const MAX_ENTRIES = 500

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

/**
 * Lokaler Zwischenspeicher der zuletzt empfangenen Einsaetze. Nichts verfaellt
 * nach Zeit - die vollstaendige Aufzeichnung liegt im Alarm-Log des Relays.
 */
export function loadHistory(): AlarmEvent[] {
  try {
    const entries = JSON.parse(readFileSync(historyPath(), 'utf8')) as AlarmEvent[]
    return entries.slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

export function saveHistory(entries: AlarmEvent[]): void {
  writeFileSync(historyPath(), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), 'utf8')
}
