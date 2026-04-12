export interface TurnPair {
  id: string;
  source: string;
  conversationId: string;
  timestamp: string;
  userText: string;
  assistantText: string;
  toolSummary?: string;
}

export interface EmbeddedChunk {
  turnPair: TurnPair;
  embedding: number[];
  text: string;
}

export interface Embedder {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchResult {
  id: string;
  score: number;
  turnPair: TurnPair;
}

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[]): Promise<void>;
  query(embedding: number[], k: number): Promise<SearchResult[]>;
  has(ids: string[]): Promise<Set<string>>;
  close(): Promise<void>;
}

export interface Importer {
  name: string;
  parse(path: string): AsyncIterable<TurnPair>;
}

export type IngestPhase = 'idle' | 'embedding' | 'indexing' | 'error';

export interface IngestStatus {
  phase: IngestPhase;
  pending: number;
  error?: string;
}
