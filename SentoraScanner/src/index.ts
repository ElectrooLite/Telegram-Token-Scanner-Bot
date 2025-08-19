// src/index.ts
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';
import type { ConfirmedSignatureInfo } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';

/* ===========================
   BOOTSTRAP
=========================== */
const bot = new Telegraf(process.env.BOT_TOKEN!);
const RPC = process.env.SOLANA_RPC || clusterApiUrl('mainnet-beta');
const connection = new Connection(RPC, 'confirmed');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : '';

  
/* ===========================
   TYPES / CONSTANTS
=========================== */
type CacheEntry = { ts: number; text: string };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

type DevAsset = {
  id: string;
  name?: string;
  symbol?: string;
  interface?: string;
  createdAt?: string;
};

const KNOWN_MARKET_AUTHORITIES = new Set<string>([
  // Pump.fun hot/update authority (expand as you learn more)
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
]);

/* ===========================
   SMALL HELPERS
=========================== */


// Works for both legacy and v0 messages
function getAllAccountKeysBase58(tx: any): string[] {
  try {
    const msg: any = tx?.transaction?.message;
    // v0: use getAccountKeys with loaded addresses
    if (msg && typeof msg.getAccountKeys === 'function') {
      const aks = msg.getAccountKeys({ accountKeysFromLookups: tx?.meta?.loadedAddresses });
      const s = (aks?.staticAccountKeys || []).map((k: any) => k?.toBase58?.() || String(k));
      const l0 = (aks?.accountKeysFromLookups?.writable || []).map((k: any) => k?.toBase58?.() || String(k));
      const l1 = (aks?.accountKeysFromLookups?.readonly || []).map((k: any) => k?.toBase58?.() || String(k));
      return [...s, ...l0, ...l1].filter(Boolean);
    }
    // legacy: array of PublicKey
    const arr = msg?.accountKeys || [];
    return arr.map((k: any) => k?.toBase58?.() || k?.pubkey?.toBase58?.() || String(k)).filter(Boolean);
  } catch { return []; }
}

function getFeePayerBase58(tx: any): string | undefined {
  try {
    const msg: any = tx?.transaction?.message;
    // v0
    if (msg && typeof msg.getAccountKeys === 'function') {
      const aks = msg.getAccountKeys({ accountKeysFromLookups: tx?.meta?.loadedAddresses });
      const k = aks?.staticAccountKeys?.[0];
      return k?.toBase58?.() || (k ? String(k) : undefined);
    }
    // legacy
    const k = msg?.accountKeys?.[0];
    return k?.toBase58?.() || k?.pubkey?.toBase58?.() || (k ? String(k) : undefined);
  } catch { return undefined; }
}

// ===========================
// BUNDLE DETECTION FOR PUMPSWAP (Pump.fun)
// ===========================

// Seed list; expand as you confirm real tip addresses
const JITO_TIP_ACCOUNTS = new Set<string>([
  // placeholders — update later as you curate
  'Tip111111111111111111111111111111111111111',
  '7XyTip1111111111111111111111111111111111111',
]);

