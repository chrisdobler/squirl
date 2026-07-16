import { describe, expect, it } from 'vitest';
import { explicitWorkflowTerminalState, workflowIsStalled, workflowProgressFromJournal, workflowResumePrompt, workflowStatusFromJournal } from './background-workflow.js';

describe('background workflow evidence', () => {
  it('treats an equal started/result journal as progress, not completion', () => {
    const journal = [
      JSON.stringify({ type: 'started', key: 'worker-1' }),
      JSON.stringify({ type: 'result', key: 'worker-1' }),
    ].join('\n');
    expect(workflowProgressFromJournal(journal)).toMatchObject({ completed: 1, active: 0 });
    expect(explicitWorkflowTerminalState(journal, 'task-1')).toBeNull();
  });

  it('reports the provider agents that are still running', () => {
    const journal = [
      JSON.stringify({ type: 'started', key: 'one', agentId: 'agent-one' }),
      JSON.stringify({ type: 'started', key: 'two', agentId: 'agent-two' }),
      JSON.stringify({ type: 'result', key: 'one', agentId: 'agent-one', result: {} }),
    ].join('\n');
    expect(workflowStatusFromJournal(journal)).toEqual({
      progress: { completed: 1, active: 1, phase: 'Background workflow' },
      workers: [
        { id: 'agent-one', key: 'one', state: 'completed' },
        { id: 'agent-two', key: 'two', state: 'running' },
      ],
    });
  });

  it('ignores quiet or unrelated provider records', () => {
    expect(explicitWorkflowTerminalState('', 'task-1')).toBeNull();
    expect(explicitWorkflowTerminalState(JSON.stringify({ taskId: 'task-2', status: 'completed' }), 'task-1')).toBeNull();
  });

  it('accepts only a matching structured terminal provider record, including nested metadata', () => {
    const completed = JSON.stringify({ message: { toolUseResult: { taskId: 'task-1', status: 'completed' } } });
    expect(explicitWorkflowTerminalState(completed, 'task-1')).toEqual({ state: 'completed' });
    const failed = JSON.stringify({ task: { task_id: 'task-1', task_status: 'failed', error: 'worker crashed' } });
    expect(explicitWorkflowTerminalState(failed, 'task-1')).toEqual({ state: 'failed', error: 'worker crashed' });
  });

  it('accepts Claude task notifications embedded in structured queue records', () => {
    const completed = JSON.stringify({
      type: 'queue-operation', timestamp: '2026-07-14T23:16:18.047Z',
      content: '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>',
    });
    expect(explicitWorkflowTerminalState(completed, 'task-1')).toEqual({
      state: 'completed', completedAt: '2026-07-14T23:16:18.047Z',
    });
  });

  it('requires stale evidence and a missing provider process before declaring a stall', () => {
    const input = {
      now: Date.parse('2026-07-14T20:10:00Z'),
      startedAt: '2026-07-14T20:00:00Z',
      lastActivityAt: '2026-07-14T20:05:00Z',
    };
    expect(workflowIsStalled({ ...input, providerProcessRunning: true })).toBe(false);
    expect(workflowIsStalled({ ...input, providerProcessRunning: undefined })).toBe(false);
    expect(workflowIsStalled({ ...input, providerProcessRunning: false })).toBe(true);
    expect(workflowIsStalled({ ...input, lastActivityAt: '2026-07-14T20:09:30Z', providerProcessRunning: false })).toBe(false);
  });

  it('builds a provider-native continuation request that preserves completed work', () => {
    const prompt = workflowResumePrompt({ taskId: 'task-1', runId: 'wf-1', scriptPath: '/tmp/deep-research-wf-1.js' });
    expect(prompt).toContain(
      'resumeFromRunId "wf-1"',
    );
    expect(prompt).toContain(
      'rerun only unfinished workers',
    );
    expect(prompt).toContain('args are mandatory');
    expect(prompt).toContain('cached scope result');
  });

  it('embeds known workflow args in the exact resume invocation', () => {
    const prompt = workflowResumePrompt({
      taskId: 'task-1', runId: 'wf-1', scriptPath: '/tmp/deep-research-wf-1.js', workflowArgs: 'original question',
    });
    expect(prompt).toContain('"resumeFromRunId":"wf-1"');
    expect(prompt).toContain('"args":"original question"');
    expect(prompt).toContain('Do not call any other tools first.');
    expect(prompt).not.toContain('Recover the exact original');
  });
});
