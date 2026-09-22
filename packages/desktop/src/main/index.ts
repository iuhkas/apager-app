import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  shell
} from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALARM_FRESH_WINDOW_MS,
  buildAlarmEvent,
  dedupeKey,
  isAlarmEvent,
  type AutostartState,
  type WebsiteStatus,
  type AlarmEvent
} from '@apager/shared'
import { loadSettings, saveSettings, type Settings } from './config'
import { loadHistory, saveHistory } from './store'
import { RelayClient, type ConnectionState } from './relay-client'
import { LocalServer } from './local-server'

const DEDUPE_WINDOW_MS = 90_000

interface AppState {
  connection: ConnectionState
  localListening: boolean
  activeAlarm: AlarmEvent | null
  history: AlarmEvent[]
  settings: Settings
}

let settings = loadSettings()
let history: AlarmEvent[] = []
let activeAlarm: AlarmEvent | null = null
let connection: ConnectionState = 'disabled'
let localListening = false
let dismissTimer: NodeJS.Timeout | null = null

const seenIds = new Set<string>()
const lastByKey = new Map<string, number>()
const relay = new RelayClient()
const localServer = new LocalServer()

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/**
 * Beim Autostart soll kein Fenster aufgehen. Windows erkennt das am Argument
 * aus dem Registry-Eintrag, macOS meldet es ueber wasOpenedAtLogin.
 */
const AUTOSTART_ARGS = ['--hidden']

function startedByLogin(): boolean {
  if (process.argv.includes('--hidden')) return true
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS }).wasOpenedAtLogin === true
}

function resource(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}

function snapshot(): AppState {
  return { connection, localListening, activeAlarm, history, settings }
}

function pushState(): void {
  window?.webContents.send('state', snapshot())
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const icon = activeAlarm
    ? 'tray-alarm.png'
    : connection === 'online' || localListening
      ? 'tray-idle.png'
      : 'tray-offline.png'
  tray.setImage(nativeImage.createFromPath(resource(icon)).resize({ width: 18, height: 18 }))
  tray.setToolTip(
    activeAlarm
      ? `Einsatz: ${activeAlarm.keyword} (${activeAlarm.unit})`
      : `aPager Monitor - ${connectionLabel()}`
  )
}

