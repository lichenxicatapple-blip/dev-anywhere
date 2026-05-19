export type BailianRegion = "cn" | "intl";

const BAILIAN_HOSTS: Record<BailianRegion, string> = {
  cn: "wss://dashscope.aliyuncs.com",
  intl: "wss://dashscope-intl.aliyuncs.com",
};

export function bailianRealtimeUrl(region: BailianRegion, model?: string): string {
  const url = `${BAILIAN_HOSTS[region]}/api-ws/v1/realtime`;
  return model ? `${url}?model=${encodeURIComponent(model)}` : url;
}

export function bailianInferenceUrl(region: BailianRegion): string {
  return `${BAILIAN_HOSTS[region]}/api-ws/v1/inference`;
}
