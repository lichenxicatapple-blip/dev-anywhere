import { describe, expect, it } from "vitest";
import { proxyRemovalDescription } from "./proxy-removal-dialog";

describe("proxyRemovalDescription", () => {
  it("makes removal and future reconnection semantics explicit", () => {
    const copy = proxyRemovalDescription({ proxyId: "proxy-1", name: "旧 Mac" });

    expect(copy).toContain("只会从当前 Relay 的开发机列表中移除");
    expect(copy).toContain("不会删除机器上的文件或会话");
    expect(copy).toContain("不会阻止它再次连接");
    expect(copy).toContain("重新运行时，它会重新出现在列表中");
  });
});
