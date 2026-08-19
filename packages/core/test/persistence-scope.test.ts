import { describe, expect, test } from "bun:test"
import { RequestScope } from "@opencode-ai/core/persistence/scope"

const requestId = "018f47a0-7b5e-7c3a-8d9f-0123456789ab"
const runId = "018f47a0-7b5e-7c3a-8d9f-abcdef012345"

describe("RequestScope", () => {
  test("decodes trusted persistence headers", () => {
    expect(
      RequestScope.decode(
        new Headers({
          "x-opencode-user-id": "user-1",
          "x-opencode-owner-generation": "12",
          "x-request-id": requestId,
          "x-opencode-run-id": runId,
        }),
      ),
    ).toEqual({ userId: "user-1", generation: 12n, requestId, runId })
  })

  test.each([
    ["x-opencode-user-id", ""],
    ["x-opencode-owner-generation", "0"],
    ["x-opencode-owner-generation", "1.5"],
    ["x-request-id", "not-a-uuid"],
    ["x-opencode-run-id", "not-a-uuid"],
  ])("rejects invalid %s", (header, value) => {
    const headers = new Headers({
      "x-opencode-user-id": "user-1",
      "x-opencode-owner-generation": "12",
      "x-request-id": requestId,
      "x-opencode-run-id": runId,
    })
    headers.set(header, value)
    expect(() => RequestScope.decode(headers)).toThrow(RequestScope.InvalidError)
  })
})
