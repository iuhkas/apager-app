import { timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { LogController } from 'fastify'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import {
  startWebsiteTicker,
  stopWebsiteTicker,
  websiteConfigured,
  websiteTickerStatus
} from './website.js'
import {
  buildAlarmEvent,
  dedupeKey,
  flatten,
  isAlarmEvent,
  DEFAULT_INGEST_HEADER,
  type AlarmEvent,
  type ServerMessage
} from '@apager/shared'

const PORT = Number(process.env.PORT ?? 8080)
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? ''
const INGEST_HEADER = (process.env.INGEST_HEADER ?? DEFAULT_INGEST_HEADER).toLowerCase()
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? ''
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_SECONDS ?? 90) * 1000
const DATA_DIR = process.env.DATA_DIR ?? './data'
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 365)
const RECENT_LIMIT = 200

if (!INGEST_TOKEN || !CLIENT_TOKEN) {
  console.error('INGEST_TOKEN und CLIENT_TOKEN muessen gesetzt sein (siehe .env.example).')
  process.exit(1)
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- Persistentes Alarm-Log -------------------------------------------------
// Append-only JSONL, damit Einsaetze auch dann dokumentiert sind, wenn keine
// Desktop-App laeuft. Eine Zeile = ein Alarm.

mkdirSync(DATA_DIR, { recursive: true })
const LOG_PATH = join(DATA_DIR, 'alarms.jsonl')

function readLog(): AlarmEvent[] {
  try {
    return readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as unknown
        } catch {
          return null
        }
      })
      .filter(isAlarmEvent)
  } catch {
    return []
  }
}

function appendLog(event: AlarmEvent): void {
  appendFileSync(LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8')
}

/** Beim Start einmal aufraeumen, damit das Log nicht unbegrenzt waechst. */
function pruneLog(entries: AlarmEvent[]): AlarmEvent[] {
  if (LOG_RETENTION_DAYS <= 0) return entries
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const kept = entries.filter((entry) => Date.parse(entry.receivedAt) >= cutoff)
  if (kept.length !== entries.length) {
    writeFileSync(LOG_PATH, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8')
  }
  return kept
}

const clients = new Set<WebSocket>()
/** Puffer (neueste zuerst), damit eine App nach kurzer Downtime nachziehen kann. */
const recent: AlarmEvent[] = pruneLog(readLog()).slice(-RECENT_LIMIT).reverse()
const lastSeen = new Map<string, number>()

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message)
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(payload)
  }
}

function accept(event: AlarmEvent): 'accepted' | 'duplicate' {
  const key = dedupeKey(event)
  const previous = lastSeen.get(key)
  const now = Date.parse(event.receivedAt)
  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
    lastSeen.set(key, now)
    return 'duplicate'
  }
  lastSeen.set(key, now)
  appendLog(event)
  recent.unshift(event)
  recent.length = Math.min(recent.length, RECENT_LIMIT)
  broadcast({ type: 'alarm', event })
  return 'accepted'
}

if (!websiteConfigured) {
  console.info('Website-Anbindung aus (WEBSITE_ALARM_URL/WEBSITE_TOKEN nicht gesetzt).')
}

// Der Healthcheck des Containers laeuft alle 30 Sekunden und wuerde das Log
// zuschuetten - fuer ihn bleibt das Request-Logging aus, fuer alles andere an.
const app = Fastify({
  logger: true,
  logController: new LogController({
    disableRequestLogging: (request) => request.url.startsWith('/health')
  })
})
await app.register(websocket)

app.get('/health', async () => ({
  status: 'ok',
  clients: clients.size,
  buffered: recent.length,
  serverTime: new Date().toISOString()
}))

