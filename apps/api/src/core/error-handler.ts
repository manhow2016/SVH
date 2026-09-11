/**
 * 统一错误处理
 *
 * 落实技术文档第 66 条与审计结论：
 * - 返回给用户的是「发生了什么 + 可能原因 + 下一步怎么做」
 * - 技术错误（堆栈、Provider 原始报文、连接串）只进日志
 * - 使用真实 HTTP 状态码，不用 200 + 错误码包装
 *
 * 同时把 Fastify 自带的校验错误（FST_ERR_VALIDATION）归一化，
 * 避免出现 `body/xxx must be string` 这类面向开发者的英文报文直接暴露给用户。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  isSvhError,
  toSvhError,
  ValidationError,
  type ApiErrorBody,
} from '@svh/domain';

import { toLoggableError } from './logger.js';

/** Fastify 内置校验错误码 */
const FASTIFY_VALIDATION_CODES = new Set(['FST_ERR_VALIDATION']);

/** 已知的 Fastify 错误码 → 面向用户的处置 */
function mapFastifyError(err: FastifyError): { status: number; body: ApiErrorBody['error'] } | null {
  if (err.code && FASTIFY_VALIDATION_CODES.has(err.code)) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION_FAILED',
        message: '提交的内容有问题，请检查后重试。',
        suggestions: ['检查必填项是否完整', '检查字段格式是否正确'],
        retryable: false,
      },
    };
  }

  switch (err.code) {
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return {
        status: 400,
        body: {
          code: 'BAD_REQUEST',
          message: '请求格式无法识别，请确认使用的是 JSON 格式。',
          suggestions: ['检查 Content-Type 是否为 application/json'],
          retryable: false,
        },
      };
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        status: 413,
        body: {
          code: 'BAD_REQUEST',
          message: '上传的内容体积超出了限制。',
          suggestions: ['压缩后再上传', '拆分为多次提交'],
          retryable: false,
        },
      };
    case 'FST_ERR_REQ_INVALID_VALIDATION_INVOCATION':
      return {
        status: 422,
        body: {
          code: 'VALIDATION_FAILED',
          message: '提交的内容有问题，请检查后重试。',
          suggestions: ['刷新页面后重试'],
          retryable: false,
        },
      };
    case 'FST_ERR_NOT_FOUND':
      return {
        status: 404,
        body: {
          code: 'NOT_FOUND',
          message: '请求的地址不存在。',
          suggestions: ['检查请求路径是否正确'],
          retryable: false,
        },
      };
    case 'FST_ERR_RATE_LIMIT':
      return {
        status: 429,
        body: {
          code: 'RATE_LIMITED',
          message: '操作过于频繁，请稍后再试。',
          suggestions: ['稍等片刻后重试'],
          retryable: true,
        },
      };
    default:
      return null;
  }
}

/** 注册全局错误处理器 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: '请求的地址不存在。',
        suggestions: ['检查请求路径是否正确'],
        retryable: false,
      },
      requestId,
    } satisfies ApiErrorBody);
  });

  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    // 1) Fastify 内置错误：按语义映射，避免技术报文泄漏
    const mapped = mapFastifyError(err);
    if (mapped) {
      request.log.warn(
        { err: toLoggableError(err), requestId, url: request.url },
        '请求校验失败',
      );
      void reply.status(mapped.status).send({ error: mapped.body, requestId } satisfies ApiErrorBody);
      return;
    }

    // 2) 领域错误：已经是用户可理解的形式，直接用其 httpStatus
    const svhError = isSvhError(err)
      ? err
      : err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500
        ? new ValidationError(err.message)
        : toSvhError(err);

    // 5xx 记 error（需要告警），4xx 记 warn（正常业务分支）
    const logPayload = {
      ...svhError.toLogObject(),
      requestId,
      method: request.method,
      url: request.url,
    };
    if (svhError.httpStatus >= 500) {
      request.log.error(logPayload, '请求处理失败');
    } else {
      request.log.warn(logPayload, '请求被拒绝');
    }

    void reply.status(svhError.httpStatus).send({
      error: svhError.toUserResponse(),
      requestId,
    } satisfies ApiErrorBody);
  });
}
