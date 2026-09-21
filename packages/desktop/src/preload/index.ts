import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getState: () => ipcRenderer.invoke('app:state'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  testAlarm: () => ipcRenderer.invoke('alarm:test'),
  exportHistory: () => ipcRenderer.invoke('history:export'),
  acknowledge: () => ipcRenderer.invoke('alarm:ack'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  getAutostart: () => ipcRenderer.invoke('app:autostart-state'),
  setAutostart: (enabled: boolean) => ipcRenderer.invoke('app:autostart', enabled),
  onState: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown): void => handler(state)
    ipcRenderer.on('state', listener)
    return () => ipcRenderer.removeListener('state', listener)
  }
}

contextBridge.exposeInMainWorld('apager', api)

export type ApagerApi = typeof api
