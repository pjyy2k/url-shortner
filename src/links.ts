export interface Link { url: string; createdAt: string; expiresAt: number | null; createdBy?: 'guest' | 'admin' }
export interface AllocatorEnv {
  CODE_ALLOCATOR?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
export async function allocateLink(env: AllocatorEnv, link: Link, customCode?: string): Promise<Response> {
  if (!env.CODE_ALLOCATOR) return Response.json({ error: '짧은 코드 생성 기능을 배포해 주세요.' }, { status: 503 });
  const allocator = env.CODE_ALLOCATOR.get(env.CODE_ALLOCATOR.idFromName('global-short-code-sequence'));
  return allocator.fetch(new Request('https://codes.internal/', { method: 'POST', body: JSON.stringify({ ...link, ...(customCode ? { customCode } : {}) }) }));
}
