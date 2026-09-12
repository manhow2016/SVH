/**
 * Zod 校验辅助
 *
 * Fastify 5 原生基于 JSON Schema，而 SVH 的领域契约全部用 Zod 表达。
 * 与其把 Zod 手工翻译成 JSON Schema（必然漂移），这里直接复用 **同一份 Zod
 * Schema** 作为请求校验入口 —— 一份声明同时驱动编译期类型与运行时校验。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ValidationError } from '@svh/domain';

/** 把 Zod 错误转为面向用户的字段级提示 */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * 校验请求参数并抛出版域错误。
 *
 * 抛出 `ValidationError` 后由全局错误处理器统一转成 400 响应，
 * 因此插件里不需要到处写 try/catch。
 *
 * 泛型固定为 `<T extends z.ZodTypeAny>` 并用 `z.infer<T>` 作为返回类型 ——
 * 这是调用方能正确推断出精确类型的唯一写法。代价是 `ZodTypeAny` 把 Output
 * 固定为 `any`，使 `result.data` 在该函数签名下被视作 `any`。
 *
 * 这里刻意使用**定点豁免**而不是把规则关掉：
 * 泛型换成 `<S extends z.ZodType<O>, O>` 实测会让所有调用方推断出 `unknown`
 * （12 处编译错误），用更差的类型去满足 lint 是本末倒置。
 * 该函数是全仓唯一需要此豁免的位置。
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  /** 参数来源，用于生成更精确的错误信息 */
  source: 'body' | 'query' | 'params' = 'body',
): z.infer<T> {
  const result = schema.safeParse(value);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- 见上方注释：any 源自 ZodTypeAny 的 Output 定义
  if (result.success) return result.data;

  const details = formatZodIssues(result.error);
  throw new ValidationError(`请求${sourceLabel(source)}校验失败：${details.join('；')}`, {
    suggestions: [
      ...details.slice(0, 3),
      '检查请求体字段名称与类型是否正确',
    ],
  });
}

function sourceLabel(source: 'body' | 'query' | 'params'): string {
  switch (source) {
    case 'body':
      return '体';
    case 'query':
      return '参数';
    case 'params':
      return '路径参数';
  }
}

/**
 * 校验请求体。
 *
 * 注意 `request.body ?? {}`：当请求**没有 Content-Type 或没有请求体**时，
 * Fastify 不会解析 body，`request.body` 为 undefined。
 * 这在「全部字段都可选的 POST」上会表现为莫名其妙的 400（Required）。
 * 统一归一化为空对象后，缺失字段交由 Schema 自己决定是否合法，
 * 行为更可预测。
 */
export function parseBody<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, request.body ?? {}, 'body');
}

/** 校验查询参数 */
export function parseQuery<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, request.query, 'query');
}

/** 校验路径参数 */
export function parseParams<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, request.params, 'params');
}

/**
 * 校验路径参数中的 id。
 * 几乎所有资源路由都需要，单独抽出来避免重复。
 */
export const idParamsSchema = z.object({ id: z.string().min(1).max(64) });

/** 读取 id 路径参数 */
export function parseIdParam(request: FastifyRequest): string {
  const { id } = parseParams(request, idParamsSchema);
  return id;
}

/** 发送 201 Created 响应 */
export function created<T>(reply: FastifyReply, data: T): FastifyReply {
  return reply.status(201).send(data);
}

/** 发送 204 No Content 响应 */
export function noContent(reply: FastifyReply): FastifyReply {
  return reply.status(204).send();
}