function getComputeUnitPriceIx(tx: any): number | null {
  try {
    const top = tx?.transaction?.message?.instructions || [];
    const inn = (tx?.meta?.innerInstructions || []).flatMap((ii: any) => ii.instructions) || [];
    const allIxs = [...top, ...inn];

    for (const ix of allIxs) {
      const pid = ix.programId?.toBase58?.() || String(ix.programId || '');
      if (pid !== 'ComputeBudget111111111111111111111111111111') continue;
      if (ix.parsed?.type === 'setComputeUnitPrice') {
        const v = Number(ix.parsed?.info?.microLamports ?? ix.parsed?.info?.micro_lamports ?? 0);
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  } catch {}
  return null;
}

function sumJitoTipsLamports(tx: any): number {
  try {
    let sum = 0;
    const top = tx?.transaction?.message?.instructions || [];
    const inn = (tx?.meta?.innerInstructions || []).flatMap((ii: any) => ii.instructions) || [];
    const allIxs = [...top, ...inn];

    for (const ix of allIxs) {
      const pid = ix.programId?.toBase58?.() || String(ix.programId || '');
      if (pid !== '11111111111111111111111111111111') continue; // SystemProgram

      if (ix.parsed?.type === 'transfer') {
        const dst = String(ix.parsed?.info?.destination || '');
        const lamports = Number(ix.parsed?.info?.lamports ?? ix.parsed?.info?.amount ?? 0);
        if (dst && JITO_TIP_ACCOUNTS.has(dst) && Number.isFinite(lamports)) {
          sum += lamports;
        }
      }
    }
    return sum;
  } catch { return 0; }
}

function txPaysJitoTip(tx: any): boolean {
  return sumJitoTipsLamports(tx) > 0;
}

function estSolSpentByFeePayerSOL(tx: any): number {
  try {
    const pre = Number(tx?.meta?.preBalances?.[0] ?? 0);  // fee payer is index 0
    const post = Number(tx?.meta?.postBalances?.[0] ?? 0);
    if (!Number.isFinite(pre) || !Number.isFinite(post)) return 0;

    const deltaLamports = Math.max(0, pre - post);
    const feeLamports = Number(tx?.meta?.fee ?? 0);
    const tipLamports = sumJitoTipsLamports(tx);
    const net = deltaLamports - feeLamports - tipLamports;
    return Math.max(0, net) / 1e9;
  } catch { return 0; }
}

// PumpSwap-aware swap detector (no hardcoded program IDs needed)
function isPumpSwapSwapTxForMint(tx: any, mint: string, pairAddress?: string, dexId?: string): boolean {
  try {
  const keys = getAllAccountKeysBase58(tx);

    // Dexscreener says this token trades on PumpSwap
    const isPumpSwap = (dexId || '').toLowerCase() === 'pumpswap';

    // Touches the specific pair (narrow noise)
    const touchesPair = pairAddress ? keys.includes(pairAddress) : false;

    // Token balance table touches our mint
    const tbs = (tx?.meta?.postTokenBalances || []) as any[];
    const touchesMint = tbs.some(b => String(b?.mint) === mint);

    // Fee payer SOL decreased (most swaps wrap SOL)
    const solDrop = (tx?.meta?.preBalances?.[0] ?? 0) > (tx?.meta?.postBalances?.[0] ?? 0);

    return isPumpSwap && touchesPair && touchesMint && solDrop;
  } catch {
    return false;
  }
}

type LiteTx = {
  sig: string;
  slot: number;
  owner?: string;
  cuPrice?: number | null;
  jitoTip?: boolean;
  solSpent?: number;
};

function isLikelyBundled(t: LiteTx): boolean {
  const cuHigh = (t.cuPrice ?? 0) >= 50_000; // tune 30k–200k μLamports
  return !!t.jitoTip && cuHigh;
}

function clusterLikelyBundlesSameSlot(txs: LiteTx[]): Set<string> {
  const bySlot = new Map<number, LiteTx[]>();
  for (const t of txs) {
    const arr = bySlot.get(t.slot) || [];
    arr.push(t);
    bySlot.set(t.slot, arr);
  }
  const bundledSigSet = new Set<string>();
  for (const [, arr] of bySlot) {
    const cand = arr.filter(isLikelyBundled);
    if (cand.length >= 2) cand.forEach(t => bundledSigSet.add(t.sig));
  }
  return bundledSigSet;
}

/**
 * Detect bundled SOL for a Pump.fun (PumpSwap) token.
 * Returns { bundledSOL, totalSOL, bundledPct, bundledCount, sampleWallets }
 */
async function detectBundledSolForMint(mint: string, maxTx = 200) {
  // 1) Resolve Dexscreener best pair (expects PumpSwap when Pump.fun graduates)
  const ds = await fetchDexscreenerForMint(mint);
  const pairAddress = ds?.pairAddress;
  const dexId = ds?.dexId;

  if (!pairAddress || (dexId || '').toLowerCase() !== 'pumpswap') {
    return { bundledSOL: 0, totalSOL: 0, bundledPct: 0, bundledCount: 0, sampleWallets: [] as string[] };
  }

  // 2) Pull recent signatures against the pair (less noise than mint)
  const pk = new PublicKey(pairAddress);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: maxTx }, 'confirmed');

  const lite: LiteTx[] = [];
  for (const s of sigs) {
    const tx = await connection.getParsedTransaction(s.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    if (!isPumpSwapSwapTxForMint(tx, mint, pairAddress, dexId)) continue;

    const cuPrice  = getComputeUnitPriceIx(tx);
    const jitoTip  = txPaysJitoTip(tx);
    const feePayer = getFeePayerBase58(tx);
    const solSpent = estSolSpentByFeePayerSOL(tx);

    lite.push({
      sig: s.signature,
      slot: tx.slot,
      owner: feePayer, // string | undefined OK (owner? in type)
      cuPrice,
      jitoTip,
      solSpent,
    });
  } // <-- this closing brace was missing

  const totalSOL = lite.reduce((a, t) => a + (t.solSpent || 0), 0);

  // 3) Bundled = same-slot clusters of (JitoTip + high CU price) txs
  const bundledSigSet = clusterLikelyBundlesSameSlot(lite);
  const bundledSOL = lite
    .filter(t => bundledSigSet.has(t.sig))
    .reduce((a, t) => a + (t.solSpent || 0), 0);

  const bundledPct = totalSOL > 0 ? (bundledSOL / totalSOL) * 100 : 0;

  // distinct wallets in bundled set (for the count)
  const bundledWallets = Array.from(
    new Set(lite.filter(t => bundledSigSet.has(t.sig)).map(t => t.owner).filter(Boolean) as string[])
  );

  return {
    bundledSOL,
    totalSOL,
    bundledPct,
    bundledCount: bundledWallets.length,
    sampleWallets: bundledWallets.slice(0, 10),
  };
}

function humanAge(fromUnixSec: number): string {
  const sec = Math.max(0, Math.floor(Date.now()/1000) - fromUnixSec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtTokenAmount(n?: number, sym?: string) {
  if (n === undefined || n === null || !isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)}M${sym ? ' ' + sym : ''}`;
  if (n >= 1_000) return `${(n/1_000).toFixed(2)}K${sym ? ' ' + sym : ''}`;
  return `${n.toFixed(2)}${sym ? ' ' + sym : ''}`;
}

function isValidPubkey(addr: string): boolean {
  try { new PublicKey(addr); return true; } catch { return false; }
}
function fmtPct(n: number) { return !isFinite(n) ? '—' : `${(n * 100).toFixed(2)}%`; }
function short(pk: string) { return `${pk.slice(0, 4)}…${pk.slice(-4)}`; }
function fmtMoney(n?: number | string, noDollar?: boolean) {
  if (n === undefined || n === null) return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!isFinite(v)) return '—';
  const s = v >= 1_000_000 ? `${(v/1_000_000).toFixed(2)}M`
          : v >= 1_000 ? `${(v/1_000).toFixed(2)}K`
          : v.toFixed(2);
  return noDollar ? s : `$${s}`;
}
function fmtSol(n?: number) {
  if (n === undefined || n === null || !isFinite(n)) return '—';
  return `${n.toFixed(2)} SOL`;
}
function isPumpMint(mint: string) {
  return mint.toLowerCase().endsWith('pump');
}

/* ===========================
   RISK SCORE
=========================== */
function riskScore(opts: {
  mintAuthorityNull: boolean; freezeAuthorityNull: boolean;
  top1Share: number; top10Share: number; tradable: boolean;
}): { score: number; label: string } {
  let score = 100;
  if (!opts.mintAuthorityNull) score -= 35;
  if (!opts.freezeAuthorityNull) score -= 25;
  if (opts.top1Share > 0.20) score -= 20;
  if (opts.top10Share > 0.70) score -= 15;
  if (opts.top1Share > 0.40) score -= 15;
  if (!opts.tradable) score -= 10;
  if (score >= 80) return { score, label: 'Low' };
  if (score >= 55) return { score, label: 'Medium' };
  return { score, label: 'High' };
}

/* ===========================
   HELIUS RPC WRAPPER
=========================== */
type HeliusRpcReq = { jsonrpc: '2.0'; id: string; method: string; params?: any };
async function heliusRpc<T = any>(method: string, params?: any): Promise<T | null> {
  if (!HELIUS_URL) return null;
  const body: HeliusRpcReq = { jsonrpc: '2.0', id: 'sentora', method, params };
  const res = await fetch(HELIUS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data?.result ?? null;
}

/* ===========================
   CREATOR DISCOVERY
=========================== */
async function getCreatorFromDAS(mint: string): Promise<string | null> {
  if (!HELIUS_API_KEY) return null;
  const result: any = await heliusRpc('getAsset', { id: mint });
  const creators = result?.content?.metadata?.creators || result?.creators || [];
  if (!Array.isArray(creators) || creators.length === 0) return null;

  // Prefer verified, non-platform
  for (const c of creators) {
    const addr = c?.address || c?.creator;
    const verified = !!c?.verified;
    const share = typeof c?.share === 'number' ? c.share : 0;
    if (addr && verified && share > 0 && !KNOWN_MARKET_AUTHORITIES.has(addr)) return addr;
  }
  // Fallback: any non-platform creator
  for (const c of creators) {
    const addr = c?.address || c?.creator;
    if (addr && !KNOWN_MARKET_AUTHORITIES.has(addr)) return addr;
  }
  return null;
}

async function getCreatorFromFirstTx(mint: string): Promise<string | null> {
  try {
    const mintPk = new PublicKey(mint);
    let before: string | undefined = undefined;
    let oldestSig: string | null = null;

    for (let i = 0; i < 10; i++) {
      const sigs = await connection.getSignaturesForAddress(mintPk, { before, limit: 100 }, 'confirmed');
      if (sigs.length === 0) break;
      oldestSig = sigs[sigs.length - 1].signature;
      if (sigs.length < 100) break;
      before = sigs[sigs.length - 1].signature;
    }
    if (!oldestSig) return null;

    const tx = await connection.getParsedTransaction(oldestSig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;

    const feePayer = getFeePayerBase58(tx);
    return feePayer || null;
  } catch {
    return null;
  }
}

async function getUpdateAuthorityDAS(mint: string): Promise<string | null> {
  const result: any = await heliusRpc('getAsset', { id: mint });
  const updateAuth =
    result?.authorities?.find((a: any) => a?.authorityScope === 'full' && a?.address)?.address ||
    result?.authority || result?.updateAuthority || result?.ownership?.owner || null;
  const metaUpdate =
    result?.compression?.updateAuthority ||
    result?.mintExtensions?.metadata?.updateAuthority ||
    result?.updateAuthority || null;
  return (metaUpdate || updateAuth) ?? null;
}

/* ===========================
   DEV HISTORY (DAS, owner fallback)
=========================== */
async function getFungibleByCreatorDAS(creator: string, excludeMint: string): Promise<DevAsset[]> {
  if (!HELIUS_API_KEY) return [];
  async function search(params: any) {
    const result: any = await heliusRpc('searchAssets', params);
    const items = result?.items || [];
    return items
      .filter((it: any) => it?.id && it.id !== excludeMint)
      .map((it: any) => ({
        id: it.id,
        name: it?.content?.metadata?.name || it?.name,
        symbol: it?.content?.metadata?.symbol || it?.symbol,
        interface: it?.interface,
        createdAt: it?.creationTime ? new Date(it.creationTime * 1000).toISOString() : undefined,
      })) as DevAsset[];
  }

  let out: DevAsset[] = [];
  out = out.concat(await search({ creatorAddress: creator, creatorVerified: true, page: 1, limit: 200 }));
  out = out.concat(await search({ creatorAddress: creator, page: 1, limit: 200 }));
  out = out.concat(await search({ ownerAddress: creator, page: 1, limit: 200 }));

  const uniq = new Map<string, DevAsset>();
  for (const a of out) if (a.id) uniq.set(a.id, a);
  return Array.from(uniq.values()).slice(0, 10);
}

async function getAssetsByAuthorityDAS(authority: string, excludeMint: string): Promise<DevAsset[]> {
  const result: any = await heliusRpc('getAssetsByAuthority', { authorityAddress: authority, page: 1, limit: 50 });
  if (!result?.items) return [];
  const items = result.items as any[];
  const out: DevAsset[] = items
    .filter((it: any) => (it?.interface || '').toLowerCase().includes('fungible'))
    .map((it: any) => ({
      id: it?.id,
      name: it?.content?.metadata?.name || it?.name,
      symbol: it?.content?.metadata?.symbol || it?.symbol,
      interface: it?.interface,
      createdAt: it?.creationTime ? new Date(it.creationTime * 1000).toISOString() : undefined,
    }))
    .filter((x) => x.id && x.id !== excludeMint);
  if (out.length === 0) {
    return items
      .filter((it: any) => it?.id && it?.id !== excludeMint)
      .slice(0, 10)
      .map((it: any) => ({
        id: it.id,
        name: it?.content?.metadata?.name || it?.name,
        symbol: it?.content?.metadata?.symbol || it?.symbol,
        interface: it?.interface,
        createdAt: it?.creationTime ? new Date(it.creationTime * 1000).toISOString() : undefined,
      }));
  }
  return out.slice(0, 10);
}

/* ===========================
   HOLDERS / AGE / BALANCES
=========================== */
async function getHolderConcentration(mintPk: PublicKey) {
  const largest = await connection.getTokenLargestAccounts(mintPk, 'confirmed');
  const infos = largest.value || [];
  const amountsRaw = infos.map(x => Number(x.uiAmount ?? 0));
  const top1 = amountsRaw[0] ?? 0;
  const top10 = amountsRaw.slice(0, 10).reduce((a, b) => a + b, 0);
  return { raw: infos, top1Ui: top1, top10Ui: top10 };
}

async function getMintFirstBlockTime(mint: string): Promise<number | null> {
  const mintPk = new PublicKey(mint);
  let before: string | undefined = undefined;
  let oldest: ConfirmedSignatureInfo | null = null;

  for (let i = 0; i < 10; i++) {
    const sigs = await connection.getSignaturesForAddress(
      mintPk,
      { before, limit: 100 },
      'confirmed'
    );

    if (sigs.length === 0) break;

    oldest = sigs[sigs.length - 1];

    if (sigs.length < 100) break;

    if (oldest) {
      before = oldest.signature;
    }
  }

  return oldest?.blockTime ?? null;
}


async function getSolBalance(pubkey: string): Promise<number> {
  try {
    const lamports = await connection.getBalance(new PublicKey(pubkey), 'confirmed');
    return lamports / 1e9;
  } catch { return 0; }
}
    async function getOwnerTokenBalance(owner: string, mint: string): Promise<number> {
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(owner),
      { mint: new PublicKey(mint) },
      'confirmed'
    );
    let total = 0n; // raw base units
    for (const it of resp.value) {
      const amountStr = it.account.data.parsed?.info?.tokenAmount?.amount as string | undefined;
      if (amountStr) total += BigInt(amountStr);
    }
    return Number(total);
  } catch { return 0; }
}


/* ===========================
   JUPITER TRADABILITY
=========================== */
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // wSOL
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function jupHasRoute(inputMint: string, outputMint: string): Promise<boolean> {
  const url = new URL('https://quote-api.jup.ag/v6/quote');
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', '1000000');
  url.searchParams.set('slippageBps', '50');
  const res = await fetch(url.toString());
  if (!res.ok) return false;
  const data: any = await res.json();
  const routes = (data?.data ?? data?.routes ?? []) as any[];
  return Array.isArray(routes) && routes.length > 0;
}
async function checkTradableOnJupiter(mint: string): Promise<{ tradable: boolean; via: string[] }> {
  const via: string[] = [];
  let tradable = false;
  try { if (await jupHasRoute(mint, SOL_MINT)) { tradable = true; via.push('SOL'); } } catch {}
  try { if (await jupHasRoute(mint, USDC_MINT)) { tradable = true; via.push('USDC'); } } catch {}
  return { tradable, via };
}

/* ===========================
   DEXSCREENER (MARKET + ORDERS)
=========================== */
/* ===========================
   DEXSCREENER (MARKET + ORDERS)
=========================== */

type DS_Pair = {
  chainId: string; dexId: string; pairAddress: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h1?: number; h24?: number };
  pairCreatedAt?: number; // ms since epoch
  priceChange?: { h24?: number }; // %
  ath?: { marketCap?: number; fdv?: number; priceUsd?: number };
  athMarketCap?: number;
  athFdv?: number;
};

// Mint -> best pair
async function fetchDexscreenerForMint(mint: string): Promise<DS_Pair | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const pairs: DS_Pair[] = Array.isArray(json?.pairs) ? json.pairs : [];
    const best = pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return best ?? null;
  } catch { return null; }
}

// Pair -> richer data
async function fetchDexscreenerPair(chainId: 'solana', pairAddress: string): Promise<DS_Pair | null> {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`);
    if (!resp.ok) return null;
    const json: any = await resp.json();
    // Some responses use {pairs:[...]}; others {pair:{...}}
    if (Array.isArray(json?.pairs)) return json.pairs[0] ?? null;
    return (json?.pair ?? null) as DS_Pair | null;
  } catch { return null; }
}

