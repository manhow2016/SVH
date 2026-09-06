/**
 * 供应商 API Key 验证（无副作用，仅探测连通性）。
 *
 * 策略：
 * 1. 优先 GET {baseUrl}/models —— OpenAPI 兼容端点标准能力，零成本、无模型依赖；
 * 2. 401/403 视为 Key 无效；
 * 3. 端点不支持 /models（404/405 等）时降级为一次最小 chat/completions 请求
 *    （仅当调用方可提供该供应商任一模型名；消耗可忽略）；
 * 4. 网络异常 / 超时 / 其余状态返回 network。
 */

/** 验证结果状态（no_key 由上层未配置判定，其余来自探测逻辑） */
export type ProviderVerifyStatus = "ok" | "no_key" | "invalid_key" | "network" | "unsupported";

/** 验证结果（ok = 验证通过；status 供前端区分渲染；message 为可读说明） */
export interface ProviderVerifyOutcome {
  ok: boolean;
  status: ProviderVerifyStatus;
  message: string;
}

const TIMEOUT_MS = 10_000;

/** 最短停顿：避免"验证中"一闪而过，保证状态图标可感知 */
const MIN_DURATION_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 统一构造结果，保证"验证中"至少展示 MIN_DURATION_MS（由调用方处理） */
function outcome(status: ProviderVerifyStatus, message: string): ProviderVerifyOutcome {
  return { ok: status === "ok", status, message };
}

/**
 * 验证 OpenAI 兼容供应商 API Key。
 *
 * @param options.baseUrl     供应商 base URL（如 https://ark.cn-beijing.volces.com/api/v3）
 * @param options.apiKey      待验证的 API Key
 * @param options.chatModelName 可选：该供应商任一模型名（端点不支持 /models 时降级 chat 验证用）
 * @param options.minDurationMs 可选：最小展示时长毫秒（默认 600，避免状态图标一闪而过；测试可传 0）
 */
export async function verifyOpenAICompatibleKey(options: {
  baseUrl: string;
  apiKey: string;
  chatModelName?: string;
  minDurationMs?: number;
}): Promise<ProviderVerifyOutcome> {
  const { baseUrl, apiKey, chatModelName } = options;
  const minDuration = options.minDurationMs ?? MIN_DURATION_MS;
  const base = baseUrl.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  const started = Date.now();

  // 1. 标准端点 GET /models
  let modelsResponse: Response;
  try {
    modelsResponse = await fetch(`${base}/models`, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    await ensureMinDuration(started, minDuration);
    return outcome("network", `无法连接供应商：${(err as Error).message}`);
  }

  if (modelsResponse.ok) {
    await ensureMinDuration(started, minDuration);
    return outcome("ok", "API Key 验证通过");
  }
  if (modelsResponse.status === 401 || modelsResponse.status === 403) {
    await ensureMinDuration(started, minDuration);
    return outcome("invalid_key", `API Key 无效（授权失败，HTTP ${modelsResponse.status}）`);
  }

  // 2. 端点不支持 /models → 降级最小 chat 请求（无模型名则无法验证）
  if (!chatModelName) {
    await ensureMinDuration(started, minDuration);
    return outcome("unsupported", "供应商端点不支持 /models，无法完成验证");
  }

  let chatResponse: Response;
  try {
    chatResponse = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: chatModelName,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    await ensureMinDuration(started, minDuration);
    return outcome("network", `无法连接供应商：${(err as Error).message}`);
  }

  await ensureMinDuration(started, minDuration);
  if (chatResponse.ok) return outcome("ok", "API Key 验证通过");
  if (chatResponse.status === 401 || chatResponse.status === 403) {
    return outcome("invalid_key", `API Key 无效（授权失败，HTTP ${chatResponse.status}）`);
  }
  return outcome("network", `供应商请求失败（HTTP ${chatResponse.status}）`);
}

/** 保证整体耗时不低于最小展示时长（视觉可感知） */
async function ensureMinDuration(started: number, minDuration: number): Promise<void> {
  const elapsed = Date.now() - started;
  const remain = minDuration - elapsed;
  if (remain > 0) await sleep(remain);
}
