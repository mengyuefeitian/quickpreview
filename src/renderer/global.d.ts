export {};

declare global {
  interface Window {
    qp: {
      openFiles: () => Promise<import('../shared/types').FileItem[]>;
      openFolder: () => Promise<import('../shared/types').FileItem[]>;
      setList: (paths: string[]) => Promise<import('../shared/types').FileItem[]>;
      prepareMedia: (filePath: string) => Promise<{ ok: boolean; url?: string; mime?: string; error?: string }>;
      showInFolder: (p: string) => Promise<void>;
    };
  }
}
