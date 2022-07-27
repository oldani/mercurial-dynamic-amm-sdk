import { AnchorProvider, Program, BN, EventParser } from '@project-serum/anchor';
import { PublicKey, Connection, Cluster, Transaction, TransactionInstruction, AccountInfo } from '@solana/web3.js';
import { StaticTokenListResolutionStrategy, TokenInfo, TokenListProvider } from '@solana/spl-token-registry';
import { AccountLayout, MintLayout, Token, TOKEN_PROGRAM_ID, u64 } from '@solana/spl-token';
import { ASSOCIATED_PROGRAM_ID } from '@project-serum/anchor/dist/cjs/utils/token';
import VaultImpl, { getAmountByShare, getUnmintAmount } from '@mercurial-finance/vault-sdk';
import invariant from 'invariant';
import { AmmImplementation, PoolInformation, PoolState } from './types';
import { Amm, IDL as AmmIDL } from './idl';
import { Vault, IDL as VaultIdl } from './vault-idl';
import {
  DEFAULT_SLIPPAGE,
  DEVNET_COIN,
  ERROR,
  CURVE_TYPE_ACCOUNTS,
  PROGRAM_ID,
  SEEDS,
  SIMULATION_USER,
  VAULT_PROGRAM_ID,
  WRAPPED_SOL_MINT,
} from './constants';
import { StableSwap, SwapCurve, TradeDirection } from './curve';
import { ConstantProductSwap } from './curve/constant-product';
import {
  computeActualDepositAmount,
  getMaxAmountWithSlippage,
  getMinAmountWithSlippage,
  getOrCreateATAInstruction,
  parseLogs,
  unwrapSOLInstruction,
  wrapSOLInstruction,
} from './utils';

type AmmProgram = Program<Amm>;
type VaultProgram = Program<Vault>;

type Opt = {
  cluster: Cluster;
};

const getPoolState = async (poolMint: PublicKey, program: AmmProgram) => {
  const poolState = (await program.account.pool.fetchNullable(poolMint)) as PoolState;
  invariant(poolState, `Pool ${poolMint.toBase58()} not found`);

  const account = await program.provider.connection.getAccountInfo(poolState.lpMint);
  invariant(account, ERROR.INVALID_ACCOUNT);

  const lpMintInfo = MintLayout.decode(account.data);
  const lpSupply = new BN(u64.fromBuffer(lpMintInfo.supply));

  return { ...poolState, lpSupply };
};

const getRemainingAccounts = (poolState: PoolState) => {
  let accounts: Array<{
    pubkey: PublicKey;
    isWritable: boolean;
    isSigner: boolean;
  }> = [];
  if ('stable' in poolState.curveType) {
    if ('marinade' in poolState.curveType['stable'].depeg.depegType) {
      accounts.push({
        pubkey: CURVE_TYPE_ACCOUNTS.marinade,
        isWritable: false,
        isSigner: false,
      });
    }

    if ('lido' in poolState.curveType['stable'].depeg.depegType) {
      accounts.push({
        pubkey: CURVE_TYPE_ACCOUNTS.solido,
        isWritable: false,
        isSigner: false,
      });
    }
  }

  return accounts;
};

const getPoolInfo = async ({
  poolMint,
  poolState,
  program,
  vaultA,
  vaultB,
  apyPda,
}: {
  poolMint: PublicKey;
  poolState: PoolState;
  program: AmmProgram;
  vaultA: VaultImpl;
  vaultB: VaultImpl;
  apyPda: PublicKey;
}) => {
  const poolInfoInstruction = await program.methods
    .getPoolInfo()
    .accounts({
      aVault: poolState.aVault,
      aVaultLp: poolState.aVaultLp,
      aVaultLpMint: vaultA.vaultState.lpMint,
      bVault: poolState.bVault,
      bVaultLp: poolState.bVaultLp,
      bVaultLpMint: vaultB.vaultState.lpMint,
      lpMint: poolState.lpMint,
      pool: poolMint,
      apy: apyPda,
    })
    .remainingAccounts(getRemainingAccounts(poolState))
    .instruction();

  const eventParser = new EventParser(program.programId, program.coder);
  const poolInfoTransaction = new Transaction();
  poolInfoTransaction.add(poolInfoInstruction);
  poolInfoTransaction.feePayer = SIMULATION_USER;
  const tx = await program.provider.connection.simulateTransaction(poolInfoTransaction);
  const poolInfo = (await parseLogs(eventParser, tx.value.logs ?? [])) as PoolInformation;

  return poolInfo;
};

export default class AmmImpl implements AmmImplementation {
  public swapCurve: SwapCurve;
  private vaultProgram: VaultProgram;
  private opt: Opt = {
    cluster: 'mainnet-beta',
  };

