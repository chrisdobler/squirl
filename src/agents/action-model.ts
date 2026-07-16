import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { SelectedModel } from '../components/ModelPicker.js';
import type { Message } from '../types.js';
import {
  ACTION_DECISION_JSON_SCHEMA,
  ACTION_PLANNER_SYSTEM_PROMPT,
  PROPOSE_HANDOFF_TOOL,
  actionPlannerInput,
  parseSquirlActionDecision,
  type ActionPlanningAgent,
  type ModelActionCapabilities,
  type RawActionDecision,
  type SquirlActionDecision,
} from './actions.js';

const ACTION_MODEL_TIMEOUT_MS = 60_000;
const capabilityCache = new Map<string, Promise<ModelActionCapabilities>>();

type OpenAICreate = (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>;

function cacheKey(model: SelectedModel): string {
  return `${model.provider}|${model.baseUrl ?? ''}|${model.id}`;
}

function openAIClient(model: SelectedModel): OpenAI {
  if (model.provider === 'local') {
    return new OpenAI({ baseURL: model.baseUrl, apiKey: 'not-needed', timeout: ACTION_MODEL_TIMEOUT_MS, maxRetries: 0 });
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? 'not-configured', timeout: ACTION_MODEL_TIMEOUT_MS, maxRetries: 0 });
}

async function probeLocalCapabilities(model: SelectedModel, create?: OpenAICreate): Promise<ModelActionCapabilities> {
  const invoke = create ?? ((params, options) => openAIClient(model).chat.completions.create(params as any, options));
  let nativeToolCalls = false;
  let structuredOutput = false;
  try {
    const response = await invoke({
      model: model.id,
      messages: [{ role: 'user', content: 'Call propose_handoff for agent probe with task probe.' }],
      tools: [PROPOSE_HANDOFF_TOOL],
      tool_choice: { type: 'function', function: { name: 'propose_handoff' } },
      temperature: 0,
      max_tokens: 128,
    });
    nativeToolCalls = response.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'propose_handoff';
  } catch { /* unsupported or unavailable */ }

  try {
    const response = await invoke({
      model: model.id,
      messages: [{ role: 'user', content: 'Choose respond.' }],
      response_format: { type: 'json_schema', json_schema: ACTION_DECISION_JSON_SCHEMA },
      temperature: 0,
      max_tokens: 128,
    });
    const raw = JSON.parse(response.choices?.[0]?.message?.content ?? '') as RawActionDecision;
    structuredOutput = raw.decision === 'respond' || raw.decision === 'handoff';
  } catch { /* unsupported or unavailable */ }

  return { nativeToolCalls, structuredOutput };
}

/** Discover action transports independently from the model's filesystem/command tools. */
export function probeModelActionCapabilities(model: SelectedModel, create?: OpenAICreate): Promise<ModelActionCapabilities> {
  if (model.provider === 'anthropic') return Promise.resolve({ nativeToolCalls: true, structuredOutput: false });
  if (model.provider === 'openai') return Promise.resolve({ nativeToolCalls: true, structuredOutput: true });
  const key = cacheKey(model);
  if (create) return probeLocalCapabilities(model, create);
  const cached = capabilityCache.get(key);
  if (cached) return cached;
  const pending = probeLocalCapabilities(model).catch(() => ({ nativeToolCalls: false, structuredOutput: false }));
  capabilityCache.set(key, pending);
  return pending;
}

export function clearModelActionCapabilityCache(): void {
  capabilityCache.clear();
}

export function actionDecisionFromToolArguments(value: unknown): RawActionDecision {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '') as Record<string, unknown>;
    return { decision: 'handoff', ...parsed };
  } catch {
    return { decision: 'respond' };
  }
}

async function decideWithOpenAI(
  model: SelectedModel,
  capabilities: ModelActionCapabilities,
  input: string,
  signal?: AbortSignal,
): Promise<RawActionDecision> {
  const client = openAIClient(model);
  const messages = [
    { role: 'system', content: ACTION_PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];
  if (capabilities.nativeToolCalls) {
    const response = await client.chat.completions.create({
      model: model.id, messages, tools: [PROPOSE_HANDOFF_TOOL], tool_choice: 'auto', temperature: 0, max_tokens: 512,
    } as any, { signal });
    const call = (response.choices[0]?.message?.tool_calls as any[] | undefined)?.find((item: any) => item.function?.name === 'propose_handoff');
    return call ? actionDecisionFromToolArguments(call.function.arguments) : { decision: 'respond' };
  }
  if (!capabilities.structuredOutput) return { decision: 'respond' };
  const response = await client.chat.completions.create({
    model: model.id,
    messages: [...messages, { role: 'user', content: 'Return the action decision using the required JSON schema.' }],
    response_format: { type: 'json_schema', json_schema: ACTION_DECISION_JSON_SCHEMA },
    temperature: 0,
    max_tokens: 512,
  } as any, { signal });
  try {
    return JSON.parse(response.choices[0]?.message?.content ?? '') as RawActionDecision;
  } catch {
    return { decision: 'respond' };
  }
}

async function decideWithAnthropic(model: SelectedModel, input: string, signal?: AbortSignal): Promise<RawActionDecision> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? 'not-configured', timeout: ACTION_MODEL_TIMEOUT_MS, maxRetries: 0 });
  const response = await client.messages.create({
    model: model.id,
    system: ACTION_PLANNER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: input }],
    tools: [{
      name: PROPOSE_HANDOFF_TOOL.function.name,
      description: PROPOSE_HANDOFF_TOOL.function.description,
      input_schema: PROPOSE_HANDOFF_TOOL.function.parameters as any,
    }],
    tool_choice: { type: 'auto' },
    max_tokens: 512,
    temperature: 0,
  }, { signal });
  const call = response.content.find((block) => block.type === 'tool_use' && block.name === 'propose_handoff');
  return call?.type === 'tool_use' ? { decision: 'handoff', ...(call.input as Record<string, unknown>) } : { decision: 'respond' };
}

/** Convert either provider-native tool calling or JSON-schema output into one validated decision. */
export async function decideSquirlAction(
  request: string,
  agents: ActionPlanningAgent[],
  recentContext: Message[],
  model: SelectedModel,
  capabilities: ModelActionCapabilities,
  signal?: AbortSignal,
): Promise<SquirlActionDecision> {
  if (!capabilities.nativeToolCalls && !capabilities.structuredOutput) return { type: 'respond' };
  try {
    const input = actionPlannerInput(request, agents, recentContext);
    const raw = model.provider === 'anthropic'
      ? await decideWithAnthropic(model, input, signal)
      : await decideWithOpenAI(model, capabilities, input, signal);
    return parseSquirlActionDecision(raw, agents);
  } catch {
    return { type: 'respond' };
  }
}
