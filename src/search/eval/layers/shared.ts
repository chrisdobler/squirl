import type { Message } from '../../../types.js';
import type { EvalConversationMessage } from '../types.js';

/** Turn an eval case's conversation into the Message[] the pipeline expects. */
export function toMessages(conversation: EvalConversationMessage[]): Message[] {
  return conversation.map((m, i) => ({ id: `m${i}`, role: m.role, content: m.content }));
}
