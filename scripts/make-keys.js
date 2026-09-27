/* ------------------------------------------------------------------
   make-keys.js - generate the two keys this project needs.

   Run:  node scripts/make-keys.js

   Writes them straight into the .env files and prints only the ADDRESSES.
   The private keys never touch stdout, so they never end up in terminal
   scrollback, a screen recording, or a pasted log - which is where testnet
   keys usually leak from, and the same habit is the one you want when a key
   eventually matters.

   Both files are already in .gitignore. This script appends and refuses to
   overwrite: run it twice and it will tell you the keys are already there
   rather than quietly replacing the ones your deployed contract points at.
------------------------------------------------------------------- */

const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')

const ROOT = path.join(__dirname, '..')
const SPLIT_LINES = new RegExp('\r?\n')

/* name -> { file, why } */
const KEYS = {
  DEPLOYER_PRIVATE_KEY: {
    file: path.join(ROOT, 'contracts', '.env'),
    why: 'deploys FighterNFT + ArenaBattle, and owns them afterwards'
  },
  ARBITER_PRIVATE_KEY: {
    file: path.join(ROOT, '.env'),
    why: 'signs settlements AND sends lockAgents/openBetting/startMatch'
  }
}

function hasKey(file, name) {
  if (!fs.existsSync(file)) return false
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .some((l) => l.trim().startsWith(name + '=') && l.trim().length > name.length + 1)
}

/* Writing a fresh private key into a file git is already tracking would put
   it in the next commit. That is a NEW leak, not an inherited one, and it is
   worth refusing outright rather than warning about - a warning scrolls past
   and the key is in history forever.

   The repo's root .env is exactly this case today: it was committed before
   .gitignore covered it, so `git check-ignore` says ignored while `git ls-files`
   says tracked, and the tracked answer is the one that decides what gets
   committed. */
function isTracked(file) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', file], {
      cwd: ROOT,
      stdio: 'ignore'
    })
    return true
  } catch (e) {
    return false            // untracked, or no git at all - both fine
  }
}

function append(file, name, value, why) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const exists = fs.existsSync(file)
  /* Never start a new assignment mid-line: an existing file that does not end
     in a newline would otherwise glue this onto whatever came last. */
  const pad = exists && fs.readFileSync(file, 'utf8').replace(/\s+$/, '').length ? '\n\n' : ''
  fs.appendFileSync(file, pad + '# ' + why + '\n' + name + '=' + value + '\n')
}

/* --show: read the addresses back out of the .env files without ever
   printing, logging or returning the keys themselves. This is the command to
   reach for when you need to check what a faucet should be funding, or which
   address a deployed contract's `arbiter` ought to be. */
if (process.argv.includes('--show')) {
  console.log('')
  for (const [name, spec] of Object.entries(KEYS)) {
    const rel = path.relative(ROOT, spec.file).replace(/\\/g, '/')
    if (!hasKey(spec.file, name)) {
      console.log('  ' + name + ': not set in ' + rel)
      continue
    }
    const line = fs.readFileSync(spec.file, 'utf8')
      .split(SPLIT_LINES)
      .find((l) => l.trim().startsWith(name + '='))
    const key = line.slice(line.indexOf('=') + 1).trim()
    try {
      console.log('  ' + name + ': ' + new ethers.Wallet(key).address + '   (' + rel + ')')
    } catch (e) {
      console.log('  ' + name + ': INVALID KEY in ' + rel)
    }
  }
  console.log('')
  process.exit(0)
}

console.log('')
let made = 0
let blocked = 0

for (const [name, spec] of Object.entries(KEYS)) {
  const rel = path.relative(ROOT, spec.file).replace(/\\/g, '/')

  if (hasKey(spec.file, name)) {
    console.log('  ' + name)
    console.log('    already set in ' + rel + ' - left alone')
    console.log('')
    continue
  }

  /* Checked BEFORE the key is generated, so a refusal never leaves a fresh
     secret sitting in a file that git is about to pick up. */
  if (isTracked(spec.file)) {
    console.log('  ' + name + '  ->  REFUSED')
    console.log('    ' + rel + ' is TRACKED by git - writing a key there would commit it.')
    console.log('')
    console.log('    Fix it without touching history:')
    console.log('        git rm --cached ' + rel)
    console.log('')
    console.log('    The file stays on disk. Anything already in history stays')
    console.log('    there too, and still needs rotating.')
    console.log('')
    blocked++
    continue
  }

  const wallet = ethers.Wallet.createRandom()
  append(spec.file, name, wallet.privateKey, spec.why)
  made++

  console.log('  ' + name + '  ->  ' + rel)
  console.log('    address: ' + wallet.address)
  console.log('    ' + spec.why)
  console.log('')
}

if (blocked) {
  console.log('Run the command(s) above, then run this script again.\n')
  process.exit(1)
}

if (!made) {
  console.log('Nothing to do - both keys already exist.\n')
  process.exit(0)
}

console.log('Both addresses need testnet MON before you deploy.')
console.log('The arbiter is not optional: it sends three transactions per match.')
console.log('')
console.log('Faucets:')
console.log('  https://faucet.quicknode.com/monad')
console.log('  https://www.alchemy.com/faucets/monad-testnet')
console.log('  https://faucets.chain.link/monad-testnet')
console.log('')
console.log('To read an address back later without printing its key:')
console.log('  node scripts/make-keys.js --show')
console.log('')
