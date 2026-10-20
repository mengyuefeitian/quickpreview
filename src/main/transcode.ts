// ffmpeg 转码封装（按需转码 ape/mkv 等不可直接播放的格式，带缓存）
import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { extOf, audioNeedsTranscode, videoNeedsTranscode, transcodeTarget, getMime } from './mime';
import { addAllowed, localUrl } from './allowed';

let ffmpegPathCache: string | null = null;

export function resolveFfmpeg(): string {
  if (ffmpegPathCache) return ffmpegPathCache;
  if (app.isPackaged) {
    const bin = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    ffmpegPathCache = path.join(process.resourcesPath, 'ffmpeg-static', bin);
  } else {
    // 开发态：ffmpeg-static 包提供的二进制
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ffmpegPathCache = require('ffmpeg-static') as string;
  }
  return ffmpegPathCache;
}

function tempDir(): string {
  const dir = path.join(app.getPath('temp'), 'quickpreview');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(inputPath: string): string {
  const stat = fs.statSync(inputPath);
  const base = `${inputPath}:${stat.size}:${stat.mtimeMs}`;
  return crypto.createHash('md5').update(base).digest('hex');
}

export interface TranscodeResult {
  ok: boolean;
  url?: string;       // 成功时返回 local:// 绝对路径
  localPath?: string;
  mime?: string;
  error?: string;
}

// 传入原始文件绝对路径，返回可直接在 <audio>/<video> 播放的 local:// 地址
export function prepareMedia(inputPath: string): TranscodeResult {
  const ext = extOf(inputPath);
  const isAudio = audioNeedsTranscode(ext);
  const isVideo = videoNeedsTranscode(ext);

  // 本身可播放 → 直接返回原文件
  if (!isAudio && !isVideo) {
    addAllowed(inputPath);
    return {
      ok: true,
      url: localUrl(inputPath),
      localPath: inputPath,
      mime: getMime(ext)
    };
  }

  const kind = isAudio ? 'audio' : 'video';
  const targetExt = transcodeTarget(ext, kind);
  const key = cacheKey(inputPath);
  const outPath = path.join(tempDir(), `${key}.${targetExt}`);

  if (fs.existsSync(outPath)) {
    addAllowed(outPath);
    return { ok: true, url: localUrl(outPath), localPath: outPath, mime: getMime(targetExt) };
  }

  // 同步转码（预览为交互操作，文件一般不大；大视频会较慢，前端有 loading 提示）
  try {
    runFfmpeg(inputPath, outPath, kind);
    if (!fs.existsSync(outPath)) {
      return { ok: false, error: '转码后未生成文件' };
    }
    addAllowed(outPath);
    return { ok: true, url: localUrl(outPath), localPath: outPath, mime: getMime(targetExt) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function runFfmpeg(input: string, output: string, kind: 'audio' | 'video'): void {
  const ff = resolveFfmpeg();
  const args: string[] = ['-y', '-i', input];
  if (kind === 'audio') {
    args.push('-vn', '-acodec', 'flac');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-strict', 'experimental');
  }
  args.push(output);

  const res = spawnSyncSafe(ff, args);
  if (res.status !== 0) {
    throw new Error(`ffmpeg 失败(${res.status}): ${res.stderr.slice(-500)}`);
  }
}

function spawnSyncSafe(cmd: string, args: string[]): { status: number; stderr: string } {
  // 使用同步子进程，简单可靠
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require('child_process');
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  return { status: r.status ?? -1, stderr: r.stderr || '' };
}
