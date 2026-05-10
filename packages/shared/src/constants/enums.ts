// 协议层共用的枚举字面量集合。Zod schema、TypeScript 类型、运行时常量都从这里派生，
// 避免在 relay-control / session / chat / web 各自手写 z.enum(["claude", "codex"]) 漂移。

export const providerValues = ["claude", "codex"] as const;
export type ProviderId = (typeof providerValues)[number];

export const ptyOwnerValues = ["local-terminal", "proxy-hosted"] as const;
export type PtyOwner = (typeof ptyOwnerValues)[number];

export const sessionModeValues = ["pty", "json"] as const;
export type SessionMode = (typeof sessionModeValues)[number];
