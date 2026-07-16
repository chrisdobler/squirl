import type { Message, ResearchProvenance, ResearchSource } from './types.js';

export function collectResearchProvenance(messages: Message[], answer = ''): ResearchProvenance | undefined {
  const queries: string[] = [];
  const sources = new Map<string, ResearchSource>();
  for (const message of messages) {
    if (message.role !== 'tool' || !message.webResearch) continue;
    if (message.webResearch.query && !queries.includes(message.webResearch.query)) queries.push(message.webResearch.query);
    for (const source of message.webResearch.sources) {
      const previous = sources.get(source.url);
      sources.set(source.url, { ...previous, ...source, fetched: Boolean(previous?.fetched || source.fetched) });
    }
  }
  if (!queries.length && !sources.size) return undefined;
  const retainedSources = [...sources.values()].slice(0, 10);
  return {
    queries: queries.slice(0, 5), sources: retainedSources,
    citedSourceCount: retainedSources.filter((source) => answer.includes(source.url)).length,
  };
}
