export default defineAppConfig({
  pages: [
    "pages/proxy-select/index",
    "pages/session-list/index",
    "pages/chat/index",
  ],
  window: {
    navigationBarTextStyle: "white",
    navigationBarTitleText: "CC Anywhere",
    navigationBarBackgroundColor: "#1A1A2E",
    backgroundColor: "#1A1A2E",
    pageOrientation: "auto",
  },
  // @ts-expect-error ext 是飞书小程序特有配置，Taro AppConfig 类型未收录
  ext: {
    defaultPages: {
      PCMode: "appCenter",
    },
  },
});
