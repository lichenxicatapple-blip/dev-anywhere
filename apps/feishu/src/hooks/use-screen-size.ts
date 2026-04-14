// 响应式视口检测 hook，通过 Taro.onWindowResize 实时跟踪屏幕尺寸变化
import Taro from "@tarojs/taro";
import { useState, useEffect } from "react";

export type ScreenCategory = "phone-portrait" | "phone-landscape" | "desktop";

export const BREAKPOINT_LANDSCAPE = 500;
export const BREAKPOINT_DESKTOP = 860;

// 纯函数，根据窗口宽度分类屏幕类型，方便测试
export function classifyScreen(
  windowWidth: number,
  _windowHeight: number,
  _deviceType: string,
): ScreenCategory {
  if (windowWidth >= BREAKPOINT_DESKTOP) return "desktop";
  if (windowWidth >= BREAKPOINT_LANDSCAPE) return "phone-landscape";
  return "phone-portrait";
}

// 返回对应的 CSS 类名，用于 class-based 响应式切换
export function getResponsiveClass(category: ScreenCategory): string {
  switch (category) {
    case "phone-portrait":
      return "screen-portrait";
    case "phone-landscape":
      return "screen-landscape";
    case "desktop":
      return "screen-desktop";
  }
}

export interface ScreenInfo {
  category: ScreenCategory;
  className: string;
  windowWidth: number;
  windowHeight: number;
  deviceType: string;
  statusBarHeight: number;
  safeArea: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
}

// React hook，订阅 Taro.onWindowResize 实现实时跟踪
export function useScreenSize(): ScreenInfo {
  let info: Record<string, unknown> = {};
  try {
    info = (Taro.getSystemInfoSync() as unknown as Record<string, unknown>) || {};
  } catch {
    // H5 直接刷新深层路由时 Taro 可能未完全初始化
  }
  const w = (info.windowWidth as number) || window?.innerWidth || 390;
  const h = (info.windowHeight as number) || window?.innerHeight || 844;
  const [size, setSize] = useState({
    windowWidth: w,
    windowHeight: h,
    deviceType: (info.deviceType as string) || "phone",
    statusBarHeight: (info.statusBarHeight as number) || 0,
    safeArea: (info.safeArea as ScreenInfo["safeArea"]) || {
      top: 0,
      bottom: h,
      left: 0,
      right: w,
      width: w,
      height: h,
    },
  });

  useEffect(() => {
    const handler: Taro.onWindowResize.Callback = (res) => {
      setSize((prev) => ({
        ...prev,
        windowWidth: res.size.windowWidth,
        windowHeight: res.size.windowHeight,
      }));
    };
    Taro.onWindowResize(handler);
    // @ts-expect-error offWindowResize 接受的 Callback 参数类型比 onWindowResize 宽泛，传入同一引用会报类型不兼容
    return () => Taro.offWindowResize(handler);
  }, []);

  const category = classifyScreen(size.windowWidth, size.windowHeight, size.deviceType);
  return {
    category,
    className: getResponsiveClass(category),
    windowWidth: size.windowWidth,
    windowHeight: size.windowHeight,
    deviceType: size.deviceType,
    statusBarHeight: size.statusBarHeight,
    safeArea: size.safeArea,
  };
}
