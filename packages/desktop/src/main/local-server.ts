import { createServer, type Server } from 'node:http'
import { buildAlarmEvent, flatten, type AlarmEvent } from '@apager/shared'

/**
 * Fallback fuer den Betrieb im eigenen WLAN: aPager PRO kann den Webhook
 * direkt an diesen Rechner schicken, ohne Relay dazwischen.
 */
export class LocalServer {
  private server: Server | null = null

  start(port: number, token: string, onAlarm: (event: AlarmEvent) => void): void {
    this.stop()
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (!url.pathname.startsWith('/hook/') || url.pathname.slice(6) !== token) {
        res.writeHead(401).end('unauthorized')
        return
      }

      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const query = flatten(Object.fromEntries(url.searchParams))
        let body: Record<string, string> = {}
        if (chunks.length > 0) {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            body = flatten(JSON.parse(text))
          } catch {
            body = flatten(Object.fromEntries(new URLSearchParams(text)))
          }
        }
        onAlarm(buildAlarmEvent({ ...query, ...body }, { source: 'local' }))
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      })
    })
    this.server.listen(port, '0.0.0.0')
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}
