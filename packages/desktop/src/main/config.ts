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
  /** Historie aelter als X Tage wird beim Start verworfen. */
  retentionDays: number
}

export const defaultSettings: Settings = {
  relayUrl: '',
  clientToken: '',
  localListener: { enabled: false, port: 8099, token: 'lokal-bitte-aendern' },
  autoDismissMinutes: 15,
  playSound: true,
  unitFilter: [],
  retentionDays: 90
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Settings>
    return {
      ...defaultSettings,
      ...raw,
      localListener: { ...defaultSettings.localListener, ...raw.localListener }
    }
  } catch {
    return { ...defaultSettings }
  }
}

export function saveSettings(settings: Settings): void {
  writeFileSync(configPath(), JSON.stringify(settings, null, 2), 'utf8')
}
