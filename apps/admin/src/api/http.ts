export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface ErrorBody {
  code?: string;
  message?: string | string[];
}

export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'include', headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接服务器，请检查网络后重试', 0, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    const raw: unknown = await response.json().catch(() => ({}));
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as ErrorBody : {};
    const message = Array.isArray(body.message)
      ? body.message.join('；')
      : body.message;
    throw new ApiError(operatorError(message, response.status), response.status, body.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try { return (await response.json()) as T; }
  catch { throw new ApiError('服务器返回内容异常，请稍后重试', 502, 'INVALID_RESPONSE'); }
}

export function operatorError(message: unknown, status: number): string {
  // Never expose SQL, stack traces or proxy HTML from server failures.
  if (status >= 500) return '服务暂时不可用，请稍后重试；如持续发生，请联系管理员';
  if (typeof message === 'string' && /[\u4e00-\u9fff]/.test(message)) return message;
  if (status === 401) return '账号或密码不正确，或登录已过期，请重新登录';
  if (status === 403) return '当前账号没有此操作权限，请联系管理员';
  if (status === 404) return '记录不存在或已删除，请刷新列表';
  if (status === 409) return '数据已被更新或记录已存在，请刷新后重试';
  if (status === 413) return '上传文件过大，请缩小文件后重试';
  if (status === 429) return '操作过于频繁，请稍后再试';
  if (status === 400 || status === 422) return '填写的信息不符合要求，请检查必填项和格式';
  return '操作未完成，请稍后重试';
}
