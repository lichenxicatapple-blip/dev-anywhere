import { ControlErrorCode, type RelayControlMessage } from "@dev-anywhere/shared";
import type { Logger } from "@dev-anywhere/shared/logger";
import type { WebSocket } from "ws";
import type { VoiceConfigStore } from "./config-store.js";
import { mergeVoiceConfigForTest } from "./config-test.js";
import type { VoiceProviderRegistry } from "./provider.js";

export function handleVoiceConfigControl(
  msg: RelayControlMessage,
  ws: WebSocket,
  store: VoiceConfigStore,
  logger: Logger,
  providers?: VoiceProviderRegistry,
): boolean {
  if (msg.type === "voice_config_request") {
    ws.send(
      JSON.stringify({
        type: "voice_config_response",
        requestId: msg.requestId,
        config: store.read(),
      }),
    );
    return true;
  }

  if (msg.type === "voice_config_update") {
    try {
      const config = store.update(msg.config);
      ws.send(
        JSON.stringify({
          type: "voice_config_update_response",
          requestId: msg.requestId,
          success: true,
          config,
        }),
      );
    } catch (err) {
      logger.warn({ err }, "Voice config update failed");
      ws.send(
        JSON.stringify({
          type: "voice_config_update_response",
          requestId: msg.requestId,
          success: false,
          errorCode: ControlErrorCode.UNKNOWN,
          error: err instanceof Error ? err.message : "Voice config update failed",
        }),
      );
    }
    return true;
  }

  if (msg.type === "voice_capabilities_request") {
    if (!providers) {
      ws.send(
        JSON.stringify({
          type: "voice_capabilities_response",
          requestId: msg.requestId,
          errorCode: ControlErrorCode.UNKNOWN,
          error: "Voice capabilities provider is not available",
        }),
      );
      return true;
    }

    const config = { ...store.readSecret(), ...(msg.region ? { region: msg.region } : {}) };
    let provider;
    try {
      provider = providers.current(config);
    } catch (err) {
      logger.warn({ err }, "Voice capabilities provider resolution failed");
      ws.send(
        JSON.stringify({
          type: "voice_capabilities_response",
          requestId: msg.requestId,
          errorCode: ControlErrorCode.UNKNOWN,
          error: err instanceof Error ? err.message : "Voice capabilities request failed",
        }),
      );
      return true;
    }

    void provider
      .readCapabilities(config)
      .then((capabilities) => {
        ws.send(
          JSON.stringify({
            type: "voice_capabilities_response",
            requestId: msg.requestId,
            capabilities,
          }),
        );
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "Voice capabilities request failed");
        ws.send(
          JSON.stringify({
            type: "voice_capabilities_response",
            requestId: msg.requestId,
            errorCode: ControlErrorCode.UNKNOWN,
            error: err instanceof Error ? err.message : "Voice capabilities request failed",
          }),
        );
      });
    return true;
  }

  if (msg.type === "voice_config_test") {
    if (!providers) {
      ws.send(
        JSON.stringify({
          type: "voice_config_test_response",
          requestId: msg.requestId,
          success: false,
          errorCode: ControlErrorCode.UNKNOWN,
          error: "Voice config tester is not available",
        }),
      );
      return true;
    }

    const testConfig = mergeVoiceConfigForTest(store.readSecret(), msg.config);
    let provider;
    try {
      provider = providers.current(testConfig);
    } catch (err) {
      logger.warn({ err }, "Voice config test provider resolution failed");
      ws.send(
        JSON.stringify({
          type: "voice_config_test_response",
          requestId: msg.requestId,
          success: false,
          errorCode: ControlErrorCode.UNKNOWN,
          error: err instanceof Error ? err.message : "Voice config test failed",
        }),
      );
      return true;
    }

    void provider
      .testConfig(testConfig)
      .then((result) => {
        ws.send(
          JSON.stringify({
            type: "voice_config_test_response",
            requestId: msg.requestId,
            success: true,
            ...(result.audio ? { audioBase64: result.audio.toString("base64") } : {}),
            ...(result.sampleRate ? { audioSampleRate: result.sampleRate } : {}),
            ...(result.audio ? { audioEncoding: "pcm_s16le" } : {}),
            ...(result.transcript ? { transcript: result.transcript } : {}),
          }),
        );
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "Voice config test failed");
        ws.send(
          JSON.stringify({
            type: "voice_config_test_response",
            requestId: msg.requestId,
            success: false,
            errorCode: ControlErrorCode.UNKNOWN,
            error: err instanceof Error ? err.message : "Voice config test failed",
          }),
        );
      });
    return true;
  }

  return false;
}
