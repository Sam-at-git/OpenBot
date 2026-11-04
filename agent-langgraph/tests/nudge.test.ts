import { describe, expect, test } from "bun:test";
import { announcesNextStep } from "../src/nudge";
import { type RunStreamEvent, streamRun } from "../src/stream";

describe("a reply that announces a step and stops", () => {
  // What a local model ended its turn with, word for word, on 2026-11-04.
  test.each([
    "看到了子菜单，现在点击「商机管理」。",
    "好的，已切换到表格视图。现在点击「新建」按钮。",
    "对话框已打开（「新建商机管理」），包含字段：客户*、商机标题*、预估金额、商机阶段、预期成交日、销售负责人等。让我重新获取快照以拿到表单字段的引用。",
    "当前是看板视图，按手册说明「新建」按钮在表格视图里。先切换到表格视图。",
    "The form is open. Let me take a snapshot to get the field references.",
  ])("is caught: %s", (text) => {
    expect(announcesNextStep(text)).toBe(true);
  });

  test.each([
    "已完成 5 条，2 条有问题：张三的工号重复，李四缺少部门。",
    "以下是要保存的内容，请确认后我再提交：客户 SCL，商机标题 年度维保。",
    "表单已经填好，要我现在保存吗？",
    "Nothing new. Re-checked the one record I can reach, unchanged.",
    "Should I submit it now?",
    "",
  ])("is left alone: %s", (text) => {
    expect(announcesNextStep(text)).toBe(false);
  });

  test("only the end of a long answer counts", () => {
    const earlier = `我先打开了列表，然后点击了筛选。${"核对结果一切正常。".repeat(30)}`;
    expect(announcesNextStep(earlier)).toBe(false);
  });
});

describe("the answer after a nudge", () => {
  test("is its own message, not glued onto the announcement", async () => {
    const events: RunStreamEvent[] = [
      { event: "on_chat_model_stream", data: { chunk: { content: "现在点击「新建」。" } } },
      { event: "on_chain_end", name: "nudge", data: {} },
      { event: "on_chat_model_stream", data: { chunk: { content: "已点击。" } } },
    ];
    const sent: Array<Record<string, unknown>> = [];
    await streamRun(
      async () =>
        (async function* () {
          for (const event of events) yield event;
        })(),
      { runId: "run_1", threadId: "thread_1" },
      (event) => sent.push(event as unknown as Record<string, unknown>),
    );
    const starts = sent.filter((event) => event.type === "TEXT_MESSAGE_START");
    expect(starts.map((event) => event.messageId)).toEqual([
      "msg_run_1_0",
      "msg_run_1_1",
    ]);
  });
});
