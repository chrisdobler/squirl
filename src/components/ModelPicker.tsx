import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { fetchAvailableModels, detectLocalBackend, type DetectedModel, type LocalBackend } from '../api.js';

type ModelEntry =
  | { type: 'section'; label: string }
  | { type: 'model'; id: string; label: string; provider: 'openai' | 'anthropic' | 'local' };

const MODELS: ModelEntry[] = [
  { type: 'section', label: 'Anthropic' },
  { type: 'model', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { type: 'model', id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic' },
  { type: 'model', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { type: 'section', label: 'OpenAI' },
  { type: 'model', id: 'gpt-4o', label: 'gpt-4o', provider: 'openai' },
  { type: 'model', id: 'gpt-4o-mini', label: 'gpt-4o-mini', provider: 'openai' },
  { type: 'model', id: 'o3-mini', label: 'o3-mini', provider: 'openai' },
  { type: 'section', label: 'Local' },
  { type: 'model', id: 'local', label: 'Local (Ollama, vLLM, etc.)', provider: 'local' },
];

const MODEL_ENTRIES = MODELS.filter(
  (m): m is Extract<ModelEntry, { type: 'model' }> => m.type === 'model'
);

export interface SelectedModel {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic' | 'local';
  baseUrl?: string;
  contextWindow?: number;
  backend?: LocalBackend;
}

interface ModelPickerProps {
  currentModelId: string;
  onSelect: (model: SelectedModel) => void;
  onClose: () => void;
  defaultLocalUrl?: string;
}

type LocalStep = 'url' | 'detecting' | 'pick' | 'manual';

export const ModelPicker: React.FC<ModelPickerProps> = ({ currentModelId, onSelect, onClose, defaultLocalUrl }) => {
  const { stdout } = useStdout();
  const width = Math.min(stdout.columns ?? 80, 58);

  const [cursorIndex, setCursorIndex] = useState(() => {
    const idx = MODEL_ENTRIES.findIndex((m) => m.id === currentModelId);
    return idx >= 0 ? idx : 0;
  });
  const [localModelName, setLocalModelName] = useState('');
  const [localUrl, setLocalUrl] = useState(defaultLocalUrl ?? 'http://localhost:8000/v1');
  const [enteringLocal, setEnteringLocal] = useState(false);
  const [localStep, setLocalStep] = useState<LocalStep>('url');
  const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([]);
  const [detectedBackend, setDetectedBackend] = useState<LocalBackend>('unknown');
  const [pickIdx, setPickIdx] = useState(0);

  // Auto-detect backend and models when entering 'detecting' step
  useEffect(() => {
    if (localStep !== 'detecting') return;
    let cancelled = false;
    (async () => {
      const backend = await detectLocalBackend(localUrl);
      if (cancelled) return;
      setDetectedBackend(backend);
      const models = await fetchAvailableModels(localUrl, backend);
      if (cancelled) return;
      if (models.length > 0) {
        setDetectedModels(models);
        setPickIdx(0);
        setLocalStep('pick');
      } else {
        setLocalStep('manual');
      }
    })();
    return () => { cancelled = true; };
  }, [localStep, localUrl]);

  useInput((_input, key) => {
    if (enteringLocal) {
      if (localStep === 'pick') {
        if (key.escape) { onClose(); return; }
        if (key.upArrow) setPickIdx((i) => Math.max(0, i - 1));
        if (key.downArrow) setPickIdx((i) => Math.min(detectedModels.length - 1, i + 1));
        if (key.return) {
          const model = detectedModels[pickIdx]!;
          onSelect({ id: model.id, label: model.id, provider: 'local', baseUrl: localUrl, contextWindow: model.contextWindow, backend: detectedBackend });
        }
      }
      return;
    }
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setCursorIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursorIndex((i) => Math.min(MODEL_ENTRIES.length - 1, i + 1)); return; }
    if (key.return) {
      const selected = MODEL_ENTRIES[cursorIndex];
      if (!selected) return;
      if (selected.provider === 'local') {
        setEnteringLocal(true);
        setLocalStep('url');
      } else {
        onSelect({ id: selected.id, label: selected.label, provider: selected.provider });
      }
    }
  });

  const handleUrlSubmit = (url: string) => {
    setLocalUrl(url || localUrl);
    setLocalStep('detecting');
  };

  const handleManualModelSubmit = (val: string) => {
    const name = val || localModelName;
    onSelect({ id: name, label: name, provider: 'local', baseUrl: localUrl, backend: detectedBackend });
  };

  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingTop={2}>
      <Box
        flexDirection="column"
        width={width}
        borderStyle="round"
        borderColor="white"
        paddingX={1}
      >
        <Box
          paddingBottom={1}
          borderStyle="single"
          borderBottom={true}
          borderTop={false}
          borderLeft={false}
          borderRight={false}
          marginBottom={0}
        >
          <Text bold>Select Model</Text>
        </Box>

        {!enteringLocal && MODELS.map((entry, i) => {
          if (entry.type === 'section') {
            return (
              <Box key={`section-${i}`} paddingTop={1} paddingLeft={1}>
                <Text dimColor bold>{entry.label}</Text>
              </Box>
            );
          }
          const modelIdx = MODEL_ENTRIES.indexOf(entry);
          const isActive = modelIdx === cursorIndex;
          const isCurrent = entry.id === currentModelId;
          return (
            <Box key={entry.id} paddingLeft={2}>
              <Text color={isActive ? 'cyan' : undefined}>
                {isActive ? '❯ ' : '  '}
                {entry.label}
                {isCurrent ? <Text dimColor>  (current)</Text> : null}
              </Text>
            </Box>
          );
        })}

        {enteringLocal && localStep === 'url' && (
          <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
            <Text dimColor>Enter the base URL of your local server</Text>
            <Box paddingTop={1} gap={1}>
              <Text color="green">URL:</Text>
              <TextInput
                value={localUrl}
                onChange={setLocalUrl}
                onSubmit={handleUrlSubmit}
                focus={true}
              />
            </Box>
          </Box>
        )}

        {enteringLocal && localStep === 'detecting' && (
          <Box paddingTop={1} paddingLeft={2}>
            <Text dimColor>Detecting models at {localUrl}...</Text>
          </Box>
        )}

        {enteringLocal && localStep === 'pick' && (
          <Box flexDirection="column" paddingTop={1} paddingLeft={1}>
            <Text dimColor>Found {detectedModels.length} model(s)</Text>
            <Text> </Text>
            {detectedModels.map((m, i) => (
              <Box key={m.id} paddingLeft={1}>
                <Text color={i === pickIdx ? 'cyan' : undefined}>
                  {i === pickIdx ? '❯ ' : '  '}{m.id}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {enteringLocal && localStep === 'manual' && (
          <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
            <Text dimColor>Could not detect models. Enter the name manually.</Text>
            <Box paddingTop={1} gap={1}>
              <Text color="green">Model:</Text>
              <TextInput
                value={localModelName}
                onChange={setLocalModelName}
                onSubmit={handleManualModelSubmit}
                focus={true}
              />
            </Box>
          </Box>
        )}

        <Box paddingTop={1} paddingLeft={1}>
          <Text dimColor>
            {enteringLocal && localStep === 'pick'
              ? '↑↓ navigate  enter select  esc close'
              : enteringLocal
                ? 'enter confirm  esc close'
                : '↑↓ navigate  enter select  esc close'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
