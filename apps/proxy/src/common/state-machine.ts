// 有限状态机 helper
//
// 提供显式转换表 + 非法转换 throw 的小型 FSM。为可观测、可校验的状态变迁提供基建，
// 避免各处裸赋值导致的无效转换悄无声息地通过。
//
// onTransition 仅做日志/观测，不应 throw；如果抛异常会破坏状态机一致性调用方需自己保证。

interface FSMDef<S extends string> {
  initial: S;
  // from-state → 允许转入的 to-state 列表；终态对应空数组
  transitions: Record<S, readonly S[]>;
  // 合法转换发生后触发，典型用法是结构化日志
  onTransition?: (from: S, to: S) => void;
}

interface FSM<S extends string> {
  current(): S;
  is(state: S): boolean;
  isIn(states: readonly S[]): boolean;
  canTransitionTo(to: S): boolean;
  // 非法转换抛 Error，调用方负责只在合法路径调用
  transitionTo(to: S): void;
}

export function createFSM<S extends string>(def: FSMDef<S>): FSM<S> {
  let state = def.initial;
  return {
    current: () => state,
    is: (s) => state === s,
    isIn: (ss) => ss.includes(state),
    canTransitionTo: (to) => def.transitions[state]?.includes(to) ?? false,
    transitionTo: (to) => {
      const allowed = def.transitions[state];
      if (!allowed?.includes(to)) {
        throw new Error(`Invalid FSM transition: ${state} -> ${to}`);
      }
      const from = state;
      state = to;
      def.onTransition?.(from, to);
    },
  };
}
