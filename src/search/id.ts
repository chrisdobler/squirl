import { createHash } from 'node:crypto';

export function chunkId(source: string, userMsgId: string, assistantMsgId: string): string {
  return createHash('sha1').update(`${source}\0${userMsgId}\0${assistantMsgId}`).digest('hex');
}
