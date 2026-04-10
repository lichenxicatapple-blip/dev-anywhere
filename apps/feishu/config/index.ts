// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const config = {
  projectName: "cc-anywhere-feishu",
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    375: 2,
    828: 1.81 / 2,
  },
  sourceRoot: "src",
  outputRoot: "dist",
  plugins: ["@tarojs/plugin-platform-lark"],
  framework: "react",
  compiler: "webpack5",
  alias: {
    "@": path.resolve(__dirname, "..", "src"),
  },
  defineConstants: {
    RELAY_URL: JSON.stringify(process.env.RELAY_URL || "ws://localhost:3000/client"),
  },
  mini: {
    postcss: {
      pxtransform: {
        enable: true,
      },
    },
  },
};

module.exports = function (merge: unknown) {
  if (typeof merge === "function") {
    return merge({}, config);
  }
  return config;
};
