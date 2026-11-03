import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import type { Row } from '../marketplace/data.js';
import { requireDisk } from '../disks/service.js';

/** Called before funding, under the task-creation transaction. */
export async function reserveWorkspace(
  ctx: AppContext,
  db: PoolClient,
  buyerId: string,
  input: { diskId?: string; workspaceId?: string; goal: string },
  repository: { url: string; sha: string },
) {
  if (!input.diskId) return null;
  await requireDisk(ctx, db, buyerId, input.diskId);
  if (input.workspaceId) {
    const workspace = (
      await db.query(
        'SELECT * FROM broker_disk_workspaces WHERE id=$1 AND disk_id=$2 AND buyer_id=$3 FOR UPDATE',
        [input.workspaceId, input.diskId, buyerId],
      )
    ).rows[0];
    if (!workspace) throw new HttpError(404, 'Workspace not found.');
    if (workspace.active_task_id)
      throw new HttpError(409, 'This workspace is already in use by another task.');
    if (!workspace.initialized)
      throw new HttpError(
        409,
        'This workspace has no confirmed preparation receipt. Inspect it before continuing.',
      );
    if (workspace.repository_url !== repository.url || workspace.commit_sha !== repository.sha)
      throw new HttpError(
        409,
        'The workspace repository changed. Review the selected workspace again.',
      );
    return workspace as Row;
  }
  return (
    await db.query(
      `INSERT INTO broker_disk_workspaces(id,disk_id,buyer_id,name,repository_url,commit_sha)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        randomUUID(),
        input.diskId,
        buyerId,
        input.goal.slice(0, 80),
        repository.url,
        repository.sha,
      ],
    )
  ).rows[0] as Row;
}

/** A new task never plans against a remote checkout when continuing saved files. */
export async function workspaceContext(ctx: AppContext, task: Row) {
  const workspace = (
    await ctx.pool.query(
      `SELECT w.*,d.upstream_id FROM broker_disk_workspaces w JOIN broker_disks d ON d.id=w.disk_id
       WHERE w.id=$1 AND w.disk_id=$2 AND w.buyer_id=$3 AND w.active_task_id=$4`,
      [task.workspace_id, task.disk_id, task.buyer_id, task.id],
    )
  ).rows[0];
  if (!workspace || !ctx.wick.drives)
    throw new HttpError(409, 'The saved workspace is unavailable; no new model purchase was made.');
  const prefix = `workspaces/${workspace.id}/repository/`;
  const page = await ctx.wick.drives.listFiles(workspace.upstream_id, { prefix });
  const files = [...page.data.map((entry) => entry.key), ...page.commonPrefixes]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter((key) => key && !key.startsWith('.git/'))
    .slice(0, 50);
  const manifests = [];
  for (const name of ['pyproject.toml', 'package.json']) {
    const entry = page.data.find((file) => file.key === prefix + name);
    if (!entry) continue;
    if (entry.size > 12000)
      throw new HttpError(409, 'Use a small text project manifest for automatic planning.');
    const file = await ctx.wick.drives.readFile(workspace.upstream_id, entry.key);
    manifests.push({
      path: name,
      content: Buffer.from(file.contentBase64, 'base64').toString('utf8').slice(0, 12000),
    });
  }
  if (!files.length)
    throw new HttpError(
      409,
      'The saved workspace files are unavailable. Review the disk before continuing.',
    );
  return {
    files,
    manifests,
    continuingWorkspace: true,
    originalCommit: workspace.commit_sha,
    truncated: page.isTruncated,
  };
}
