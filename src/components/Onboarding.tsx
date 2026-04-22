import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { fetchAvailableModels, detectLocalBackend, type DetectedModel, type LocalBackend } from '../api.js';
import type { SquirlConfig } from '../config.js';

type Step = 'welcome' | 'provider' | 'anthropic-key' | 'openai-key' | 'local-url' | 'local-detect' | 'local-pick' | 'local-model' | 'import-chatgpt' | 'index-setup' | 'index-store' | 'index-chroma-url' | 'index-embedder' | 'index-embedder-url' | 'index-embedder-detect' | 'index-embedder-pick' | 'done';
type Provider = 'anthropic' | 'openai' | 'local';

const PROVIDERS: { id: Provider; label: string; description: string }[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', description: 'Claude Sonnet, Opus, Haiku' },
  { id: 'openai', label: 'OpenAI', description: 'GPT-4o, o3-mini' },
  { id: 'local', label: 'Local', description: 'Ollama, vLLM, etc.' },
];

interface OnboardingProps {
  onComplete: (config: SquirlConfig) => void;
  initialConfig?: SquirlConfig;
}

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete, initialConfig }) => {
  const { stdout } = useStdout();
  const width = Math.min(stdout.columns ?? 80, 64);

  const initProvider = (initialConfig?.defaultProvider ?? 'anthropic') as Provider;
  const [step, setStep] = useState<Step>(initialConfig ? 'provider' : 'welcome');
  const [providerIdx, setProviderIdx] = useState(Math.max(0, PROVIDERS.findIndex(p => p.id === initProvider)));
  const [selectedProvider, setSelectedProvider] = useState<Provider>(initProvider);
  const [anthropicKey, setAnthropicKey] = useState(initialConfig?.anthropicApiKey ?? '');
  const [openaiKey, setOpenaiKey] = useState(initialConfig?.openaiApiKey ?? '');
  const [localModelName, setLocalModelName] = useState(initialConfig?.defaultModel ?? '');
  const [localUrl, setLocalUrl] = useState(initialConfig?.localBaseUrl ?? 'http://localhost:8000/v1');
  const [detectedModels, setDetectedModels] = useState<DetectedModel[]>([]);
  const [modelPickIdx, setModelPickIdx] = useState(0);
  const [alsoConfigureOpenai, setAlsoConfigureOpenai] = useState(false);
  const [alsoConfigureAnthropic, setAlsoConfigureAnthropic] = useState(false);
  const [detectedBackend, setDetectedBackend] = useState<LocalBackend>('unknown');
  const [importPath, setImportPath] = useState('');
  const [importCount, setImportCount] = useState<number | null>(null);
  const [importError, setImportError] = useState('');
  const [indexSetupIdx, setIndexSetupIdx] = useState(initialConfig?.index?.enabled ? 0 : 1);
  const [indexStoreIdx, setIndexStoreIdx] = useState(initialConfig?.index?.store === 'remote-chroma' ? 1 : 0);
  const [indexEmbedderIdx, setIndexEmbedderIdx] = useState(initialConfig?.index?.embedder && initialConfig.index.embedder !== 'openai' ? 1 : 0);
  const [indexEnabled, setIndexEnabled] = useState(initialConfig?.index?.enabled ?? false);
  const [indexStore, setIndexStore] = useState<'local-chroma' | 'remote-chroma'>((initialConfig?.index?.store as 'local-chroma' | 'remote-chroma') ?? 'local-chroma');
  const [indexChromaUrl, setIndexChromaUrl] = useState(initialConfig?.index?.chromaUrl ?? 'http://localhost:8000');
  const [indexEmbedder, setIndexEmbedder] = useState<'openai' | 'local'>(initialConfig?.index?.embedder === 'openai' ? 'openai' : 'local');
  const [indexEmbedderUrl, setIndexEmbedderUrl] = useState(initialConfig?.index?.embedderUrl ?? 'http://localhost:11434');
  const [indexEmbedderModels, setIndexEmbedderModels] = useState<DetectedModel[]>([]);
  const [indexEmbedderModelIdx, setIndexEmbedderModelIdx] = useState(0);
  const [indexEmbedderModel, setIndexEmbedderModel] = useState(initialConfig?.index?.embedderModel ?? '');
  const [indexEmbedderBackend, setIndexEmbedderBackend] = useState<LocalBackend>('unknown');

  // Auto-detect backend and models when entering the detect step
  useEffect(() => {
    if (step !== 'local-detect') return;
    let cancelled = false;
    (async () => {
      const backend = await detectLocalBackend(localUrl);
      if (cancelled) return;
      setDetectedBackend(backend);
      const models = await fetchAvailableModels(localUrl, backend);
      if (cancelled) return;
      if (models.length > 0) {
        setDetectedModels(models);
        setModelPickIdx(0);
        setStep('local-pick');
      } else {
        setStep('local-model');
      }
    })();
    return () => { cancelled = true; };
  }, [step, localUrl]);

  // Auto-detect embedder backend and models
  useEffect(() => {
    if (step !== 'index-embedder-detect') return;
    let cancelled = false;
    (async () => {
      const url = indexEmbedderUrl.endsWith('/v1') ? indexEmbedderUrl : indexEmbedderUrl.replace(/\/+$/, '') + '/v1';
      const backend = await detectLocalBackend(url);
      if (cancelled) return;
      setIndexEmbedderBackend(backend);
      const models = await fetchAvailableModels(url, backend);
      if (cancelled) return;
      if (models.length > 0) {
        setIndexEmbedderModels(models);
        setIndexEmbedderModelIdx(0);
        setStep('index-embedder-pick');
      } else {
        // No models found — use the URL as-is, model will be auto-detected at runtime
        setStep('done');
      }
    })();
    return () => { cancelled = true; };
  }, [step, indexEmbedderUrl]);

  useInput((input, key) => {
    if (step === 'welcome') {
      if (key.return) setStep('provider');
      return;
    }

    if (step === 'provider') {
      if (key.upArrow) setProviderIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setProviderIdx((i) => Math.min(PROVIDERS.length - 1, i + 1));
      if (key.return) {
        const provider = PROVIDERS[providerIdx]!.id;
        setSelectedProvider(provider);
        if (provider === 'anthropic') setStep('anthropic-key');
        else if (provider === 'openai') setStep('openai-key');
        else setStep('local-url');
      }
      return;
    }

    if (step === 'local-pick') {
      if (key.upArrow) setModelPickIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setModelPickIdx((i) => Math.min(detectedModels.length - 1, i + 1));
      if (key.return) {
        setLocalModelName(detectedModels[modelPickIdx]!.id);
        setAlsoConfigureAnthropic(true);
        setStep('anthropic-key');
      }
      return;
    }

    if (step === 'index-setup') {
      if (key.upArrow) setIndexSetupIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setIndexSetupIdx((i) => Math.min(1, i + 1));
      if (key.return) {
        if (indexSetupIdx === 0) {
          setIndexEnabled(true);
          setStep('index-store');
        } else {
          setStep('done');
        }
      }
      return;
    }

    if (step === 'index-store') {
      const stores = ['local-chroma', 'remote-chroma'] as const;
      if (key.upArrow) setIndexStoreIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setIndexStoreIdx((i) => Math.min(stores.length - 1, i + 1));
      if (key.return) {
        setIndexStore(stores[indexStoreIdx]!);
        setStep('index-chroma-url');
      }
      return;
    }

    if (step === 'index-embedder') {
      const embedders = ['openai', 'local'] as const;
      if (key.upArrow) setIndexEmbedderIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setIndexEmbedderIdx((i) => Math.min(embedders.length - 1, i + 1));
      if (key.return) {
        setIndexEmbedder(embedders[indexEmbedderIdx]!);
        if (embedders[indexEmbedderIdx] === 'local') {
          setStep('index-embedder-url');
        } else {
          setStep('done');
        }
      }
      return;
    }

    if (step === 'index-embedder-pick') {
      if (key.upArrow) setIndexEmbedderModelIdx((i) => Math.max(0, i - 1));
      if (key.downArrow) setIndexEmbedderModelIdx((i) => Math.min(indexEmbedderModels.length - 1, i + 1));
      if (key.return) {
        setIndexEmbedderModel(indexEmbedderModels[indexEmbedderModelIdx]!.id);
        setStep('done');
      }
      return;
    }

    if (step === 'done') {
      if (key.return) finalize();
    }
  });

  const handleAnthropicKeySubmit = (val: string) => {
    setAnthropicKey(val);
    if (selectedProvider === 'anthropic') {
      setAlsoConfigureOpenai(true);
      setStep('openai-key');
    } else {
      setStep('import-chatgpt');
    }
  };

  const handleOpenaiKeySubmit = (val: string) => {
    setOpenaiKey(val);
    if (selectedProvider === 'openai') {
      setAlsoConfigureAnthropic(true);
      setStep('anthropic-key');
    } else {
      setStep('import-chatgpt');
    }
  };

  const handleLocalUrlSubmit = (val: string) => {
    setLocalUrl(val || localUrl);
    setStep('local-detect');
  };

  const handleLocalModelSubmit = (val: string) => {
    setLocalModelName(val || localModelName);
    setAlsoConfigureAnthropic(true);
    setStep('anthropic-key');
  };

  const handleImportSubmit = async (val: string) => {
    if (!val.trim()) {
      setStep('index-setup');
      return;
    }
    const resolved = val.trim().replace(/\\ /g, ' ').replace(/^~/, process.env.HOME ?? '');
    try {
      const { ChatGPTImporter } = await import('../search/importers/chatgpt.js');
      const { appendImportMessage } = await import('../history.js');
      const importer = new ChatGPTImporter();
      let count = 0;
      for await (const pair of importer.parse(resolved)) {
        if (pair.userText) appendImportMessage({ id: crypto.randomUUID(), role: 'user', content: pair.userText }, 'chatgpt', pair.timestamp);
        if (pair.assistantText) appendImportMessage({ id: crypto.randomUUID(), role: 'assistant', content: pair.assistantText }, 'chatgpt', pair.timestamp);
        count++;
      }
      setImportCount(count);
      setStep('index-setup');
    } catch (err: unknown) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChromaUrlSubmit = (val: string) => {
    setIndexChromaUrl(val || indexChromaUrl);
    setStep('index-embedder');
  };

  const handleEmbedderUrlSubmit = (val: string) => {
    setIndexEmbedderUrl(val || indexEmbedderUrl);
    setStep('index-embedder-detect');
  };

  const finalize = () => {
    const config: SquirlConfig = { defaultProvider: selectedProvider };

    if (anthropicKey) config.anthropicApiKey = anthropicKey;
    if (openaiKey) config.openaiApiKey = openaiKey;
    if (selectedProvider === 'local') {
      config.localBaseUrl = localUrl;
      config.localBackend = detectedBackend;
    }

    if (selectedProvider === 'anthropic') config.defaultModel = 'claude-sonnet-4-6';
    else if (selectedProvider === 'openai') config.defaultModel = 'gpt-4o';
    else if (selectedProvider === 'local' && localModelName) config.defaultModel = localModelName;

    if (indexEnabled) {
      config.index = {
        enabled: true,
        store: indexStore,
        chromaUrl: indexChromaUrl,
        embedder: indexEmbedder,
        ...(indexEmbedder === 'local' ? {
          embedderUrl: indexEmbedderUrl,
          ...(indexEmbedderModel ? { embedderModel: indexEmbedderModel } : {}),
        } : {}),
      };
    }

    onComplete(config);
  };

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%" paddingTop={2}>
      <Box
        flexDirection="column"
        width={width}
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        gap={1}
      >
        {step === 'welcome' && (
          <>
            <Text bold color="cyan">Welcome to squirl</Text>
            <Text>Let's get you set up. This will create a config file at</Text>
            <Text dimColor>~/.squirl/config.json</Text>
            <Text> </Text>
            <Text dimColor>Press enter to continue</Text>
          </>
        )}

        {step === 'provider' && (
          <>
            <Text bold>Choose your default provider</Text>
            <Text> </Text>
            {PROVIDERS.map((p, i) => (
              <Box key={p.id} paddingLeft={1}>
                <Text color={i === providerIdx ? 'cyan' : undefined}>
                  {i === providerIdx ? '❯ ' : '  '}
                  <Text bold>{p.label}</Text>
                  <Text dimColor>{'  '}{p.description}</Text>
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'anthropic-key' && (
          <>
            <Text bold>
              {alsoConfigureAnthropic || selectedProvider === 'local'
                ? 'Anthropic API key (optional, press enter to skip)'
                : 'Enter your Anthropic API key'}
            </Text>
            <Text dimColor>Get one at console.anthropic.com</Text>
            <Box paddingTop={1}>
              <Text color="green">Key: </Text>
              <TextInput
                value={anthropicKey}
                onChange={setAnthropicKey}
                onSubmit={handleAnthropicKeySubmit}
                mask="*"
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'openai-key' && (
          <>
            <Text bold>
              {alsoConfigureOpenai
                ? 'OpenAI API key (optional, press enter to skip)'
                : 'Enter your OpenAI API key'}
            </Text>
            <Text dimColor>Get one at platform.openai.com</Text>
            <Box paddingTop={1}>
              <Text color="green">Key: </Text>
              <TextInput
                value={openaiKey}
                onChange={setOpenaiKey}
                onSubmit={handleOpenaiKeySubmit}
                mask="*"
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'local-url' && (
          <>
            <Text bold>Local model base URL</Text>
            <Text dimColor>e.g. Ollama: localhost:11434/v1, vLLM: localhost:8000/v1</Text>
            <Box paddingTop={1}>
              <Text color="green">URL: </Text>
              <TextInput
                value={localUrl}
                onChange={setLocalUrl}
                onSubmit={handleLocalUrlSubmit}
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'local-detect' && (
          <>
            <Text bold>Detecting available models...</Text>
            <Text dimColor>Querying {localUrl}/models</Text>
          </>
        )}

        {step === 'local-pick' && (
          <>
            <Text bold>Select a model</Text>
            <Text dimColor>Found {detectedModels.length} model(s) on the server</Text>
            <Text> </Text>
            {detectedModels.map((m, i) => (
              <Box key={m.id} paddingLeft={1}>
                <Text color={i === modelPickIdx ? 'cyan' : undefined}>
                  {i === modelPickIdx ? '❯ ' : '  '}{m.id}
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'local-model' && (
          <>
            <Text bold>Enter model name</Text>
            <Text dimColor>Could not auto-detect models. Enter the name manually (e.g. llama3, mistral)</Text>
            <Box paddingTop={1}>
              <Text color="green">Model: </Text>
              <TextInput
                value={localModelName}
                onChange={setLocalModelName}
                onSubmit={handleLocalModelSubmit}
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'import-chatgpt' && (
          <>
            <Text bold>Import ChatGPT conversations?</Text>
            <Text>If you have a ChatGPT export, paste the path to the extracted folder (or a single file)</Text>
            <Text dimColor>Export from chatgpt.com → Settings → Data controls → Export data</Text>
            <Text dimColor>Press enter to skip</Text>
            {importError && <Text color="red">{importError}</Text>}
            <Box paddingTop={1}>
              <Text color="green">Path: </Text>
              <TextInput
                value={importPath}
                onChange={setImportPath}
                onSubmit={handleImportSubmit}
                placeholder="~/Downloads/chatgpt-export"
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'index-setup' && (
          <>
            <Text bold>Set up semantic search?</Text>
            <Text>This lets you search past conversations with <Text bold>/recall</Text></Text>
            <Text dimColor>Requires a ChromaDB instance and an embedding provider</Text>
            <Text> </Text>
            {['Yes, set it up', 'No, skip for now'].map((label, i) => (
              <Box key={label} paddingLeft={1}>
                <Text color={i === indexSetupIdx ? 'cyan' : undefined}>
                  {i === indexSetupIdx ? '❯ ' : '  '}{label}
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'index-store' && (
          <>
            <Text bold>Choose vector store</Text>
            <Text> </Text>
            {[
              { id: 'local-chroma', label: 'Local ChromaDB', desc: 'Docker container on localhost' },
              { id: 'remote-chroma', label: 'Remote ChromaDB', desc: 'Hosted Chroma instance' },
            ].map((s, i) => (
              <Box key={s.id} paddingLeft={1}>
                <Text color={i === indexStoreIdx ? 'cyan' : undefined}>
                  {i === indexStoreIdx ? '❯ ' : '  '}
                  <Text bold>{s.label}</Text>
                  <Text dimColor>{'  '}{s.desc}</Text>
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'index-chroma-url' && (
          <>
            <Text bold>ChromaDB URL</Text>
            <Text dimColor>Press enter for default</Text>
            <Box paddingTop={1}>
              <Text color="green">URL: </Text>
              <TextInput
                value={indexChromaUrl}
                onChange={setIndexChromaUrl}
                onSubmit={handleChromaUrlSubmit}
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'index-embedder' && (
          <>
            <Text bold>Choose embedding provider</Text>
            <Text> </Text>
            {[
              { id: 'openai', label: 'OpenAI API', desc: 'text-embedding-3-small (requires API key)' },
              { id: 'local', label: 'Local server', desc: 'vLLM, Ollama, llama.cpp, etc.' },
            ].map((e, i) => (
              <Box key={e.id} paddingLeft={1}>
                <Text color={i === indexEmbedderIdx ? 'cyan' : undefined}>
                  {i === indexEmbedderIdx ? '❯ ' : '  '}
                  <Text bold>{e.label}</Text>
                  <Text dimColor>{'  '}{e.desc}</Text>
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'index-embedder-url' && (
          <>
            <Text bold>Embedding server URL</Text>
            <Text dimColor>The server should have an embedding model loaded</Text>
            <Box paddingTop={1}>
              <Text color="green">URL: </Text>
              <TextInput
                value={indexEmbedderUrl}
                onChange={setIndexEmbedderUrl}
                onSubmit={handleEmbedderUrlSubmit}
                focus={true}
              />
            </Box>
          </>
        )}

        {step === 'index-embedder-detect' && (
          <>
            <Text bold>Detecting embedding models...</Text>
            <Text dimColor>Querying {indexEmbedderUrl}</Text>
          </>
        )}

        {step === 'index-embedder-pick' && (
          <>
            <Text bold>Select an embedding model</Text>
            <Text dimColor>Found {indexEmbedderModels.length} model(s) on the server</Text>
            <Text> </Text>
            {indexEmbedderModels.map((m, i) => (
              <Box key={m.id} paddingLeft={1}>
                <Text color={i === indexEmbedderModelIdx ? 'cyan' : undefined}>
                  {i === indexEmbedderModelIdx ? '❯ ' : '  '}{m.id}
                </Text>
              </Box>
            ))}
            <Text> </Text>
            <Text dimColor>↑↓ navigate  enter select</Text>
          </>
        )}

        {step === 'done' && (
          <>
            <Text bold color="green">Setup complete!</Text>
            <Text> </Text>
            <Text>Provider: <Text bold>{selectedProvider}</Text></Text>
            {anthropicKey && <Text>Anthropic key: <Text dimColor>configured</Text></Text>}
            {openaiKey && <Text>OpenAI key: <Text dimColor>configured</Text></Text>}
            {selectedProvider === 'local' && <Text>Local model: <Text dimColor>{localModelName || '(not set)'}</Text></Text>}
            {selectedProvider === 'local' && <Text>Local URL: <Text dimColor>{localUrl}</Text></Text>}
            {importCount !== null && <Text>ChatGPT import: <Text dimColor>{importCount} conversations</Text></Text>}
            {indexEnabled && <Text>Vector store: <Text dimColor>{indexStore} ({indexChromaUrl})</Text></Text>}
            {indexEnabled && <Text>Embedder: <Text dimColor>{indexEmbedder === 'local' ? `${indexEmbedderModel || 'auto'} (${indexEmbedderUrl})` : 'OpenAI API'}</Text></Text>}
            <Text> </Text>
            <Text dimColor>Config will be saved to ~/.squirl/config.json</Text>
            <Text dimColor>Press enter to start</Text>
          </>
        )}
      </Box>
    </Box>
  );
};
