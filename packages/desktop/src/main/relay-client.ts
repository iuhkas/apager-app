import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  WS_PING_INTERVAL_MS,
  type AlarmEvent,
  type ServerMessage
} from '@apager/shared'

export type ConnectionState = 'disabled' | 'connecting' | 'online' | 'offline'

export interface RelayClientEvents {
  alarm: [AlarmEvent]
  state: [ConnectionState]
}

/**
 * Haelt eine ausgehende WebSocket-Verbindung zum Relay offen.
 * Ausgehend deshalb, weil am Einsatzrechner keine Portfreigabe noetig sein soll.
 */
export class RelayClient extends EventEmitter<RelayClientEvents> {
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private attempt = 0
  private stopped = true
  private url = ''
  private token = ''

  start(url: string, token: string): void {
    this.stop()
    this.url = url.trim()
    this.token = token.trim()
    this.stopped = false
    if (!this.url) {
      this.emit('state', 'disabled')
      return
    }
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
    this.socket?.removeAllListeners()
    this.socket?.close()
    this.socket = null
  }

  private connect(): void {
    this.emit('state', this.attempt === 0 ? 'connecting' : 'offline')
    const target = new URL(this.url)
    target.searchParams.set('token', this.token)

    const socket = new WebSocket(target)
    this.socket = socket

    socket.on('open', () => {
      this.attempt = 0
      this.emit('state', 'online')
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, WS_PING_INTERVAL_MS)
    })

    socket.on('message', (data) => {
      let message: ServerMessage
      try {
        message = JSON.parse(data.toString()) as ServerMessage
      } catch {
        return
      }
      if (message.type === 'alarm') this.emit('alarm', message.event)
      // "hello" liefert verpasste Einsaetze nach; die App entscheidet ueber Dedup.
      if (message.type === 'hello') {
        for (const event of [...message.recent].reverse()) this.emit('alarm', event)
      }
    })

    const retry = (): void => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      socket.removeAllListeners()
      if (this.stopped) return
      this.emit('state', 'offline')
      this.attempt += 1
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5))
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }

    socket.on('close', retry)
    socket.on('error', retry)
  }
}
