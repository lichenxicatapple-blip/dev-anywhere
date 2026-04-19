// 品牌打字机动画
// 状态机: typing -> paused -> deleting -> waiting -> typing(下一条)
import { useEffect, useRef, useState } from "react";

const PAUSE_AFTER_TYPE = 1500;
const PAUSE_AFTER_DELETE = 300;
const TYPE_SPEED = 70;
const DELETE_SPEED = 35;

interface TypewriterProps {
  texts: string[];
  className?: string;
}

export function Typewriter({ texts, className }: TypewriterProps) {
  const [displayed, setDisplayed] = useState("");
  const [cursorOn, setCursorOn] = useState(true);
  const phase = useRef<"typing" | "paused" | "deleting" | "waiting">("typing");
  const charIdx = useRef(0);
  const textIdx = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setCursorOn((v) => !v), 530);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const current = () => texts[textIdx.current % texts.length];

    const tick = () => {
      const p = phase.current;
      if (p === "typing") {
        const t = current();
        if (charIdx.current < t.length) {
          charIdx.current += 1;
          setDisplayed(t.slice(0, charIdx.current));
          timer = setTimeout(tick, TYPE_SPEED);
        } else {
          phase.current = "paused";
          timer = setTimeout(tick, PAUSE_AFTER_TYPE);
        }
      } else if (p === "paused") {
        phase.current = "deleting";
        timer = setTimeout(tick, DELETE_SPEED);
      } else if (p === "deleting") {
        if (charIdx.current > 0) {
          charIdx.current -= 1;
          setDisplayed(current().slice(0, charIdx.current));
          timer = setTimeout(tick, DELETE_SPEED);
        } else {
          textIdx.current += 1;
          phase.current = "waiting";
          timer = setTimeout(tick, PAUSE_AFTER_DELETE);
        }
      } else {
        phase.current = "typing";
        timer = setTimeout(tick, TYPE_SPEED);
      }
    };

    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [texts]);

  return (
    <div
      className={`font-mono text-2xl md:text-3xl font-bold leading-tight select-none ${className ?? ""}`}
      data-slot="brand-typewriter"
    >
      <span className="text-green-500">&gt; </span>
      <span className="text-foreground/90">{displayed}</span>
      <span className={`text-primary ${cursorOn ? "opacity-100" : "opacity-0"}`}>_</span>
    </div>
  );
}
