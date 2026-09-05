import { ensureService } from "#src/terminal/serve-bootstrap.js";
import { SERVICE_CONTROL_PATH } from "#src/common/paths.js";
import { requestServiceControl } from "#src/common/service-control.js";

const intentIndex = process.argv.indexOf("--intent");
const intent = intentIndex >= 0 ? process.argv[intentIndex + 1] : "initial";
if (intent !== "initial" && intent !== "reconnect") throw new Error("Invalid fixture intent");

const socket = await ensureService(intent);
socket.destroy();
const service = await requestServiceControl(SERVICE_CONTROL_PATH, "status");
if (service?.state !== "ready") throw new Error("Connected service is not ready");
process.stdout.write(
  `${JSON.stringify({ connected: true, pid: service.pid, instanceId: service.instanceId })}\n`,
);
