import { contextBridge, ipcRenderer } from 'electron';

// 渲染进程通过 window.qp 安全地调用主进程能力
contextBridge.exposeInMainWorld('qp', {
  openFiles: (): Promise<any> => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: (): Promise<any> => ipcRenderer.invoke('dialog:openFolder'),
  setList: (paths: string[]): Promise<any> => ipcRenderer.invoke('files:setList', paths),
  prepareMedia: (filePath: string): Promise<any> => ipcRenderer.invoke('media:prepare', filePath),
  showInFolder: (p: string): Promise<any> => ipcRenderer.invoke('shell:openExternal', p)
});

// Web 引擎统一通过 window.QP 调用宿主能力；
// 开发模式（Electron）下转发到主进程，服务模式（WebView2）下由 C# 宿主对象提供。
contextBridge.exposeInMainWorld('QP', {
  prepareMediaAsync: (filePath: string): Promise<any> => ipcRenderer.invoke('media:prepare', filePath),
  showInFolder: (p: string): Promise<any> => ipcRenderer.invoke('shell:openExternal', p)
});
