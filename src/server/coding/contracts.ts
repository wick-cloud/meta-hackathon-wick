import { z } from 'zod';
import { HttpError } from '../context.js';
import { boundedJson } from '../inference/runtime.js';

export function publicRepository(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'Use a public HTTPS GitHub repository URL.');
  }
  const match = url.pathname.match(
    /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/,
  );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new HttpError(
      400,
      'Use https://github.com/owner/repository without credentials, a query, or a fragment.',
    );
  const name = match[2]!.replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'Invalid repository name.');
  return { owner: match[1]!, name, url: `https://github.com/${match[1]}/${name}` };
}
export const baseRefSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._/-]*)?$/)
  .refine(
    (s) => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.lock'),
    'Use a branch or commit, not a Git expression.',
  );
export const codingAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), path: z.string().min(1).max(240) }).strict(),
  z
    .object({
      action: z.literal('write'),
      path: z.string().min(1).max(240),
      content: z.string().max(12000),
    })
    .strict(),
  z.object({ action: z.literal('test') }).strict(),
  z.object({ action: z.literal('finish'), summary: z.string().min(1).max(3000) }).strict(),
]);
export type CodingAction = z.infer<typeof codingAction>;
/** Anonymous, fixed-origin requests only. A valid URL shape does not prove public access. */
export async function verifyPublicRepository(
  url: string,
  ref: string,
  fetcher: typeof fetch = fetch,
) {
  const repo = publicRepository(url);
  async function get(path: string) {
    const response = await fetcher(
      `https://api.github.com/repos/${repo.owner}/${repo.name}${path}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Wick-Broker-Public-Coding',
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        400,
        'Repository or ref is unavailable anonymously. Only public GitHub repositories are supported.',
      );
    }
    return boundedJson(response, 65536);
  }
  const info = z
    .object({
      private: z.literal(false),
      visibility: z.literal('public'),
      size: z.number().max(20000),
      default_branch: z.string().min(1).max(100),
      full_name: z.string(),
    })
    .safeParse(await get(''));
  if (
    !info.success ||
    info.data.full_name.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
  )
    throw new HttpError(
      400,
      'Choose a public repository under 20 MB; renamed or redirected repositories must use their current URL.',
    );
  const selected = baseRefSchema.parse(ref || info.data.default_branch);
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(await get(`/commits/${encodeURIComponent(selected)}`));
  return { ...repo, ref: selected, sha: commit.sha };
}
