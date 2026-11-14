import { HumanMessage } from "@langchain/core/messages";

/**
 * A Bot that says what it will do next and then stops.
 *
 * Some models, local ones especially, end a turn with "Now I'll click New." and no tool call. The
 * run finishes, nothing clicks, and the page sits still until the person types "continue". When the
 * last words of a text-only answer announce a step, the model is asked once more in the same run to
 * take it. The note is not one of the conversation's messages: it is never streamed, so it is never
 * stored or shown.
 */

/** Asking the person something is a reason to stop, not a stall. */
const ASKS_THE_PERSON =
  /[?？]\s*$|确认|请问|是否|要不要|需不需要|需要你|请你|告诉我|你来|你决定|shall i|should i|do you want|would you like|let me know|confirm/i;

const ANNOUNCES_A_STEP = [
  /(现在|接下来|下一步|然后|马上|随后|我先|我来|我将|我会|我要|让我|准备|开始|先)[^。！!\n]{0,40}(点击|点开|打开|填写|填入|输入|选择|选中|切换|搜索|查找|获取|拿到|查看|读取|保存|提交|滚动|等待|截图|快照|执行|调用|操作|检查|核对|导航|进入|返回|刷新|登录|下载|上传|运行|尝试|处理)/,
  /\b(let me|i'll|i will|i am going to|i'm going to|now i|next,? i)\b/i,
];

/**
 * A last sentence that is itself the step: "我打开它编辑。", "选它并发一条测试指令。" (both 2026-11-14, missed by the
 * patterns above because nothing comes before the verb). Not a report of one already done (了, 过, 完), and not a
 * verb used as a noun ("检查结果全部通过").
 */
const STEP_AS_LAST_SENTENCE =
  /^(?:好的?[，,]?\s*)?(?:我们?|那我)?(?:再|去|就|直接|先|马上|现在|接着|继续|这就|立即|立刻|然后|下面)*(?:点击|点开|点一下|打开|填写|填入|输入|选择|选中|选它|选上|勾选|切换|搜索|查找|获取|查看|读取|保存|提交|上传|下载|运行|执行|编辑|修改|改成|改为|删除|创建|新建|添加|进入|返回|刷新|登录|截图|快照|滚动|等待|检查|核对|调用|试试|试一下|发一条|发送|重试|关闭)(?!了|过|完|结果|如下|后|中|的)/;

/** The tail of the answer is where a stall announces itself; earlier sentences are what was done. */
const TAIL_CHARS = 160;

/** The last sentence of a text, without the punctuation that ends it. */
function lastSentence(text: string): string {
  const sentences = text
    .split(/[。！!？?\n]+/)
    .map((sentence) => sentence.replace(/^[\s"'“”「」*#>-]+/, "").trim())
    .filter(Boolean);
  return sentences.at(-1) ?? "";
}

export function announcesNextStep(text: string): boolean {
  const tail = text.trim().slice(-TAIL_CHARS);
  if (!tail) return false;
  if (ASKS_THE_PERSON.test(tail)) return false;
  return (
    ANNOUNCES_A_STEP.some((pattern) => pattern.test(tail)) ||
    STEP_AS_LAST_SENTENCE.test(lastSentence(tail))
  );
}

/** How many times one run may be asked to go on. One is enough to unstick it and cannot loop. */
export const NUDGES_PER_RUN = 1;

export const NUDGE_TEXT =
  "(Note from OpenBot, not from the person.) Your last reply said what you would do next but did not call a tool, so nothing happened. If there is a step to take, call the tool for it now. If the task is finished or you need the person to decide something, say so in one sentence and stop.\n" +
  "（这是 OpenBot 的提示，不是用户说的。）你上一条回复说了下一步要做什么，但没有调用工具，所以什么都没发生。如果还有操作要做，现在直接调用对应的工具；如果任务已完成或需要用户确认，用一句话说明并结束。";

export function nudgeMessage(): HumanMessage {
  return new HumanMessage(NUDGE_TEXT);
}
