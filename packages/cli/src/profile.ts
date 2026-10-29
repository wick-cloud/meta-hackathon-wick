import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_API_URL = 'https://meta-hackathon-wick-production.up.railway.app';
export interface BrokerCredentials {
  apiUrl: string;
  apiKey: string;
}
export interface CredentialOptions {
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  configDirectory?: string;
}
export class CredentialError extends Error {
  readonly code = 'credentials_required';
}
export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CredentialError('Use a valid Broker API origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new CredentialError(
      'Broker API URL must be an HTTPS origin; HTTP is allowed only for localhost.',
    );
  return url.origin;
}
export function validateBrokerKey(value: string): string {
  if (!/^wbk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
    throw new CredentialError(
      'Use a Wick Broker API key beginning wbk_. Wick keys are separate and are not accepted.',
    );
  return value;
}
export function credentialFile(options: CredentialOptions = {}): string {
  return join(
    options.configDirectory ??
      options.env?.WICK_BROKER_CONFIG_DIR ??
      process.env.WICK_BROKER_CONFIG_DIR ??
      join(homedir(), '.config', 'wick-broker'),
    'credentials.json',
  );
}
export async function readSavedCredentials(
  options: CredentialOptions = {},
): Promise<BrokerCredentials | undefined> {
  const file = credentialFile(options);
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && info.mode & 0o077)
    )
      throw new CredentialError(
        'Broker credential file must be a regular private file with permissions 0600.',
      );
    const saved = JSON.parse(await readFile(file, 'utf8')) as BrokerCredentials;
    return { apiUrl: normalizeApiUrl(saved.apiUrl), apiKey: validateBrokerKey(saved.apiKey) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('Saved Broker credentials could not be read. Run auth login again.');
  }
}
export async function saveCredentials(
  credentials: BrokerCredentials,
  options: CredentialOptions = {},
): Promise<void> {
  const data = {
    apiUrl: normalizeApiUrl(credentials.apiUrl),
    apiKey: validateBrokerKey(credentials.apiKey),
  };
  const file = credentialFile(options),
    directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CredentialError('Broker credential directory must be a regular private directory.');
  await chmod(directory, 0o700);
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function removeCredentials(options: CredentialOptions = {}): Promise<void> {
  await rm(credentialFile(options), { force: true });
}
export async function resolveCredentials(
  options: CredentialOptions = {},
): Promise<BrokerCredentials> {
  const env = options.env ?? process.env;
  const override = options.apiUrl ?? env.WICK_BROKER_API_URL;
  if (env.WICK_BROKER_API_KEY)
    return {
      apiUrl: normalizeApiUrl(override ?? DEFAULT_API_URL),
      apiKey: validateBrokerKey(env.WICK_BROKER_API_KEY),
    };
  const saved = await readSavedCredentials(options);
  const apiUrl = normalizeApiUrl(override ?? saved?.apiUrl ?? DEFAULT_API_URL);
  if (!saved || saved.apiUrl !== apiUrl)
    throw new CredentialError(
      'No Broker credential is saved for this origin. Use auth login or WICK_BROKER_API_KEY and WICK_BROKER_API_URL.',
    );
  return { apiUrl, apiKey: saved.apiKey };
}
