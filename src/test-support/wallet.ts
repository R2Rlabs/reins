/**
 * Signing helpers for tests. Kept out of the build (see tsconfig.build.json)
 * and out of the test files themselves, since importing one test file from
 * another runs its tests twice.
 */
import { privateKeyToAccount } from "viem/accounts";
import { approveBuilderFeeTypedData, type ApproveBuilderFeeAction } from "../builder-approval.js";

/** Hardhat's first default account: a published test key that holds nothing. */
export const testWallet = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

/** Hardhat's second default account. */
export const otherTestWallet = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/** Signs the way a browser wallet does, from the same typed data the page builds. */
export function signLikeAWallet(action: ApproveBuilderFeeAction, account = testWallet) {
  const { types, message, ...rest } = approveBuilderFeeTypedData(action);
  const { EIP712Domain: _domain, ...actionTypes } = types;
  return account.signTypedData({
    ...rest,
    types: actionTypes,
    message: { ...message, builder: message.builder as `0x${string}`, nonce: BigInt(message.nonce) },
  });
}
