import { describe, expect, it } from "vitest";
import {
  classifyClientRegistrationProtocol,
  inspectClientRegistrationAdmission,
} from "#src/client-registration-admission.js";
import { RELAY_CONTROL_PROTOCOL_VERSION, RelayProtocolRejectReason } from "@dev-anywhere/shared";

describe("client registration admission", () => {
  it("separates an unversioned registration from the versioned business schema", () => {
    expect(
      inspectClientRegistrationAdmission(
        JSON.stringify({ type: "client_register", clientId: "client-old" }),
      ),
    ).toEqual({ kind: "unversioned_client_registration", clientId: "client-old" });
  });

  it("recognizes a registration whose JSON type uses a valid unicode escape", () => {
    expect(
      inspectClientRegistrationAdmission(
        '{"type":"client\\u005fregister","clientId":"client-escaped"}',
      ),
    ).toEqual({
      kind: "unversioned_client_registration",
      clientId: "client-escaped",
    });
  });

  it.each([0, 1, 2, null])("preserves an explicit protocol version candidate %s", (version) => {
    expect(
      inspectClientRegistrationAdmission(
        JSON.stringify({
          type: "client_register",
          protocolVersion: version,
          clientId: "client-versioned",
        }),
      ),
    ).toEqual({
      kind: "versioned_client_registration",
      clientId: "client-versioned",
      protocolVersion: version,
    });
  });

  it.each(["not-json", JSON.stringify({ type: "proxy_register" }), JSON.stringify(null)])(
    "does not treat %s as client registration admission",
    (raw) => {
      expect(inspectClientRegistrationAdmission(raw)).toEqual({
        kind: "not_client_registration",
      });
    },
  );

  it("classifies both update directions independently of the current version value", () => {
    expect(classifyClientRegistrationProtocol(1, 2)).toBe(RelayProtocolRejectReason.PAGE_OUTDATED);
    expect(classifyClientRegistrationProtocol(2, 1)).toBe(
      RelayProtocolRejectReason.SERVICE_OUTDATED,
    );
    expect(
      classifyClientRegistrationProtocol(
        RELAY_CONTROL_PROTOCOL_VERSION,
        RELAY_CONTROL_PROTOCOL_VERSION,
      ),
    ).toBeNull();
  });

  it.each([0, -1, 1.5, "1", null])(
    "treats invalid protocol candidate %s as a generic mismatch",
    (candidate) => {
      expect(classifyClientRegistrationProtocol(candidate)).toBe(
        RelayProtocolRejectReason.PROTOCOL_MISMATCH,
      );
    },
  );
});
