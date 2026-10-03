// SEC-IDX-08 against the shape of Seer's real NewMarket event (observed on a Gnosis fork): its `questionId` field is
// Seer's conditional-tokens question id (Market.questionId()), and the Reality.eth question id the ClaimRegistry records
// (Market.questionsIds()[0]) is the single entry of `questionsIds`.

import { encodeAbiParameters, encodeEventTopics, zeroAddress, type AbiEvent, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { seerMarketFactoryAbi } from "@pine/shared/abi/external";
import type { Address, Hex32 } from "@pine/shared/types";
import { hasMatchingNewMarket } from "./receipts.js";

const FACTORY = "0x83183da839ce8228e31ae41222ead9edbb5cdcf1" as Address;
const MARKET = "0x829fe042b4983de01a4e40fd848750ec1deff788" as Address;
const CONDITION_ID = "0x5534476368fb0aacfa1938c05ebad36be82801604996fb978f697298db7603b3" as Hex32;
/** Market.questionsIds()[0]: the Reality question id (what ClaimCreated and the read model carry). */
const REALITY_QUESTION_ID = "0x2645565725176567275175f34dd6a66b555079e0c7ee44a1acf4b90071054e8b" as Hex32;
/** Market.questionId(): Seer's conditional-tokens question id (NewMarket's `questionId` field). */
const CTF_QUESTION_ID = "0x4436291b24a4c452801ac8244cb43eda7116643f3be987817bd647022e5b77ee" as Hex32;
const OTHER_QUESTION_ID = `0x${"ab".repeat(32)}` as Hex32;
const MARKET_NAME = "Pine claim [Example]: question text";

const newMarketAbi = seerMarketFactoryAbi.find((item) => item.type === "event" && item.name === "NewMarket") as AbiEvent;

function receiptWith(questionId: Hex32, questionsIds: Hex32[]): TransactionReceipt {
  const topics = encodeEventTopics({ abi: seerMarketFactoryAbi, eventName: "NewMarket", args: { market: MARKET } });
  const data = encodeAbiParameters(
    newMarketAbi.inputs.filter((input) => !input.indexed),
    [MARKET_NAME, zeroAddress, CONDITION_ID, questionId, questionsIds],
  );
  return { status: "success", logs: [{ address: FACTORY, topics, data }] } as unknown as TransactionReceipt;
}

const expected = { market: MARKET, conditionId: CONDITION_ID, questionId: REALITY_QUESTION_ID, marketName: MARKET_NAME };

describe("hasMatchingNewMarket", () => {
  it("SEC-IDX-08 accepts Seer's real NewMarket shape (questionId = CTF question id, questionsIds = [Reality question id])", () => {
    expect(hasMatchingNewMarket(receiptWith(CTF_QUESTION_ID, [REALITY_QUESTION_ID]), FACTORY, expected)).toBe(true);
  });

  it("SEC-IDX-08 refuses a NewMarket whose Reality question id differs from the registry's", () => {
    expect(hasMatchingNewMarket(receiptWith(CTF_QUESTION_ID, [OTHER_QUESTION_ID]), FACTORY, expected)).toBe(false);
  });

  it("SEC-IDX-08 refuses a NewMarket that only repeats the Reality question id in its questionId field", () => {
    expect(hasMatchingNewMarket(receiptWith(REALITY_QUESTION_ID, [OTHER_QUESTION_ID]), FACTORY, expected)).toBe(false);
  });

  it("SEC-IDX-08 refuses a multi-question NewMarket", () => {
    expect(hasMatchingNewMarket(receiptWith(CTF_QUESTION_ID, [REALITY_QUESTION_ID, OTHER_QUESTION_ID]), FACTORY, expected)).toBe(false);
  });
});
