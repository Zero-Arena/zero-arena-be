// Minimal ABI fragments the season-keeper needs. Full ABI lives in
// @zero-arena/contracts; this file only carries what we actually call so
// the keeper has no extra dep on the contracts npm package.

export const SEASON_ABI = [
  'function nextSeasonId() view returns (uint256)',
  'function seasons(uint256) view returns (bytes32 datasetSpec, uint64 initialBalance, uint16 feeBps, uint16 slippageBps, uint8 market, uint8 maxLeverage, uint64 startTime, uint64 endTime, uint256 prizePool, address creator, bool settled)',
  'function participantCount(uint256) view returns (uint256)',
  'function getParticipants(uint256) view returns (uint256[])',
  'function settle(uint256 seasonId, uint256[] sortedTokens) external',
  'event Settled(uint256 indexed seasonId, uint256[] sortedWinners, uint256 paidOut)',
  'event PrizeAwarded(uint256 indexed seasonId, uint256 indexed tokenId, address indexed winner, uint256 amount)',
] as const;

export const LIVE_CERTIFICATE_KEEPER_ABI = [
  'function runs(uint256) view returns (bytes32 cumulativeHash, uint64 startedAt, uint64 lastUpdatedAt, uint64 epochCount, uint8 status, uint16 liveMaxDrawdownBps, uint16 liveWinRateBps, int128 liveTotalReturnBps, uint128 liveSharpeX1000)',
] as const;
