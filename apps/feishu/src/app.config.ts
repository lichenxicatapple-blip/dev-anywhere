export default defineAppConfig({
  pages: [
    "pages/proxy-select/index",
    "pages/session-list/index",
    "pages/chat/index",
    "pages/index/index",
  ],
  window: {
    navigationBarTextStyle: "black",
    navigationBarTitleText: "CC Anywhere",
    navigationBarBackgroundColor: "#F8F8F8",
    backgroundColor: "#F8F8F8",
    pageOrientation: "auto",
  },
  // @ts-expect-error ext 是飞书小程序特有配置，Taro AppConfig 类型未收录
  ext: {
    defaultPages: {
      PCMode: "appCenter",
    },
  },
});
