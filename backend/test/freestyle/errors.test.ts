import { describe, expect, test } from "bun:test";
import { FreestyleApiError } from "freestyle";
import { toIntegrationError } from "../../src/integrations/freestyle/errors.ts";

const api = (status: number, code: string) => new FreestyleApiError(status, { code, message: "vendor prose" }, "/v5/vms");

describe("toIntegrationError", () => {
  test("a plan limit is a final rejection that says so, not an outage", () => {
    const error = toIntegrationError(api(429, "LIMIT_EXCEEDED"), "Create VM");
    expect(error).toMatchObject({ kind: "dependency_rejected", retryable: false });
    expect(error.message).toBe("Create VM: the Freestyle plan limit is reached. Remove an unused environment or raise the plan's limit.");
    expect(error.message).not.toContain("vendor prose");
  });

  test("any other 429 is still a temporary outage", () => {
    expect(toIntegrationError(api(429, "RATE_LIMITED"), "Create VM")).toMatchObject({ kind: "dependency_unavailable", retryable: true });
  });

  test("status mapping", () => {
    expect(toIntegrationError(api(404, "NOT_FOUND"), "a")).toMatchObject({ kind: "not_found", retryable: false });
    expect(toIntegrationError(api(409, "CONFLICT"), "a")).toMatchObject({ kind: "conflict", retryable: true });
    expect(toIntegrationError(api(401, "UNAUTHORIZED"), "a")).toMatchObject({ kind: "dependency_rejected", retryable: false });
    expect(toIntegrationError(api(503, "UNAVAILABLE"), "a")).toMatchObject({ kind: "dependency_unavailable", retryable: true });
    expect(toIntegrationError(api(400, "BAD_REQUEST"), "a")).toMatchObject({ kind: "invalid_input", retryable: false });
  });
});
