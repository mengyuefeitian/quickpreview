import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { extOf, categoryOf, isPreviewable, getMime } from './mime';
import { addAllowed, addAllowedMany, isAllowed, localUrl } from './allowed';
import { prepareMedia } from './transcode';
import type { FileItem } from '../shared/types';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'QuickPreview - 空格键快速预览',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- 本地文件协议（安全白名单 + Range 支持，供 <img>/<video>/fetch 使用）----------
function registerLocalProtocol(): void {
  protocol.handle('local', (request: Request) => {
    const url = new URL(request.url);
    const p = url.searchParams.get('path') || '';
    if (!p || !isAllowed(p) || !fs.existsSync(p)) {
      return new Response('Forbidden', { status: 403 });
    }
    const stat = fs.statSync(p);
    const mime = getMime(extOf(p));
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      let start = 0;
      let end = stat.size - 1;
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
      }
      if (start > end || start >= stat.size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` }
        });
      }
      const buf = fs.readFileSync(p);
      const chunk = buf.subarray(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }
    const buf = fs.readFileSync(p);
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Accept-Ranges': 'bytes'
      }
    });
  });
}

// ---------- 文件夹递归扫描 ----------
function walkDir(dir: string, out: FileItem[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      walkDir(full, out);
    } else if (e.isFile()) {
      const ext = extOf(e.name);
      if (isPreviewable(ext)) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({ path: full, name: e.name, ext, category: categoryOf(ext), size });
      }
    }
  }
}

function scanFolder(folder: string): FileItem[] {
  const list: FileItem[] = [];
  walkDir(folder, list);
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  addAllowedMany(list.map((f) => f.path));
  return list;
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要预览的文件',
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || r.filePaths.length === 0) return [];
    const list: FileItem[] = r.filePaths
      .filter((p) => isPreviewable(extOf(p)))
      .map((p) => {
        const ext = extOf(p);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* ignore */ }
        return { path: p, name: path.basename(p), ext, category: categoryOf(ext), size };
      });
    addAllowedMany(list.map((f) => f.path));
    return list;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: '选择文件夹',
      properties: ['openDirectory']
    });
    if (r.canceled || r.filePaths.length === 0) return [];
    return scanFolder(r.filePaths[0]);
  });

  ipcMain.handle('files:setList', (_e, paths: string[]) => {
    const list: FileItem[] = paths
      .filter((p) => isPreviewable(extOf(p)))
      .map((p) => {
        const ext = extOf(p);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* ignore */ }
        return { path: p, name: path.basename(p), ext, category: categoryOf(ext), size };
      });
    addAllowedMany(list.map((f) => f.path));
    return list;
  });

  ipcMain.handle('media:prepare', (_e, filePath: string) => {
    return prepareMedia(filePath);
  });

  ipcMain.handle('shell:openExternal', (_e, p: string) => {
    shell.showItemInFolder(p);
  });
}

// ---------- 启动 ----------
// 必须在 app ready 之前注册特权协议
protocol.registerSchemesAsPrivileged([
  { scheme: 'local', privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
]);

app.whenReady().then(() => {
  registerLocalProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
