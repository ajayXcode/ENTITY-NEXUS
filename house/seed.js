/* ------------------------------------------------------------------
   house/seed.js - the contract's seed, as the engine wants it.

   ArenaBattle produces a uint256; mulberry32 wants 32 bits. XOR-folding
   rather than truncating keeps every bit of the blockhash-and-pools
   entropy in play instead of throwing away the top 224 of them.

   Its own file because two things must agree on it exactly: the server,
   which runs the fight it is about to sign, and the browsers, which
   receive the folded value over the relay and play the same fight. The
   browser never folds - it is handed the result - so there is one
   implementation, here, and it is tested.
------------------------------------------------------------------- */

function foldSeed(seedStr) {
  let v = 0n
  try { v = BigInt(seedStr) } catch (e) { return 0 }
  let out = 0
  while (v > 0n) {
    out = (out ^ Number(v & 0xffffffffn)) >>> 0
    v >>= 32n
  }
  return out >>> 0
}

module.exports = { foldSeed }
