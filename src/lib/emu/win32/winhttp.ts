import type { Emulator, WinHttpSession, WinHttpConnect, WinHttpRequest, WinHttpHandleData } from '../emulator';

// ==========================
// WinHTTP 常量定义
// ==========================
const WINHTTP_NO_PROXY_NAME = 0;
const WINHTTP_NO_PROXY_BYPASS = 0;
const WINHTTP_FLAG_ASYNC = 0x00000001;
const WINHTTP_FLAG_SECURE = 0x00800000;
const WINHTTP_FLAG_REFRESH = 0x10000000;

const WINHTTP_ACCESS_TYPE_DEFAULT_PROXY = 0;
const WINHTTP_ACCESS_TYPE_NO_PROXY = 1;
const WINHTTP_ACCESS_TYPE_NAMED_PROXY = 3;

const WINHTTP_RESOLVE_TIMEOUT = 0;
const WINHTTP_CONNECT_TIMEOUT = 60000;
const WINHTTP_SEND_TIMEOUT = 30000;
const WINHTTP_RECEIVE_TIMEOUT = 30000;
const WINHTTP_RECEIVE_RESPONSE_TIMEOUT = 30000;

const WINHTTP_OPTION_PROXY = 2;
const WINHTTP_OPTION_CONNECT_TIMEOUT = 3;
const WINHTTP_OPTION_RECEIVE_TIMEOUT = 6;
const WINHTTP_OPTION_SEND_TIMEOUT = 5;
const WINHTTP_OPTION_RESOLVE_TIMEOUT = 2;

const ERROR_WINHTTP_INCORRECT_HANDLE_TYPE = 12173;
const ERROR_WINHTTP_INTERNAL_ERROR = 12174;
const ERROR_WINHTTP_INVALID_URL = 12180;
const ERROR_WINHTTP_UNRECOGNIZED_SCHEME = 12181;
const ERROR_WINHTTP_NAME_NOT_RESOLVED = 12182;
const ERROR_WINHTTP_INVALID_OPTION_ID = 12185;
const ERROR_WINHTTP_OPTION_NOT_SETTABLE = 12186;
const ERROR_WINHTTP_SHUTDOWN = 12191;
const ERROR_WINHTTP_LOGIN_FAILURE = 12193;
const ERROR_WINHTTP_OPERATION_CANCELLED = 12197;
const ERROR_WINHTTP_INCORRECT_HANDLE_STATE = 12198;
const ERROR_WINHTTP_NOT_INITIALIZED = 12172;
const ERROR_WINHTTP_TIMEOUT = 12002;
const ERROR_WINHTTP_SECURE_FAILURE = 12175;
const ERROR_WINHTTP_AUTO_PROXY_SERVICE_ERROR = 12178;
const ERROR_WINHTTP_BAD_AUTO_PROXY_SCRIPT = 12179;
const ERROR_WINHTTP_UNABLE_TO_DOWNLOAD_SCRIPT = 12183;
const ERROR_WINHTTP_SECURE_INVALID_CERT = 12169;
const ERROR_WINHTTP_SECURE_CERT_REV_FAILED = 12170;
const ERROR_WINHTTP_SECURE_CERT_REQUIRES_REV = 12171;
const ERROR_WINHTTP_SECURE_CERT_DATE_INVALID = 12137;
const ERROR_WINHTTP_SECURE_CERT_SUBJECT_INVALID = 12138;
const ERROR_WINHTTP_SECURE_CERT_WRONG_USAGE = 12149;
const ERROR_WINHTTP_SECURE_INVALID_CERT_CHAIN = 12193;
const ERROR_WINHTTP_SECURE_SERVER_CERT_STATE_INVALID = 12163;

const INTERNET_SCHEME_HTTP = 1;
const INTERNET_SCHEME_HTTPS = 2;
const INTERNET_SCHEME_FTP = 3;

const HTTP_QUERY_HOST = 26;
const HTTP_QUERY_CONTENT_TYPE = 1;
const HTTP_QUERY_CONTENT_LENGTH = 5;
const HTTP_QUERY_STATUS_CODE = 19;
const HTTP_QUERY_RAW_HEADERS_CRLF = 21;
const HTTP_QUERY_FLAG_REQUEST_HEADERS = 0x80000000;

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_SERVER_ERROR = 500;