  private constructor(
    private program: AmmProgram,
    private apyPda: PublicKey,
    private tokenInfos: Array<TokenInfo>,
    public address: PublicKey,
    public poolState: PoolState & PoolInformation & { lpSupply: BN },
    public vaultA: VaultImpl,
    public vaultB: VaultImpl,
    private depegAccounts: Map<String, AccountInfo<Buffer>>,
    opt: Opt,
  ) {
    this.vaultProgram = new Program<Vault>(VaultIdl, VAULT_PROGRAM_ID, this.program.provider);
    this.opt = {
      ...this.opt,
      ...opt,
    };

    if ('stable' in this.poolState.curveType) {
      const { amp, depeg, tokenMultiplier } = this.poolState.curveType['stable'];
      this.swapCurve = new StableSwap(
        amp.toNumber(),
        tokenMultiplier,
        depeg,
        this.depegAccounts,
        this.program.provider.connection,
      );
    } else {
      this.swapCurve = new ConstantProductSwap();
    }
  }

  public static async create(
    connection: Connection,
    pool: PublicKey,
    opt?: {
      cluster?: Cluster;
    },
  ): Promise<AmmImpl> {
    const provider = new AnchorProvider(connection, {} as any, AnchorProvider.defaultOptions());
    const cluster = opt?.cluster ?? 'mainnet-beta';
    const program = new Program<Amm>(AmmIDL, PROGRAM_ID, provider);

    const [apyPda] = await PublicKey.findProgramAddress([Buffer.from(SEEDS.APY), pool.toBuffer()], program.programId);

    const poolState = await getPoolState(pool, program);

    const tokenListContainer = await new TokenListProvider().resolve();
    const tokenMap = cluster === 'devnet' ? DEVNET_COIN : tokenListContainer.filterByClusterSlug(cluster).getList();

    const tokenInfoA = tokenMap.find((token) => token.address === poolState.tokenAMint.toBase58());
    const tokenInfoB = tokenMap.find((token) => token.address === poolState.tokenBMint.toBase58());
    invariant(tokenInfoA, `TokenInfo ${poolState.tokenAMint.toBase58()} A not found`);
    invariant(tokenInfoB, `TokenInfo ${poolState.tokenBMint.toBase58()} A not found`);

    const vaultA = await VaultImpl.create(program.provider.connection, tokenInfoA, { cluster });
    const vaultB = await VaultImpl.create(program.provider.connection, tokenInfoB, { cluster });

    const poolInfo = await getPoolInfo({
      poolMint: pool,
      poolState,
      program,
      vaultA,
      vaultB,
      apyPda,
    });

    const depegAccounts = new Map<String, AccountInfo<Buffer>>();

    if (poolState.curveType['stable'] && !poolState.curveType['stable']['depeg']['depegType']['none']) {
      let extraAddresses: PublicKey[] = [];
      for (const [, address] of Object.entries(CURVE_TYPE_ACCOUNTS)) {
        extraAddresses = extraAddresses.concat(address);
      }
      const accounts = await program.provider.connection.getMultipleAccountsInfo(extraAddresses);
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const address = extraAddresses[i].toBase58();
        if (account) {
          depegAccounts.set(address, account);
        }
      }
    }

