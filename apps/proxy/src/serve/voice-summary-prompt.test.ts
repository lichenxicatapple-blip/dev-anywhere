import { describe, expect, it } from "vitest";
import { buildVoiceSummaryPrompt } from "./voice-summary-prompt.js";

describe("buildVoiceSummaryPrompt", () => {
  it("keeps approval summaries concise and parameter-informed without risk judgments", () => {
    const prompt = buildVoiceSummaryPrompt({
      reason: "approval",
      text: 'toolName: WebSearch\ninput: {"query":"Web Speech API docs"}',
    });

    expect(prompt).toContain("Keep it under 100 Chinese characters");
    expect(prompt).toContain("Use the parameters to infer the key target");
    expect(prompt).toContain("Prefer concrete names from the request");
    expect(prompt).toContain("Do not say generic phrases like 项目配置文件");
    expect(prompt).toContain("For search requests, include the query topic");
    expect(prompt).toContain("For file requests, include the concrete file name");
    expect(prompt).toContain("Mention up to two key parameters");
    expect(prompt).toContain("Do not evaluate risk or safety");
    expect(prompt).not.toContain("relevant risk");
  });
});
