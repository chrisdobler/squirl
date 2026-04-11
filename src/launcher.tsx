import React, { useState } from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { Onboarding } from './components/Onboarding.js';
import { configExists, loadConfig, saveConfig, applyConfigToEnv } from './config.js';
import { mouseFilter } from './mouse-filter.js';
import type { SquirlConfig } from './config.js';

const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h';
const DISABLE_MOUSE = '\x1b[?1000l\x1b[?1006l';

const Root: React.FC = () => {
  const [config, setConfig] = useState<SquirlConfig | null>(() => {
    if (configExists()) {
      const cfg = loadConfig();
      applyConfigToEnv(cfg);
      return cfg;
    }
    return null;
  });

  if (!config) {
    return (
      <Onboarding
        onComplete={(cfg) => {
          saveConfig(cfg);
          applyConfigToEnv(cfg);
          setConfig(cfg);
        }}
      />
    );
  }

  return <App config={config} />;
};

export async function launchApp(): Promise<void> {
  // Enter alternate screen buffer for full-screen TUI
  process.stdout.write('\x1b[?1049h');
  process.stdout.write('\x1b[H');

  // Enable SGR mouse tracking and pipe stdin through the mouse filter
  process.stdout.write(ENABLE_MOUSE);
  process.stdin.pipe(mouseFilter);

  const { waitUntilExit, unmount } = render(<Root />, {
    stdin: mouseFilter as any,
  });

  const cleanup = () => {
    unmount();
    // Disable mouse tracking + leave alternate screen buffer
    process.stdout.write(DISABLE_MOUSE);
    process.stdout.write('\x1b[?1049l');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await waitUntilExit();
  // Disable mouse tracking + leave alt buffer on normal exit
  process.stdout.write(DISABLE_MOUSE);
  process.stdout.write('\x1b[?1049l');
}
