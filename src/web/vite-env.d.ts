/// <reference types="vite/client" />

declare module '*.png' {
  const src: string;
  export default src;
}

interface Window {
  squirlDesktop?: {
    platform: string;
    version: () => Promise<string>;
    selectPath: (options?: { directories?: boolean }) => Promise<string | null>;
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
  };
}
