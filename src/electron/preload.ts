import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('squirlDesktop', {
  version: () => ipcRenderer.invoke('squirl:version') as Promise<string>,
  selectPath: (options?: { directories?: boolean }) => ipcRenderer.invoke('squirl:select-path', options) as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke('squirl:open-external', url) as Promise<void>,
});