    return new AmmImpl(
      program,
      apyPda,
      [tokenInfoA, tokenInfoB],
      pool,
      { ...poolState, ...poolInfo },
      vaultA,
      vaultB,
      depegAccounts,
      {
        cluster,
      },
    );
  }

  get tokenA(): TokenInfo {
    return this.tokenInfos[0];
  }

  get tokenB(): TokenInfo {
    return this.tokenInfos[1];
  }

  get decimals(): number {
    return Math.max(this.tokenA.decimals, this.tokenB.decimals);
  }

  get symbol(): string {
    return `${this.tokenA.symbol}-${this.tokenB.symbol}`;
  }

  get isStablePool(): boolean {
    return 'stable' in this.poolState.curveType;
  }

  public async updatePoolState() {
    const poolState = await getPoolState(this.address, this.program);
    const poolInfo = await this.getPoolInfo();

    this.poolState = { ...poolState, ...poolInfo };
  }

  /**
   * It returns the pool token mint.
   * @returns The poolState.lpMint
   */
  public getPoolTokenMint() {
    return this.poolState.lpMint;
  }

  /**
   * Get the user's balance by looking up the account associated with the user's public key
   * @param {PublicKey} owner - PublicKey - The public key of the user you want to get the balance of
   * @returns The amount of tokens the user has.
   */
  public async getUserBalance(owner: PublicKey) {
    const account = await Token.getAssociatedTokenAddress(
      ASSOCIATED_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      this.poolState.lpMint,
      owner,
    );
    if (!account) return new BN(0);

    const accountInfo = await this.program.provider.connection.getAccountInfo(account);
    if (!accountInfo) return new BN(0);

    const accountInfoData = AccountLayout.decode(accountInfo.data);

    return new BN(u64.fromBuffer(accountInfoData.amount));
  }

  /**
   * `getSwapQuote` returns the amount of `outToken` that you will receive if you swap
   * `inAmountLamport` of `inToken` into the pool
   * @param {PublicKey} inTokenMint - The mint you want to swap from.
   * @param {BN} inAmountLamport - The amount of lamports you want to swap.
   * @param {number} [slippage] - The maximum amount of slippage you're willing to accept.
   * @returns The amount of the destination token that will be received after the swap.
   */
  public async getSwapQuote(inTokenMint: PublicKey, inAmountLamport: BN, slippage?: number) {
    const slippageRate = slippage ?? DEFAULT_SLIPPAGE;
    invariant(
      inTokenMint.equals(this.poolState.tokenAMint) || inTokenMint.equals(this.poolState.tokenBMint),
      ERROR.INVALID_MINT,
    );

    const { tokenAAmount, tokenBAmount } = await this.getPoolInfo();

    const { vaultALpSupply, vaultBLpSupply } = await this.getSplInfo();

    const [
      sourceAmount,
      swapSourceAmount,
      swapDestinationAmount,
      swapSourceVault,
      swapDestinationVault,
      swapSourceVaultLpSupply,
      swapDestinationVaultLpSupply,
      tradeDirection,
    ] = inTokenMint.equals(this.poolState.tokenAMint)
      ? [
          inAmountLamport,
          tokenAAmount,
          tokenBAmount,
          this.vaultA,
          this.vaultB,
          vaultALpSupply,
          vaultBLpSupply,
          TradeDirection.AToB,
        ]
      : [
          inAmountLamport,
          tokenBAmount,
          tokenAAmount,
          this.vaultB,
          this.vaultA,
          vaultBLpSupply,
          vaultALpSupply,
          TradeDirection.BToA,
        ];
    const adminFee = this.calculateAdminTradingFee(sourceAmount);
    const tradeFee = this.calculateTradingFee(sourceAmount);

    const sourceVaultWithdrawableAmount = await swapSourceVault.getWithdrawableAmount();
    // Get vault lp minted when deposit to the vault
    const sourceVaultLp = getUnmintAmount(
      sourceAmount.sub(adminFee),
      sourceVaultWithdrawableAmount,
      swapSourceVaultLpSupply,
    );

    const actualSourceAmount = getAmountByShare(sourceVaultLp, sourceVaultWithdrawableAmount, swapSourceVaultLpSupply);

    let sourceAmountWithFee = actualSourceAmount.sub(tradeFee);

    const destinationAmount = this.swapCurve.computeOutAmount(
      sourceAmountWithFee,
      swapSourceAmount,
      swapDestinationAmount,
      tradeDirection,
    );

    const destinationVaultWithdrawableAmount = await swapDestinationVault.getWithdrawableAmount();
    // Get vault lp to burn when withdraw from the vault
    const destinationVaultLp = getUnmintAmount(
      destinationAmount,
      destinationVaultWithdrawableAmount,
      swapDestinationVaultLpSupply,
    );

    let actualDestinationAmount = getAmountByShare(
      destinationVaultLp,
      destinationVaultWithdrawableAmount,
      swapDestinationVaultLpSupply,
    );

    return getMinAmountWithSlippage(actualDestinationAmount, slippageRate);
  }

  /**
   * `getMaxSwapOutAmount` returns the maximum amount of tokens that can be swapped out of the pool
   * @param {PublicKey} tokenMint - The mint of the token you want to swap out.
   * @returns The maximum amount of tokens that can be swapped out of the pool.
   */
  public async getMaxSwapOutAmount(tokenMint: PublicKey) {
    invariant(
      tokenMint.equals(this.poolState.tokenAMint) || tokenMint.equals(this.poolState.tokenBMint),
      ERROR.INVALID_MINT,
    );

    const { tokenAAmount, tokenBAmount } = await this.getPoolInfo();
    const { vaultAReserve, vaultBReserve } = await this.getSplInfo();
    const [outTotalAmount, outReserveBalance] = tokenMint.equals(this.poolState.tokenAMint)
      ? [tokenAAmount, vaultAReserve]
      : [tokenBAmount, vaultBReserve];

    return outTotalAmount.gt(outReserveBalance) ? outReserveBalance : outTotalAmount;
  }

  /**
   * `swap` is a function that takes in a `PublicKey` of the owner, a `PublicKey` of the input token
   * mint, an `BN` of the input amount of lamports, and an `BN` of the output amount of lamports. It
   * returns a `Promise<Transaction>` of the swap transaction
   * @param {PublicKey} owner - The public key of the user who is swapping
   * @param {PublicKey} inTokenMint - The mint of the token you're swapping from.
   * @param {BN} inAmountLamport - The amount of the input token you want to swap.
   * @param {BN} outAmountLamport - The amount of the output token you want to receive.
   * @returns A transaction object
   */
  public async swap(owner: PublicKey, inTokenMint: PublicKey, inAmountLamport: BN, outAmountLamport: BN) {
    const [sourceToken, destinationToken] =
      this.tokenA.address === inTokenMint.toBase58()
        ? [this.poolState.tokenAMint, this.poolState.tokenBMint]
        : [this.poolState.tokenBMint, this.poolState.tokenAMint];

    const adminTokenFee =
      this.tokenA.address === inTokenMint.toBase58() ? this.poolState.adminTokenAFee : this.poolState.adminTokenBFee;

    let preInstructions: Array<TransactionInstruction> = [];
    const [[userSourceToken, createUserSourceIx], [userDestinationToken, createUserDestinationIx]] =
      await this.createATAPreInstructions(owner, [sourceToken, destinationToken]);

    createUserSourceIx && preInstructions.push(createUserSourceIx);
    createUserDestinationIx && preInstructions.push(createUserDestinationIx);

    if (sourceToken.equals(WRAPPED_SOL_MINT)) {
      preInstructions = preInstructions.concat(wrapSOLInstruction(owner, userSourceToken, inAmountLamport.toNumber()));
    }

    preInstructions.push(await this.getApySyncInstructions());

    const postInstructions: Array<TransactionInstruction> = [];
    if (WRAPPED_SOL_MINT.equals(destinationToken)) {
      const unwrapSOLIx = await unwrapSOLInstruction(owner);
      unwrapSOLIx && postInstructions.push(unwrapSOLIx);
    }

    const swapTx = await this.program.methods
      .swap(inAmountLamport, outAmountLamport)
      .accounts({
        aTokenVault: this.vaultA.vaultState.tokenVault,
        bTokenVault: this.vaultB.vaultState.tokenVault,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        userSourceToken,
        userDestinationToken,
        user: owner,
        adminTokenFee,
        pool: this.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        vaultProgram: this.vaultProgram.programId,
      })
      .remainingAccounts(getRemainingAccounts(this.poolState))
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash('finalized')),
    }).add(swapTx);
  }

  /**
   * `getDepositQuote` is a function that takes in a tokenAInAmount, tokenBInAmount, balance, and
   * slippage, and returns a poolTokenAmountOut, tokenAInAmount, and tokenBInAmount
   * @param {BN} tokenAInAmount - BN,
   * @param {BN} tokenBInAmount - BN,
   * @param {boolean} [balance=true] - return false if the deposit is imbalance (default: true)
   * @param {number} [slippage] - The amount of slippage you're willing to accept.
   * @returns The return value is a tuple of the poolTokenAmountOut, tokenAInAmount, and
   * tokenBInAmount.
   */
  public async getDepositQuote(
    tokenAInAmount: BN,
    tokenBInAmount: BN,
    balance = true,
    slippage?: number,
  ): Promise<{
    poolTokenAmountOut: BN;
    tokenAInAmount: BN;
    tokenBInAmount: BN;
  }> {
    invariant(!(!tokenAInAmount.isZero() && !tokenBInAmount.isZero() && balance), 'Deposit balance is not possible');

    const slippageRate = slippage ?? DEFAULT_SLIPPAGE;
    const { tokenAAmount, tokenBAmount } = await this.getPoolInfo();

    const { poolLpSupply, vaultALpSupply, vaultBLpSupply, poolVaultALp, poolVaultBLp } = await this.getSplInfo();

    const vaultAWithdrawableAmount = await this.vaultA.getWithdrawableAmount();
    const vaultBWithdrawableAmount = await this.vaultB.getWithdrawableAmount();

    if (tokenAInAmount.isZero() && balance) {
      const poolTokenAmountOut = this.getShareByAmount(tokenBInAmount, tokenBAmount, poolLpSupply);

      // Calculate for stable pool balance deposit but used `addImbalanceLiquidity`
      if (this.isStablePool) {
        return {
          poolTokenAmountOut: getMinAmountWithSlippage(poolTokenAmountOut, slippageRate),
          tokenAInAmount: tokenBInAmount.mul(tokenAAmount).div(tokenBAmount),
          tokenBInAmount,
        };
      }

      // Constant product pool balance deposit
      const [actualTokenAInAmount, actualTokenBInAmount] = this.computeActualInAmount(
        poolTokenAmountOut,
        poolLpSupply,
        poolVaultALp,
        poolVaultBLp,
        vaultALpSupply,
        vaultBLpSupply,
        vaultAWithdrawableAmount,
        vaultBWithdrawableAmount,
      );

      return {
        poolTokenAmountOut,
        tokenAInAmount: getMaxAmountWithSlippage(actualTokenAInAmount, slippageRate),
        tokenBInAmount: getMaxAmountWithSlippage(actualTokenBInAmount, slippageRate),
      };
    }

    if (tokenBInAmount.isZero() && balance) {
      const poolTokenAmountOut = this.getShareByAmount(tokenAInAmount, tokenAAmount, poolLpSupply);

      // Calculate for stable pool balance deposit but used `addImbalanceLiquidity`
      if (this.isStablePool) {
        return {
          poolTokenAmountOut: getMinAmountWithSlippage(poolTokenAmountOut, slippageRate),
          tokenAInAmount,
          tokenBInAmount: tokenAInAmount.mul(tokenBAmount).div(tokenAAmount),
        };
      }

      // Constant product pool
      const [actualTokenAInAmount, actualTokenBInAmount] = this.computeActualInAmount(
        poolTokenAmountOut,
        poolLpSupply,
        poolVaultALp,
        poolVaultBLp,
        vaultALpSupply,
        vaultBLpSupply,
        vaultAWithdrawableAmount,
        vaultBWithdrawableAmount,
      );

      return {
        poolTokenAmountOut,
        tokenAInAmount: getMaxAmountWithSlippage(actualTokenAInAmount, slippageRate),
        tokenBInAmount: getMaxAmountWithSlippage(actualTokenBInAmount, slippageRate),
      };
    }

    // Imbalance deposit
    const actualDepositAAmount = computeActualDepositAmount(
      tokenAInAmount,
      tokenAAmount,
      poolVaultALp,
      vaultALpSupply,
      vaultAWithdrawableAmount,
    );

    const actualDepositBAmount = computeActualDepositAmount(
      tokenBInAmount,
      tokenBAmount,
      poolVaultBLp,
      vaultBLpSupply,
      vaultBWithdrawableAmount,
    );
    const poolTokenAmountOut = this.swapCurve.computeImbalanceDeposit(
      actualDepositAAmount,
      actualDepositBAmount,
      tokenAAmount,
      tokenBAmount,
      poolLpSupply,
      this.poolState.fees,
    );

    return {
      poolTokenAmountOut: getMinAmountWithSlippage(poolTokenAmountOut, slippageRate),
      tokenAInAmount,
      tokenBInAmount,
    };
  }

  /**
   * `deposit` creates a transaction that deposits `tokenAInAmount` and `tokenBInAmount` into the pool,
   * and mints `poolTokenAmount` of the pool's liquidity token
   * @param {PublicKey} owner - PublicKey - The public key of the user who is depositing liquidity
   * @param {BN} tokenAInAmount - The amount of token A you want to deposit
   * @param {BN} tokenBInAmount - The amount of token B you want to deposit
   * @param {BN} poolTokenAmount - The amount of pool tokens you want to mint.
   * @returns A transaction object
   */
  public async deposit(
    owner: PublicKey,
    tokenAInAmount: BN,
    tokenBInAmount: BN,
    poolTokenAmount: BN,
  ): Promise<Transaction> {
    const { tokenAMint, tokenBMint, lpMint } = this.poolState;

    const [[userAToken, createTokenAIx], [userBToken, createTokenBIx], [userPoolLp, createLpMintIx]] =
      await this.createATAPreInstructions(owner, [tokenAMint, tokenBMint, lpMint]);

    let preInstructions: Array<TransactionInstruction> = [];
    createTokenAIx && preInstructions.push(createTokenAIx);
    createTokenBIx && preInstructions.push(createTokenBIx);
    createLpMintIx && preInstructions.push(createLpMintIx);

    if (WRAPPED_SOL_MINT.equals(new PublicKey(this.tokenA.address))) {
      preInstructions = preInstructions.concat(wrapSOLInstruction(owner, userAToken, tokenAInAmount.toNumber()));
    }
    if (WRAPPED_SOL_MINT.equals(new PublicKey(this.tokenB.address))) {
      preInstructions = preInstructions.concat(wrapSOLInstruction(owner, userBToken, tokenBInAmount.toNumber()));
    }

    preInstructions.push(await this.getApySyncInstructions());

    const postInstructions: Array<TransactionInstruction> = [];
    if ([this.tokenA.address, this.tokenB.address].includes(WRAPPED_SOL_MINT.toBase58())) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(owner);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    const programMethod = this.isStablePool
      ? this.program.methods.addImbalanceLiquidity
      : this.program.methods.addBalanceLiquidity;

    const depositTx = await programMethod(poolTokenAmount, tokenAInAmount, tokenBInAmount)
      .accounts({
        aTokenVault: this.vaultA.vaultState.tokenVault,
        bTokenVault: this.vaultB.vaultState.tokenVault,
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        pool: this.address,
        user: owner,
        userAToken,
        userBToken,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        lpMint: this.poolState.lpMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        vaultProgram: this.vaultProgram.programId,
        userPoolLp,
      })
      .remainingAccounts(getRemainingAccounts(this.poolState))
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash('finalized')),
    }).add(depositTx);
  }

  /**
   * `getWithdrawQuote` is a function that takes in a withdraw amount and returns the amount of tokens
   * that will be withdrawn from the pool
   * @param {BN} withdrawTokenAmount - The amount of tokens you want to withdraw from the pool.
   * @param {PublicKey} [tokenMint] - The token you want to withdraw. If you want balanced withdraw, leave this blank.
   * @param {number} [slippage] - The amount of slippage you're willing to accept.
   * @returns The return value is a tuple of the poolTokenAmountIn, tokenAOutAmount, and
   * tokenBOutAmount.
   */
  public async getWithdrawQuote(
    withdrawTokenAmount: BN,
    tokenMint?: PublicKey,
    slippage?: number,
  ): Promise<{
    poolTokenAmountIn: BN;
    tokenAOutAmount: BN;
    tokenBOutAmount: BN;
  }> {
    const slippageRate = slippage ?? DEFAULT_SLIPPAGE;
    const { tokenAAmount, tokenBAmount } = await this.getPoolInfo();
    const { poolLpSupply, vaultALpSupply, vaultBLpSupply, poolVaultALp, poolVaultBLp } = await this.getSplInfo();

    const vaultAWithdrawableAmount = await this.vaultA.getWithdrawableAmount();
    const vaultBWithdrawableAmount = await this.vaultB.getWithdrawableAmount();

    // balance withdraw
    if (!tokenMint) {
      const vaultALpBurn = this.getShareByAmount(withdrawTokenAmount, poolLpSupply, poolVaultALp);
      const vaultBLpBurn = this.getShareByAmount(withdrawTokenAmount, poolLpSupply, poolVaultBLp);

      const tokenAOutAmount = this.getAmountByShare(vaultALpBurn, vaultAWithdrawableAmount, vaultALpSupply);
      const tokenBOutAmount = this.getAmountByShare(vaultBLpBurn, vaultBWithdrawableAmount, vaultBLpSupply);

      return {
        poolTokenAmountIn: withdrawTokenAmount,
        tokenAOutAmount: getMinAmountWithSlippage(tokenAOutAmount, slippageRate),
        tokenBOutAmount: getMinAmountWithSlippage(tokenBOutAmount, slippageRate),
      };
    }

    // Imbalance withdraw
    const isWithdrawingTokenA = tokenMint.equals(new PublicKey(this.tokenA.address));
    const isWithdrawingTokenB = tokenMint.equals(new PublicKey(this.tokenB.address));
    invariant(isWithdrawingTokenA || isWithdrawingTokenB, ERROR.INVALID_MINT);

    const tradeDirection = tokenMint.equals(this.poolState.tokenAMint) ? TradeDirection.BToA : TradeDirection.AToB;

    const outAmount = this.swapCurve.computeWithdrawOne(
      withdrawTokenAmount,
      poolLpSupply,
      tokenAAmount,
      tokenBAmount,
      this.poolState.fees,
      tradeDirection,
    );

    const [vaultLpSupply, vaultTotalAmount] =
      tradeDirection == TradeDirection.AToB
        ? [vaultALpSupply, vaultBWithdrawableAmount]
        : [vaultBLpSupply, vaultAWithdrawableAmount];

    const vaultLpToBurn = outAmount.mul(vaultLpSupply).div(vaultTotalAmount);
    // "Actual" out amount (precision loss)
    const realOutAmount = getMinAmountWithSlippage(
      vaultLpToBurn.mul(vaultTotalAmount).div(vaultLpSupply),
      slippageRate,
    );

    return {
      poolTokenAmountIn: withdrawTokenAmount,
      tokenAOutAmount: isWithdrawingTokenA ? realOutAmount : new BN(0),
      tokenBOutAmount: isWithdrawingTokenB ? realOutAmount : new BN(0),
    };
  }

  /**
   * `withdraw` is a function that takes in the owner's public key, the amount of tokens to withdraw,
   * and the amount of tokens to withdraw from each pool, and returns a transaction that withdraws the
   * specified amount of tokens from the pool
   * @param {PublicKey} owner - PublicKey - The public key of the user who is withdrawing liquidity
   * @param {BN} withdrawTokenAmount - The amount of LP tokens to withdraw.
   * @param {BN} tokenAOutAmount - The amount of token A you want to withdraw.
   * @param {BN} tokenBOutAmount - BN,
   * @returns A transaction object
   */
  public async withdraw(owner: PublicKey, withdrawTokenAmount: BN, tokenAOutAmount: BN, tokenBOutAmount: BN) {
    const preInstructions: Array<TransactionInstruction> = [];
    const [[userAToken, createUserAIx], [userBToken, createUserBIx], [userPoolLp, createLpTokenIx]] = await Promise.all(
      [this.poolState.tokenAMint, this.poolState.tokenBMint, this.poolState.lpMint].map((key) =>
        getOrCreateATAInstruction(key, owner, this.program.provider.connection),
      ),
    );

    createUserAIx && preInstructions.push(createUserAIx);
    createUserBIx && preInstructions.push(createUserBIx);
    createLpTokenIx && preInstructions.push(createLpTokenIx);

    preInstructions.push(await this.getApySyncInstructions());

    const postInstructions: Array<TransactionInstruction> = [];
    if ([this.tokenA.address, this.tokenB.address].includes(WRAPPED_SOL_MINT.toBase58())) {
      const closeWrappedSOLIx = await unwrapSOLInstruction(owner);
      closeWrappedSOLIx && postInstructions.push(closeWrappedSOLIx);
    }

    const programMethod =
      this.isStablePool && (tokenAOutAmount.isZero() || tokenBOutAmount.isZero())
        ? this.program.methods.removeLiquiditySingleSide(withdrawTokenAmount, new BN(0)).accounts({
            aTokenVault: this.vaultA.vaultState.tokenVault,
            aVault: this.poolState.aVault,
            aVaultLp: this.poolState.aVaultLp,
            aVaultLpMint: this.vaultA.vaultState.lpMint,
            bTokenVault: this.vaultB.vaultState.tokenVault,
            bVault: this.poolState.bVault,
            bVaultLp: this.poolState.bVaultLp,
            bVaultLpMint: this.vaultB.vaultState.lpMint,
            lpMint: this.poolState.lpMint,
            pool: this.address,
            userDestinationToken: tokenBOutAmount.isZero() ? userAToken : userBToken,
            userPoolLp,
            user: owner,
            tokenProgram: TOKEN_PROGRAM_ID,
            vaultProgram: this.vaultProgram.programId,
          })
        : this.program.methods.removeBalanceLiquidity(withdrawTokenAmount, tokenAOutAmount, tokenBOutAmount).accounts({
            pool: this.address,
            lpMint: this.poolState.lpMint,
            aVault: this.poolState.aVault,
            aTokenVault: this.vaultA.vaultState.tokenVault,
            aVaultLp: this.poolState.aVaultLp,
            aVaultLpMint: this.vaultA.vaultState.lpMint,
            bVault: this.poolState.bVault,
            bTokenVault: this.vaultB.vaultState.tokenVault,
            bVaultLp: this.poolState.bVaultLp,
            bVaultLpMint: this.vaultB.vaultState.lpMint,
            userAToken,
            userBToken,
            user: owner,
            userPoolLp,
            tokenProgram: TOKEN_PROGRAM_ID,
            vaultProgram: this.vaultProgram.programId,
          });

    const withdrawTx = await programMethod
      .remainingAccounts(getRemainingAccounts(this.poolState))
      .preInstructions(preInstructions)
      .postInstructions(postInstructions)
      .transaction();

    return new Transaction({
      feePayer: owner,
      ...(await this.program.provider.connection.getLatestBlockhash('finalized')),
    }).add(withdrawTx);
  }

  private async getSplInfo() {
    const [
      vaultAReserveBuffer,
      vaultBReserveBuffer,
      vaultALpMintBuffer,
      vaultBLpMintBuffer,
      poolVaultALpBuffer,
      poolVaultBLpBuffer,
      poolLpMintBuffer,
    ] = await this.program.provider.connection.getMultipleAccountsInfo([
      this.vaultA.vaultState.tokenVault,
      this.vaultB.vaultState.tokenVault,
      this.vaultA.vaultState.lpMint,
      this.vaultB.vaultState.lpMint,
      this.poolState.aVaultLp,
      this.poolState.bVaultLp,
      this.poolState.lpMint,
    ]);

    const vaultAReserveInfo = AccountLayout.decode(vaultAReserveBuffer!.data);
    const vaultALpMintInfo = MintLayout.decode(vaultALpMintBuffer!.data);
    const vaultBReserveInfo = AccountLayout.decode(vaultBReserveBuffer!.data);
    const vaultBLpMintInfo = MintLayout.decode(vaultBLpMintBuffer!.data);
    const poolVaultALpInfo = AccountLayout.decode(poolVaultALpBuffer!.data);
    const poolVaultBLpInfo = AccountLayout.decode(poolVaultBLpBuffer!.data);
    const poolLpMintInfo = MintLayout.decode(poolLpMintBuffer!.data);

    return {
      vaultAReserve: new BN(u64.fromBuffer(vaultAReserveInfo.amount)),
      vaultBReserve: new BN(u64.fromBuffer(vaultBReserveInfo.amount)),
      vaultALpSupply: new BN(u64.fromBuffer(vaultALpMintInfo.supply)),
      vaultBLpSupply: new BN(u64.fromBuffer(vaultBLpMintInfo.supply)),
      poolVaultALp: new BN(u64.fromBuffer(poolVaultALpInfo.amount)),
      poolVaultBLp: new BN(u64.fromBuffer(poolVaultBLpInfo.amount)),
      poolLpSupply: new BN(u64.fromBuffer(poolLpMintInfo.supply)),
    };
  }

  private async getPoolInfo() {
    return getPoolInfo({
      poolMint: this.address,
      apyPda: this.apyPda,
      poolState: this.poolState,
      program: this.program,
      vaultA: this.vaultA,
      vaultB: this.vaultB,
    });
  }

  private async getApySyncInstructions() {
    return this.program.methods
      .syncApy()
      .accounts({
        aVault: this.poolState.aVault,
        bVault: this.poolState.bVault,
        aVaultLp: this.poolState.aVaultLp,
        bVaultLp: this.poolState.bVaultLp,
        pool: this.address,
        lpMint: this.poolState.lpMint,
        aVaultLpMint: this.vaultA.vaultState.lpMint,
        bVaultLpMint: this.vaultB.vaultState.lpMint,
        apy: this.apyPda,
      })
      .remainingAccounts(getRemainingAccounts(this.poolState))
      .instruction();
  }

  private async createATAPreInstructions(owner: PublicKey, mintList: Array<PublicKey>) {
    return Promise.all(
      mintList.map((mint) => {
        return getOrCreateATAInstruction(mint, owner, this.program.provider.connection);
      }),
    );
  }

  private calculateAdminTradingFee(amount: BN): BN {
    const { ownerTradeFeeDenominator, ownerTradeFeeNumerator } = this.poolState.fees;
    return amount.mul(ownerTradeFeeNumerator).div(ownerTradeFeeDenominator);
  }

  private calculateTradingFee(amount: BN): BN {
    const { tradeFeeDenominator, tradeFeeNumerator } = this.poolState.fees;
    return amount.mul(tradeFeeNumerator).div(tradeFeeDenominator);
  }

  private computeActualInAmount(
    poolTokenAmount: BN,
    poolLpSupply: BN,
    poolVaultALp: BN,
    poolVaultBLp: BN,
    vaultALpSupply: BN,
    vaultBLpSupply: BN,
    vaultAWithdrawableAmount: BN,
    vaultBWithdrawableAmount: BN,
  ): [BN, BN] {
    const aVaultLpMinted = this.getShareByAmount(poolTokenAmount, poolLpSupply, poolVaultALp, true);
    const bVaultLpMinted = this.getShareByAmount(poolTokenAmount, poolLpSupply, poolVaultBLp, true);

    const actualTokenAInAmount = this.getAmountByShare(aVaultLpMinted, vaultAWithdrawableAmount, vaultALpSupply, true);
    const actualTokenBInAmount = this.getAmountByShare(bVaultLpMinted, vaultBWithdrawableAmount, vaultBLpSupply, true);

    return [actualTokenAInAmount, actualTokenBInAmount];
  }

  private getShareByAmount(amount: BN, tokenAmount: BN, lpSupply: BN, roundUp?: boolean): BN {
    return roundUp ? amount.mul(lpSupply).divRound(tokenAmount) : amount.mul(lpSupply).div(tokenAmount);
  }

  private getAmountByShare(amount: BN, tokenAmount: BN, lpSupply: BN, roundUp?: boolean): BN {
    return roundUp ? amount.mul(tokenAmount).divRound(lpSupply) : amount.mul(tokenAmount).div(lpSupply);
  }
}
