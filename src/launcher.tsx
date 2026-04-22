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
  const [showSetup, setShowSetup] = useState(false);

  if (!config || showSetup) {
    return (
      <Onboarding
        initialConfig={config ?? undefined}
        onComplete={(cfg) => {
          saveConfig(cfg);
          applyConfigToEnv(cfg);
          setConfig(cfg);
          setShowSetup(false);
        }}
      />
    );
  }

  return <App config={config} onSetup={() => setShowSetup(true)} />;
};

export async function launchApp(): Promise<void> {
  // Clear screen for full-screen TUI (no alternate screen — Warp strips
  // modifier keys like Option+Backspace in alternate screen mode)
  process.stdout.write('\x1b[2J\x1b[H');

  // Enable SGR mouse tracking and pipe stdin through the mouse filter
  process.stdout.write(ENABLE_MOUSE);
  process.stdin.pipe(mouseFilter);

  const { waitUntilExit, unmount } = render(<Root />, {
    stdin: mouseFilter as any,
  });

  const cleanup = () => {
    unmount();
    process.stdout.write(DISABLE_MOUSE);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await waitUntilExit();
  process.stdout.write(DISABLE_MOUSE);
}
