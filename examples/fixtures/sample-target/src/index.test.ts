import { expect, test } from "bun:test";

import { hello } from "./index.ts";

test("hello returns the baseline greeting", () => {
  expect(hello()).toBe("hello");
});
