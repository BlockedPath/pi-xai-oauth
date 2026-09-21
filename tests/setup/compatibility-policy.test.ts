import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import policy from "../../compatibility/pi-versions.json";

const require = createRequire(import.meta.url);
type RangePolicy = {
  peerRange: string;
  minimum: string;
  latest: string;
  unsupported: { older: string; upper: string; excluded?: string[] };
};
const { parsePeerRange, satisfiesPeerRange, verifyRangePolicy } = require("../../scripts/verify-compatibility.js") as {
  parsePeerRange(range: string): Array<{ minimum: string; upper: string }>;
  satisfiesPeerRange(version: string, range: string): boolean;
  verifyRangePolicy(policy: RangePolicy): void;
};
const range = ">=0.80.1 <0.85.0 || >=0.85.1 <0.87.0";
const fixture = (): RangePolicy => ({
  peerRange: range,
  minimum: "0.80.1",
  latest: "0.86.1",
  unsupported: { older: "0.79.10", excluded: ["0.85.0"], upper: "0.87.0" },
});

describe("bounded Pi compatibility policy", () => {
  it("retains the published single-interval policy form", () => {
    expect(() => verifyRangePolicy({
      peerRange: ">=0.80.1 <0.85.0",
      minimum: "0.80.1",
      latest: "0.84.4",
      unsupported: { older: "0.79.10", upper: "0.85.0" },
    })).not.toThrow();
  });

  it.each(["0.80.1", "0.80.8", "0.84.4", "0.85.1", "0.85.9", "0.86.0", "0.86.1"])("accepts supported release %s", (version) => {
    expect(satisfiesPeerRange(version, range)).toBe(true);
  });

  it.each(["0.79.10", "0.80.0", "0.85.0", "0.87.0", "1.0.0"])("rejects unsupported release %s", (version) => {
    expect(satisfiesPeerRange(version, range)).toBe(false);
  });

  it.each([
    "", "^0.85.1", ">=0.80.1", ">=0.80.1 <0.85.0 || ",
    ">=0.85.0 <0.85.0", ">=0.86.0 <0.85.0",
    ">=0.80.1 <0.86.0 || >=0.85.1 <0.87.0",
    ">=0.85.1 <0.86.0 || >=0.80.1 <0.85.0",
    ">=0.80.1 <0.85.0 || >=0.85.0 <0.86.0",
    ">=0.080.1 <0.85.0", ">=0.80.1 <0.85.1-beta.1",
  ])("rejects ambiguous or malformed range %s", (invalid) => {
    expect(() => parsePeerRange(invalid)).toThrow();
  });

  it.each(["0.85.1-beta.1", "0.085.1", "0.85.9007199254740992"])("rejects non-stable or invalid version %s", (version) => {
    expect(() => satisfiesPeerRange(version, range)).toThrow();
  });

  it("pins the checked-in gap and matrix endpoints", () => {
    expect(() => verifyRangePolicy(policy)).not.toThrow();
    expect(policy).toMatchObject(fixture());
  });

  it("rejects widening through a known-broken release", () => {
    expect(() => verifyRangePolicy({ ...fixture(), peerRange: ">=0.80.1 <0.87.0" }))
      .toThrow(/Excluded release 0.85.0 must not be supported/);
  });

  it("requires an explicit negative fixture for each internal gap", () => {
    const invalid = fixture();
    delete invalid.unsupported.excluded;
    expect(() => verifyRangePolicy(invalid)).toThrow(/explicit negative fixture/);
  });

  it.each(["0.80.1", "0.84.4", "0.85.0", "0.87.0"])("rejects latest endpoint %s outside the final interval", (latest) => {
    expect(() => verifyRangePolicy({ ...fixture(), latest })).toThrow(/final supported interval/);
  });

  it("rejects inconsistent lower and upper endpoints", () => {
    expect(() => verifyRangePolicy({ ...fixture(), minimum: "0.80.2" })).toThrow(/lower bound/);
    const invalid = fixture();
    invalid.unsupported.upper = "0.88.0";
    expect(() => verifyRangePolicy(invalid)).toThrow(/final excluded bound/);
  });

  it("requires the older negative fixture to precede supported releases", () => {
    const invalid = fixture();
    invalid.unsupported.older = "0.85.0";
    expect(() => verifyRangePolicy(invalid)).toThrow(/Older sentinel/);
  });

  it.each(["0.79.10", "0.87.0", "0.85.1"])("rejects misplaced exclusion %s", (excluded) => {
    const invalid = fixture();
    invalid.unsupported.excluded = ["0.85.0", excluded];
    expect(() => verifyRangePolicy(invalid)).toThrow(/Excluded release/);
  });

  it("rejects duplicate negative fixtures", () => {
    const invalid = fixture();
    invalid.unsupported.excluded = ["0.85.0", "0.85.0"];
    expect(() => verifyRangePolicy(invalid)).toThrow(/unique/);
  });
});