let nextHandle = 0x10000;
let globalParsedUrl: URL | null = null;

// ==========================
// 句柄辅助函数
// ==========================
function allocHandle(emu: Emulator, type: string, data: WinHttpHandleData): number {
  const handle = nextHandle++;
  emu.winHttpHandles.set(handle, { type, data });
  return handle;
}

function getSession(emu: Emulator, handle: number): WinHttpSession | undefined {
  const entry = emu.winHttpHandles.get(handle);
  if (entry?.type === 'session') return entry.data as WinHttpSession;
  return undefined;
}

function getConnect(emu: Emulator, handle: number): WinHttpConnect | undefined {
  const entry = emu.winHttpHandles.get(handle);
  if (entry?.type === 'connect') return entry.data as WinHttpConnect;
  return undefined;
}

function getRequest(emu: Emulator, handle: number): WinHttpRequest | undefined {
  const entry = emu.winHttpHandles.get(handle);
  if (entry?.type === 'request') return entry.data as WinHttpRequest;
  return undefined;
}

// ==========================
// 自动请求：JSON→二进制，文本→普通二进制
// ==========================
function fetchAutoResponse(url: string): {
  isBinary: boolean;
  body: Uint8Array;
  contentType: string;
  statusCode: number;
} | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send(null);

    const ok = xhr.status >= 200 && xhr.status < 300;
    if (!ok) {
      return {
        isBinary: false,
        body: new Uint8Array(0),
        contentType: 'text/plain',
        statusCode: xhr.status
      };
    }

    const text = xhr.responseText;
    const isJson = url.toLowerCase().endsWith('.json');

    if (isJson) {
      return {
        isBinary: true,
        body: new TextEncoder().encode(text),
        contentType: 'application/json; charset=utf-8',
        statusCode: 200
      };
    } else {
      return {
        isBinary: false,
        body: new TextEncoder().encode(text),
        contentType: 'text/plain; charset=utf-8',
        statusCode: 200
      };
    }
  } catch {
    return null;
  }
}

