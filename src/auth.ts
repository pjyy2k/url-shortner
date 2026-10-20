interface AuthKV {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}
export interface AuthEnv { LINKS: AuthKV; ADMIN_PASSWORD?: string; ADMIN_TOKEN?: string }
export interface Credentials { salt: string; hash: string; sessionKey: string; iterations: number }
export const AUTH_KEY = 'auth:credentials';
const AGE = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) || [], h => parseInt(h, 16));
const random = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function digest(value: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function equal(a: string, b: string) {
  const [x,y] = await Promise.all([digest(a),digest(b)]);
  let difference = 0; for (let i = 0; i < x.length; i++) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
export function initialPassword(env: AuthEnv) {
  const value = env.ADMIN_PASSWORD || env.ADMIN_TOKEN;
  return value && value.length >= 10 && value.length <= 256 && !/[\r\n\x00]/.test(value) ? value : null;
}
export async function credentials(env: AuthEnv): Promise<Credentials | null> {
  const stored = await env.LINKS.get(AUTH_KEY, 'json') as Credentials | null;
  if (stored && (!/^[a-f0-9]{32}$/.test(stored.salt) || !/^[a-f0-9]{64}$/.test(stored.hash) || !/^[a-f0-9]{64}$/.test(stored.sessionKey) || stored.iterations !== 100000)) throw new Error('Invalid credentials configuration');
  return stored;
}
async function passwordHash(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations }, key, 256));
}
export async function checkPassword(password: unknown, env: AuthEnv, stored: Credentials | null) {
  if (typeof password !== 'string' || password.length > 256) return false;
  if (stored) return equal(await passwordHash(password, stored.salt, stored.iterations), stored.hash);
  const initial = initialPassword(env);
  return initial ? equal(password, initial) : false;
}
export async function changePassword(password: string, env: AuthEnv) {
  const salt = random(16);
  const stored: Credentials = { salt, hash: await passwordHash(password, salt, 100000), sessionKey: random(32), iterations: 100000 };
  await env.LINKS.put(AUTH_KEY, JSON.stringify(stored));
  return stored;
}
async function signingKey(env: AuthEnv, stored: Credentials | null) {
  const secret = stored?.sessionKey || await digest(`shortner-initial-session:${initialPassword(env) || ''}`);
  return crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
}
function cookieName(request: Request) { return new URL(request.url).protocol === 'https:' ? '__Host-shortner_session' : 'shortner_session'; }
function cookieAttributes(request: Request) { return `Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
export function clearCookie(request: Request) { return `${cookieName(request)}=; Max-Age=0; ${cookieAttributes(request)}`; }
export async function sessionCookie(request: Request, env: AuthEnv, stored: Credentials | null) {
  const payload = `${Math.floor(Date.now()/1000) + AGE}.${random(16)}`;
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(env, stored), encoder.encode(`${new URL(request.url).origin}\n${payload}`)));
  return `${cookieName(request)}=${payload}.${signature}; Max-Age=${AGE}; ${cookieAttributes(request)}`;
}
export async function validSession(request: Request, env: AuthEnv, stored: Credentials | null) {
  if (!stored && !initialPassword(env)) return false;
  const cookies = (request.headers.get('Cookie') || '').split(';').map(s=>s.trim());
  const value = cookies.find(s=>s.startsWith(`${cookieName(request)}=`))?.slice(cookieName(request).length+1);
  if (!value || !/^\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expires,nonce,signature] = value.split('.');
  const now = Math.floor(Date.now()/1000);
  if (Number(expires) <= now || Number(expires) > now + AGE) return false;
  return crypto.subtle.verify('HMAC', await signingKey(env, stored), unhex(signature), encoder.encode(`${new URL(request.url).origin}\n${expires}.${nonce}`));
}
// Legacy API tokens only work before a password is saved; changing the password disables them.
export async function validLegacyToken(request: Request, env: AuthEnv, stored: Credentials | null) {
  const value = request.headers.get('Authorization');
  return !stored && !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32 && env.ADMIN_TOKEN.length <= 256 && !/\s/.test(env.ADMIN_TOKEN) && !!value && value.length <= 512 && await equal(value, `Bearer ${env.ADMIN_TOKEN}`);
}
export async function apiKeyHash(value: string) { return digest(value); }
export function newApiKey() { return `usk_${random(32)}`; }
export async function validApiKey(request: Request, env: AuthEnv) {
  const value = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!/^usk_[a-f0-9]{64}$/.test(value)) return false;
  const record = await env.LINKS.get(`apikey:${await apiKeyHash(value)}`, 'json') as { version?: number } | null;
  return record?.version === 1;
}
