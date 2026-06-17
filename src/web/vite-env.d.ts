/// <reference types="vite/client" />

declare module '*.png' {
  const src: string;
  export default src;
}

interface Window {
  squirlDesktop?: {
    version: () => Promise<string>;
    selectPath: (options?: { directories?: boolean }) => Promise<string | null>;
  };
}
