import { describe, it, expect } from 'vitest';
import {
  validatePlan,
  planMessages,
  planFailureMessage,
  planOperation,
} from '../src/server/coding/planning.js';

const candidates = [{ id: 'approved-small' }];
const plan = {
  catalogId: 'approved-small',
  testCommand: 'python3 -m unittest',
  explanation: 'Small offline task.',
};
describe('Studio planning validation and recovery contract', () => {
  it('requires a complete final plan and keeps VM and owner-command checks authoritative', () => {
    expect(validatePlan(JSON.stringify(plan), 'stop', candidates, plan.testCommand)).toEqual({
      plan,
      failure: null,
    });
    for (const [content, reason, code] of [
      [JSON.stringify(plan), 'length', 'truncated'],
      ['{"catalogId":', 'stop', 'invalid_json'],
      [JSON.stringify({ ...plan, shell: 'unapproved' }), 'stop', 'invalid_schema'],
      [JSON.stringify({ ...plan, catalogId: 'invented' }), 'stop', 'unapproved_vm'],
      [JSON.stringify({ ...plan, testCommand: 'changed' }), 'stop', 'changed_test_command'],
      ['', 'content_filter', 'refused'],
    ])
      expect(validatePlan(content!, reason!, candidates, plan.testCommand)).toEqual({
        plan: null,
        failure: code,
      });
    expect(validatePlan(JSON.stringify(plan), 'stop', candidates, null, true).failure).toBe(
      'oversized_response',
    );
    expect(
      validatePlan('Explanation then ' + JSON.stringify(plan), 'stop', candidates).failure,
    ).toBe('invalid_json');
  });
  it('uses a small stable prompt and includes only the failure category in repairs', () => {
    const messages = planMessages(
      'Change one JSON value.',
      plan.testCommand,
      { context: { files: ['railway.json'] }, candidates },
      'truncated',
    );
    expect(messages[0]!.content).toContain('short selection task');
    expect(messages[0]!.content).toContain('explanation under 160 characters');
    expect(messages[0]!.content).toContain('previous settled reply failed validation (truncated)');
    expect(JSON.parse(messages[1]!.content).ownerTestCommand).toBe(plan.testCommand);
    expect(planOperation('task', 0)).toBe('studio:task:plan');
    expect(planOperation('task', 1)).toBe('studio:task:plan:repair:1');
    expect(planFailureMessage('truncated', 2048)).toContain('2,048-token');
  });
  it('bounds planning metadata without hiding that the repository summary is partial', () => {
    const messages = planMessages('x'.repeat(4000), null, {
      context: {
        files: Array(150).fill('x'.repeat(240)),
        manifests: Array(2).fill({ path: 'package.json', content: 'a'.repeat(12000) }),
      },
      candidates,
    });
    const body = JSON.parse(messages[1]!.content);
    expect(body.repository.files).toHaveLength(50);
    expect(body.repository.totalRootEntries).toBe(150);
    expect(body.repository.manifests[0].content.length).toBe(4000);
    expect(body.repository.manifests[0].truncated).toBe(true);
    expect(messages[1]!.content.length).toBeLessThan(30000);
  });
});
