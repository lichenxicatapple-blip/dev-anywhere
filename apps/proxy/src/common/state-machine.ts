// 有限状态机 helper
//
// 提供显式转换表的小型 FSM，区分两类调用模式：
// - transitionTo(throw)：同步确定性流程里调用，非法转移代表 bug，立即暴露
// - tryTransitionTo(bool)：异步事件回调里调用，非法转移可能是吸收态残余事件，调用方按
//   isInAbsorbingState() 分级日志
//
// 吸收态采用传递闭包定义：终态（transitions=[]）或所有出边都指向吸收态的状态都算吸收。
// 这样 SessionState.ERROR (→[TERMINATED]) 和 RelayConnectionState.CLOSED ([]) 都被
// 自动识别为吸收态，不用在 caller 里硬编码状态名。
//
// onTransition/onRejected 仅做日志/观测，不应 throw。

interface FSMDef<S extends string> {
  initial: S;
  // from-state → 允许转入的 to-state 列表；终态对应空数组
  transitions: Record<S, readonly S[]>;
  // 合法转换发生后触发，典型用法是结构化日志
  onTransition?: (from: S, to: S) => void;
  // tryTransitionTo 非法转移时触发；isAbsorbing 指示 from 是否吸收态（晚到残余 vs. 真非法）
  onRejected?: (from: S, to: S, isAbsorbing: boolean) => void;
}

interface FSM<S extends string> {
  current(): S;
  is(state: S): boolean;
  isIn(states: readonly S[]): boolean;
  canTransitionTo(to: S): boolean;
  // 非法转换抛 Error；同步流程里当 assert 用
  transitionTo(to: S): void;
  // 非法转换返回 false，不抛；异步回调里用，配合 isInAbsorbingState 分级日志
  tryTransitionTo(to: S): boolean;
  // 当前是否在吸收态（传递闭包）
  isInAbsorbingState(): boolean;
}

// 计算吸收态集合：终态 + 所有出边都指向吸收态的状态，迭代至不动点
function computeAbsorbingSet<S extends string>(transitions: Record<S, readonly S[]>): Set<S> {
  const absorbing = new Set<S>();
  const entries = Object.entries(transitions) as Array<[S, readonly S[]]>;
  for (const [s, outs] of entries) {
    if (outs.length === 0) absorbing.add(s);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [s, outs] of entries) {
      if (absorbing.has(s)) continue;
      if (outs.length > 0 && outs.every((t) => absorbing.has(t))) {
        absorbing.add(s);
        changed = true;
      }
    }
  }
  return absorbing;
}

export function createFSM<S extends string>(def: FSMDef<S>): FSM<S> {
  let state = def.initial;
  const absorbing = computeAbsorbingSet(def.transitions);
  const tryTransitionTo = (to: S): boolean => {
    const allowed = def.transitions[state];
    if (!allowed?.includes(to)) {
      def.onRejected?.(state, to, absorbing.has(state));
      return false;
    }
    const from = state;
    state = to;
    def.onTransition?.(from, to);
    return true;
  };
  return {
    current: () => state,
    is: (s) => state === s,
    isIn: (ss) => ss.includes(state),
    canTransitionTo: (to) => def.transitions[state]?.includes(to) ?? false,
    transitionTo: (to) => {
      if (!tryTransitionTo(to)) {
        throw new Error(`Invalid FSM transition: ${state} -> ${to}`);
      }
    },
    tryTransitionTo,
    isInAbsorbingState: () => absorbing.has(state),
  };
}

// 无内部 state 的 FSM 视图，供 state 存在外部（如 SessionInfo、DB 行）的 per-instance 场景使用。
// 调用方自行传入 from，canTransition 校验；吸收态判定通过 isAbsorbing(state) 提供。
interface StatelessFSM<S extends string> {
  canTransition(from: S, to: S): boolean;
  isAbsorbing(state: S): boolean;
}

export function defineFSM<S extends string>(transitions: Record<S, readonly S[]>): StatelessFSM<S> {
  const absorbing = computeAbsorbingSet(transitions);
  return {
    canTransition: (from, to) => transitions[from]?.includes(to) ?? false,
    isAbsorbing: (state) => absorbing.has(state),
  };
}
