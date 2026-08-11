export type AutoCategory = "工作" | "个人" | "订阅";

export interface ClassifiableMessage {
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  toText: string | null;
  textBody: string | null;
  snippet: string;
}

const publicMailDomains = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "qq.com", "163.com", "126.com", "yahoo.com"
]);

function matches(value: string, terms: string[]): boolean {
  return terms.some((term) => value.includes(term));
}

export function classifyMail(message: ClassifiableMessage): AutoCategory | null {
  const subject = message.subject.toLowerCase();
  const senderName = (message.fromName ?? "").toLowerCase();
  const sender = (message.fromAddress ?? "").toLowerCase();
  const localPart = sender.split("@")[0] ?? "";
  const domain = sender.split("@")[1] ?? "";
  const body = `${message.snippet} ${message.textBody ?? ""}`.toLowerCase().slice(0, 20_000);
  const combined = `${subject} ${senderName} ${body}`;
  const automated = /(^|[._-])(no-?reply|newsletter|news|notify|notification|updates?|marketing|promo|alerts?)([._-]|$)/i.test(localPart);

  let subscription = automated ? 3 : 0;
  let work = 0;
  let personal = 0;

  if (matches(subject, ["newsletter", "digest", "weekly", "daily brief", "suggested", "推荐", "简报", "周报", "月报", "促销", "优惠", "折扣", "last chance", "限时", "活动通知"])) subscription += 3;
  if (matches(combined, ["unsubscribe", "manage preferences", "email preferences", "取消订阅", "退订", "不再接收"])) subscription += 5;
  if (matches(senderName, ["newsletter", "news", "updates", "notifications", "营销", "资讯", "快讯"])) subscription += 2;

  if (matches(subject, ["meeting", "project", "proposal", "contract", "invoice", "report", "deadline", "interview", "application", "review", "schedule", "会议", "项目", "合同", "发票", "报告", "截止", "面试", "申请", "评审", "排期", "报价"])) work += 4;
  if (matches(body, ["meeting agenda", "project update", "action items", "purchase order", "会议纪要", "项目进度", "工作安排", "请审批", "待办事项"])) work += 3;
  if (domain && !publicMailDomains.has(domain) && !automated) work += 1;

  if (!automated && publicMailDomains.has(domain)) personal += 2;
  if (matches(subject, ["happy birthday", "birthday", "invitation", "photos", "family", "travel", "聚会", "生日", "邀请", "照片", "家人", "旅行", "问候"])) personal += 4;
  if (matches(body.slice(0, 600), ["dear ", "hi ", "hello ", "亲爱的", "你好", "嗨，"])) personal += 1;

  const scores: Array<[AutoCategory, number]> = [["订阅", subscription], ["工作", work], ["个人", personal]];
  scores.sort((left, right) => right[1] - left[1]);
  const [category, score] = scores[0]!;
  return score >= 4 ? category : null;
}
