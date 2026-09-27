const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------------------
   Deploy FighterNFT + ArenaBattle, wire them together, and print the two
   lines that have to go into js/config.js.

   THE ARBITER ADDRESS IS NOT OPTIONAL

   ArenaBattle only accepts settlements signed by `arbiter`. That address
   must be the one whose PRIVATE key sits in the root .env as
   ARBITER_PRIVATE_KEY, because that is the key server.js signs with. Deploy
   with the deployer as arbiter by accident and every settlement will revert
   with "bad arbiter signature" until setArbiter is called - so this script
   refuses to guess, and says so.
------------------------------------------------------------------- */

function readArbiterFromRootEnv() {
  /* The arbiter key lives in the ROOT .env (server.js reads it there), not
     in contracts/.env. Derive the address from it so the deployment and the
     signer cannot drift apart. Only the address is ever printed. */
  try {
    const envPath = path.join(__dirname, "..", "..", ".env");
    if (!fs.existsSync(envPath)) return null;
    const line = fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith("ARBITER_PRIVATE_KEY="));
    if (!line) return null;
    const key = line.slice(line.indexOf("=") + 1).trim();
    if (!key) return null;
    return new ethers.Wallet(key).address;
  } catch (e) {
    return null;
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const arbiter =
    process.env.ARBITER_ADDRESS ||
    readArbiterFromRootEnv();

  console.log("=========================================");
  console.log("AARAGE - ArenaBattle v2 deployment");
  console.log("Network  :", net.name, "(chainId " + net.chainId + ")");
  console.log("Deployer :", deployer.address);
  console.log("Balance  :", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "MON");
  console.log("=========================================");

  if (!arbiter) {
    console.error("");
    console.error("No arbiter address.");
    console.error("Set ARBITER_PRIVATE_KEY in the ROOT .env (server.js signs with it),");
    console.error("or pass ARBITER_ADDRESS=0x... to this script.");
    console.error("");
    console.error("Deploying without it would produce a contract that rejects every");
    console.error("settlement this project can produce.");
    process.exitCode = 1;
    return;
  }
  console.log("Arbiter  :", arbiter);
  if (arbiter.toLowerCase() === deployer.address.toLowerCase()) {
    console.warn("  ! arbiter == deployer. Fine for a demo; separate them for anything real.");
  }

  console.log("\n1. FighterNFT...");
  const FighterNFT = await ethers.getContractFactory("FighterNFT");
  const nft = await FighterNFT.deploy(deployer.address);
  await nft.waitForDeployment();
  const nftAddress = await nft.getAddress();
  console.log("   deployed at", nftAddress);

  console.log("2. ArenaBattle...");
  const ArenaBattle = await ethers.getContractFactory("ArenaBattle");
  const arena = await ArenaBattle.deploy(nftAddress, arbiter, deployer.address);
  await arena.waitForDeployment();
  const arenaAddress = await arena.getAddress();
  console.log("   deployed at", arenaAddress);

  console.log("3. Authorising the arena to mint...");
  const tx = await nft.setArenaContract(arenaAddress);
  await tx.wait();
  console.log("   confirmed", tx.hash);

  /* Verify rather than assume. A deployment that silently failed to wire
     the two contracts together looks perfectly fine until the first
     settlement reverts inside mintWinner. */
  console.log("4. Verifying...");
  const wired = await nft.arenaContract();
  const onChainArbiter = await arena.arbiter();
  const fee = await arena.feeBps();
  if (wired.toLowerCase() !== arenaAddress.toLowerCase()) throw new Error("NFT is not wired to the arena");
  if (onChainArbiter.toLowerCase() !== arbiter.toLowerCase()) throw new Error("arbiter mismatch");
  console.log("   nft.arenaContract =", wired);
  console.log("   arena.arbiter     =", onChainArbiter);
  console.log("   arena.feeBps      =", fee.toString(), "(" + Number(fee) / 100 + "%)");
  console.log("   domainSeparator   =", await arena.domainSeparator());

  console.log("\n=========================================");
  console.log("DEPLOYMENT COMPLETE");
  console.log("=========================================");
  console.log("Paste into js/config.js, inside const MONAD:\n");
  console.log("  USE_REAL_CHAIN: true,");
  console.log("  arenaAddress: '" + arenaAddress + "',");
  console.log("  nftAddress: '" + nftAddress + "',");
  console.log("");

  const out = {
    chainId: Number(net.chainId),
    arenaAddress,
    nftAddress,
    arbiter,
    deployer: deployer.address,
    feeBps: Number(fee),
    deployedAt: new Date().toISOString()
  };
  const file = path.join(__dirname, "..", "deployments." + net.chainId + ".json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("Written to", file);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
