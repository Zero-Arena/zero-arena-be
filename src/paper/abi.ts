// Minimal LiveCertificate + Season ABIs the daemon needs. Inlined here
// instead of importing from the SDK because v0.1 zeroarena doesn't ship
// these contracts in its ABI bundle yet (they belong to RFC-001 v0.3).
//
// Mirror of the canonical fragments in
// zero-arena-contracts/src/{LiveCertificate.sol,Season.sol}. Keep both
// sides in sync — the human-readable format is identical to what
// ethers' Interface accepts.

export const LIVE_CERTIFICATE_ABI = [
  'function start(uint256 tokenId, bytes32 initialCumulativeHash) external',
  'function stop(uint256 tokenId) external',
  'function markLiquidated(uint256 tokenId) external',
  'function update(uint256 tokenId, uint64 epochIndex, bytes32 epochHash, int128 liveTotalReturnBps, uint128 liveSharpeX1000, uint16 liveMaxDrawdownBps, uint16 liveWinRateBps) external',
  'function isActive(uint256 tokenId) external view returns (bool)',
  'function get(uint256 tokenId) external view returns (tuple(bytes32 cumulativeHash, uint64 startedAt, uint64 lastUpdatedAt, uint64 epochCount, uint8 status, uint16 liveMaxDrawdownBps, uint16 liveWinRateBps, int128 liveTotalReturnBps, uint128 liveSharpeX1000))',
  'event PaperRunStarted(uint256 indexed tokenId, address indexed owner, uint64 startedAt, bytes32 initialCumulativeHash)',
  'event EpochCommitted(uint256 indexed tokenId, uint64 indexed epochIndex, bytes32 cumulativeHash, bytes32 epochHash, int128 liveTotalReturnBps, uint128 liveSharpeX1000)',
] as const;

export const SEASON_ABI = [
  'function enroll(uint256 seasonId, uint256 tokenId) external',
  'function seasons(uint256 id) external view returns (bytes32 datasetSpec, uint64 initialBalance, uint16 feeBps, uint16 slippageBps, uint8 market, uint8 maxLeverage, uint64 startTime, uint64 endTime, uint256 prizePool, address creator, bool settled)',
] as const;