// ==========================
// 注册 WinHTTP
// ==========================
export function registerWinHttp(emu: Emulator): void {
  const winhttp = emu.registerDll('WINHTTP.DLL');
  emu.winHttpHandles = new Map();

  function hAlloc(type: string, data: any) {
    const h = nextHandle++;
    emu.winHttpHandles.set(h, { type, data });
    return h;
  }

  // ------------------------------
  // 基础 API
  // ------------------------------
  winhttp.register('WinHttpOpen', 5, () => hAlloc('session', {}));

  winhttp.register('WinHttpCloseHandle', 1, () => {
    emu.winHttpHandles.delete(emu.readArg(0));
    return 1;
  });

  winhttp.register('WinHttpConnect', 4, () => hAlloc('connect', {}));

  winhttp.register('WinHttpOpenRequest', 7, () =>
    hAlloc('request', {
      responseText: '',
      responseBody: new Uint8Array(0),
      isBinary: false,
      contentType: '',
      statusCode: 0
    })
  );

  winhttp.register('WinHttpCrackUrl', 4, () => {
    const urlStr = emu.memory.readUTF16String(emu.readArg(0));
    try {
      globalParsedUrl = new URL(urlStr);
      return 1;
    } catch {
      return 0;
    }
  });

  // ------------------------------
  // 发送请求（先执行，设置二进制标记）
  // ------------------------------
  winhttp.register('WinHttpSendRequest', 7, () => {
    if (!globalParsedUrl) return 0;
    const req = emu.winHttpHandles.get(emu.readArg(0))?.data;
    if (!req) return 0;

    const res = fetchAutoResponse(globalParsedUrl.href);
    if (!res) return 0;

    req.isBinary = res.isBinary;
    req.responseBody = res.body;
    req.contentType = res.contentType;
    req.statusCode = res.statusCode;

    console.log('[WinHTTP] 类型:', res.isBinary ? 'JSON二进制' : '文本', '长度:', res.body.length);
    return 1;
  });

  winhttp.register('WinHttpReceiveResponse', 3, () => 1);

  // ------------------------------
  // 查询响应头（后执行，返回类型给调用方）
  // ------------------------------
  winhttp.register('WinHttpQueryHeaders', 5, () => {
    const hRequest = emu.readArg(0);
    const dwInfoLevel = emu.readArg(1);
    const lpBuffer = emu.readArg(3);
    const lpdwBufferLength = emu.readArg(4);

    const req = emu.winHttpHandles.get(hRequest)?.data;
    if (!req || !lpBuffer || !lpdwBufferLength) return 0;

    const info = dwInfoLevel & 0xFFFF;
    const bufLen = emu.memory.readU32(lpdwBufferLength);

    // 返回内容类型，调用方以此区分 JSON / 文本
    if (info === HTTP_QUERY_CONTENT_TYPE) {
      const s = req.contentType || 'text/plain';
      if (bufLen < s.length + 1) {
        emu.memory.writeU32(lpdwBufferLength, s.length + 1);
        return 0;
      }
      emu.memory.writeCString(lpBuffer, s);
      emu.memory.writeU32(lpdwBufferLength, s.length);
      return 1;
    }

    // 返回状态码
    if (info === HTTP_QUERY_STATUS_CODE) {
      const s = String(req.statusCode || 200);
      if (bufLen < s.length + 1) {
        emu.memory.writeU32(lpdwBufferLength, s.length + 1);
        return 0;
      }
      emu.memory.writeCString(lpBuffer, s);
      emu.memory.writeU32(lpdwBufferLength, s.length);
      return 1;
    }

    return 0;
  });

  // ------------------------------
  // 查询可用数据长度
  // ------------------------------
  winhttp.register('WinHttpQueryDataAvailable', 2, () => {
    const req = emu.winHttpHandles.get(emu.readArg(0))?.data;
    const pLen = emu.readArg(1);
    const len = req.responseBody?.length || 0;
    emu.memory.writeU32(pLen, len);
    return 1;
  });

  // ------------------------------
  // 统一二进制读取
  // ------------------------------
winhttp.register('WinHttpReadData', 4, () => {
  const req = emu.winHttpHandles.get(emu.readArg(0))?.data;
  const dst = emu.readArg(1);
  const maxSize = emu.readArg(2);
  const outRead = emu.readArg(3);

  if (!req || !dst || !outRead) return 0;

  const body = req.responseBody ?? new Uint8Array(0);
  const copyLen = Math.min(maxSize, body.length);

  // ✅ 用你原来的逐字节 writeU8，兼容你的模拟器，不报错
  for (let i = 0; i < copyLen; i++) {
    emu.memory.writeU8(dst + i, body[i]);
  }

  // 剩余数据截断
  req.responseBody = body.slice(copyLen);

  emu.memory.writeU32(outRead, copyLen);
  return 1;
});

  // ------------------------------
  // 其他补充 API
  // ------------------------------
  winhttp.register('WinHttpAddRequestHeaders', 4, () => 1);
  winhttp.register('WinHttpSetOption', 4, () => 1);
  winhttp.register('WinHttpQueryOption', 4, () => 0);
  winhttp.register('WinHttpWriteData', 5, () => 1);
  winhttp.register('WinHttpCreateUrl', 1, () => 0);
  winhttp.register('WinHttpSetStatusCallback', 4, () => 0);
  winhttp.register('WinHttpSetTimeouts', 5, () => 1);
  winhttp.register('WinHttpTimeFromSystemTime', 2, () => 1);
  winhttp.register('WinHttpTimeToSystemTime', 2, () => 1);
  winhttp.register('WinHttpGetProxyForUrl', 3, () => 0);
  winhttp.register('WinHttpGetIEProxyConfigForCurrentUser', 1, () => 0);
  winhttp.register('WinHttpDetectAutoProxyConfigUrl', 2, () => 0);
  winhttp.register('WinHttpAutoProxySvcMain', 4, () => 0);
  winhttp.register('WinHttpWebSocketClose', 3, () => 0);
  winhttp.register('WinHttpWebSocketReceive', 4, () => 0);
  winhttp.register('WinHttpWebSocketSend', 3, () => 0);
  winhttp.register('WinHttpWebSocketShutdown', 3, () => 0);
  winhttp.register('WinHttpWebSocketOpen', 6, () => 0);
}