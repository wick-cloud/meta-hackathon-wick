import type { CodingDetail, CodingStep } from '../shared/coding';

export type CodingTone = 'success' | 'error' | 'warning' | 'neutral' | 'active';
export type CodingState = { label: string; tone: CodingTone; message?: string };
export type TestResult = {
  output?: string;
  exitCode?: number;
  interrupted?: boolean;
  truncated?: boolean;
  limitExceeded?: string;
};
export const testResult = (step: CodingStep) => step.result?.result as TestResult | undefined;
// The executor records its initial test immediately after the clone at sequence 1.
export const baselineTest = (step: CodingStep) => step.action === 'test' && step.sequence === 1;

export function stepState(step: CodingStep): CodingState {
  if (step.status === 'rejected' || step.receipt?.status === 'rejected')
    return { label: 'Rejected', tone: 'error' };
  if (step.status === 'uncertain') return { label: 'Needs reconciliation', tone: 'warning' };
  if (step.receipt && ['outcome_unknown', 'needs_reconciliation'].includes(step.receipt.status))
    return { label: 'Needs reconciliation', tone: 'warning' };
  if (step.result?.state === 'failed' || step.status === 'failed')
    return { label: 'Failed', tone: 'error' };
  if (step.status !== 'completed')
    return step.receipt?.status === 'settled'
      ? { label: 'Response needs review', tone: 'warning' }
      : step.status === 'pending'
        ? { label: 'Queued', tone: 'neutral' }
        : { label: 'Awaiting receipt', tone: 'active' };
  if (step.action === 'expired') return { label: 'Artifact expired', tone: 'neutral' };
  const commandResult = step.kind === 'command' ? testResult(step) : undefined;
  if (commandResult?.limitExceeded) return { label: 'Resource limit reached', tone: 'error' };
  if (commandResult?.interrupted) return { label: 'Interrupted', tone: 'warning' };
  if (step.action === 'test') {
    const result = testResult(step);
    if (result?.exitCode === undefined) return { label: 'Result unavailable', tone: 'warning' };
    if (result.exitCode !== 0) {
      if (
        baselineTest(step) &&
        /ImportError: Start directory is not importable:/.test(result.output ?? '')
      )
        return {
          label: 'Could not start',
          tone: 'warning',
          message:
            'The test directory was unavailable before the changes. This check did not run any tests.',
        };
      return {
        label: 'Failed',
        tone: 'error',
        message: 'The test command returned a nonzero exit code.',
      };
    }
    if (result.truncated) return { label: 'Passed · output truncated', tone: 'success' };
    return { label: 'Passed', tone: 'success' };
  }
  if (commandResult?.exitCode !== undefined && commandResult.exitCode !== 0)
    return { label: 'Failed', tone: 'error' };
  if (step.action === 'diff' && commandResult?.truncated)
    return { label: 'Export incomplete', tone: 'warning' };
  if (step.kind === 'model' && !step.result?.action)
    return { label: 'Response needs review', tone: 'warning' };
  if (
    step.action === 'read' &&
    (step.result?.result as { content?: string | null } | undefined)?.content === null
  )
    return { label: 'File not found', tone: 'neutral' };
  return { label: 'Succeeded', tone: 'success' };
}

export function jobState(detail: CodingDetail, now = Date.now()): CodingState {
  const { job, parentTask: task, vm, artifactsExpired } = detail;
  if (task?.status === 'cleaning_up')
    return {
      label: 'Cleanup in progress',
      tone: 'active',
      message: 'Studio is reconciling usage and VM cleanup before closing the task budget.',
    };
  if (task?.status === 'completed')
    return {
      label: 'Completed',
      tone: 'success',
      message: artifactsExpired
        ? 'The task completed. Retained source artifacts have expired; execution receipts remain available.'
        : `Tests passed after the final edit and the verified patch is retained.${vm?.cleanupConfirmedAt ? ' VM cleanup is confirmed.' : ''}`,
    };
  if (task?.status === 'failed')
    return {
      label: 'Task failed',
      tone: 'error',
      message:
        task.blockedReason ||
        'The task ended before it could complete. Review its saved results and cleanup state.',
    };
  if (task?.status === 'stopped')
    return {
      label: 'Task stopped',
      tone: 'neutral',
      message: 'No further work will run. Review retained results and funding in the Studio task.',
    };
  if (job.status === 'uncertain')
    return {
      label: 'Result needs reconciliation',
      tone: 'warning',
      message:
        'The original command or model request may have run. Inspect its existing receipt before continuing; do not send a replacement request.',
    };
  if (!['ready', 'failed', 'stopped'].includes(job.status) && Date.parse(job.deadlineAt) <= now)
    return {
      label: 'Deadline reached',
      tone: 'warning',
      message:
        'No further work can start. Waiting for execution and cleanup receipts before the task is closed.',
    };
  if (
    !['ready', 'failed', 'stopped'].includes(job.status) &&
    vm &&
    ['terminated', 'failed', 'expired'].includes(vm.status)
  )
    return {
      label: 'Workspace unavailable',
      tone: 'error',
      message:
        'The VM is no longer available, so no further commands can run. Review the saved results and task cleanup before starting new work.',
    };
  if (task?.status === 'needs_budget' || job.status === 'needs_allowance')
    return {
      label: task ? 'Needs funding' : 'Needs model allowance',
      tone: 'warning',
      message:
        'Work is paused. Review the remaining budget and purchased allowance before continuing.',
    };
  if (job.status === 'failed')
    return {
      label: 'Execution failed',
      tone: 'error',
      message:
        job.blockedReason || 'Execution could not complete. Review the saved command receipts.',
    };
  if (job.status === 'paused' || task?.status === 'needs_attention')
    return {
      label: 'Needs attention',
      tone: 'warning',
      message:
        job.blockedReason ||
        task?.blockedReason ||
        'Execution is paused. Review the latest step before resuming within the original deadline.',
    };
  if (job.status === 'stopped')
    return {
      label: 'Execution stopped',
      tone: 'neutral',
      message: 'Execution has stopped. Saved receipts remain available.',
    };
  if (job.status === 'stopping')
    return {
      label: 'Stopping execution',
      tone: 'active',
      message: 'Waiting for confirmation that the current process has stopped.',
    };
  if (job.status === 'ready')
    return {
      label: 'Changes verified',
      tone: 'success',
      message: artifactsExpired
        ? 'Retained source artifacts have expired; execution receipts remain available.'
        : 'Tests passed after the final edit. Review or download the retained patch.',
    };
  return {
    label: job.status === 'queued' ? 'Queued' : 'Executing task',
    tone: 'active',
    message:
      'Meta is working in the isolated job workspace. Results update as command receipts arrive.',
  };
}

export function codingPolling(detail?: CodingDetail | null): number {
  if (!detail) return 3000;
  if (detail.parentTask)
    return ['completed', 'failed', 'stopped'].includes(detail.parentTask.status) ? 0 : 3000;
  if (!['ready', 'failed', 'stopped'].includes(detail.job.status)) return 3000;
  return detail.vm?.status === 'running' || detail.vm?.status === 'terminating' ? 15000 : 0;
}