function connectionLabel(): string {
  if (connection === 'online') return 'verbunden'
  if (connection === 'connecting') return 'verbinde...'
  if (connection === 'offline') return 'keine Verbindung'
  return localListening ? 'nur LAN-Empfang' : 'nicht konfiguriert'
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    title: 'aPager Monitor',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  window.on('close', (event) => {
    // Schliessen versteckt nur - die App soll im Hintergrund weiterlauschen.
    if (!quitting) {
      event.preventDefault()
      window?.hide()
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  window.webContents.on('did-finish-load', pushState)
}

function showWindow(focus = true): void {
  if (!window) createWindow()
  if (process.platform === 'darwin') void app.dock?.show()
  window?.show()
  if (focus) window?.focus()
}

function matchesFilter(event: AlarmEvent): boolean {
  if (settings.unitFilter.length === 0) return true
  return settings.unitFilter.some((unit) => event.unit.toLowerCase().includes(unit.toLowerCase()))
}

/** true, wenn der Alarm neu ist und noch nicht in der Historie steht. */
function record(event: AlarmEvent): boolean {
  if (seenIds.has(event.id) || history.some((entry) => entry.id === event.id)) return false
  seenIds.add(event.id)
  if (!matchesFilter(event)) return false

  const key = dedupeKey(event)
  const previous = lastByKey.get(key)
  const at = Date.parse(event.receivedAt)
  if (previous !== undefined && Math.abs(at - previous) < DEDUPE_WINDOW_MS) return false
  lastByKey.set(key, at)

  history = [event, ...history].sort(
    (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
  ).slice(0, 500)
  saveHistory(history)
  return true
}

/**
 * Nachgelieferte Alarme (Relay-Puffer, /alarms) landen still in der Historie.
 * Nur frische Alarme reissen den Bildschirm auf - aPager sendet keine Entwarnung,
 * ein alter Einsatz darf nach einem Neustart nicht erneut auslaufen.
 */
function ingest(event: AlarmEvent): void {
  const fresh = Date.now() - Date.parse(event.receivedAt) < ALARM_FRESH_WINDOW_MS
  if (!record(event)) return
  if (fresh) raiseAlarm(event)
  else pushState()
}

function raiseAlarm(event: AlarmEvent): void {
  activeAlarm = event

  showWindow()
  window?.flashFrame(true)
  if (process.platform === 'darwin') app.dock?.bounce('critical')

  new Notification({
    title: event.keyword,
    body: event.unit,
    urgency: 'critical'
  }).show()

  if (dismissTimer) clearTimeout(dismissTimer)
  if (settings.autoDismissMinutes > 0) {
    dismissTimer = setTimeout(() => acknowledge(), settings.autoDismissMinutes * 60_000)
  }

  pushState()
}

/**
 * HTTP-Adresse einer Relay-Strecke aus der WebSocket-URL ableiten.
 * Eingestellt wird nur "wss://relay.example.de/ws"; alles andere haengt
 * daran.
 */
function relayHttpUrl(weg: string): URL | null {
  if (!settings.relayUrl || !settings.clientToken) return null
  try {
    const url = new URL(settings.relayUrl)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = url.pathname.replace(/\/ws$/, weg)
    return url
  } catch {
    return null
  }
}

/**
 * Den Relay nach dem Einsatzband fragen oder es abschalten.
 *
 * Die App spricht bewusst nicht direkt mit der Website: deren Schluessel
 * liegt nur auf dem Server, nicht auf jedem Rechner mit dieser App.
 */
async function websiteRequest(method: 'GET' | 'POST', weg: string): Promise<WebsiteStatus> {
  const url = relayHttpUrl(weg)
  if (!url) return { configured: false }
  try {
    const response = await fetch(url, {
      method,
      headers: { 'x-apager-client-token': settings.clientToken },
      signal: AbortSignal.timeout(10_000)
    })
    /*
     * Ein aelterer Relay kennt die Strecke nicht. Dann ist die Anbindung
     * schlicht nicht vorhanden - das ist kein Fehler, den der Anwender
     * sehen muesste, also blendet die Oberflaeche den Bereich aus.
     */
    if (response.status === 404) return { configured: false }
    if (!response.ok) {
      return { configured: true, error: `Relay antwortete mit ${response.status}` }
    }
    return (await response.json()) as WebsiteStatus
  } catch {
    return { configured: true, error: 'Relay nicht erreichbar' }
  }
}

/**
 * Autostart-Stand samt Begruendung.
 *
 * macOS registriert Anmeldeobjekte seit 13 ueber den Service-Manager, und
 * der lehnt unsignierte Programme ab oder verlangt eine Freigabe in den
 * Systemeinstellungen. Vorher meldete die App in beiden Faellen nur
 * "aus", und der Haken sprang wortlos zurueck.
 */
function autostartState(): AutostartState {
  const stand = app.getLoginItemSettings({ args: AUTOSTART_ARGS })
  return {
    enabled: stand.openAtLogin,
    status: process.platform === 'darwin' ? stand.status : undefined
  }
}

async function backfill(): Promise<void> {
  const url = relayHttpUrl('/alarms')
  if (!url) return
  try {
    url.searchParams.set('limit', '200')

    const response = await fetch(url, {
      headers: { 'x-apager-client-token': settings.clientToken }
    })
    if (!response.ok) return
    const payload = (await response.json()) as { alarms?: unknown[] }
    for (const entry of payload.alarms ?? []) {
      if (isAlarmEvent(entry)) ingest(entry)
    }
  } catch {
    // Relay nicht erreichbar - die WebSocket-Verbindung versucht es weiter.
  }
}

function exportCsv(): void {
  const target = dialog.showSaveDialogSync({
    title: 'Einsatzhistorie exportieren',
    defaultPath: `einsaetze-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (!target) return

  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`
  const rows = [
    'Zeitpunkt;Einheit;Stichwort;Quelle',
    ...history.map((event) =>
      [
        new Date(event.receivedAt).toLocaleString('de-DE'),
        event.unit,
        event.keyword,
        event.source
      ]
        .map(escape)
        .join(';')
    )
  ]
  // BOM, damit Excel die Umlaute richtig liest.
  writeFileSync(target, `\uFEFF${rows.join('\r\n')}\r\n`, 'utf8')
}

function acknowledge(): void {
  activeAlarm = null
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = null
  window?.flashFrame(false)
  pushState()
}

function applySettings(next: Settings): void {
  // Abgetippte URLs und Token schleppen gern Leerzeichen mit.
  settings = {
    ...next,
    relayUrl: next.relayUrl.trim(),
    clientToken: next.clientToken.trim(),
    localListener: { ...next.localListener, token: next.localListener.token.trim() }
  }
  saveSettings(settings)

  if (settings.relayUrl && settings.clientToken) {
    relay.start(settings.relayUrl, settings.clientToken)
  } else {
    relay.stop()
    connection = 'disabled'
  }

  if (settings.localListener.enabled) {
    localServer.start(settings.localListener.port, settings.localListener.token, ingest)
    localListening = true
  } else {
    localServer.stop()
    localListening = false
  }
  pushState()
}

function buildTray(): void {
  tray = new Tray(
    nativeImage.createFromPath(resource('tray-idle.png')).resize({ width: 18, height: 18 })
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Fenster anzeigen', click: () => showWindow() },
      { label: 'Testalarm', click: () => ingest(testAlarm()) },
      { type: 'separator' },
      {
        label: 'Beenden',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => showWindow())
  updateTray()
}

function testAlarm(): AlarmEvent {
  return buildAlarmEvent(
    { unit: 'FF Musterdorf', keyword: 'B2 Zimmerbrand - TESTALARM' },
    { source: 'test' }
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(() => {
    history = loadHistory()
    saveHistory(history)

    relay.on('alarm', ingest)
    relay.on('state', (state) => {
      const reconnected = connection !== 'online' && state === 'online'
      connection = state
      pushState()
      if (reconnected) void backfill()
    })

    createWindow()
    buildTray()
    applySettings(settings)

    // Beim Autostart bleibt die App unsichtbar im Hintergrund. Nur beim
    // manuellen Start ohne Konfiguration hat ein Fenster einen Zweck.
    const unconfigured = !settings.relayUrl && !settings.localListener.enabled
    if (!startedByLogin() && unconfigured) showWindow()
    else if (process.platform === 'darwin') app.dock?.hide()

    ipcMain.handle('app:state', () => snapshot())
    ipcMain.handle('settings:save', (_event, next: Settings) => {
      applySettings(next)
      return snapshot()
    })
    ipcMain.handle('alarm:test', () => ingest(testAlarm()))
    ipcMain.handle('history:export', () => exportCsv())
    ipcMain.handle('alarm:ack', () => acknowledge())
    ipcMain.handle('window:hide', () => window?.hide())
    ipcMain.handle('app:autostart', (_event, enabled: boolean) => {
      app.setLoginItemSettings({ openAtLogin: enabled, args: AUTOSTART_ARGS })
      return autostartState()
    })
    ipcMain.handle('app:autostart-state', () => autostartState())
    // Direkt zu den Anmeldeobjekten, wenn macOS eine Freigabe verlangt.
    ipcMain.handle('app:open-login-items', () =>
      shell.openExternal(
        'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
      )
    )
    ipcMain.handle('website:status', () => websiteRequest('GET', '/website/status'))
    ipcMain.handle('website:entwarnung', () => websiteRequest('POST', '/website/entwarnung'))
  })

  app.on('window-all-closed', () => {
    // Tray-App: laeuft weiter, auch wenn kein Fenster offen ist.
  })

  app.on('activate', () => showWindow())
  app.on('before-quit', () => {
    quitting = true
    relay.stop()
    localServer.stop()
  })
}
