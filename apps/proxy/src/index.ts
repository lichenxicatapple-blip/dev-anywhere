import { Command } from "commander";
import { startClient } from "./client.js";
import { startService } from "./serve.js";

const program = new Command();

program
  .name("cc-anywhere")
  .description("CC Anywhere - transparent Claude Code proxy with remote control")
  .version("0.0.0");

program
  .command("serve")
  .description("Start the cc-anywhere service daemon")
  .action(async () => {
    await startService();
  });

// 默认命令：以客户端模式运行，所有未识别参数透传给 claude
program
  .argument("[args...]", "Arguments passed to claude")
  .passThroughOptions()
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (args: string[]) => {
    await startClient(args);
  });

program.parse();
