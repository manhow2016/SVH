/**
 * localizer 单测（资产本地化转存，设计文档 §4 / §9）。
 *
 * 策略：假 fetchImpl + 真临时目录。断言覆盖
 * 成功落盘 / 退避重试序列 / 全失败宽落库语义（返回不抛）/ 两种超限不可重试
 * / part 文件零残留 / 半途断流收敛 / 错误文本防签名参数泄漏 / 覆盖与空 body 边界
 * / Content-Type 扩展名推断 / env 配置解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { extFromContentType, localizeToFile, readLocalizeConfig } from "../src/index";

/** 把 Buffer 数组 / 异步生成器包装成「无 Content-Length」的分块流 Response（贴近真实分块传输） */
function streamResponse(chunks: Buffer[] | AsyncIterable<Buffer>, headers: Record<string, string> = {}): Response {
  const web = ReadableStream.from(chunks as AsyncIterable<Uint8Array> | Uint8Array[]);
  return new Response(web, { status: 200, headers });
}

/** 记录退避等待序列（避免测试真的睡 10 秒） */
function makeSleeper(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** 取失败结果的 error 字段（配合 assert.ok(!r.ok) 收窄） */
function errorOf(result: { ok: true } | { ok: false; error: string }): string {
  if (result.ok) {
    throw new Error("期望失败，实际成功");
  }
  return result.error;
}

const SIGNED_URL = "https://dashscope.example.com/files/a.mp4?Expires=1700000000&Signature=SECRET123";

test("localizeToFile：流式响应一次成功 → 字节落盘正确、无 part 残留、回传 contentType", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const payload = Buffer.concat([Buffer.from("meta-"), Buffer.alloc(1024, 7)]);
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      assert.equal(String(input), SIGNED_URL);
      return streamResponse([payload], { "content-type": "video/mp4" });
    };

    const result = await localizeToFile({
      url: SIGNED_URL,
      destPath: join(dir, "ast_1.mp4"),
      maxBytes: 10 * 1024,
      fetchImpl,
      sleep,
    });

    assert.deepEqual(result, { ok: true, bytes: payload.length, contentType: "video/mp4" });
    assert.deepEqual(await readFile(join(dir, "ast_1.mp4")), payload);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(await readdir(dir), ["ast_1.mp4"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：大文件走真实文件流（file → part → rename）内容逐字节一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const src = join(dir, "source.bin");
    const payload = Buffer.alloc(64 * 1024, 3);
    await writeFile(src, payload);
    const destPath = join(dir, "ast_2.mp4");
    const { sleep } = makeSleeper();
    const fetchImpl: typeof fetch = async () =>
      new Response(Readable.toWeb(createReadStream(src)) as unknown as ReadableStream, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });

    const result = await localizeToFile({ url: SIGNED_URL, destPath, maxBytes: 1024 * 1024, fetchImpl, sleep });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.bytes, payload.length);
    }
    assert.deepEqual(await readFile(destPath), payload);
    assert.deepEqual(await readdir(dir).then((names) => names.filter((n) => n !== "source.bin")), ["ast_2.mp4"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：destPath 父目录不存在时自动创建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { sleep } = makeSleeper();
    const fetchImpl: typeof fetch = async () => streamResponse([Buffer.from("png")], { "content-type": "image/png" });
    const destPath = join(dir, "media", "nested", "ast_3.png");

    const result = await localizeToFile({ url: SIGNED_URL, destPath, fetchImpl, sleep });

    assert.equal(result.ok, true);
    assert.deepEqual(await readFile(destPath), Buffer.from("png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：前 2 次抛错第 3 次成功 → 退避序列 [500,2000] 且成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const destPath = join(dir, "ast_4.mp4");
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error(`network down #${calls}`);
      }
      return streamResponse([Buffer.from("video-bytes")], { "content-type": "video/mp4" });
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath, fetchImpl, sleep });

    assert.deepEqual(result, { ok: true, bytes: 11, contentType: "video/mp4" });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [500, 2000]);
    assert.deepEqual(await readFile(destPath), Buffer.from("video-bytes"));
    assert.deepEqual(await readdir(dir), ["ast_4.mp4"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：4 次尝试全抛错 → 返回 {ok:false} 不抛异常、退避 [500,2000,8000]、零残留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const sub = join(dir, "out");
    await writeFile(join(dir, "keep.txt"), "sentinel");
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error(`network down #${calls}`);
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath: join(sub, "ast_5.mp4"), fetchImpl, sleep });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /network down #4/);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [500, 2000, 8000]);
    // part 与半文件一律不留（父目录本身允许存在，内容为空）
    assert.deepEqual(await readdir(sub), []);
    assert.deepEqual(await readdir(dir), ["keep.txt", "out"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：HTTP 非 2xx 视为可重试失败，4 次后 error 含状态码且不留文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("upstream exploded", { status: 500 });
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath: join(dir, "ast_6.mp4"), fetchImpl, sleep });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /500/);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [500, 2000, 8000]);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：Content-Length 预检超限 → 立即失败不重试（不消耗等待）、不创建 part", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(Buffer.alloc(4), {
        status: 200,
        headers: { "content-length": String(10 * 1024), "content-type": "video/mp4" },
      });
    };

    const result = await localizeToFile({
      url: SIGNED_URL,
      destPath: join(dir, "ast_7.mp4"),
      maxBytes: 1024,
      fetchImpl,
      sleep,
    });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /上限/);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：无 Content-Length 时流式计数超限 → 中止下载不重试、part 零残留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const totalChunks = 2000;
    let yielded = 0;
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      async function* gen(): AsyncGenerator<Buffer> {
        for (let i = 0; i < totalChunks; i += 1) {
          yielded += 1;
          yield Buffer.alloc(64, i % 256);
        }
      }
      return streamResponse(gen());
    };

    const result = await localizeToFile({
      url: SIGNED_URL,
      destPath: join(dir, "ast_8.mp4"),
      maxBytes: 1000,
      fetchImpl,
      sleep,
    });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /上限/);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
    assert.ok(yielded < totalChunks, `应在超限处中止，实际已产出 ${yielded} 块`);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：错误文本只留主机名+路径，签名 query 不入 error（防泄漏到日志/DB）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { sleep } = makeSleeper();
    const fetchImpl: typeof fetch = async () => {
      throw new Error(`fetch failed for ${SIGNED_URL}`);
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath: join(dir, "ast_9.mp4"), fetchImpl, sleep });

    const error = errorOf(result);
    assert.equal(result.ok, false);
    assert.ok(!error.includes("SECRET123"), `error 泄漏签名参数：${error}`);
    assert.ok(!error.includes("Expires=1700000000"), `error 泄漏 query：${error}`);
    assert.ok(error.includes("dashscope.example.com/files/a.mp4"), `error 应保留主机名+路径：${error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：单次尝试受 AbortSignal.timeout 约束（超时计为可重试失败）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const hangingFetch: typeof fetch = (_input, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("实现未传 AbortSignal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("请求超时（AbortSignal）")));
      });
    };

    const result = await localizeToFile({
      url: SIGNED_URL,
      destPath: join(dir, "ast_10.mp4"),
      timeoutMs: 5,
      fetchImpl: hangingFetch,
      sleep,
    });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /超时/);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [500, 2000, 8000]);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：响应成功但无 body → 记为可重试失败而非崩溃", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const { sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath: join(dir, "ast_11.mp4"), fetchImpl, sleep });

    assert.equal(result.ok, false);
    assert.equal(calls, 4);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 半途断流（spec §4「断流不留 part」，同时是评审 C1 的回归钉）。
 *
 * 假流在 start() 内同步 enqueue 两块后立刻 error()：错误在微任务时间线排队，
 * 而实现的 `await open(part)` 走 libuv 宏任务 → 错误稳定落在
 * 「fromWeb 之后、for-await 挂监听之前」的窗口内。占位监听在位时错误经
 * for-await rejection 正常收敛；占位监听被删则 Node 以无监听者状态 emit
 * 'error'，整个测试进程当场崩溃（红）。
 */
test("localizeToFile：body 半途断流 → 收敛为可重试失败，4 次后 {ok:false} 且零残留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const destPath = join(dir, "ast_12.mp4");
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("chunk-a"));
            controller.enqueue(Buffer.from("chunk-b"));
            controller.error(new Error("mid-stream reset"));
          },
        }),
        { status: 200, headers: { "content-type": "video/mp4" } },
      );
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath, maxBytes: 1024, fetchImpl, sleep });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /mid-stream reset/);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [500, 2000, 8000]);
    // 已落盘的半文件必须随 part 一起清掉
    assert.deepEqual(await readdir(dir), []);
    assert.equal(existsSync(destPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：成功但响应无 Content-Type → 恰为 {ok:true,bytes}，无 contentType 幽灵键", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const destPath = join(dir, "ast_13.bin");
    const { sleep } = makeSleeper();
    const fetchImpl: typeof fetch = async () => streamResponse([Buffer.from("no-ct")]);

    const result = await localizeToFile({ url: SIGNED_URL, destPath, fetchImpl, sleep });

    assert.deepEqual(result, { ok: true, bytes: 5 });
    assert.equal("contentType" in result, false);
    assert.deepEqual(await readFile(destPath), Buffer.from("no-ct"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：rename 失败（destPath 撞已存在目录）→ 失败收敛、part 清理、按可重试口径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const blocker = join(dir, "ast_14.mp4");
    await mkdir(blocker);
    const { waits, sleep } = makeSleeper();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return streamResponse([Buffer.from("bytes")], { "content-type": "video/mp4" });
    };

    const result = await localizeToFile({ url: SIGNED_URL, destPath: blocker, fetchImpl, sleep });

    assert.equal(result.ok, false);
    assert.match(errorOf(result), /改名落盘失败/);
    assert.equal(calls, 4);
    assert.deepEqual(waits, [500, 2000, 8000]);
    // part 不留；被 rename 撞上的目录原样存在
    assert.deepEqual(await readdir(dir), ["ast_14.mp4"]);
    assert.equal((await stat(blocker)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：destPath 已有旧内容 → 成功后被完整覆盖且无 part", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const destPath = join(dir, "ast_15.mp4");
    await writeFile(destPath, Buffer.from("陈旧且更长的旧内容-xxxxxxxxxxxxxxxxxxxxxxxx"));
    const { sleep } = makeSleeper();
    const fresh = Buffer.from("新内容");
    const fetchImpl: typeof fetch = async () => streamResponse([fresh], { "content-type": "video/mp4" });

    const result = await localizeToFile({ url: SIGNED_URL, destPath, fetchImpl, sleep });

    assert.deepEqual(result, { ok: true, bytes: fresh.byteLength, contentType: "video/mp4" });
    assert.deepEqual(await readFile(destPath), fresh);
    assert.deepEqual(await readdir(dir), ["ast_15.mp4"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localizeToFile：空 body（零字节流）→ bytes=0 并落一个空文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "svh-localize-"));
  try {
    const destPath = join(dir, "ast_16.png");
    const { sleep } = makeSleeper();
    const fetchImpl: typeof fetch = async () => streamResponse([], { "content-type": "image/png" });

    const result = await localizeToFile({ url: SIGNED_URL, destPath, fetchImpl, sleep });

    assert.deepEqual(result, { ok: true, bytes: 0, contentType: "image/png" });
    assert.equal((await stat(destPath)).size, 0);
    assert.deepEqual(await readdir(dir), ["ast_16.png"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extFromContentType：四类已知 MIME 映射，未知与 undefined 返回 null", () => {
  assert.equal(extFromContentType("video/mp4"), "mp4");
  assert.equal(extFromContentType("image/png"), "png");
  assert.equal(extFromContentType("image/webp"), "webp");
  assert.equal(extFromContentType("image/jpeg"), "jpg");
  assert.equal(extFromContentType("video/mp4; codecs=avc1.42E01E"), "mp4");
  assert.equal(extFromContentType("TEXT/HTML"), null);
  assert.equal(extFromContentType("application/octet-stream"), null);
  assert.equal(extFromContentType(""), null);
  assert.equal(extFromContentType(undefined), null);
});

test("readLocalizeConfig：默认值、env 数字化与非法值回退", () => {
  assert.deepEqual(readLocalizeConfig({}), { maxBytes: 500 * 1024 * 1024, timeoutMs: 60000 });
  assert.deepEqual(
    readLocalizeConfig({ SVH_LOCALIZE_MAX_BYTES: "1048576", SVH_LOCALIZE_TIMEOUT_MS: "30000" }),
    { maxBytes: 1024 * 1024, timeoutMs: 30000 },
  );
  assert.deepEqual(readLocalizeConfig({ SVH_LOCALIZE_MAX_BYTES: " 2048 ", SVH_LOCALIZE_TIMEOUT_MS: " 1500 " }), {
    maxBytes: 2048,
    timeoutMs: 1500,
  });
  // 非法值一律回退默认
  for (const bad of ["", "abc", "0", "-1", "1.5", "Infinity", "NaN"]) {
    assert.deepEqual(
      readLocalizeConfig({ SVH_LOCALIZE_MAX_BYTES: bad, SVH_LOCALIZE_TIMEOUT_MS: bad }),
      { maxBytes: 500 * 1024 * 1024, timeoutMs: 60000 },
      `非法值 ${JSON.stringify(bad)} 应回退默认`,
    );
  }
});
