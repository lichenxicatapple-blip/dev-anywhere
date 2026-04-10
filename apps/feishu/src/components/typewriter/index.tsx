// 品牌打字机动画，多文本轮播：打字 -> 停留 -> 擦除 -> 停留 -> 下一条
import { useState, useEffect, useRef } from "react";
import { View, Text } from "@tarojs/components";
import "./index.css";

const PAUSE_AFTER_TYPE = 1500;
const PAUSE_AFTER_DELETE = 300;
const TYPE_SPEED = 70;
const DELETE_SPEED = 35;

interface TypewriterProps {
  texts: string[];
}

export function Typewriter({ texts }: TypewriterProps) {
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

    const currentText = () => texts[textIdx.current % texts.length];

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
  }, [texts]);

  return (
    <View className="typewriter-container">
      <Text className="typewriter-prefix">{">"} </Text>
      <Text className="typewriter-text">{displayed}</Text>
      <Text className={`typewriter-cursor ${cursorVisible ? "visible" : "hidden"}`}>_</Text>
    </View>
  );
}
