export interface ChatActivityTextDetail {
  kind?: "text";
  title: string;
  content: string;
}

export interface ChatActivityDiffDetail {
  kind: "diff";
  title: string;
  content: string;
  oldContent: string;
  newContent: string;
}

export type ChatActivityDetail = ChatActivityTextDetail | ChatActivityDiffDetail;

export function isDiffActivityDetail(detail: ChatActivityDetail): detail is ChatActivityDiffDetail {
  return detail.kind === "diff";
}
