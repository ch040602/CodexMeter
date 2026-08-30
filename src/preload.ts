import { contextBridge, ipcRenderer } from 'electron';
import type { MeterApi, MeterSettings, MeterSnapshot } from './contracts';

const api: MeterApi = {
  getSnapshot: () => ipcRenderer.invoke('meter:get-snapshot'),
  getSettings: () => ipcRenderer.invoke('meter:get-settings'),
  setGuardrail: value => ipcRenderer.invoke('meter:set-guardrail', value),
  setOverlay: visible => ipcRenderer.invoke('meter:set-overlay', visible),
  setOverlayMode: mode => ipcRenderer.invoke('meter:set-overlay-mode', mode),
  setOverlayOpacity: value => ipcRenderer.invoke('meter:set-overlay-opacity', value),
  refresh: () => ipcRenderer.invoke('meter:refresh'),
  closeWindow: () => ipcRenderer.invoke('meter:close-window'),
  onUpdate(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: MeterSnapshot, nextSettings: MeterSettings) => {
      callback(snapshot, nextSettings);
    };
    ipcRenderer.on('meter:update', listener);
    return () => ipcRenderer.removeListener('meter:update', listener);
  },
};

contextBridge.exposeInMainWorld('meter', api);
