const { ethers } = require("hardhat");
const { expect } = require("chai");
const { BigNumber } = require("ethers");

const timestamp = async () => {
  const latestBlock = await ethers.provider.getBlock(
    await ethers.provider.getBlockNumber()
  );

  return latestBlock.timestamp;
};

const timetravel = async (addTime) => {
  await network.provider.send("evm_increaseTime", [addTime]);
  await network.provider.send("evm_mine");
};

describe("AaveV2StablecoinCellar", () => {
  let owner;
  let alice;
  let bob;
  let cellar;
  let Token;
  let usdc;
  let weth;
  let dai;
  let usdt;
  let router;
  let lendingPool;
  let incentivesController;
  let gravity;
  let aUSDC;
  let aDAI;
  let stkAAVE;
  let aave;
  let dataProvider;

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();

    // Deploy mock Uniswap router contract
    const SwapRouter = await ethers.getContractFactory("MockSwapRouter");
    router = await SwapRouter.deploy();
    await router.deployed();

    // Deploy mock tokens
    Token = await ethers.getContractFactory("MockToken");
    usdc = await Token.deploy("USDC");
    dai = await Token.deploy("DAI");
    weth = await Token.deploy("WETH");
    usdt = await Token.deploy("USDT");

    await usdc.deployed();
    await dai.deployed();
    await weth.deployed();
    await usdt.deployed();

    // Deploy mock aUSDC
    const MockAToken = await ethers.getContractFactory("MockAToken");
    aUSDC = await MockAToken.deploy(usdc.address, "aUSDC");
    await aUSDC.deployed();

    // Deploy mock aDAI
    aDAI = await MockAToken.deploy(dai.address, "aDAI");
    await aDAI.deployed();

    // Deploy mock Aave USDC lending pool
    const LendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await LendingPool.deploy();
    await lendingPool.deployed();

    await lendingPool.initReserve(usdc.address, aUSDC.address);
    await lendingPool.initReserve(dai.address, aDAI.address);

    await aUSDC.setLendingPool(lendingPool.address);
    await aDAI.setLendingPool(lendingPool.address);

    // Deploy mock AAVE
    aave = await Token.deploy("AAVE");

    // Deploy mock stkAAVE
    const MockStkAAVE = await ethers.getContractFactory("MockStkAAVE");
    stkAAVE = await MockStkAAVE.deploy(aave.address);
    await stkAAVE.deployed();

    // Deploy mock Aave incentives controller
    const MockIncentivesController = await ethers.getContractFactory(
      "MockIncentivesController"
    );
    incentivesController = await MockIncentivesController.deploy(
      stkAAVE.address
    );
    await incentivesController.deployed();

    const MockGravity = await ethers.getContractFactory("MockGravity");
    gravity = await MockGravity.deploy();
    await gravity.deployed();

    // Deploy cellar contract
    const AaveV2StablecoinCellar = await ethers.getContractFactory(
      "AaveV2StablecoinCellar"
    );
    cellar = await AaveV2StablecoinCellar.deploy(
      router.address,
      router.address,
      lendingPool.address,
      incentivesController.address,
      gravity.address,
      stkAAVE.address,
      aave.address,
      weth.address,
      usdc.address,
      usdc.address
    );
    await cellar.deployed();

    // Mint mock tokens to signers
    await usdc.mint(owner.address, 1_000_000);
    await dai.mint(owner.address, 1_000_000);
    await weth.mint(owner.address, 1_000_000);
    await usdt.mint(owner.address, 1_000_000);

    await usdc.mint(alice.address, 1_000_000);
    await dai.mint(alice.address, 1_000_000);
    await weth.mint(alice.address, 1_000_000);
    await usdt.mint(alice.address, 1_000_000);

    // Approve cellar to spend mock tokens
    await usdc.approve(cellar.address, 1_000_000);
    await dai.approve(cellar.address, 1_000_000);
    await weth.approve(cellar.address, 1_000_000);
    await usdt.approve(cellar.address, 1_000_000);

    await usdc.connect(alice).approve(cellar.address, 1_000_000);
    await dai.connect(alice).approve(cellar.address, 1_000_000);
    await weth.connect(alice).approve(cellar.address, 1_000_000);
    await usdt.connect(alice).approve(cellar.address, 1_000_000);

    // Approve cellar to spend shares (to take as fees)
    await cellar.approve(cellar.address, ethers.constants.MaxUint256);

    await cellar
      .connect(alice)
      .approve(cellar.address, ethers.constants.MaxUint256);

    // Mint initial liquidity to Aave USDC lending pool
    await usdc.mint(aUSDC.address, 5_000_000);

    // Mint initial liquidity to router
    await usdc.mint(router.address, 5_000_000);
    await dai.mint(router.address, 5_000_000);
    await weth.mint(router.address, 5_000_000);
    await usdt.mint(router.address, 5_000_000);

    // Initialize with mock tokens as input tokens
    await cellar.setInputToken(usdc.address, true);
    await cellar.setInputToken(dai.address, true);
  });

  describe("deposit", () => {
    it("should mint correct amount of shares to user", async () => {
      // add $100 of inactive assets in cellar
      await cellar["deposit(uint256)"](100);
      // expect 100 shares to be minted (because total supply of shares is 0)
      expect(await cellar.balanceOf(owner.address)).to.eq(100);

      // add $50 of inactive assets in cellar
      await cellar.connect(alice)["deposit(uint256)"](50);
      // expect 50 shares = 100 total shares * ($50 / $100) to be minted
      expect(await cellar.balanceOf(alice.address)).to.eq(50);
    });

    it("should transfer input token from user to cellar", async () => {
      const initialUserBalance = await usdc.balanceOf(owner.address);
      const initialCellarBalance = await usdc.balanceOf(cellar.address);

      await cellar["deposit(uint256)"](100);

      const updatedUserBalance = await usdc.balanceOf(owner.address);
      const updatedCellarBalance = await usdc.balanceOf(cellar.address);

      // expect $100 to have been transferred from owner to cellar
      expect(updatedUserBalance - initialUserBalance).to.eq(-100);
      expect(updatedCellarBalance - initialCellarBalance).to.eq(100);
    });

    it("should swap input token for current lending token if not already", async () => {
      const initialUserBalance = await dai.balanceOf(owner.address);
      const initialCellarBalance = await usdc.balanceOf(cellar.address);

      await cellar["deposit(address,uint256,uint256,address)"](
        dai.address,
        100,
        95,
        owner.address
      );

      const updatedUserBalance = await dai.balanceOf(owner.address);
      const updatedCellarBalance = await usdc.balanceOf(cellar.address);

      // expect $100 to have been transferred from owner
      expect(updatedUserBalance - initialUserBalance).to.eq(-100);
      // expect $95 to have been received by cellar (simulate $5 being lost during swap)
      expect(updatedCellarBalance - initialCellarBalance).to.eq(95);

      // expect shares to be minted to owner as if they deposited $95 even though
      // they deposited $100 (because that is what the cellar received after swap)
      expect(await cellar.balanceOf(owner.address)).to.eq(95);
    });

    it("should mint shares to receiver instead of caller if specified", async () => {
      // owner mints to alice
      await cellar["deposit(uint256,address)"](100, alice.address);
      // expect alice receives 100 shares
      expect(await cellar.balanceOf(alice.address)).to.eq(100);
      // expect owner receives no shares
      expect(await cellar.balanceOf(owner.address)).to.eq(0);
    });

    it("should deposit all user's balance if tries to deposit more than they have", async () => {
      // owner has $1m to deposit, withdrawing $2m should only withdraw $1m
      await cellar["deposit(uint256)"](2_000_000);
      expect(await usdc.balanceOf(owner.address)).to.eq(0);
      expect(await usdc.balanceOf(cellar.address)).to.eq(1_000_000);
    });

    it("should emit Deposit event", async () => {
      await expect(cellar["deposit(uint256,address)"](100, alice.address))
        .to.emit(cellar, "Deposit")
        .withArgs(owner.address, alice.address, 100, 100);
    });
  });

  describe("withdraw", () => {
    beforeEach(async () => {
      // both owner and alice should start off owning 50% of the cellar's total assets each
      await cellar["deposit(uint256)"](100);
      await cellar.connect(alice)["deposit(uint256)"](100);
    });

    it("should withdraw correctly when called with all inactive shares", async () => {
      const ownerInitialBalance = await usdc.balanceOf(owner.address);
      // owner should be able redeem all shares for initial $100 (50% of total)
      await cellar["withdraw(uint256)"](100);
      const ownerUpdatedBalance = await usdc.balanceOf(owner.address);
      // expect owner receives desired amount of tokens
      expect(ownerUpdatedBalance - ownerInitialBalance).to.eq(100);
      // expect all owner's shares to be burned
      expect(await cellar.balanceOf(owner.address)).to.eq(0);

      const aliceInitialBalance = await usdc.balanceOf(alice.address);
      // alice should be able redeem all shares for initial $100 (50% of total)
      await cellar.connect(alice)["withdraw(uint256)"](100);
      const aliceUpdatedBalance = await usdc.balanceOf(alice.address);
      // expect alice receives desired amount of tokens
      expect(aliceUpdatedBalance - aliceInitialBalance).to.eq(100);
      // expect all alice's shares to be burned
      expect(await cellar.balanceOf(alice.address)).to.eq(0);
    });

    it("should withdraw correctly when called with all active shares", async () => {
      // convert all inactive assets -> active assets
      await cellar.enterStrategy();

      // mimic growth from $200 -> $250 (1.25x increase) while in strategy
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );

      const ownerInitialBalance = await usdc.balanceOf(owner.address);
      // owner should be able redeem all shares for $125 (50% of total)
      await cellar["withdraw(uint256)"](125);
      const ownerUpdatedBalance = await usdc.balanceOf(owner.address);
      // expect owner receives desired amount of tokens
      expect(ownerUpdatedBalance - ownerInitialBalance).to.eq(125);
      // expect all owner's shares to be burned
      expect(await cellar.balanceOf(owner.address)).to.eq(0);

      const aliceInitialBalance = await usdc.balanceOf(alice.address);
      // alice should be able redeem all shares for $125 (50% of total)
      await cellar.connect(alice)["withdraw(uint256)"](125);
      const aliceUpdatedBalance = await usdc.balanceOf(alice.address);
      // expect alice receives desired amount of tokens
      expect(aliceUpdatedBalance - aliceInitialBalance).to.eq(125);
      // expect all alice's shares to be burned
      expect(await cellar.balanceOf(alice.address)).to.eq(0);
    });

    it("should withdraw correctly when called with active and inactive shares", async () => {
      // convert all inactive assets -> active assets
      await cellar.enterStrategy();

      // mimic growth from $200 -> $250 (1.25x increase) while in strategy
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );

      // owner adds $100 of inactive assets
      await cellar["deposit(uint256)"](100);
      // alice adds $75 of inactive assets
      await cellar.connect(alice)["deposit(uint256)"](75);

      const ownerInitialBalance = await usdc.balanceOf(owner.address);
      // owner should be able redeem all shares for $225 ($125 active + $100 inactive)
      await cellar["withdraw(uint256)"](225);
      const ownerUpdatedBalance = await usdc.balanceOf(owner.address);
      // expect owner receives desired amount of tokens
      expect(ownerUpdatedBalance - ownerInitialBalance).to.eq(225);
      // expect all owner's shares to be burned
      expect(await cellar.balanceOf(owner.address)).to.eq(0);

      const aliceInitialBalance = await usdc.balanceOf(alice.address);
      // alice should be able redeem all shares for $200 ($125 active + $75 inactive)
      await cellar.connect(alice)["withdraw(uint256)"](200);
      const aliceUpdatedBalance = await usdc.balanceOf(alice.address);
      // expect alice receives desired amount of tokens
      expect(aliceUpdatedBalance - aliceInitialBalance).to.eq(200);
      // expect all alice's shares to be burned
      expect(await cellar.balanceOf(alice.address)).to.eq(0);
    });

    it("should use and store index of first non-zero deposit", async () => {
      // owner withdraws everything from deposit object at index 0
      await cellar["withdraw(uint256)"](100);
      // expect next non-zero deposit is set to index 1
      expect(await cellar.currentDepositIndex(owner.address)).to.eq(1);

      // alice only withdraws half from index 0, leaving some shares remaining
      await cellar.connect(alice)["withdraw(uint256)"](50);
      // expect next non-zero deposit is set to index 0 since some shares still remain
      expect(await cellar.currentDepositIndex(alice.address)).to.eq(0);
    });

    it("should withdraw all user's assets if tries to withdraw more than they have", async () => {
      await cellar["withdraw(uint256)"](100);
      // owner should now have nothing left to withdraw
      expect(await cellar.balanceOf(owner.address)).to.eq(0);
      await expect(cellar["withdraw(uint256)"](1)).to.be.revertedWith(
        "ZeroShares()"
      );

      // alice only has $100 to withdraw, withdrawing $150 should only withdraw $100
      await cellar.connect(alice)["withdraw(uint256)"](100);
      expect(await usdc.balanceOf(alice.address)).to.eq(1_000_000);
    });

    it("should not allow unapproved 3rd party to withdraw using another's shares", async () => {
      // owner tries to withdraw alice's shares without approval (expect revert)
      await expect(
        cellar["withdraw(uint256,address,address)"](
          100,
          owner.address,
          alice.address
        )
      ).to.be.reverted;

      cellar.connect(alice).approve(100);

      // owner tries again after alice approved owner to withdraw $100 (expect pass)
      await expect(
        cellar["withdraw(uint256,address,address)"](
          100,
          owner.address,
          alice.address
        )
      ).to.be.reverted;

      // owner tries to withdraw another $100 (expect revert)
      await expect(
        cellar["withdraw(uint256,address,address)"](
          100,
          owner.address,
          alice.address
        )
      ).to.be.reverted;
    });

    it("should emit Withdraw event", async () => {
      await expect(
        cellar["withdraw(uint256,address,address)"](
          100,
          alice.address,
          owner.address
        )
      )
        .to.emit(cellar, "Withdraw")
        .withArgs(owner.address, alice.address, owner.address, 100, 100);
    });
  });

  describe("transfer", () => {
    it("should correctly update deposit accounting upon transferring shares", async () => {
      // deposit $100 -> 100 shares
      await cellar["deposit(uint256)"](100);
      const depositTimestamp = await timestamp();

      const aliceOldBalance = await cellar.balanceOf(alice.address);
      await cellar.transfer(alice.address, 25);
      const aliceNewBalance = await cellar.balanceOf(alice.address);

      expect(aliceNewBalance - aliceOldBalance).to.eq(25);

      const ownerDeposit = await cellar.userDeposits(owner.address, 0);
      const aliceDeposit = await cellar.userDeposits(alice.address, 0);

      expect(ownerDeposit[0]).to.eq(75); // expect 75 assets
      expect(ownerDeposit[1]).to.eq(75); // expect 75 shares
      expect(ownerDeposit[2]).to.eq(depositTimestamp);
      expect(aliceDeposit[0]).to.eq(25); // expect 25 assets
      expect(aliceDeposit[1]).to.eq(25); // expect 25 shares
      expect(aliceDeposit[2]).to.eq(depositTimestamp);
    });

    it("should allow withdrawing of transferred shares", async () => {
      await cellar["deposit(uint256)"](100);
      await cellar.transfer(alice.address, 100);

      await cellar.enterStrategy();

      // mimic growth from $100 -> $125 (1.25x increase) while in strategy
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );

      await cellar.connect(alice)["deposit(uint256)"](100);

      const aliceOldBalance = await usdc.balanceOf(alice.address);
      await cellar.connect(alice)["withdraw(uint256)"](125 + 100);
      const aliceNewBalance = await usdc.balanceOf(alice.address);

      expect(await cellar.balanceOf(alice.address)).to.eq(0);
      expect(aliceNewBalance - aliceOldBalance).to.eq(225);
    });

    it("should require approval for transferring other's shares", async () => {
      await cellar.connect(alice)["deposit(uint256)"](100);
      await cellar.connect(alice).approve(owner.address, 50);

      await cellar.transferFrom(alice.address, owner.address, 50);
      await expect(cellar.transferFrom(alice.address, owner.address, 200)).to.be
        .reverted;
    });
  });

  describe("swap", () => {
    beforeEach(async () => {
      // Mint initial liquidity to cellar
      await usdc.mint(cellar.address, 2000);
    });

    it("should swap input tokens for at least the minimum amount of output tokens", async () => {
      await cellar.swap(usdc.address, dai.address, 1000, 950);
      expect(await usdc.balanceOf(cellar.address)).to.eq(1000);
      expect(await dai.balanceOf(cellar.address)).to.be.at.least(950);

      // expect fail if minimum amount of output tokens not received
      await expect(
        cellar.swap(usdc.address, dai.address, 1000, 2000)
      ).to.be.revertedWith("amountOutMin invariant failed");
    });

    it("should revert if trying to swap more tokens than cellar has", async () => {
      await expect(
        cellar.swap(usdc.address, dai.address, 3000, 2800)
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("should emit Swapped event", async () => {
      await expect(cellar.swap(usdc.address, dai.address, 1000, 950))
        .to.emit(cellar, "Swapped")
        .withArgs(usdc.address, 1000, dai.address, 950);
    });
  });

  describe("multihopSwap", () => {
    beforeEach(async () => {
      // Mint initial liquidity to cellar
      await weth.mint(cellar.address, 2000);
    });

    it("should swap input tokens for at least the minimum amount of output tokens", async () => {
      const balanceWETHBefore = await weth.balanceOf(cellar.address);
      const balanceUSDTBefore = await usdt.balanceOf(cellar.address);

      await cellar.multihopSwap(
        [weth.address, usdc.address, usdt.address],
        1000,
        950
      );

      expect(balanceUSDTBefore).to.eq(0);
      expect(await weth.balanceOf(cellar.address)).to.eq(
        balanceWETHBefore - 1000
      );
      expect(await usdt.balanceOf(cellar.address)).to.eq(
        balanceUSDTBefore + 950
      );

      await expect(
        cellar.multihopSwap(
          [weth.address, usdc.address, dai.address],
          1000,
          2000
        )
      ).to.be.revertedWith("amountOutMin invariant failed");
    });

    it("multihop swap with two tokens in the path", async () => {
      const balanceWETHBefore = await weth.balanceOf(cellar.address);
      const balanceDAIBefore = await dai.balanceOf(cellar.address);

      await cellar.multihopSwap([weth.address, dai.address], 1000, 950);

      expect(await weth.balanceOf(cellar.address)).to.eq(
        balanceWETHBefore - 1000
      );
      expect(await dai.balanceOf(cellar.address)).to.be.at.least(
        balanceDAIBefore + 950
      );
    });

    it("multihop swap with four tokens in the path", async () => {
      await usdc.mint(cellar.address, 2000);

      const balanceUSDCBefore = await usdc.balanceOf(cellar.address);
      const balanceUSDTBefore = await usdt.balanceOf(cellar.address);

      await cellar.multihopSwap(
        [usdc.address, weth.address, dai.address, usdt.address],
        1000,
        950
      );
      expect(await usdc.balanceOf(cellar.address)).to.eq(
        balanceUSDCBefore - 1000
      );
      expect(await usdt.balanceOf(cellar.address)).to.be.at.least(
        balanceUSDTBefore + 950
      );
    });

    it("should revert if trying to swap more tokens than cellar has", async () => {
      await expect(
        cellar.multihopSwap(
          [weth.address, usdc.address, dai.address],
          3000,
          2800
        )
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("should emit Swapped event", async () => {
      await expect(
        cellar.multihopSwap(
          [weth.address, usdc.address, dai.address],
          1000,
          950
        )
      )
        .to.emit(cellar, "Swapped")
        .withArgs(weth.address, 1000, dai.address, 950);
    });
  });

  describe("enterStrategy", () => {
    beforeEach(async () => {
      // owner adds $100 of inactive assets
      await cellar["deposit(uint256)"](100);

      // alice adds $100 of inactive assets
      await cellar.connect(alice)["deposit(uint256)"](100);

      // enter all $200 of inactive assets into a strategy
      await cellar.enterStrategy();
    });

    it("should deposit cellar inactive assets into Aave", async () => {
      // cellar's initial $200 - deposited $200 = $0
      expect(await usdc.balanceOf(cellar.address)).to.eq(0);
      // aave's initial $5,000,000 + deposited $200 = $5,000,200
      expect(await usdc.balanceOf(aUSDC.address)).to.eq(5000200);
    });

    it("should return correct amount of aTokens to cellar", async () => {
      expect(await aUSDC.balanceOf(cellar.address)).to.eq(200);
    });

    it("should not allow deposit if cellar does not have enough liquidity", async () => {
      // cellar tries to enter strategy with $100 it does not have
      await expect(cellar.enterStrategy()).to.be.reverted;
    });

    it("should emit DepositToAave event", async () => {
      await cellar["deposit(uint256)"](200);

      await expect(cellar.enterStrategy())
        .to.emit(cellar, "DepositToAave")
        .withArgs(usdc.address, 200);
    });
  });

  describe("claimAndUnstake", () => {
    beforeEach(async () => {
      // simulate cellar contract having 100 stkAAVE to claim
      await incentivesController.addRewards(cellar.address, 100);

      await cellar["claimAndUnstake()"]();
    });

    it("should claim rewards from Aave and begin unstaking", async () => {
      // expect cellar to claim all 100 stkAAVE
      expect(await stkAAVE.balanceOf(cellar.address)).to.eq(100);
    });

    it("should have started 10 day unstaking cooldown period", async () => {
      expect(await stkAAVE.stakersCooldowns(cellar.address)).to.eq(
        await timestamp()
      );
    });
  });

  describe("reinvest", () => {
    beforeEach(async () => {
      await incentivesController.addRewards(cellar.address, 100);
      // cellar claims rewards and begins the 10 day cooldown period
      await cellar["claimAndUnstake()"]();

      await timetravel(864000);

      await cellar["reinvest(uint256)"](95);
    });

    it("should reinvested rewards back into principal", async () => {
      expect(await stkAAVE.balanceOf(cellar.address)).to.eq(0);
      expect(await aUSDC.balanceOf(cellar.address)).to.eq(95);
    });
  });

  describe("redeemFromAave", () => {
    beforeEach(async () => {
      // Mint initial liquidity to cellar
      await usdc.mint(cellar.address, 1000);

      await cellar.enterStrategy();

      await cellar.redeemFromAave(usdc.address, 1000);
    });

    it("should return correct amount of tokens back to cellar from lending pool", async () => {
      expect(await usdc.balanceOf(cellar.address)).to.eq(1000);
    });

    it("should transfer correct amount of aTokens to lending pool", async () => {
      expect(await aUSDC.balanceOf(cellar.address)).to.eq(0);
    });

    it("should not allow redeeming more than cellar deposited", async () => {
      // cellar tries to redeem $100 when it should have deposit balance of $0
      await expect(cellar.redeemFromAave(usdc.address, 100)).to.be.reverted;
    });

    it("should emit RedeemFromAave event", async () => {
      await usdc.mint(cellar.address, 1000);
      await cellar.enterStrategy();

      await expect(cellar.redeemFromAave(usdc.address, 1000))
        .to.emit(cellar, "RedeemFromAave")
        .withArgs(usdc.address, 1000);
    });
  });

  describe("rebalance", () => {
    beforeEach(async () => {
      await usdc.mint(cellar.address, 1000);
      await cellar.enterStrategy();
    });

    it("should rebalance all usdc liquidity in dai", async () => {
      expect(await dai.balanceOf(cellar.address)).to.eq(0);
      expect(await aUSDC.balanceOf(cellar.address)).to.eq(1000);

      await cellar.rebalance(dai.address, 0);

      expect(await aUSDC.balanceOf(cellar.address)).to.eq(0);
      // After the swap,  amount of  coin will change from the exchange rate of 0.95
      expect(await aDAI.balanceOf(cellar.address)).to.eq(950);

      await cellar.redeemFromAave(dai.address, 950);

      expect(await aDAI.balanceOf(cellar.address)).to.eq(0);
      expect(await dai.balanceOf(cellar.address)).to.eq(950);
    });

    it("should not be possible to rebalance to the same token", async () => {
      await expect(cellar.rebalance(usdc.address, 0)).to.be.revertedWith(
        "SameLendingToken"
      );
    });
  });

  describe("fees", () => {
    it("should accrue platform fees", async () => {
      // owner deposits $1,000,000
      await cellar["deposit(uint256)"](1_000_000);

      // convert all inactive assets -> active assets
      await cellar.enterStrategy();

      await timetravel(86400); // 1 day

      await cellar.accruePlatformFees();

      // $27 worth of shares in fees = $1,000,000 * 86430 sec * (2% / secsPerYear)
      expect(await cellar.balanceOf(cellar.address)).to.eq(27);
    });

    it("should accrue performance fees upon withdraw", async () => {
      // owner deposits $1000
      await cellar["deposit(uint256)"](1000);

      // convert all inactive assets -> active assets
      await cellar.enterStrategy();

      // mimic growth from $1000 -> $1250 (1.25x increase) while in strategy
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );

      await cellar.shutdown();

      // expect all of active liquidity to be withdrawn from Aave
      expect(await usdc.balanceOf(cellar.address)).to.eq(1250);

      // should allow users to withdraw from holding pool
      await cellar["withdraw(uint256)"](1250);

      // expect cellar to have received $12 fees in shares = $250 gain * 5%
      expect(await cellar.balanceOf(cellar.address)).to.eq(9);
    });

    it("should be able to transfer fees", async () => {
      // accrue some platform fees
      await cellar["deposit(uint256)"](1_000_000);
      await cellar.enterStrategy();
      await timetravel(86400); // 1 day
      await cellar.accruePlatformFees();

      // accrue some performance fees
      await cellar.connect(alice)["deposit(uint256)"](1000);
      await cellar.enterStrategy();
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );
      await cellar.connect(alice)["withdraw(uint256)"](1250);

      const fees = await cellar.balanceOf(cellar.address);
      const feeInAssets = await cellar.convertToAssets(fees);

      await cellar.transferFees();

      // expect all fee shares to be transferred out
      expect(await cellar.balanceOf(cellar.address)).to.eq(0);
      expect(await usdc.balanceOf(gravity.address)).to.eq(feeInAssets);
    });
  });

  describe("pause", () => {
    it("should prevent users from depositing while paused", async () => {
      await cellar.setPause(true);
      expect(cellar["deposit(uint256)"](100)).to.be.revertedWith(
        "ContractPaused()"
      );
    });

    it("should emits a Pause event", async () => {
      await expect(cellar.setPause(true))
        .to.emit(cellar, "Pause")
        .withArgs(owner.address, true);
    });
  });

  describe("shutdown", () => {
    it("should prevent users from depositing while shutdown", async () => {
      await cellar["deposit(uint256)"](100);
      await cellar.shutdown();
      expect(cellar["deposit(uint256)"](100)).to.be.revertedWith(
        "ContractShutdown()"
      );
    });

    it("should allow users to withdraw", async () => {
      // alice first deposits
      await cellar.connect(alice)["deposit(uint256)"](100);

      // cellar is shutdown
      await cellar.shutdown();

      await cellar.connect(alice)["withdraw(uint256)"](100);
    });

    it("should withdraw all active assets from Aave", async () => {
      await cellar["deposit(uint256)"](1000);

      await cellar.enterStrategy();

      // mimic growth from $1000 -> $1250 (1.25x increase) while in strategy
      await lendingPool.setLiquidityIndex(
        BigNumber.from("1250000000000000000000000000")
      );

      await cellar.shutdown();

      // expect all of active liquidity to be withdrawn from Aave
      expect(await usdc.balanceOf(cellar.address)).to.eq(1250);

      // should allow users to withdraw from holding pool
      await cellar["withdraw(uint256)"](1250);
    });

    it("should emit a Shutdown event", async () => {
      await expect(cellar.shutdown())
        .to.emit(cellar, "Shutdown")
        .withArgs(owner.address);
    });
  });

  describe("restrictLiquidity", () => {
    it("should prevent deposit it greater than max liquidity", async () => {
      await usdc.mint(
        cellar.address,
        ethers.BigNumber.from("5000000000000000000000000") // $5m
      );

      await expect(cellar["deposit(uint256)"](1)).to.be.revertedWith(
        "LiquidityRestricted(5000000000000000000000000, 5000000000000000000000000)"
      );
    });

    it("should prevent deposit it greater than max deposit", async () => {
      await expect(
        cellar["deposit(uint256)"](
          ethers.BigNumber.from("50000000000000000000001")
        )
      ).to.be.revertedWith(
        "DepositRestricted(1000000, 50000000000000000000000)"
      );
    });

    it("should allow deposits above max liquidity once restriction removed", async () => {
      await usdc.mint(
        cellar.address,
        ethers.BigNumber.from("5000000000000000000000000") // $5m
      );

      await cellar.removeLiquidityRestriction();

      await cellar["deposit(uint256)"](50_001);
    });
  });

  describe("sweep", () => {
    let SOMM;

    beforeEach(async () => {
      SOMM = await Token.deploy("SOMM");
      await SOMM.deployed();

      // mimic 1000 SOMM being transferred to the cellar contract by accident
      await SOMM.mint(cellar.address, 1000);
    });

    it("should not allow assets managed by cellar to be transferred out", async () => {
      await expect(cellar.sweep(usdc.address)).to.be.revertedWith(
        `ProtectedToken("${usdc.address}")`
      );
      await expect(cellar.sweep(aUSDC.address)).to.be.revertedWith(
        `ProtectedToken("${aUSDC.address}")`
      );
    });

    it("should recover tokens accidentally transferred to the contract", async () => {
      await cellar.sweep(SOMM.address);

      // expect 1000 SOMM to have been transferred from cellar to owner
      expect(await SOMM.balanceOf(owner.address)).to.eq(1000);
      expect(await SOMM.balanceOf(cellar.address)).to.eq(0);
    });

    it("should emit Sweep event", async () => {
      await expect(cellar.sweep(SOMM.address))
        .to.emit(cellar, "Sweep")
        .withArgs(SOMM.address, 1000);
    });
  });
});
