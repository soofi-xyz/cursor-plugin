import { describe, expect, it } from "vitest";

import { mintAddressIdentity } from "../src/core/address-signature.mjs";

const GOLDEN_SIGNATURE =
  "address:v1|country:2:us|state:2:fl|postal_code:5:32225|street:17:11659 jonathan rd|unit:0:";
const GOLDEN_UUID = "c3a982a7-1102-50b8-b2cd-6cb3fca2060f";
const GOLDEN_TOKEN =
  "da5b90e067f162ea35eb482befaea835b32df7861adb282c6fb3983f17fa325e";

const goldenInput = {
  country: "us",
  state: "FL",
  postalCode: "32225",
  street: "11659 JONATHAN RD",
  unit: null,
};

describe("mintAddressIdentity", () => {
  it("mints the lowercase Jonathan Rd golden fixture", () => {
    const identity = mintAddressIdentity(goldenInput);

    expect(identity).toEqual({
      signature: GOLDEN_SIGNATURE,
      elephantUuid: GOLDEN_UUID,
      elephantToken: GOLDEN_TOKEN,
    });
  });

  it("treats ZIP+4 and 9-digit postal values as ZIP5", () => {
    for (const postalCode of ["32225-1234", "322251234", "32225", " 32225 "]) {
      expect(mintAddressIdentity({ ...goldenInput, postalCode })).toEqual({
        signature: GOLDEN_SIGNATURE,
        elephantUuid: GOLDEN_UUID,
        elephantToken: GOLDEN_TOKEN,
      });
    }
  });

  it("collapses inner whitespace and does not mutate the input object", () => {
    const input = {
      country: "US",
      state: "FL",
      postalCode: "32225",
      street: "  11659   JONATHAN   RD  ",
      unit: null,
    };

    const identity = mintAddressIdentity(input);

    expect(identity?.signature).toBe(GOLDEN_SIGNATURE);
    expect(input.street).toBe("  11659   JONATHAN   RD  ");
    expect(input.state).toBe("FL");
  });

  it("does not convert ROAD to RD", () => {
    const identity = mintAddressIdentity({
      ...goldenInput,
      street: "11659 JONATHAN ROAD",
    });

    expect(identity?.signature).toContain("street:19:11659 jonathan road");
    expect(identity?.elephantUuid).not.toBe(GOLDEN_UUID);
  });

  it("returns null when street or postal is missing", () => {
    expect(mintAddressIdentity({ ...goldenInput, street: null })).toBeNull();
    expect(mintAddressIdentity({ ...goldenInput, postalCode: "322" })).toBeNull();
    expect(mintAddressIdentity({ ...goldenInput, state: null })).toBeNull();
  });

  it("serializes a present unit with its UTF-8 length", () => {
    const identity = mintAddressIdentity({
      ...goldenInput,
      unit: "APT 2",
    });

    expect(identity?.signature).toContain("|unit:5:apt 2");
  });
});
