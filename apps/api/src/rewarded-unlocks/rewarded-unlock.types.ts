export interface CreateRewardedUnlockChallengeInput {
  platform?: unknown;
  placementKey?: unknown;
}

export interface RewardedUnlockChallengeResponse {
  adUnitId?: string;
  alreadyUnlocked: boolean;
  challengeId?: string;
  expiresAt?: string;
  placementKey?: string;
  status: 'granted' | 'pending';
}

export interface RewardedUnlockStatusResponse {
  challengeId: string;
  episodeId: string;
  grantedAt?: string;
  status: 'expired' | 'granted' | 'pending';
}
