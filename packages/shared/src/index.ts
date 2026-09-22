/**
 * Gemeinsame Typen und Normalisierung fuer die aPager-PRO-Smart-Home-Schnittstelle.
 *
 * aPager PRO ruft bei einem Alarm einen frei konfigurierbaren Webhook auf:
 *   GET  .../hook?unit=...&keyword=...
 *   POST .../hook   mit JSON-Body { "unit": "...", "keyword": "..." }
 * Authentifiziert wird ueber einen eigenen Header (in aPager konfigurierbar);
 * ein Token im Pfad funktioniert weiterhin als Rueckfallebene.
 * Die Parameternamen sind in der App aenderbar, deshalb akzeptieren wir
 * mehrere Schreibweisen und behalten die Rohdaten bei.
 */

export type AlarmSource = 'webhook' | 'local' | 'test'

export interface AlarmEvent {
  id: string
  /** Zeitpunkt, zu dem der Relay/die App den Alarm angenommen hat (ISO 8601). */
  receivedAt: string
  /** Alarmierte Einheit, z. B. "FF Musterdorf". */
  unit: string
  /** Einsatzstichwort, z. B. "B2 Zimmerbrand". */
  keyword: string
  source: AlarmSource
  /** Unveraendert alles, was der Webhook mitgeschickt hat. */
  raw: Record<string, string>
}

const UNIT_KEYS = ['unit', 'einheit', 'organisation', 'org', 'wache']
const KEYWORD_KEYS = ['keyword', 'stichwort', 'alarm', 'einsatzstichwort', 'text']

function pick(input: Record<string, string>, candidates: string[]): string | undefined {
  const lowered = new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]))
  for (const key of candidates) {
    const value = lowered.get(key)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Flacht Query-Parameter bzw. einen JSON-Body zu String-Paaren ab. */
export function flatten(input: unknown): Record<string, string> {
  if (input === null || typeof input !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'object') {
      out[key] = JSON.stringify(value)
    } else {
      out[key] = String(value)
    }
  }
  return out
}

export interface BuildAlarmOptions {
  source: AlarmSource
  /** Fallback, wenn der Webhook keine Einheit uebertraegt. */
  fallbackUnit?: string
  now?: Date
  id?: string
}

export function buildAlarmEvent(
  input: Record<string, string>,
  options: BuildAlarmOptions
): AlarmEvent {
  const now = options.now ?? new Date()
  return {
    id: options.id ?? randomId(),
    receivedAt: now.toISOString(),
    unit: pick(input, UNIT_KEYS) ?? options.fallbackUnit ?? 'Unbekannte Einheit',
    keyword: pick(input, KEYWORD_KEYS) ?? 'Alarm',
    source: options.source,
    raw: input
  }
}

/** Laufzeit-Pruefung fuer Daten, die aus dem Log oder vom Relay kommen. */
export function isAlarmEvent(value: unknown): value is AlarmEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    typeof event.id === 'string' &&
    typeof event.receivedAt === 'string' &&
    typeof event.unit === 'string' &&
    typeof event.keyword === 'string'
  )
}

/**
 * Mehrere Handys mit aktiviertem Webhook loesen denselben Einsatz mehrfach aus.
 * Gleiche Einheit + gleiches Stichwort innerhalb des Fensters = ein Einsatz.
 */
export function dedupeKey(event: AlarmEvent): string {
  return `${event.unit.toLowerCase()}|${event.keyword.toLowerCase()}`
}

export function randomId(): string {
  return globalThis.crypto.randomUUID()
}

/** Relay -> Desktop-App. */
export type ServerMessage =
  | { type: 'hello'; serverTime: string; recent: AlarmEvent[] }
  | { type: 'alarm'; event: AlarmEvent }
  | { type: 'pong'; serverTime: string }

/** Desktop-App -> Relay. */
export type ClientMessage = { type: 'ping' }

export const WS_PING_INTERVAL_MS = 20_000
export const WS_STALE_AFTER_MS = 60_000

/** Standardname des Auth-Headers, den aPager PRO mitschickt. */
export const DEFAULT_INGEST_HEADER = 'x-apager-token'

/**
 * Alarme, die aelter sind, werden beim Nachladen still in die Historie
 * uebernommen statt den Alarmbildschirm zu oeffnen. aPager sendet keine
 * Entwarnung, deshalb braucht es diese Grenze.
 */
export const ALARM_FRESH_WINDOW_MS = 5 * 60_000

/**
 * Stand des Einsatzbandes auf der Feuerwehr-Website.
 *
 * Liegt hier, weil ihn drei Seiten brauchen: der Relay erzeugt ihn, der
 * Main-Prozess reicht ihn durch, die Oberflaeche zeigt ihn an.
 */
export interface WebsiteStatus {
  /** Falsch, wenn Relay oder Website nicht eingerichtet sind - dann blendet
   *  die Oberflaeche den ganzen Bereich aus. */
  configured: boolean
  status?: 'laeuft' | 'aus'
  seit?: string
  bis?: string
  error?: string
}
