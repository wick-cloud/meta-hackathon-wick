import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Row } from '../marketplace/data.js';
import { transaction } from '../marketplace/db.js';
import { open, seal } from '../coding/artifacts.js';
import { completeDemoStudio } from '../inference/gateway.js';
import { demoActor, demoModeAllowed } from './service.js';
import { demoStudioCommand } from './studio-script.js';
export { demoStudioCommand, demoStudioMessages, demoStudioRunnerSource } from './studio-script.js';

const answerSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .refine((v) => Buffer.byteLength(v) <= 256),
  })
  .strict();
const receiptSchema = z
  .object({
    runId: z.string().uuid(),
    attempt: z.union([z.literal(0), z.literal(1)]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    valid: z.boolean(),
    stdout: z.string().max(1024),
    exitCode: z.number().int().nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict();

/** Called without a grant lock: this transaction never calls back into inference/grants. */
async function state(
  ctx: AppContext,
  runId: string,
  leaseToken: string,
  action?: (db: import('pg').PoolClient, run: Row, studio: Row) => Promise<void>,
) {
  return transaction(ctx.pool, async (db) => {
    const run = (
      await db.query(
        `SELECT r.*,v.environment_id,v.expires_at AS vm_expires_at
      FROM broker_demo_runs r JOIN broker_vms v ON v.id=r.vm_id AND v.buyer_id=r.buyer_id
      JOIN broker_disks d ON d.id=r.disk_id AND d.id=v.disk_id AND d.buyer_id=r.buyer_id
      JOIN broker_disk_attachments a ON a.vm_id=v.id AND a.disk_id=d.id AND a.environment_id=v.environment_id
      WHERE r.id=$1 AND r.kind='studio' AND r.lease_token=$2 AND r.lease_until>clock_timestamp()
      AND r.status='ready' AND NOT r.stop_requested AND r.ended_at IS NULL
      AND r.expires_at>clock_timestamp() AND v.status='running' AND v.expires_at>clock_timestamp()
      AND v.cleanup_confirmed_at IS NULL AND d.status='ready' AND NOT d.cleanup_pending
      AND d.source_mode=r.source_mode AND a.status='mounted' AND v.catalog_snapshot->>'provider'='modal'
      AND v.catalog_snapshot->>'profile'='micro' AND COALESCE(v.catalog_snapshot->>'sourceMode','fixture')=r.source_mode
      FOR UPDATE OF r`,
        [runId, leaseToken],
      )
    ).rows[0];
    if (!run || !demoModeAllowed(ctx) || run.source_mode !== ctx.wick.mode) return null;
    const studio = (
      await db.query('SELECT * FROM broker_demo_studio WHERE run_id=$1 FOR UPDATE', [runId])
    ).rows[0];
    if (!studio) return null;
    if (action) await action(db, run, studio);
    return { run, studio };
  });
}
async function attention(ctx: AppContext, id: string, lease: string, code: string) {
  await state(ctx, id, lease, async (db, _run, studio) => {
    if (studio.status === 'passed' || studio.status === 'needs_attention') return;
    await db.query(
      "UPDATE broker_demo_studio SET status='needs_attention',failure_code=$2,updated_at=clock_timestamp() WHERE run_id=$1",
      [id, code],
    );
  });
}
async function invalid(ctx: AppContext, id: string, lease: string) {
  await state(ctx, id, lease, async (db, _run, studio) => {
    await db.query(
      "UPDATE broker_demo_studio_attempts SET failure_code='invalid_source' WHERE run_id=$1 AND attempt=$2",
      [id, studio.attempt],
    );
    if (studio.attempt === 0) {
      await db.query(
        `UPDATE broker_demo_studio SET status='generating',attempt=1,source_cipher=NULL,result_cipher=NULL,code_sha256=NULL,
        execution_started_at=NULL,execution_completed_at=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE run_id=$1`,
        [id],
      );
      await db.query(
        'INSERT INTO broker_demo_studio_attempts(run_id,attempt) VALUES($1,1) ON CONFLICT DO NOTHING',
        [id],
      );
    } else
      await db.query(
        "UPDATE broker_demo_studio SET status='needs_attention',failure_code='invalid_source',updated_at=clock_timestamp() WHERE run_id=$1",
        [id],
      );
  });
}

/** Same durable worker/VM owner as the terminal demo; completion never ends the VM lease. */
export async function reconcileDemoStudio(
  ctx: AppContext,
  runId: string,
  leaseToken: string,
): Promise<void> {
  try {
    await advance(ctx, runId, leaseToken);
  } catch {
    // Unknown model/native outcomes must never trigger another paid call or command.
    // A database outage leaves its durable attempt marker for the next worker to inspect.
    await attention(ctx, runId, leaseToken, 'outcome_unknown').catch(() => {});
  }
}
async function advance(ctx: AppContext, runId: string, leaseToken: string) {
  let current = await state(ctx, runId, leaseToken, async (db, _run, studio) => {
    if (studio.status !== 'waiting') return;
    await db.query(
      "UPDATE broker_demo_studio SET status='generating',updated_at=clock_timestamp() WHERE run_id=$1",
      [runId],
    );
    await db.query(
      'INSERT INTO broker_demo_studio_attempts(run_id,attempt) VALUES($1,0) ON CONFLICT DO NOTHING',
      [runId],
    );
  });
  if (!current) return;
  current = await state(ctx, runId, leaseToken);
  if (!current || ['passed', 'needs_attention'].includes(current.studio.status)) return;
  if (current.studio.status === 'generating') {
    const attempt = current.studio.attempt as 0 | 1;
    let row = (
      await ctx.pool.query(
        'SELECT * FROM broker_demo_studio_attempts WHERE run_id=$1 AND attempt=$2',
        [runId, attempt],
      )
    ).rows[0];
    if (!row) return attention(ctx, runId, leaseToken, 'attempt_missing');
    if (!row.response_cipher && !row.request_id) {
      try {
        await completeDemoStudio(ctx, demoActor(current.run), runId, leaseToken, attempt);
      } catch {
        /* Read the committed receipt, including settlement completed before a lost reply. */
      }
      row = (
        await ctx.pool.query(
          'SELECT * FROM broker_demo_studio_attempts WHERE run_id=$1 AND attempt=$2',
          [runId, attempt],
        )
      ).rows[0];
    }
    if (!row.response_cipher)
      return attention(
        ctx,
        runId,
        leaseToken,
        row.request_id ? 'model_outcome_unknown' : 'allowance_unavailable',
      );
    const response = open(ctx, row.response_cipher);
    let source: string;
    try {
      if (response.oversized || row.finish_reason !== 'stop')
        throw new Error('Incomplete response.');
      source = answerSchema.parse(JSON.parse(response.content)).source;
    } catch {
      return invalid(ctx, runId, leaseToken);
    }
    const hash = createHash('sha256').update(source).digest('hex');
    await state(ctx, runId, leaseToken, async (db, _run, studio) => {
      if (studio.status !== 'generating' || studio.attempt !== attempt) return;
      await db.query(
        "UPDATE broker_demo_studio SET status='running',source_cipher=$2,code_sha256=$3,updated_at=clock_timestamp() WHERE run_id=$1",
        [runId, seal(ctx, { source }), hash],
      );
    });
  }
  let execution: { run: Row; studio: Row } | null = null;
  await state(ctx, runId, leaseToken, async (db, run, studio) => {
    if (studio.status !== 'running') return;
    if (studio.execution_started_at) {
      await db.query(
        "UPDATE broker_demo_studio SET status='needs_attention',failure_code='execution_unknown',updated_at=clock_timestamp() WHERE run_id=$1",
        [runId],
      );
      return;
    }
    await db.query(
      'UPDATE broker_demo_studio SET execution_started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=$1',
      [runId],
    );
    execution = { run, studio };
  });
  if (!execution) return;
  // TS cannot infer assignments inside the transaction callback.
  const { run, studio } = execution as { run: Row; studio: Row };
  const source = open(ctx, studio.source_cipher).source as string;
  const deadline = new Date(
    Math.min(new Date(run.expires_at).getTime(), new Date(run.vm_expires_at).getTime()),
  ).toISOString();
  const native = await ctx.wick.runCommand!(run.environment_id, {
    command: demoStudioCommand(runId, studio.attempt, source, deadline),
    cwd: '/workspace',
  });
  if (native.exitCode !== 0 || (ctx.wick.mode === 'real' && native.simulated))
    return attention(ctx, runId, leaseToken, 'execution_unknown');
  const receipt = receiptSchema.safeParse(
    (() => {
      try {
        return JSON.parse(native.stdout);
      } catch {
        return null;
      }
    })(),
  );
  if (
    !receipt.success ||
    receipt.data.runId !== runId ||
    receipt.data.attempt !== studio.attempt ||
    receipt.data.sha256 !== studio.code_sha256
  )
    return attention(ctx, runId, leaseToken, 'invalid_execution_receipt');
  if (!receipt.data.valid && receipt.data.errorCode === 'invalid_source')
    return invalid(ctx, runId, leaseToken);
  const passed =
    receipt.data.valid &&
    receipt.data.errorCode === null &&
    receipt.data.exitCode === 0 &&
    receipt.data.stdout === 'Hello, World!\n';
  await state(ctx, runId, leaseToken, async (db, _run, latest) => {
    if (latest.attempt !== studio.attempt || latest.status !== 'running') return;
    await db.query(
      `UPDATE broker_demo_studio SET status=$2,result_cipher=$3,execution_completed_at=clock_timestamp(),verified_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
      failure_code=$5,updated_at=clock_timestamp() WHERE run_id=$1`,
      [
        runId,
        passed ? 'passed' : 'needs_attention',
        seal(ctx, { stdout: receipt.data.stdout, exitCode: receipt.data.exitCode }),
        passed,
        passed ? null : 'test_failed',
      ],
    );
  });
}
