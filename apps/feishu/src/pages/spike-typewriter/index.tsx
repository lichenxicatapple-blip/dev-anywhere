import { useState, useEffect, useRef, useCallback } from "react";
import { View, Text } from "@tarojs/components";
import "./index.css";

const BRAND_TEXT = "CC Anywhere";
// 打完之后停留的时间
const PAUSE_AFTER_TYPE = 1500;
// 擦除完之后停留的时间
const PAUSE_AFTER_DELETE = 300;
// 打字速度
const TYPE_SPEED = 70;
// 擦除速度（比打字快）
const DELETE_SPEED = 35;

// 方案 1: 基础打字机循环
function TypewriterBasic() {
  const [displayed, setDisplayed] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);
  const phase = useRef<"typing" | "paused" | "deleting" | "waiting">("typing");
  const idx = useRef(0);

  useEffect(() => {
    // 光标闪烁
    const cursorTimer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(cursorTimer);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (phase.current === "typing") {
        if (idx.current < BRAND_TEXT.length) {
          idx.current++;
          setDisplayed(BRAND_TEXT.slice(0, idx.current));
          timer = setTimeout(tick, TYPE_SPEED);
        } else {
          phase.current = "paused";
          timer = setTimeout(tick, PAUSE_AFTER_TYPE);
        }
      } else if (phase.current === "paused") {
        phase.current = "deleting";
        timer = setTimeout(tick, DELETE_SPEED);
      } else if (phase.current === "deleting") {
        if (idx.current > 0) {
          idx.current--;
          setDisplayed(BRAND_TEXT.slice(0, idx.current));
          timer = setTimeout(tick, DELETE_SPEED);
        } else {
          phase.current = "waiting";
          timer = setTimeout(tick, PAUSE_AFTER_DELETE);
        }
      } else if (phase.current === "waiting") {
        phase.current = "typing";
        timer = setTimeout(tick, TYPE_SPEED);
      }
    };

    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View className="typewriter-container">
      <Text className="typewriter-prefix">{">"} </Text>
      <Text className="typewriter-text">{displayed}</Text>
      <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
    </View>
  );
}

// 方案 2: 多文本轮播打字机
const ROTATING_TEXTS = [
  "CC Anywhere",
  "/untethered @anytime",
];

function TypewriterRotating() {
  const [displayed, setDisplayed] = useState("");
  const [cursorVisible, setCursorVisible] = useState(true);
  const phase = useRef<"typing" | "paused" | "deleting" | "waiting">("typing");
  const charIdx = useRef(0);
  const textIdx = useRef(0);

  useEffect(() => {
    const cursorTimer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(cursorTimer);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const currentText = () => ROTATING_TEXTS[textIdx.current % ROTATING_TEXTS.length];

    const tick = () => {
      if (phase.current === "typing") {
        const text = currentText();
        if (charIdx.current < text.length) {
          charIdx.current++;
          setDisplayed(text.slice(0, charIdx.current));
          timer = setTimeout(tick, TYPE_SPEED);
        } else {
          phase.current = "paused";
          timer = setTimeout(tick, PAUSE_AFTER_TYPE);
        }
      } else if (phase.current === "paused") {
        phase.current = "deleting";
        timer = setTimeout(tick, DELETE_SPEED);
      } else if (phase.current === "deleting") {
        if (charIdx.current > 0) {
          charIdx.current--;
          setDisplayed(currentText().slice(0, charIdx.current));
          timer = setTimeout(tick, DELETE_SPEED);
        } else {
          textIdx.current++;
          phase.current = "waiting";
          timer = setTimeout(tick, PAUSE_AFTER_DELETE);
        }
      } else if (phase.current === "waiting") {
        phase.current = "typing";
        timer = setTimeout(tick, TYPE_SPEED);
      }
    };

    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View className="typewriter-container">
      <Text className="typewriter-prefix">{">"} </Text>
      <Text className="typewriter-text">{displayed}</Text>
      <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
    </View>
  );
}

// 方案 3: 终端风格品牌区域
function TerminalBrand() {
  const [line1, setLine1] = useState("");
  const [line2Visible, setLine2Visible] = useState(false);
  const [line3Visible, setLine3Visible] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorVisible, setCursorVisible] = useState(true);
  const idx = useRef(0);

  const LINE1_TEXT = "CC Anywhere v1.0";

  useEffect(() => {
    const cursorTimer = setInterval(() => {
      setCursorVisible((v) => !v);
    }, 530);
    return () => clearInterval(cursorTimer);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (idx.current < LINE1_TEXT.length) {
        idx.current++;
        setLine1(LINE1_TEXT.slice(0, idx.current));
        timer = setTimeout(tick, TYPE_SPEED);
      } else if (!line2Visible) {
        setCursorLine(2);
        setLine2Visible(true);
        timer = setTimeout(() => {
          setCursorLine(3);
          setLine3Visible(true);
        }, 600);
      }
    };

    timer = setTimeout(tick, 800);
    return () => clearTimeout(timer);
  }, [line2Visible]);

  return (
    <View className="terminal-brand">
      <View className="terminal-line">
        <Text className="terminal-prompt">$ </Text>
        <Text className="terminal-typed">{line1}</Text>
        {cursorLine === 1 && (
          <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
        )}
      </View>
      {line2Visible && (
        <View className="terminal-line fade-in">
          <Text className="terminal-info">Claude Code on your phone.</Text>
          {cursorLine === 2 && (
            <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
          )}
        </View>
      )}
      {line3Visible && (
        <View className="terminal-line fade-in">
          <Text className="terminal-prompt">$ </Text>
          <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
        </View>
      )}
    </View>
  );
}

type SchemeType = "basic" | "rotating" | "terminal";

export default function SpikeTypewriter() {
  const [scheme, setScheme] = useState<SchemeType>("basic");
  // 强制重新挂载组件的 key
  const [mountKey, setMountKey] = useState(0);

  const switchScheme = useCallback((s: SchemeType) => {
    setScheme(s);
    setMountKey((k) => k + 1);
  }, []);

  return (
    <View className="page">
      {/* 方案切换 */}
      <View className="scheme-row">
        {(["basic", "rotating", "terminal"] as const).map((s) => (
          <View
            key={s}
            className={`scheme-btn ${scheme === s ? "active" : ""}`}
            onClick={() => switchScheme(s)}
          >
            <Text className="scheme-btn-text">
              {s === "basic" ? "Basic Loop" : s === "rotating" ? "Multi-text" : "Terminal"}
            </Text>
          </View>
        ))}
      </View>

      {/* 垂直居中的主内容区 */}
      <View className="main-content">
        {/* 品牌展示区 */}
        <View className="brand-area" key={mountKey}>
          {scheme === "basic" && <TypewriterBasic />}
          {scheme === "rotating" && <TypewriterRotating />}
          {scheme === "terminal" && <TerminalBrand />}
        </View>

        {/* 模拟 proxy 列表 */}
        <View className="mock-list">
          <Text className="section-title">Proxies</Text>
          <View className="mock-item">
            <View className="dot online" />
            <Text className="item-name">MacBook-Pro</Text>
            <Text className="item-status">online</Text>
          </View>
          <View className="mock-item">
            <View className="dot offline" />
            <Text className="item-name">Office-Desktop</Text>
            <Text className="item-status">offline</Text>
          </View>
          <View className="mock-item">
            <View className="dot online" />
            <Text className="item-name">Home-Server</Text>
            <Text className="item-status">online</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
