/**
 * Mock OpenAI Compatible LLM（开发/测试用，不属于 V1 交付范围）。
 *
 * 启动：node scripts/mock-llm.mjs（默认端口 9999）
 *
 * 行为（模拟连续 Tool Call 场景，带流式延迟）：
 *  Round 1: 输出文本 + list_files 调用
 *  Round 2: 输出文本 + write_file 调用（创建 script.md）
 *  Round 3: 纯文本回复，结束
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 9999);

const TOOL_LIST_FILES = {
  id: "call_001",
  function: { name: "list_files", arguments: JSON.stringify({ path: "." }) },
};
const TOOL_WRITE_FILE = {
  id: "call_002",
  function: {
    name: "write_file",
    arguments: JSON.stringify({
      path: "script.md",
      content:
        "# 东京旅游短视频脚本\n\n## 开头（0-3s）\n清晨的东京，城市刚刚苏醒，浅草寺的香火升起。\n\n## 主体（3-15s）\n涩谷十字路口的人潮、东京塔的日落、居酒屋的灯火。\n\n## 结尾（15-20s）\n夜樱下的东京，一句文案：这一站，东京。",
    }),
  },
};

function sseEvent(choice) {
  return `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", choices: [choice] })}\n\n`;
}

const writeDelayed = (res, chunk, delay = 250) =>
  new Promise((resolve) =>
    setTimeout(() => {
      res.write(chunk);
      resolve();
    }, delay),
  );

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    const messages = body.messages ?? [];
    // 调试：打印消息摘要（role / tool_call_id / tool_calls）
    console.log(
      "[mock] 请求消息摘要:",
      JSON.stringify(
        messages.map((m) => ({
          role: m.role,
          tcid: m.tool_call_id ?? null,
          tcs: (m.tool_calls ?? []).map((t) => t.id),
          content: typeof m.content === "string" ? m.content.slice(0, 18) : m.content,
        })),
      ),
    );
    const hasToolResult = messages.some((m) => m.role === "tool");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // ---- Director 场景：请求带 create_project 工具 → 创建生产项目 ----
    // 用于验证 Chat → Workflow 自动串联（不依赖真实 LLM）。
    const wantsCreateProject = (body.tools ?? []).some(
      (t) => t.function?.name === "create_project",
    );
    if (wantsCreateProject) {
      const hasCreateResult = messages.some(
        (m) => m.role === "tool" && m.tool_call_id === "call_create_project_1",
      );
      if (!hasCreateResult) {
        await writeDelayed(res, sseEvent({ delta: { content: "我先把这个需求落成生产项目。" } }));
        await writeDelayed(
          res,
          sseEvent({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_create_project_1",
                  function: { name: "create_project" },
                },
              ],
            },
          }),
        );
        await writeDelayed(
          res,
          sseEvent({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: JSON.stringify({
                      name: "Mock：自动串联验证项目",
                      type: "short_drama",
                      description: "mock-llm 创建，用于端到端验证自动工作流",
                    }),
                  },
                },
              ],
            },
          }),
        );
        await writeDelayed(res, sseEvent({ delta: {}, finish_reason: "tool_calls" }));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      await writeDelayed(
        res,
        sseEvent({
          delta: { content: "生产项目已创建，后续剧本/角色/场景/分镜流水线将自动执行。" },
        }),
        200,
      );
      await writeDelayed(res, sseEvent({ delta: {}, finish_reason: "stop" }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // ---- Round 1：第一次调用（无工具结果） ----
    if (!hasToolResult) {
      await writeDelayed(res, sseEvent({ delta: { content: "我先看一下工作区当前的文件状态。" } }));
      await writeDelayed(
        res,
        sseEvent({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_LIST_FILES.id,
                function: { name: TOOL_LIST_FILES.function.name },
              },
            ],
          },
        }),
      );
      await writeDelayed(
        res,
        sseEvent({
          delta: {
            tool_calls: [{ index: 0, function: { arguments: TOOL_LIST_FILES.function.arguments } }],
          },
        }),
      );
      await writeDelayed(res, sseEvent({ delta: {}, finish_reason: "tool_calls" }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // ---- Round 2：已有 list_files 结果，无 write_file 结果 ----
    const hasWriteResult = messages.some(
      (m) => m.role === "tool" && m.tool_call_id === TOOL_WRITE_FILE.id,
    );
    if (!hasWriteResult) {
      await writeDelayed(
        res,
        sseEvent({ delta: { content: "当前还没有脚本文件，我直接创建一个。" } }),
      );
      await writeDelayed(
        res,
        sseEvent({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_WRITE_FILE.id,
                function: { name: TOOL_WRITE_FILE.function.name },
              },
            ],
          },
        }),
      );
      await writeDelayed(
        res,
        sseEvent({
          delta: {
            tool_calls: [{ index: 0, function: { arguments: TOOL_WRITE_FILE.function.arguments } }],
          },
        }),
      );
      await writeDelayed(res, sseEvent({ delta: {}, finish_reason: "tool_calls" }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // ---- Round 3：完成并回复 ----
    await writeDelayed(
      res,
      sseEvent({
        delta: {
          content:
            "已完成！我在工作区创建了 script.md，包含开头、主体、结尾三段结构的东京旅游短视频脚本，你可以随时在右侧文件面板查看和编辑。",
        },
      }),
      200,
    );
    await writeDelayed(res, sseEvent({ delta: {}, finish_reason: "stop" }));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`[mock-llm] listening on http://localhost:${PORT}/v1`);
});
