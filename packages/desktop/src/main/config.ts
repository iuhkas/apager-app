import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Settings {
  /** WebSocket-URL des Relays, z. B. wss://relay.example.de/ws */
  relayUrl: string
  clientToken: string
  /** Direkter Empfang im LAN, falls das Handy im selben Netz haengt. */
  localListener: {
    enabled: boolean
    port: number
    token: string
  }
  /** Alarmfenster nach so vielen Minuten automatisch schliessen (0 = nie). */
  autoDismissMinutes: number
  playSound: boolean
  /** Nur diese Einheiten anzeigen; leer = alle. */
  unitFilter: string[]
}

export const defaultSettings: Settings = {
  relayUrl: '',
  clientToken: '',
  localListener: { enabled: false, port: 8099, token: 'lokal-bitte-aendern' },
  autoDismissMinutes: 15,
  playSound: true,
  unitFilter: []
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Settings>
    const merged = {
      ...defaultSettings,
      ...raw,
      localListener: { ...defaultSettings.localListener, ...raw.localListener }
    }
    // Altlast: die Aufbewahrungsdauer der lokalen Historie ist entfallen,
    // massgeblich ist das dauerhafte Alarm-Log auf dem Relay.
    delete (merged as Record<string, unknown>).retentionDays
    return merged
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(configPath(), JSON.stringify(settings, null, 2), 'utf8')
}
