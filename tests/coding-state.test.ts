import { describe, expect, it } from 'vitest';
import { codingPolling, jobState, stepState } from '../src/client/coding-state.js';
import { completedCodingDetail, uncertainStep } from './fixtures/coding-detail.js';

describe('coding execution outcome presentation', () => {
  it('does not turn a completed receipt with a failing exit code into success', () => {
    const step = completedCodingDetail().steps[3]!;
    step.result = {
      state: 'completed',
      result: { exitCode: 1, output: 'AssertionError: wrong result' },
    };
    expect(stepState(step)).toMatchObject({ label: 'Failed', tone: 'error' });
  });
  it('explains a missing initial test directory without hiding other baseline failures', () => {
    const step = completedCodingDetail().steps[0]!;
    expect(stepState(step)).toMatchObject({ label: 'Could not start', tone: 'warning' });
    step.result = {
      state: 'completed',
      result: { exitCode: 1, output: 'AssertionError: real baseline failure' },
    };
    expect(stepState(step).label).toBe('Failed');
    step.sequence = 20;
    step.result = {
      state: 'completed',
      result: {
        exitCode: 1,
        output: "ImportError: Start directory is not importable: 'broker_tests'",
      },
    };
    expect(stepState(step).tone).toBe('error');
  });
  it('keeps interrupted, missing, resource-limited and invalid model outcomes distinct', () => {
    const step = completedCodingDetail().steps[3]!;
    step.result = { state: 'completed', result: { exitCode: 0, interrupted: true } };
    expect(stepState(step).label).toBe('Interrupted');
    step.result = { state: 'completed', result: {} };
    expect(stepState(step).label).toBe('Result unavailable');
    step.result = { state: 'completed', result: { exitCode: 0, limitExceeded: 'workspace' } };
    expect(stepState(step).tone).toBe('error');
    const model = completedCodingDetail().steps[2]!;
    model.result = { action: null };
    expect(stepState(model).label).toBe('Response needs review');
  });
  it('shows a missing file as an observation and a failed guest command as failure', () => {
    const step = completedCodingDetail().steps[1]!;
    step.action = 'read';
    step.result = { state: 'completed', result: { content: null } };
    expect(stepState(step)).toEqual({ label: 'File not found', tone: 'neutral' });
    step.result = { state: 'failed', error: 'Workspace unavailable' };
    expect(stepState(step).tone).toBe('error');
    step.action = 'diff';
    step.result = { state: 'completed', result: { exitCode: 1 } };
    expect(stepState(step).tone).toBe('error');
    step.result = { state: 'completed', result: { exitCode: 0, truncated: true } };
    expect(stepState(step).label).toBe('Export incomplete');
  });
  it('never claims an unresolved or rejected inference succeeded', () => {
    const step = uncertainStep();
    expect(stepState(step)).toMatchObject({ label: 'Needs reconciliation', tone: 'warning' });
    step.receipt!.status = 'rejected';
    expect(stepState(step)).toMatchObject({ label: 'Rejected', tone: 'error' });
    step.receipt!.status = 'settled';
    expect(stepState(step).label).toBe('Response needs review');
  });
  it('uses the parent completion and confirmed cleanup without claiming the VM clone survives', () => {
    const detail = completedCodingDetail();
    expect(jobState(detail)).toMatchObject({ label: 'Completed', tone: 'success' });
    expect(jobState(detail).message).toContain('VM cleanup is confirmed');
    expect(jobState(detail).message).not.toContain('job clone');
    expect(codingPolling(detail)).toBe(0);
  });
  it('keeps polling after coding is ready until Studio finishes cleanup', () => {
    const detail = completedCodingDetail();
    detail.parentTask!.status = 'cleaning_up';
    expect(jobState(detail).label).toBe('Cleanup in progress');
    expect(codingPolling(detail)).toBe(3000);
    detail.parentTask!.status = 'failed';
    detail.parentTask!.blockedReason = 'Compute cleanup could not be completed.';
    expect(jobState(detail)).toMatchObject({
      label: 'Task failed',
      tone: 'error',
      message: detail.parentTask!.blockedReason,
    });
  });
  it('shows uncertain execution as reconciliation rather than a retryable normal pause', () => {
    const detail = completedCodingDetail();
    detail.parentTask!.status = 'needs_attention';
    detail.job.status = 'uncertain';
    expect(jobState(detail).label).toBe('Result needs reconciliation');
    expect(jobState(detail).message).toContain('do not send a replacement');
  });
  it('preserves failure reasons and distinguishes funding from stopped work', () => {
    const detail = completedCodingDetail();
    detail.parentTask = null;
    detail.job.status = 'failed';
    detail.job.blockedReason = 'Git clone failed';
    expect(jobState(detail)).toMatchObject({
      label: 'Execution failed',
      message: 'Git clone failed',
    });
    detail.job.status = 'needs_allowance';
    detail.vm!.status = 'running';
    expect(jobState(detail).label).toBe('Needs model allowance');
    detail.job.status = 'stopped';
    expect(jobState(detail).label).toBe('Execution stopped');
  });
  it('reports artifact expiry without losing the completed outcome', () => {
    const detail = completedCodingDetail();
    detail.artifactsExpired = true;
    expect(jobState(detail).label).toBe('Completed');
    expect(jobState(detail).message).toContain('expired');
    expect(jobState(detail).message).not.toContain('patch is retained');
    const expired = detail.steps[2]!;
    expired.action = 'expired';
    expired.result = null;
    expect(stepState(expired)).toEqual({ label: 'Artifact expired', tone: 'neutral' });
  });
  it('explains a lost workspace without encouraging a resume or hiding uncertain usage', () => {
    const detail = completedCodingDetail();
    detail.parentTask!.status = 'needs_attention';
    detail.job.status = 'running';
    expect(jobState(detail)).toMatchObject({ label: 'Workspace unavailable', tone: 'error' });
    detail.job.status = 'uncertain';
    expect(jobState(detail).label).toBe('Result needs reconciliation');
  });
  it('explains a passed deadline without encouraging more work or hiding unknown usage', () => {
    const detail = completedCodingDetail();
    detail.parentTask = null;
    detail.job.status = 'paused';
    detail.job.deadlineAt = new Date(Date.now() - 1000).toISOString();
    expect(jobState(detail).label).toBe('Deadline reached');
    detail.job.status = 'uncertain';
    expect(jobState(detail).label).toBe('Result needs reconciliation');
  });
});