// aPager PRO ruft diese URL bei Alarm auf - als GET mit Query-Parametern
// oder als POST mit JSON-Body. Beides wird gleich behandelt.
app.route({
  method: ['GET', 'POST'],
  url: '/hook/:token?',
  handler: async (request, reply) => {
    const { token } = request.params as { token?: string }
    const header = request.headers[INGEST_HEADER]
    const presented = typeof header === 'string' ? header : token
    if (!tokenMatches(INGEST_TOKEN, presented)) {
      request.log.warn({ ip: request.ip }, 'webhook mit ungueltigem token abgewiesen')
      return reply.code(401).send({ error: 'invalid token' })
    }

    const input = { ...flatten(request.query), ...flatten(request.body) }
    const event = buildAlarmEvent(input, { source: 'webhook' })
    const result = accept(event)

    /*
     * Nur beim ersten Alarm, nicht bei den Dubletten der uebrigen Handys
     * derselben Einheit. Bewusst ohne await: aPager soll seine Antwort
     * sofort bekommen, und eine langsame oder tote Website darf die
     * Alarmierung nicht ausbremsen.
     */
    if (result === 'accepted') {
      void startWebsiteTicker(request.log)
    }

    request.log.info({ event, result }, 'alarm eingegangen')
    return reply.code(200).send({ status: result, id: event.id })
  }
})

/**
 * Client-Token aus Kopfzeile oder Query holen - dieselbe Pruefung fuer alle
 * Strecken, die die Desktop-App benutzt.
 */
function clientAuthorized(request: { headers: Record<string, unknown>; query: unknown }): boolean {
  const header = request.headers['x-apager-client-token']
  const token = (request.query as { token?: string } | undefined)?.token
  return tokenMatches(CLIENT_TOKEN, typeof header === 'string' ? header : token)
}

/** Historie fuer die Desktop-App (Nachladen nach Downtime) und fuer Auswertungen. */
app.get('/alarms', async (request, reply) => {
  const query = request.query as { token?: string; limit?: string; since?: string }
  if (!clientAuthorized(request)) {
    return reply.code(401).send({ error: 'invalid token' })
  }

  const limit = Math.min(Number(query.limit ?? 200), 1000)
  const since = query.since ? Date.parse(query.since) : Number.NaN
  // Direkt aus dem Log lesen - so ist die Historie vollstaendig, nicht nur der Puffer.
  const entries = readLog().reverse()
  const filtered = Number.isNaN(since)
    ? entries
    : entries.filter((entry) => Date.parse(entry.receivedAt) > since)

  return reply.send({ alarms: filtered.slice(0, limit) })
})

/*
 * Einsatzband der Website - fuer den Knopf "Einsatz beendet" in der App.
 *
 * Die App geht ueber den Relay und nicht direkt an die Website, damit der
 * Schluessel der Website nur auf dem Server liegt und nicht auf jedem
 * Rechner, auf dem die App installiert ist.
 */
app.get('/website/status', async (request, reply) => {
  if (!clientAuthorized(request)) {
    return reply.code(401).send({ error: 'invalid token' })
  }
  return reply.send(await websiteTickerStatus(request.log))
})

app.post('/website/entwarnung', async (request, reply) => {
  if (!clientAuthorized(request)) {
    return reply.code(401).send({ error: 'invalid token' })
  }
  return reply.send(await stopWebsiteTicker(request.log))
})

app.get('/ws', { websocket: true }, (socket, request) => {
  const { token } = request.query as { token?: string }
  if (!tokenMatches(CLIENT_TOKEN, token)) {
    socket.close(4401, 'invalid token')
    return
  }

  clients.add(socket)
  request.log.info({ clients: clients.size }, 'app verbunden')

  const hello: ServerMessage = {
    type: 'hello',
    serverTime: new Date().toISOString(),
    recent: recent.slice(0, 20)
  }
  socket.send(JSON.stringify(hello))

  socket.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString()) as { type?: string }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }))
      }
    } catch {
      // Unlesbare Nachrichten ignorieren.
    }
  })

  socket.on('close', () => {
    clients.delete(socket)
    request.log.info({ clients: clients.size }, 'app getrennt')
  })
})

await app.listen({ port: PORT, host: '0.0.0.0' })
