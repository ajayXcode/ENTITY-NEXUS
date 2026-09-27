/* ------------------------------------------------------------------
   house/txwait.js - wait for a transaction without trusting the RPC.

   THE PROBLEM THIS SOLVES

   ethers' tx.wait() is a thin wrapper over polling
   eth_getTransactionReceipt, and it treats any error from that call as
   fatal. Monad's public testnet endpoint intermittently answers it with

       -32603  Internal error: Archive error: Error getting index data

   The transaction itself is fine - usually already mined. It is the
   RECEIPT LOOKUP that failed, and a moment later the same call succeeds.
   But by then wait() has thrown, and upstream that read as "the whole
   match cycle failed":

       [house] LGPQ two-walls: cycle failed: could not coalesce error …

   so a table would abandon a match it had actually just created on chain,
   and start again. On a public RPC that turns into a loop of half-built
   matches and wasted gas.

   WHAT THIS DOES INSTEAD

   Treats a failed receipt lookup as "ask again", not as "the transaction
   failed". Those are completely different claims and only the chain gets to
   make the second one. It keeps asking until either

     - a receipt comes back, which is the answer; or
     - the deadline passes, and then it says plainly that it does not know,
       rather than guessing.

   A reverted transaction still throws, because that IS the chain speaking:
   receipt.status === 0 is a real answer and is passed straight through.
------------------------------------------------------------------- */

/* Long enough to ride out a flapping endpoint, short enough that a genuinely
   dropped transaction does not hold a table hostage. Monad blocks are
   sub-second, so anything not mined within this was never going to be. */
const DEFAULT_TIMEOUT_MS = 90 * 1000
const POLL_MS = 1500

function isTransientRpcError(err) {
  const msg = String((err && (err.message || err.shortMessage)) || '')
  const code = err && (err.code || (err.error && err.error.code))
  /* -32603 is "internal error", which is what an endpoint returns when its
     own index is having a moment. The string checks catch the same class of
     thing from endpoints that pick a different code for it. */
  if (code === -32603 || code === -32000 || code === -32005) return true
  return /archive error|getting index data|internal error|timeout|timed out|502|503|504|rate.?limit|too many requests|could not coalesce/i
    .test(msg)
}

/* tx: what contract.someMethod() resolved to.
   Returns the receipt, or throws with something worth reading. */
async function confirmTx(tx, opts) {
  const o = opts || {}
  const timeout = o.timeoutMs || DEFAULT_TIMEOUT_MS
  const log = o.log || (() => {})
  const provider = tx.provider || o.provider
  const hash = tx.hash

  const deadline = Date.now() + timeout
  let complained = false

  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(hash)
      if (receipt) {
        /* The chain's own verdict. A revert is a real answer and is not
           something to retry. */
        if (receipt.status === 0) {
          throw new Error('transaction ' + String(hash).slice(0, 12) + '… reverted on chain')
        }
        if (complained) log('receipt for ' + String(hash).slice(0, 12) + '… arrived after retrying')
        return receipt
      }
      /* null means "not mined yet" - not an error, just early. */
    } catch (err) {
      if (/reverted on chain/.test(String(err.message))) throw err
      if (!isTransientRpcError(err)) throw err
      if (!complained) {
        complained = true
        log('receipt lookup is failing (' +
          String(err.shortMessage || err.message).slice(0, 60) + ') - retrying')
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }

  throw new Error('could not confirm transaction ' + String(hash).slice(0, 12) +
    '… within ' + Math.round(timeout / 1000) + 's - the RPC never returned a receipt. ' +
    'It may well have been mined; this process simply cannot tell.')
}

module.exports = { confirmTx, isTransientRpcError, DEFAULT_TIMEOUT_MS }
