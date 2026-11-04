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

/** The tail of the answer is where a stall announces itself; earlier sentences are what was done. */
const TAIL_CHARS = 160;

export function announcesNextStep(text: string): boolean {
  const tail = text.trim().slice(-TAIL_CHARS);
  if (!tail) return false;
  if (ASKS_THE_PERSON.test(tail)) return false;
  return ANNOUNCES_A_STEP.some((pattern) => pattern.test(tail));
}

/** How many times one run may be asked to go on. One is enough to unstick it and cannot loop. */
export const NUDGES_PER_RUN = 1;

export const NUDGE_TEXT =
  "(Note from OpenBot, not from the person.) Your last reply said what you would do next but did not call a tool, so nothing happened. If there is a step to take, call the tool for it now. If the task is finished or you need the person to decide something, say so in one sentence and stop.\n" +
  "（这是 OpenBot 的提示，不是用户说的。）你上一条回复说了下一步要做什么，但没有调用工具，所以什么都没发生。如果还有操作要做，现在直接调用对应的工具；如果任务已完成或需要用户确认，用一句话说明并结束。";

export function nudgeMessage(): HumanMessage {
  return new HumanMessage(NUDGE_TEXT);
}
