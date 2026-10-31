import type { CodingDetail, CodingStep } from '../../src/shared/coding.js';

export const codingJobId = '11111111-1111-4111-8111-111111111111';
export const studioTaskId = '22222222-2222-4222-8222-222222222222';
export function completedCodingDetail(): CodingDetail {
  const at = new Date().toISOString();
  return {
    job: {
      id: codingJobId,
      vmId: '33333333-3333-4333-8333-333333333333',
      grantId: '44444444-4444-4444-8444-444444444444',
      repositoryUrl: 'https://github.com/example/public',
      commitSha: 'a'.repeat(40),
      baseRef: 'main',
      goal: 'Add a greeting utility and tests. Create a small Python module and regression tests, then verify the patch.',
      testCommand: 'python3 -m unittest discover -s broker_tests',
      mode: 'fixture',
      status: 'ready',
      blockedReason: null,
      requestedAction: null,
      modelCalls: 1,
      maxCalls: 8,
      maxOutputTokens: 2048,
      testsPassed: true,
      deadlineAt: new Date(Date.now() + 1800000).toISOString(),
      createdAt: at,
      artifactsExpireAt: new Date(Date.now() + 86400000).toISOString(),
    },
    artifactsExpired: false,
    parentTask: { id: studioTaskId, status: 'completed', blockedReason: null, completedAt: at },
    vm: {
      status: 'terminated',
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      cleanupConfirmedAt: at,
    },
    steps: [
      {
        id: 'baseline',
        sequence: 1,
        kind: 'command',
        status: 'completed',
        action: 'test',
        inferenceRequestId: null,
        result: {
          state: 'completed',
          result: {
            exitCode: 1,
            output: "ImportError: Start directory is not importable: 'broker_tests'",
          },
        },
      },
      {
        id: 'write',
        sequence: 2,
        kind: 'command',
        status: 'completed',
        action: 'write',
        inferenceRequestId: null,
        result: { state: 'completed', result: { path: 'greeting.py', written: true } },
      },
      {
        id: 'model',
        sequence: 3,
        kind: 'model',
        status: 'completed',
        action: 'model',
        inferenceRequestId: 'receipt-1',
        result: {
          action: { action: 'test' },
          provider: 'baseten',
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
        receipt: {
          id: 'receipt-1',
          grantId: 'grant',
          packId: 'pack',
          provider: 'baseten',
          mode: 'fixture',
          status: 'settled',
          heldInputTokens: 0,
          heldOutputTokens: 0,
          inputTokens: 100,
          outputTokens: 50,
          failureCode: null,
          createdAt: at,
          completedAt: at,
        },
      },
      {
        id: 'verified-test',
        sequence: 4,
        kind: 'command',
        status: 'completed',
        action: 'test',
        inferenceRequestId: null,
        result: {
          state: 'completed',
          result: { exitCode: 0, output: 'Ran 3 tests\nOK', truncated: false },
        },
      },
      {
        id: 'patch',
        sequence: 5,
        kind: 'command',
        status: 'completed',
        action: 'diff',
        inferenceRequestId: null,
        result: {
          state: 'completed',
          result: {
            exitCode: 0,
            output: 'diff --git a/greeting.py b/greeting.py\n+def greet(): return "Hello"\n',
            truncated: false,
          },
        },
      },
    ],
  };
}
export function uncertainStep(): CodingStep {
  const detail = completedCodingDetail();
  return {
    ...detail.steps[2]!,
    status: 'dispatching',
    result: null,
    receipt: {
      ...detail.steps[2]!.receipt!,
      status: 'needs_reconciliation',
      heldInputTokens: 1048576,
      heldOutputTokens: 2048,
      inputTokens: null,
      outputTokens: null,
      completedAt: null,
    },
  };
}