// Candles for ATH calc
type DSCandle = { t: number; o: number; h: number; l: number; c: number; v?: number };

async function fetchDexsCandles(
  chainId: 'solana',
  pairAddress: string,
  interval: '5m' | '15m' | '1h' = '1h',
  limit = 500
): Promise<DSCandle[]> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/candles/${chainId}/${pairAddress}?interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data: any = await res.json();
    const arr: any[] = Array.isArray(data?.candles) ? data.candles : [];
    const mapped: DSCandle[] = arr.map((x: any): DSCandle => ({
      t: Number(x.t), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c),
      v: x.v !== undefined ? Number(x.v) : undefined,
    }));
    return mapped.filter((cndl: DSCandle) => Number.isFinite(cndl.h));
  } catch { return []; }
}

type DexsOrder = { type: string; status?: string; paymentTimestamp?: number };
async function isDexsPaid(chainId: 'solana', mint: string): Promise<boolean> {
  try {
    const url = `https://api.dexscreener.com/orders/v1/${chainId}/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const data: DexsOrder[] = await res.json();
    return Array.isArray(data) && data.some(o => (o.paymentTimestamp ?? 0) > 0);
  } catch { return false; }
}


/* ===========================
   MISC & LINKS
=========================== */
const SCANS = new Map<string, number>();
function bumpScans(mint: string): number {
  const n = (SCANS.get(mint) ?? 0) + 1;
  SCANS.set(mint, n);
  return n;
}
function linkDexScreener(mint: string) { return `https://dexscreener.com/solana/${mint}`; }
function linkPhoton(mint: string)      { return `https://photon-sol.tinyastro.io/en/lite?inputMint=${mint}`; }
function linkBonkbot(mint: string)     { return `https://t.me/bonkbot_bot?start=ref_bonk_solana_${mint}`; }

/* ===========================
   COMMANDS
=========================== */
bot.start((ctx) =>
  ctx.reply('👋 Welcome to Sentora!\nCommands:\n• `/check <mint>` risk report\n• `/soul <mint>` Soul-style card', { parse_mode: 'Markdown' })
);

/* ----- /check ----- */
bot.command('check', async (ctx) => {
  try {
    const text = (ctx.message as any)?.text ?? '';
    const [, maybeMint] = text.trim().split(/\s+/);
    if (!maybeMint) return ctx.reply('⚠️ Usage: `/check <mint>`', { parse_mode: 'Markdown' });
    if (!isValidPubkey(maybeMint)) return ctx.reply('❌ Invalid mint.');

    const cached = CACHE.get(maybeMint);
    if (cached && Date.now() - cached.ts < TTL_MS) return ctx.reply(cached.text, { parse_mode: 'Markdown' });

    await ctx.reply(`🔎 Scanning token:\n\`${maybeMint}\`\n⏳ Please wait...`, { parse_mode: 'Markdown' });

    const mintPk = new PublicKey(maybeMint);

    // Mint info
    const mintInfo = await getMint(connection, mintPk, 'confirmed', TOKEN_PROGRAM_ID);
    const decimals = mintInfo.decimals;
    const supplyUi = Number(mintInfo.supply) / Math.pow(10, decimals);
    const mintAuth = mintInfo.mintAuthority;
    const freezeAuth = mintInfo.freezeAuthority;
    const mintAuthorityNull = mintAuth === null;
    const freezeAuthorityNull = freezeAuth === null;

    // Holders
    const { raw: largestAccounts, top1Ui, top10Ui } = await getHolderConcentration(mintPk);
    const top1Share = supplyUi > 0 ? top1Ui / supplyUi : 0;
    const top10Share = supplyUi > 0 ? top10Ui / supplyUi : 0;
    const topHoldersLines = largestAccounts.slice(0, 5).map((acc, i) => {
      const owner = acc.address?.toBase58 ? acc.address.toBase58() : String(acc.address);
      const ui = acc.uiAmount ?? 0;
      const pct = supplyUi > 0 ? (ui / supplyUi) : 0;
      return `${i + 1}. ${short(owner)} — ${ui.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${fmtPct(pct)})`;
    }).join('\n');

    // Jupiter tradability
    const { tradable, via } = await checkTradableOnJupiter(maybeMint);

    // Dev history (creator)
    let devHistorySection = '*Developer History*\n• Creator: unknown';
    let creator: string | null = await getCreatorFromDAS(maybeMint);
    if (!creator) creator = await getCreatorFromFirstTx(maybeMint);
    const ua = await getUpdateAuthorityDAS(maybeMint);
    const isPump = (ua && KNOWN_MARKET_AUTHORITIES.has(ua)) || isPumpMint(maybeMint);

    let assets: DevAsset[] = [];
    if (creator && HELIUS_API_KEY) {
      assets = await getFungibleByCreatorDAS(creator, maybeMint);
      if (assets.length === 0) assets = await getAssetsByAuthorityDAS(creator, maybeMint);
    }

    if (creator) {
      if (assets.length > 0) {
        const lines = assets.map((a, i) =>
          `${i + 1}. ${short(a.id)} — ${a.symbol || a.name || a.interface || 'token'}${a.createdAt ? ` (${a.createdAt.split('T')[0]})` : ''}`
        ).join('\n');
        devHistorySection =
`*Developer History*
• Creator: \`${creator}\`${isPump ? ' (Pump.fun)' : ''}
• Prior tokens (sample):
${lines}`;
      } else {
        devHistorySection =
`*Developer History*
• Creator: \`${creator}\`${isPump ? ' (Pump.fun)' : ''}
• No other tokens found by this wallet (in recent index sample).`;
      }
    }

    // Score & flags
    const score = riskScore({ mintAuthorityNull, freezeAuthorityNull, top1Share, top10Share, tradable });
    const flags: string[] = [];
    if (!mintAuthorityNull) flags.push('❗ Mint authority is ACTIVE (tokens can be minted).');
    if (!freezeAuthorityNull) flags.push('❗ Freeze authority is ACTIVE (accounts could be frozen).');
    if (top1Share > 0.20) flags.push(`❗ Top holder owns ${fmtPct(top1Share)} of supply.`);
    if (top10Share > 0.70) flags.push(`❗ Top 10 holders own ${fmtPct(top10Share)} of supply.`);
    if (!tradable) flags.push('❗ Not tradable on Jupiter routes (no SOL/USDC path found).');
    if (flags.length === 0) flags.push('✅ No critical flags detected in mint/holders/liquidity checks.');

    const msg =
`🛡️ *Sentora Risk Report*
*Mint:* \`${maybeMint}\`
*Score:* *${score.score}/100* — *${score.label} Risk*

*Token Info*
• Decimals: \`${decimals}\`
• Supply: \`${supplyUi.toLocaleString(undefined, { maximumFractionDigits: 2 })}\`
• Mint Authority: \`${mintAuthorityNull ? 'NULL (renounced)' : (mintAuth as any)?.toBase64?.() || (mintAuth as any)?.toBase58?.() || 'ACTIVE'}\`
• Freeze Authority: \`${freezeAuthorityNull ? 'NULL (renounced)' : (freezeAuth as any)?.toBase64?.() || (freezeAuth as any)?.toBase58?.() || 'ACTIVE'}\`

*Holder Concentration*
• Top 1: ${fmtPct(top1Share)}
• Top 10: ${fmtPct(top10Share)}
${topHoldersLines ? `\n*Top Holders*\n${topHoldersLines}` : ''}

*Liquidity / Tradability*
• Tradable on Jupiter: \`${tradable ? 'Yes' : 'No'}\`${tradable && via.length ? ` (via ${via.join(', ')})` : ''}

${devHistorySection}

*Flags*
${flags.map(f => `• ${f}`).join('\n')}
`;

    CACHE.set(maybeMint, { ts: Date.now(), text: msg });
    await ctx.reply(msg, { parse_mode: 'Markdown' });

  } catch (err: any) {
    console.error(err);
    await ctx.reply(`❌ Error: ${err?.message || 'failed to scan token'}`);
  }
});

/* ----- /soul ----- */
bot.command('soul', async (ctx) => {
  try {
    const text = (ctx.message as any)?.text ?? '';
    const [, maybeMint] = text.trim().split(/\s+/);
    if (!maybeMint) return ctx.reply('⚠️ Usage: `/soul <mint>`', { parse_mode: 'Markdown' });
    if (!isValidPubkey(maybeMint)) return ctx.reply('❌ Invalid mint.');

    const scans = bumpScans(maybeMint);
    await ctx.reply(`🧪 Building Soul card for \`${maybeMint}\`…`, { parse_mode: 'Markdown' });

    // Market (Dexscreener)
    const ds = await fetchDexscreenerForMint(maybeMint);
    const mc = Number(ds?.marketCap ?? ds?.fdv ?? 0);

    // Pair details (may include extra fields)
    const pair = (ds?.pairAddress) ? await fetchDexscreenerPair('solana', ds.pairAddress) : null;

    // Age (prefer pairCreatedAt)
    let genesisTs: number | null =
      (typeof ds?.pairCreatedAt === 'number' && ds.pairCreatedAt > 0)
        ? Math.floor(ds.pairCreatedAt / 1000)
        : await getMintFirstBlockTime(maybeMint);
    const ageStr = genesisTs ? humanAge(genesisTs) : '—';

    // 24h %
    const ch24 = typeof ds?.priceChange?.h24 === 'number' ? ds.priceChange.h24 : null;

    // Liquidity: USD + quote side (e.g., SOL)
    const vLiqUsd = Number(ds?.liquidity?.usd ?? 0);
    const quoteAmt = ds?.liquidity?.quote ?? null;
    const quoteSym = (ds?.quoteToken?.symbol || '').toUpperCase();
    const quotePretty = quoteAmt !== null
      ? (quoteSym.includes('SOL') ? fmtTokenAmount(Number(quoteAmt), 'SOL')
                                  : fmtTokenAmount(Number(quoteAmt), quoteSym || undefined))
      : '—';

    const vol1h = Number(ds?.volume?.h1 ?? 0);

    // Supply (needed before ATH fallback)
    const mintPk = new PublicKey(maybeMint);
    const mintInfo = await getMint(connection, mintPk, 'confirmed', TOKEN_PROGRAM_ID);
    const decimals = mintInfo.decimals;
    const supplyUi = Number(mintInfo.supply) / Math.pow(10, decimals);

    // Dex Paid
    const dexPaid = await isDexsPaid('solana', maybeMint);

    // Holders (Top %)
    const { raw: largest, top1Ui } = await getHolderConcentration(mintPk);
    const holdersApprox = Math.max(largest.length, 1);
    const topShare = supplyUi > 0 ? top1Ui / supplyUi : 0;

    // Creator + balances
    let creator = await getCreatorFromDAS(maybeMint);
    if (!creator) creator = await getCreatorFromFirstTx(maybeMint);
    const creatorSol = creator ? await getSolBalance(creator) : 0;
    let creatorTokPct = 0;
    if (creator) {
      const raw = await getOwnerTokenBalance(creator, maybeMint);
      const ui = raw / Math.pow(10, decimals);
      creatorTokPct = supplyUi > 0 ? ui / supplyUi : 0;
    }


    // Build card
    const sym = ds?.baseToken?.symbol || 'Token';
    const lines: string[] = [];
    lines.push(`💊  ${sym} • $${sym}`);
    lines.push('');
    lines.push(`🕒 Age:  ${ageStr} ${ch24 !== null ? `[${ch24 >= 0 ? '+' : ''}${ch24.toFixed(2)}%]` : '[—]'}`);
    lines.push(`💰 MC:   ${fmtMoney(mc)}`);
    lines.push(`💧 vLiq: ${fmtMoney(vLiqUsd)} [${quotePretty}]`);
    lines.push(`📊 Vol:  ${fmtMoney(vol1h)} [1h]`);
    lines.push('');
    lines.push(`${dexPaid ? '✅' : '❌'} Dex Paid`);
    lines.push(`⚡ Scans: ${scans}`);
    lines.push(`👥 Hodls: ${holdersApprox} • Top: ${fmtPct(topShare)}`);
    lines.push('');
    lines.push(`🔫 Snipers: —`);
    lines.push(`🎯 First 20: —`);
    lines.push(`🛠🐟🍤🍤🍤`);
    lines.push('');
    lines.push(`🛠️ Dev: ${fmtSol(creatorSol)} | ${(creatorTokPct*100).toFixed(2)}% ${sym}`);
    lines.push(`┗ Airdrop: —`);
    lines.push('');
    lines.push(`📊 Chart | Soul | Phtn | Bonk`);
    lines.push(maybeMint);

   const bund = await detectBundledSolForMint(maybeMint, 180);
lines.push(`┣ Bundled: ${bund.bundledCount} | ${bund.bundledSOL.toFixed(2)} SOL (${bund.bundledPct.toFixed(1)}%)`);


    const keyboard = {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Chart', url: linkDexScreener(maybeMint) },
          { text: 'Photon', url: linkPhoton(maybeMint) },
          { text: 'BonkBot', url: linkBonkbot(maybeMint) }
        ]]
      }
    };

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', ...keyboard });
  } catch (e: any) {
    console.error(e);
    await ctx.reply(`❌ Soul error: ${e?.message || 'failed'}`);
  }
});


/* ===========================
   LAUNCH
=========================== */
bot.launch().then(() => {
  console.log('✅ Sentora bot is running (risk + soul card).');
}).catch(console.error);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
