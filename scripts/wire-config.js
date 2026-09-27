/* ------------------------------------------------------------------
   wire-config.js - point js/config.js at a deployment.

   Run:  node scripts/wire-config.js            (after deploying)
         node scripts/wire-config.js --off      (back to demo mode)

   Reads contracts/deployments.<chainId>.json and rewrites three lines in
   js/config.js: USE_REAL_CHAIN, arenaAddress, nftAddress.

   WHY THIS IS A SCRIPT AND NOT A NOTE IN THE README

   Hand-copying two 42-character hex strings between a terminal and a config
   file is a step that fails silently. A transposed character in arenaAddress
   does not throw - ethers happily builds a contract object for an address
   with no code at it, every read returns empty, the pools render as a
   confident 0.000 MON, and the first bet reverts with something unhelpful.
   The addresses are already in a JSON file the deployer wrote; there is no
   reason for a human to retype them.

   It also checks the arbiter, which is the one mismatch that produces a
   working-looking deployment that can never settle anything - and it checks
   it against the CHAIN rather than the deployment record. The record says
   what was true at deploy time, and setArbiter can have moved it since. An
   earlier version of this script trusted the file and refused to wire a
   deployment that was already correct; the chain is the ledger here exactly
   as it is everywhere else in this project.
------------------------------------------------------------------- */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG = path.join(ROOT, 'js', 'config.js')
const SPLIT_LINES = new RegExp('\\r?\\n')
const ZERO = '0x0000000000000000000000000000000000000000'

function fail(msg) {
  console.error('\n  ' + msg + '\n')
  process.exit(1)
}

/* Replace `key: <value>` inside the MONAD block only. Anchored on the key
   name at the start of an indented line so it cannot wander into the PEN or
   CONFIG blocks, which have their own settings. */
function setField(src, key, value) {
  const re = new RegExp('^(\\s*' + key + ':\\s*).*?(,\\s*(?://.*)?)$', 'm')
  if (!re.test(src)) fail('could not find `' + key + '` in js/config.js')
  return src.replace(re, '$1' + value + '$2')
}

function currentArbiterAddress() {
  try {
    const { ethers } = require('ethers')
    const envPath = path.join(ROOT, '.env')
    if (!fs.existsSync(envPath)) return null
    const line = fs.readFileSync(envPath, 'utf8')
      .split(SPLIT_LINES)
      .find((l) => l.trim().startsWith('ARBITER_PRIVATE_KEY='))
    if (!line) return null
    return new ethers.Wallet(line.slice(line.indexOf('=') + 1).trim()).address
  } catch (e) {
    return null
  }
}

function writeConfig(useReal, arena, nft, note) {
  let src = fs.readFileSync(CONFIG, 'utf8')
  src = setField(src, 'USE_REAL_CHAIN', useReal ? 'true' : 'false')
  src = setField(src, 'arenaAddress', "'" + arena + "'")
  src = setField(src, 'nftAddress', "'" + nft + "'")
  fs.writeFileSync(CONFIG, src)
  console.log('\n  ' + note + '\n')
}

async function main() {
  if (process.argv.includes('--off')) {
    writeConfig(false, ZERO, ZERO, 'js/config.js -> DEMO MODE. Nothing will touch the chain.')
    return
  }

  /* Find whatever the deployer last wrote. Usually one file; if someone has
     also deployed to a local hardhat node, prefer the real testnet. */
  const dir = path.join(ROOT, 'contracts')
  const files = fs.readdirSync(dir).filter((f) => /^deployments\.\d+\.json$/.test(f))
  if (!files.length) {
    fail('No contracts/deployments.<chainId>.json found.\n' +
         '  Deploy first:\n' +
         '      cd contracts && npx hardhat run scripts/deploy.js --network monadTestnet')
  }

  const preferred = files.indexOf('deployments.10143.json') > -1 ? 'deployments.10143.json' : files[0]
  const file = path.join(dir, preferred)
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))

  console.log('\n  Reading contracts/' + preferred)
  console.log('    chainId : ' + d.chainId)
  console.log('    arena   : ' + d.arenaAddress)
  console.log('    nft     : ' + d.nftAddress)
  console.log('    arbiter : ' + d.arbiter + '   (as deployed)')

  if (d.chainId !== 10143) {
    console.log('\n  ! This is chain ' + d.chainId + ', not Monad testnet (10143).')
    console.log('    Wiring the frontend to a local hardhat deployment will only work')
    console.log('    while that node is running.')
  }

  const signer = currentArbiterAddress()
  let onChain = null

  try {
    const { ethers } = require('ethers')
    const rpc = process.env.MONAD_RPC || 'https://testnet-rpc.monad.xyz'
    const provider = new ethers.JsonRpcProvider(rpc)
    const arena = new ethers.Contract(d.arenaAddress,
      ['function arbiter() view returns (address)'], provider)
    onChain = await arena.arbiter()
    if (onChain.toLowerCase() !== String(d.arbiter).toLowerCase()) {
      console.log('    on chain: ' + onChain + '   (record is stale - setArbiter has run)')
    }
  } catch (e) {
    /* No RPC is not a reason to refuse: say so and fall back to the record,
       rather than blocking a wiring that is probably fine. */
    console.log('\n  ! could not reach the chain (' + (e.shortMessage || e.message) + ')')
    console.log('    falling back to the deployment record, which may be stale.')
    onChain = d.arbiter
  }

  if (signer && onChain && signer.toLowerCase() !== onChain.toLowerCase()) {
    fail('ARBITER MISMATCH.\n' +
         '  The contract will only accept settlements from ' + onChain + '\n' +
         '  but server.js signs with                        ' + signer + '\n\n' +
         '  Every settlement would revert with "bad arbiter signature".\n' +
         '  Fix it with:\n' +
         '      node scripts/set-arbiter.js --apply --to ' + signer + ' --gas 2')
  }
  if (signer) console.log('    signer  : ' + signer + '   (matches)')

  /* Keep the record honest, so the next reader is not misled the way an
     earlier version of this script was. */
  if (onChain && onChain.toLowerCase() !== String(d.arbiter).toLowerCase()) {
    d.arbiter = onChain
    fs.writeFileSync(file, JSON.stringify(d, null, 2))
    console.log('    record updated to match the chain')
  }

  writeConfig(true, d.arenaAddress, d.nftAddress,
    'js/config.js is now LIVE against Monad testnet.\n  Commit it - the deployed site reads this file.')
}

main().catch((e) => fail(e.shortMessage || e.message))
