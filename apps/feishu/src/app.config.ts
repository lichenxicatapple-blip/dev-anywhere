export default defineAppConfig({
  pages: [
    "pages/proxy-select/index",
    "pages/session-list/index",
    "pages/chat/index",
    "pages/spike-hub/index",
    "pages/spike-typewriter/index",
    "pages/spike-session-list/index",
    "pages/spike-chat-json/index",
    "pages/spike-chat-pty/index",
    "pages/spike-bubble-anim/index",

    "pages/spike-picker/index",
    "pages/index/index",
  ],
  window: {
    navigationBarTextStyle: "black",
    navigationBarTitleText: "CC Anywhere",
    navigationBarBackgroundColor: "#F8F8F8",
    backgroundColor: "#F8F8F8",
    pageOrientation: "auto",
  },
  ext: {
    defaultPages: {
      PCMode: "appCenter",
    },
  },
});
