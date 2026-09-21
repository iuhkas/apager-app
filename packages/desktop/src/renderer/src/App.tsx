import { useEffect, useRef, useState } from 'react'
import type { AlarmEvent } from '@apager/shared'
import type { Settings } from '../../main/config'
import { playAlarmSound } from './alarm-sound'

interface AppState {
  connection: 'disabled' | 'connecting' | 'online' | 'offline'
  localListening: boolean
  activeAlarm: AlarmEvent | null
  history: AlarmEvent[]
  settings: Settings
}

declare global {
  interface Window {
    apager: {
      getState: () => Promise<AppState>
      saveSettings: (settings: Settings) => Promise<AppState>
      testAlarm: () => Promise<void>
      exportHistory: () => Promise<void>
      acknowledge: () => Promise<void>
      hideWindow: () => Promise<void>
      getAutostart: () => Promise<boolean>
      setAutostart: (enabled: boolean) => Promise<boolean>
      onState: (handler: (state: AppState) => void) => () => void
    }
  }
}

const statusLabel: Record<AppState['connection'], string> = {
  online: 'Relay verbunden',
  connecting: 'verbinde ...',
  offline: 'keine Verbindung zum Relay',
  disabled: 'Relay nicht konfiguriert'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function Elapsed({ since }: { since: string }): React.ReactElement {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return <span>{`${mm}:${ss}`}</span>
}

export function App(): React.ReactElement | null {
  const [state, setState] = useState<AppState | null>(null)
  const [tab, setTab] = useState<'status' | 'settings'>('status')
  const lastAlarmId = useRef<string | null>(null)

  useEffect(() => {
    void window.apager.getState().then(setState)
    return window.apager.onState(setState)
  }, [])

  useEffect(() => {
    const alarm = state?.activeAlarm
    if (!alarm || alarm.id === lastAlarmId.current) return
    lastAlarmId.current = alarm.id
    if (state?.settings.playSound) playAlarmSound()
  }, [state?.activeAlarm, state?.settings.playSound])

  if (!state) return null

  if (state.activeAlarm) {
    const alarm = state.activeAlarm
    return (
      <div className="alarm">
        <div className="alarm__meta">
          <span className="alarm__unit">{alarm.unit}</span>
          <span className="alarm__clock">
            {formatTime(alarm.receivedAt)} · seit <Elapsed since={alarm.receivedAt} />
          </span>
        </div>
        <h1 className="alarm__keyword">{alarm.keyword}</h1>
        {alarm.source === 'test' && <p className="alarm__badge">Testalarm</p>}
        <button className="alarm__ack" onClick={() => void window.apager.acknowledge()}>
          Quittieren
        </button>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app__head">
        <div>
          <h1>aPager Monitor</h1>
          <p className={`status status--${state.connection}`}>
            {statusLabel[state.connection]}
            {state.localListening && ` · LAN-Empfang auf Port ${state.settings.localListener.port}`}
          </p>
        </div>
        <nav>
          <button
            className={tab === 'status' ? 'is-active' : ''}
            onClick={() => setTab('status')}
          >
            Einsätze
          </button>
          <button
            className={tab === 'settings' ? 'is-active' : ''}
            onClick={() => setTab('settings')}
          >
            Einstellungen
          </button>
        </nav>
      </header>

      {tab === 'status' ? (
        <HistoryView history={state.history} />
      ) : (
        <SettingsView settings={state.settings} />
      )}
    </div>
  )
}

function HistoryView({ history }: { history: AlarmEvent[] }): React.ReactElement {
  return (
    <section>
      <div className="row row--actions">
        <button onClick={() => void window.apager.testAlarm()}>Testalarm auslösen</button>
        <button onClick={() => void window.apager.exportHistory()}>Als CSV exportieren</button>
        <button onClick={() => void window.apager.hideWindow()}>In den Hintergrund</button>
      </div>
      {history.length === 0 ? (
        <p className="empty">Noch keine Einsätze empfangen.</p>
      ) : (
        <ul className="history">
          {history.map((event) => (
            <li key={event.id}>
              <span className="history__time">{formatTime(event.receivedAt)}</span>
              <span className="history__keyword">{event.keyword}</span>
              <span className="history__unit">{event.unit}</span>
              <span className={`history__source history__source--${event.source}`}>
                {event.source}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SettingsView({ settings }: { settings: Settings }): React.ReactElement {
  const [draft, setDraft] = useState<Settings>(settings)
  const [autostart, setAutostart] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.apager.getAutostart().then(setAutostart)
  }, [])

  function update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  return (
    <section className="settings">
      <label>
        Relay-URL (WebSocket)
        <input
          value={draft.relayUrl}
          placeholder="wss://relay.example.de/ws"
          onChange={(event) => update('relayUrl', event.target.value)}
        />
      </label>
      <label>
        Client-Token
        <input
          type="password"
          value={draft.clientToken}
          onChange={(event) => update('clientToken', event.target.value)}
        />
      </label>

      <fieldset>
        <legend>Direktempfang im LAN</legend>
        <label className="row">
          <input
            type="checkbox"
            checked={draft.localListener.enabled}
            onChange={(event) =>
              update('localListener', { ...draft.localListener, enabled: event.target.checked })
            }
          />
          aktiv (aPager im selben WLAN)
        </label>
        <label>
          Port
          <input
            type="number"
            value={draft.localListener.port}
            onChange={(event) =>
              update('localListener', {
                ...draft.localListener,
                port: Number(event.target.value)
              })
            }
          />
        </label>
        <label>
          Token
          <input
            value={draft.localListener.token}
            onChange={(event) =>
              update('localListener', { ...draft.localListener, token: event.target.value })
            }
          />
        </label>
        <p className="hint">
          Webhook-URL in aPager PRO: http://&lt;IP dieses Rechners&gt;:{draft.localListener.port}
          /hook/{draft.localListener.token}
        </p>
      </fieldset>

      <label>
        Alarmfenster automatisch schließen nach (Minuten, 0 = nie)
        <input
          type="number"
          value={draft.autoDismissMinutes}
          onChange={(event) => update('autoDismissMinutes', Number(event.target.value))}
        />
      </label>
      <label>
        Nur diese Einheiten anzeigen (kommagetrennt, leer = alle)
        <input
          value={draft.unitFilter.join(', ')}
          onChange={(event) =>
            update(
              'unitFilter',
              event.target.value
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            )
          }
        />
      </label>
      <label>
        Historie aufbewahren (Tage)
        <input
          type="number"
          value={draft.retentionDays}
          onChange={(event) => update('retentionDays', Number(event.target.value))}
        />
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={draft.playSound}
          onChange={(event) => update('playSound', event.target.checked)}
        />
        Alarmton abspielen
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={autostart}
          onChange={(event) => {
            void window.apager.setAutostart(event.target.checked).then(setAutostart)
          }}
        />
        Beim Systemstart automatisch starten
      </label>

      <div className="row row--actions">
        <button
          className="primary"
          onClick={() => {
            void window.apager.saveSettings(draft).then(() => setSaved(true))
          }}
        >
          Speichern
        </button>
        {saved && <span className="hint">gespeichert</span>}
      </div>
    </section>
  )
}
