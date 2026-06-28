export interface Account {
  id: string;
  email: string;
  displayName: string;
  organization?: string;
  subscriptionType?: string;
  addedAt: string;
  isActive: boolean;
}

export interface AppState {
  accounts: Account[];
  activeAccountId: string | null;
  claudeVersion?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  displayName?: string;
  organization?: string;
  apiProvider?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface UsageSummary {
  weeklyMessages: number;
  weeklySessionCount: number;
  weeklyToolCalls: number;
  todayMessages: number;
  todaySessionCount: number;
  todayToolCalls: number;
  totalMessages: number;
  totalSessions: number;
  dailyActivity: DailyActivity[];
}

export interface UsageLimits {
  fiveHourUtilization?: number;
  sevenDayUtilization?: number;
  fiveHourResetAt?: string;
  sevenDayResetAt?: string;
  /** @deprecated use fiveHourResetAt / sevenDayResetAt */
  resetAt?: string;
}

export interface DailyCost {
  date: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CostSummary {
  /** false when the LiteLLM pricing table couldn't be fetched (offline). */
  pricingAvailable: boolean;
  todayCost: number;
  weekCost: number;
  totalCost: number;
  todayTokens: number;
  dailyCost: DailyCost[];
}

export type OperationResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string };
